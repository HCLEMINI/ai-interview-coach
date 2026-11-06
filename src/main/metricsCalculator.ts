// 表达层六项指标：音频层（ffmpeg 提 PCM 算 RMS 序列）+ 文本层（基于转写）
import { spawn } from 'child_process'
import type { MetricsResult } from '../shared/types'

const SAMPLE_RATE = 8000
const FRAME_MS = 100
const FRAME_LEN = (SAMPLE_RATE * FRAME_MS) / 1000
const PAUSE_FRAMES = 15 // 1.5s

const FILLERS_ZH = ['然后', '就是', '嗯', '那个', '这个', '其实']
const CONNECTIVES_ZH = ['第一', '第二', '第三', '首先', '其次', '最后', '因此', '所以', '总之', '一方面', '另一方面']
const FILLERS_EN = ['uh', 'um', 'like', 'you know', 'kinda', 'sort of']
const CONNECTIVES_EN = ['first', 'second', 'third', 'finally', 'therefore', 'so', 'in summary', 'as a result']

export interface MetricsInput {
  audioPath: string
  text: string
  targetSec: number // 目标作答时长
  isEnglish: boolean
  isReading: boolean
  readingLang?: 'zh' | 'en'
  readingPassage?: string | null
}

function decodePcm(audioPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-i', audioPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], {
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let errText = ''
    p.stdout.on('data', (c) => chunks.push(c as Buffer))
    p.stderr.on('data', (c) => {
      errText += c.toString()
    })
    p.on('error', (e) => reject(new Error(`ffmpeg 启动失败: ${e.message}`)))
    p.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`ffmpeg 解码失败(code=${code}): ${errText.slice(-300)}`))
        return
      }
      const buf = Buffer.concat(chunks)
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)))
    })
  })
}

function rmsFrames(pcm: Float32Array): number[] {
  const frames: number[] = []
  for (let i = 0; i + FRAME_LEN <= pcm.length; i += FRAME_LEN) {
    let sum = 0
    for (let j = i; j < i + FRAME_LEN; j++) sum += pcm[j] * pcm[j]
    frames.push(Math.sqrt(sum / FRAME_LEN))
  }
  return frames
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

function normalizeZh(text: string): string {
  // 去标点与空白，只留有效字符（中英文与数字）
  return text.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array(b.length + 1)
  let cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

/** 词级编辑距离（英文朗读按词对齐评分） */
function levenshteinWords(a: string[], b: string[]): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array(b.length + 1)
  let cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

function normalizeWordsEn(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function bandScore(value: number, low: number, high: number, softLow: number, softHigh: number): number {
  // 区间内满分，区间外按距离线性衰减到 0
  if (value >= low && value <= high) return 1
  const ref = value < low ? softLow : softHigh
  const dist = value < low ? low - value : value - high
  if (ref <= 0) return 0
  return Math.max(0, 1 - dist / ref)
}

export async function computeMetrics(input: MetricsInput): Promise<MetricsResult> {
  const base: MetricsResult = {
    q_dir: '',
    audio_duration_s: 0,
    speech_duration_s: 0,
    char_count: 0,
    speech_rate_cpm: 0,
    rate_pass: false,
    pauses_gt_1_5s: 0,
    pause_limit: 5,
    pause_pass: false,
    filler_words: { total: 0, top3: [] },
    connectives: { count: 0, hits: [] },
    duration_ratio: 0,
    duration_pass: false,
    ending_rms_ratio: null,
    ending_pass: null,
    reading_char_accuracy: null,
    expression_score: null
  }

  try {
    const pcm = await decodePcm(input.audioPath)
    const durationS = pcm.length / SAMPLE_RATE
    const frames = rmsFrames(pcm)
    const sorted = [...frames].sort((a, b) => a - b)
    const floor = percentile(sorted, 0.2)
    const peak = percentile(sorted, 0.95)
    const thresh = Math.max(floor * 2.5, peak * 0.12, 0.006)

    // 语音段与停顿
    let speechFrames = 0
    let pauses = 0
    let silentRun = 0
    let lastSpeechIdx = -1
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] >= thresh) {
        speechFrames++
        silentRun = 0
        lastSpeechIdx = i
      } else {
        silentRun++
        if (silentRun === PAUSE_FRAMES) pauses++
      }
    }
    // 首尾静音不算停顿：粗略处理——结尾静音段回退计数
    void lastSpeechIdx

    const speechDurationS = (speechFrames * FRAME_MS) / 1000
    const speechMin = speechDurationS / 60

    // 结尾 5 秒音量 vs 语音段平均
    let endingRatio: number | null = null
    {
      const tailStart = Math.max(0, frames.length - Math.round(5000 / FRAME_MS))
      const tail = frames.slice(tailStart).filter((v) => v >= thresh)
      const speechAll = frames.filter((v) => v >= thresh)
      if (tail.length >= 5 && speechAll.length > 0) {
        const tailMean = tail.reduce((s, v) => s + v, 0) / tail.length
        const allMean = speechAll.reduce((s, v) => s + v, 0) / speechAll.length
        if (allMean > 0) endingRatio = Math.round((tailMean / allMean) * 100) / 100
      }
    }

    // 文本层
    const text = input.text || ''
    const normalized = normalizeZh(text)
    const charCount = input.isEnglish
      ? text.split(/\s+/).filter(Boolean).length // 英文按词
      : normalized.length

    const rate = speechMin > 0 && charCount > 0 ? Math.round(charCount / speechMin) : 0
    const rateLow = input.isEnglish ? 110 : 180
    const rateHigh = input.isEnglish ? 160 : 260
    const rateSoft = input.isEnglish ? 60 : 120 // 衰减参考带宽

    const fillerList = input.isEnglish ? FILLERS_EN : FILLERS_ZH
    const connList = input.isEnglish ? CONNECTIVES_EN : CONNECTIVES_ZH
    const lower = input.isEnglish ? text.toLowerCase() : text
    const fillerCounts = fillerList
      .map((w) => ({ word: w, count: lower.split(w).length - 1 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
    const fillerTotal = fillerCounts.reduce((s, x) => s + x.count, 0)
    const connHits = connList.filter((w) => lower.includes(w))

    const durationRatio = input.targetSec > 0 ? Math.min(1.5, durationS / input.targetSec) : 0
    const pauseLimit = Math.max(3, Math.ceil(5 * (durationS / 120)))

    // 朗读题准确率：中文按字符、英文按词（更符合评分习惯）
    let readingAccuracy: number | null = null
    if (input.isReading && input.readingPassage) {
      if (input.readingLang === 'en') {
        const ref = normalizeWordsEn(input.readingPassage)
        const hyp = normalizeWordsEn(input.text)
        if (ref.length > 0) {
          const dist = levenshteinWords(hyp, ref)
          readingAccuracy = Math.max(0, Math.round((1 - dist / ref.length) * 1000) / 10)
        }
      } else {
        const ref = normalizeZh(input.readingPassage)
        const hyp = normalized
        if (ref.length > 0) {
          const dist = levenshtein(hyp, ref)
          readingAccuracy = Math.max(0, Math.round((1 - dist / ref.length) * 1000) / 10)
        }
      }
    }

    // 表达分：加权（朗读题换权重）
    const rateScore = bandScore(rate, rateLow, rateHigh, rateSoft, rateSoft)
    const pauseScore = pauses <= pauseLimit ? 1 : Math.max(0, 1 - (pauses - pauseLimit) / pauseLimit)
    const fillerPerMin = speechMin > 0 ? fillerTotal / speechMin : 99
    const fillerScore = Math.max(0, 1 - fillerPerMin / 12) // 每分钟 12 次口头禅 = 0 分
    const connScore = Math.min(1, connHits.length / 3)
    const durationScore = Math.min(1, durationRatio / 0.9)
    const endingScore = endingRatio === null ? 0.8 : bandScore(endingRatio, 0.9, 3, 1.5, 3)
    const readingScore = readingAccuracy === null ? 1 : Math.max(0, Math.min(1, (readingAccuracy - 0.5) / 0.45))

    let expression: number
    if (input.isReading) {
      expression =
        40 * readingScore + 20 * durationScore + 15 * rateScore + 10 * pauseScore + 10 * fillerScore + 5 * endingScore
    } else {
      expression =
        30 * durationScore + 20 * rateScore + 15 * pauseScore + 15 * connScore + 10 * fillerScore + 10 * endingScore
    }

    base.audio_duration_s = Math.round(durationS * 10) / 10
    base.speech_duration_s = Math.round(speechDurationS * 10) / 10
    base.char_count = charCount
    base.speech_rate_cpm = rate
    base.rate_pass = rate >= rateLow && rate <= rateHigh
    base.pauses_gt_1_5s = pauses
    base.pause_limit = pauseLimit
    base.pause_pass = pauses <= pauseLimit
    base.filler_words = { total: fillerTotal, top3: fillerCounts.slice(0, 3) }
    base.connectives = { count: connHits.length, hits: connHits.slice(0, 6) }
    base.duration_ratio = Math.round(durationRatio * 1000) / 1000
    base.duration_pass = durationRatio >= 0.9
    base.ending_rms_ratio = endingRatio
    base.ending_pass = endingRatio === null ? null : endingRatio >= 0.9
    base.reading_char_accuracy = readingAccuracy
    base.expression_score = Math.round(expression)
    return base
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e)
    return base
  }
}

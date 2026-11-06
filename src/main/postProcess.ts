// 每题收尾异步处理链：ASR → 表达指标 →（网关可用时）LLM 内容评分与追问判定
// 串行队列（whisper 本身单线程）；进度事件推送渲染层
import { writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { GatewayConfig, LlmScore, MetricsResult, Question } from '../shared/types'
import { SidecarManager } from './sidecarManager'
import { computeMetrics } from './metricsCalculator'

interface AsrResult {
  text: string
  segments: { start: number; end: number; text: string }[]
  duration_s: number
  rtf: number | null
}

export interface ProcessJob {
  sessionRoot: string
  qDir: string
  question: Question | null // 追问层为 null
  targetSec: number
  unscored: boolean // 练习题：只转写与指标，不打 LLM 分
}

const REDLINE_RULES = `越界检测（redline）：作答中出现以下任何一类内容即触发，并给出等长度的替换话术：
1. 提及放弃/违约/毁约往事（如"之前投过没去""签了又解约""当时放弃了"）
2. 抱怨语气（吐槽导师、加班、学校、前单位等负面情绪宣泄）
3. 重修/挂科的不当表述（如自嘲"我挂过科"——应表述为"重修后掌握了方法"）
4. 贬低其他单位或把其他offer当筹码的语气`

function scoreSystemPrompt(isEnglish: boolean): string {
  if (isEnglish) {
    return `You are a strict AI interview scoring officer. Score ONLY based on the transcript. Output a single JSON object, no markdown. Schema:
{"star":{"situation":0-2,"task":0-2,"action":0-2,"result":0-2},
 "keyword_hits":{"hit":[],"miss":[]},
 "personal_experience":{"count":0,"matched":[]},
 "company_facts":{"count":0,"facts":[]},
 "sentence_comments":[{"quote":"","comment":"","severity":"info|warn|danger"}],
 "redline":{"triggered":false,"items":[]},
 "followup_verdict":{"lacks_example":true,"lacks_action":true,"lacks_result":true}}
Rules: keyword_hits checks which of the given keywords appear; personal_experience counts specific personal stories; company_facts counts concrete facts about the target company; followup_verdict marks what the answer lacks. Do NOT output any field not in the schema.`
  }
  return `你是一名严格的 AI 面试评分官（复刻北森/智联机器评分）。只依据作答转写评分，输出单个 JSON 对象，不要 markdown 包裹。Schema：
{"star":{"situation":0-2,"task":0-2,"action":0-2,"result":0-2},
 "keyword_hits":{"hit":[],"miss":[]},
 "personal_experience":{"count":0,"matched":["简述"]},
 "company_facts":{"count":0,"facts":["简述"]},
 "sentence_comments":[{"quote":"原文短句","comment":"点评","severity":"info|warn|danger"}],
 "redline":{"triggered":false,"items":[]},
 "followup_verdict":{"lacks_example":true,"lacks_action":true,"lacks_result":true}}
评分规则：
- star 四要素按完整性 0-2 分；自我介绍/动机题不必强求 STAR，相关项按内容质量给分
- keyword_hits：检查给定关键词哪些在作答中出现
- personal_experience：统计引用具体个人经历的次数（有细节才算）
- company_facts：统计与目标单位具体事实挂钩的表述数
- sentence_comments：挑最多 3 句有代表性的句子点评
- followup_verdict：作答缺具体事例/缺本人行动/缺结果数据各标 true
${REDLINE_RULES}
只输出 schema 内字段。`
}

export class PostProcessor {
  private sidecar: SidecarManager
  private getGateway: () => GatewayConfig | null
  private sendProgress: (qDir: string, stage: string, error?: string) => void
  private getModel: () => string
  private verdicts = new Map<string, { lacks_example: boolean; lacks_action: boolean; lacks_result: boolean }>()
  private chain: Promise<void> = Promise.resolve()

  constructor(deps: {
    sidecar: SidecarManager
    getGateway: () => GatewayConfig | null
    sendProgress: (qDir: string, stage: string, error?: string) => void
    getModel?: () => string
  }) {
    this.sidecar = deps.sidecar
    this.getGateway = deps.getGateway
    this.sendProgress = deps.sendProgress
    this.getModel = deps.getModel ?? ((): string => 'small')
  }

  verdict(qDir: string): { lacks_example: boolean; lacks_action: boolean; lacks_result: boolean } | null {
    return this.verdicts.get(qDir) ?? null
  }

  /** 等待某题转写完成（超时返回 null）——供动态追问取作答内容 */
  waitForTranscript(qDir: string, timeoutMs = 90_000): Promise<string | null> {
    const done = this.transcripts.get(qDir)
    if (done !== undefined) return Promise.resolve(done)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.transcriptWaiters.delete(qDir)
        resolve(null)
      }, timeoutMs)
      this.transcriptWaiters.set(qDir, (text) => {
        clearTimeout(timer)
        resolve(text)
      })
    })
  }

  private transcripts = new Map<string, string | null>()
  private transcriptWaiters = new Map<string, (text: string | null) => void>()

  clearVerdicts(): void {
    this.verdicts.clear()
  }

  /** 入队一题（串行执行）；返回的 Promise 在本题处理结束后兑现 */
  enqueue(job: ProcessJob): Promise<void> {
    const p = this.chain
      .then(() => this.process(job))
      .catch((e) => {
        console.error('[PostProcess] 处理失败', job.qDir, e)
        this.sendProgress(job.qDir, 'done', e instanceof Error ? e.message : String(e))
      })
    this.chain = p
    return p
  }

  waitIdle(): Promise<void> {
    return this.chain
  }

  private async process(job: ProcessJob): Promise<void> {
    const { sessionRoot, qDir, question, targetSec } = job
    const qPath = join(sessionRoot, qDir)
    const audioPath = join(qPath, 'audio.webm')
    if (!existsSync(audioPath)) {
      this.sendProgress(qDir, 'done', '无音频文件（未作答或放弃）')
      return
    }

    const isEnglish = question?.type === 'english' || (question?.type === 'reading' && question?.readingLang === 'en')
    const isReading = question?.type === 'reading'

    // 1. ASR
    this.sendProgress(qDir, 'asr')
    let asr: AsrResult | null = null
    try {
      asr = (await this.sidecar.request('asr', {
        audio_path: audioPath,
        language: isEnglish ? 'en' : 'zh',
        model: this.getModel()
      })) as AsrResult
      writeFileSync(join(qPath, 'transcript.txt'), asr.text || '（无语音内容）', 'utf-8')
    } catch (e) {
      this.sendProgress(qDir, 'asr', e instanceof Error ? e.message : String(e))
    }
    // 转写就绪：唤醒等待者（动态追问用）
    this.transcripts.set(qDir, asr?.text ?? null)
    this.transcriptWaiters.get(qDir)?.(asr?.text ?? null)
    this.transcriptWaiters.delete(qDir)

    // 2. 表达指标
    this.sendProgress(qDir, 'metrics')
    let metrics: MetricsResult | null = null
    if (asr) {
      metrics = await computeMetrics({
        audioPath,
        text: asr.text,
        targetSec,
        isEnglish,
        isReading,
        readingLang: question?.readingLang === 'en' ? 'en' : 'zh',
        readingPassage: question?.readingPassage ?? null
      })
      metrics.q_dir = qDir
      writeFileSync(join(qPath, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf-8')
    }

    // 3. LLM 内容评分（练习题跳过）
    if (!job.unscored && asr && (asr.text || '').trim().length > 0) {
      const gw = this.getGateway()
      if (gw && gw.apiKey) {
        this.sendProgress(qDir, 'llm')
        const userPayload = {
          题目: question?.text ?? '追问',
          题型: question?.type ?? 'behavioral',
          目标关键词: question?.targetKeywords ?? [],
          目标单位: '见会话配置（作答中出现具体单位事实即计入 company_facts）',
          作答转写: asr.text.slice(0, 6000)
        }
        try {
          const res = (await this.sidecar.request('llm', {
            gateway: {
              base_url: gw.baseUrl,
              api_key: gw.apiKey,
              model: gw.model,
              timeout_sec: gw.timeoutSec
            },
            system: scoreSystemPrompt(isEnglish),
            user: JSON.stringify(userPayload, null, 1),
            json_mode: true,
            temperature: 0.2,
            max_tokens: 3200
          })) as { content: string; parsed: Record<string, unknown> | null }

          const p = (res.parsed ?? {}) as Record<string, unknown>
          const score: LlmScore = {
            q_dir: qDir,
            model: gw.model,
            scored_at: new Date().toISOString(),
            star: this.num2(p, 'star')
              ? {
                  situation: Number((p.star as Record<string, unknown>).situation ?? 0),
                  task: Number((p.star as Record<string, unknown>).task ?? 0),
                  action: Number((p.star as Record<string, unknown>).action ?? 0),
                  result: Number((p.star as Record<string, unknown>).result ?? 0),
                  total: 0
                }
              : null,
            keyword_hits: (p.keyword_hits as LlmScore['keyword_hits']) ?? null,
            personal_experience: (p.personal_experience as LlmScore['personal_experience']) ?? null,
            company_facts: (p.company_facts as LlmScore['company_facts']) ?? null,
            sentence_comments: (p.sentence_comments as LlmScore['sentence_comments']) ?? [],
            redline: (p.redline as LlmScore['redline']) ?? null,
            followup_verdict: (p.followup_verdict as LlmScore['followup_verdict']) ?? null,
            content_score: null,
            overall: null
          }
          if (score.star) {
            score.star.total = score.star.situation + score.star.task + score.star.action + score.star.result
          }
          // 内容分在本地按确定性公式计算（不采信模型自评）
          let content = 0
          content += ((score.star?.total ?? 0) / 8) * 40
          const kw = question?.targetKeywords ?? []
          if (kw.length > 0 && score.keyword_hits) {
            const hitRatio = kw.filter((k) => score.keyword_hits!.hit.some((h) => h.includes(k) || k.includes(h))).length / kw.length
            content += hitRatio * 15
          } else content += 10
          content += (Math.min(score.personal_experience?.count ?? 0, 3) / 3) * 15
          content += (Math.min(score.company_facts?.count ?? 0, 2) / 2) * 15
          const dangerCount = score.sentence_comments?.filter((c) => c.severity === 'danger').length ?? 0
          const warnCount = score.sentence_comments?.filter((c) => c.severity === 'warn').length ?? 0
          content -= dangerCount * 4 + warnCount * 2
          if (score.redline?.triggered) content -= score.redline.items.length * 10
          score.content_score = Math.max(0, Math.min(100, Math.round(content)))
          score.overall = Math.round(score.content_score * 0.6 + (metrics?.expression_score ?? 60) * 0.4)
          writeFileSync(join(qPath, 'llm-score.json'), JSON.stringify(score, null, 2), 'utf-8')

          if (score.followup_verdict) {
            this.verdicts.set(qDir, score.followup_verdict)
          }
        } catch (e) {
          // 评分失败不阻塞：落错误文件
          const msg = e instanceof Error ? e.message : String(e)
          const fallback: LlmScore = {
            q_dir: qDir,
            model: gw.model,
            scored_at: new Date().toISOString(),
            star: null,
            keyword_hits: null,
            personal_experience: null,
            company_facts: null,
            sentence_comments: [],
            redline: null,
            followup_verdict: null,
            content_score: null,
            overall: null,
            error: msg
          }
          writeFileSync(join(qPath, 'llm-score.json'), JSON.stringify(fallback, null, 2), 'utf-8')
          this.sendProgress(qDir, 'llm', msg)
        }
      } else {
        this.sendProgress(qDir, 'llm', '未配置网关，跳过内容评分')
      }
    }

    this.sendProgress(qDir, 'done')
  }

  private num2(p: Record<string, unknown> | null, key: string): boolean {
    return !!(p && p[key] && typeof p[key] === 'object')
  }
}

/** 会话汇总：逐题 metrics/llm-score 聚合出场均分（供报告与趋势） */
export function aggregateSession(sessionRoot: string, formalDirs: string[]): {
  expression_avg: number | null
  content_avg: number | null
  total_score: number | null
  metrics_avg: Partial<MetricsResult> | null
} {
  let expSum = 0
  let expN = 0
  let conSum = 0
  let conN = 0
  const metricAgg: Partial<MetricsResult> = {}
  let rateSum = 0
  let rateN = 0
  let pauseSum = 0
  let fillerSum = 0
  let connSum = 0
  let durSum = 0
  for (const dir of formalDirs) {
    const mp = join(sessionRoot, dir, 'metrics.json')
    if (existsSync(mp)) {
      try {
        const m = JSON.parse(readFileSync(mp, 'utf-8')) as MetricsResult
        if (m.expression_score !== null) {
          expSum += m.expression_score
          expN++
        }
        if (m.speech_rate_cpm) {
          rateSum += m.speech_rate_cpm
          rateN++
        }
        pauseSum += m.pauses_gt_1_5s
        fillerSum += m.filler_words?.total ?? 0
        connSum += m.connectives?.count ?? 0
        durSum += m.duration_ratio
      } catch {
        /* 忽略坏文件 */
      }
    }
    const lp = join(sessionRoot, dir, 'llm-score.json')
    if (existsSync(lp)) {
      try {
        const s = JSON.parse(readFileSync(lp, 'utf-8')) as LlmScore
        if (s.content_score !== null) {
          conSum += s.content_score
          conN++
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  const expressionAvg = expN > 0 ? Math.round(expSum / expN) : null
  const contentAvg = conN > 0 ? Math.round(conSum / conN) : null
  const total =
    expressionAvg !== null && contentAvg !== null
      ? Math.round(contentAvg * 0.6 + expressionAvg * 0.4)
      : expressionAvg
  const n = formalDirs.length || 1
  metricAgg.speech_rate_cpm = rateN > 0 ? Math.round(rateSum / rateN) : 0
  metricAgg.pauses_gt_1_5s = Math.round(pauseSum / n)
  metricAgg.filler_words = { total: Math.round(fillerSum / n), top3: [] }
  metricAgg.connectives = { count: Math.round(connSum / n), hits: [] }
  metricAgg.duration_ratio = Math.round((durSum / n) * 1000) / 1000
  return {
    expression_avg: expressionAvg,
    content_avg: contentAvg,
    total_score: total,
    metrics_avg: expN > 0 ? metricAgg : null
  }
}

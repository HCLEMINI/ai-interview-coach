// ============================================================
// IPC 处理器：会话/录制/数据/设置全部通道接线
// 运行时（当前状态机 + 录制服务 + 会话元数据）由本模块持有
// ============================================================
import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { CH } from '../shared/ipcChannels'
import type {
  AckAction,
  CompanyCard,
  GatewayConfig,
  MachineState,
  Question,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  TrendEntry,
  VendorId,
  VendorProfile
} from '../shared/types'
import { VENDOR_PROFILES, FOLLOWUP_QUESTIONS } from '../shared/vendorProfiles'
import { QuestionEndInfo, SessionMachine } from './sessionMachine'
import { RecordingService } from './recordingService'
import { SidecarManager } from './sidecarManager'
import { PostProcessor, aggregateSession } from './postProcess'
import {
  appendTrend,
  createSession,
  listSessions,
  loadQuestionBank,
  loadSessionMeta,
  loadTrends,
  saveSessionMeta,
  saveQuestionBank,
  sessionTimestamp
} from './sessionStore'
import { companyCardsDir, digestDir, gatewayConfigPath, getDataRoot, sessionDir, ttsCacheDir } from './paths'

export interface Runtime {
  machine: SessionMachine | null
  recording: RecordingService
  sidecar: SidecarManager
  postProcessor: PostProcessor
  sessionId: string | null
  sessionRoot: string | null
  meta: SessionMeta | null
  finalizeOnQuit: () => void
}

export function registerIpcHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null
): Runtime {
  const runtime: Runtime = {
    machine: null,
    recording: new RecordingService(() => ({ ok: false, reason: '无进行中的会话' })),
    sidecar: null as unknown as SidecarManager,
    postProcessor: null as unknown as PostProcessor,
    sessionId: null,
    sessionRoot: null,
    meta: null,
    finalizeOnQuit: () => undefined
  }

  const send = (channel: string, payload: unknown): void => {
    getMainWindow()?.webContents.send(channel, payload)
  }

  const emit = (ev: SessionEvent): void => send(CH.SessionEvent, ev)
  const broadcast = (snap: SessionSnapshot): void => send(CH.SessionState, snap)

  // 边车与后处理链
  const sidecar = new SidecarManager()
  const getGateway = (): GatewayConfig | null => {
    try {
      const p = gatewayConfigPath()
      if (!existsSync(p)) return null
      const cfg = JSON.parse(readFileSync(p, 'utf-8')) as GatewayConfig
      return cfg.apiKey ? cfg : null
    } catch {
      return null
    }
  }
  const getWhisperModel = (): string => {
    const m = store.get('whisperModel') as string | undefined
    return m === 'medium' ? 'medium' : 'small'
  }
  const postProcessor = new PostProcessor({
    sidecar,
    getGateway,
    sendProgress: (qDir, stage, error) => send(CH.ProcessingProgress, { qDir, stage, error }),
    getModel: getWhisperModel
  })
  sidecar.onEvent = (ev) => send(CH.SidecarEvent, ev)
  runtime.sidecar = sidecar
  runtime.postProcessor = postProcessor

  const disposeMachine = (): void => {
    if (runtime.machine) {
      for (const d of runtime.recording.activeQDirs()) runtime.recording.forceClose(d)
      runtime.machine.dispose()
      runtime.machine = null
    }
  }

  const saveMeta = (): void => {
    if (runtime.meta) saveSessionMeta(runtime.meta)
  }

  const onQuestionEnd = (info: QuestionEndInfo): void => {
    const meta = runtime.meta
    if (!meta) return
    let rec = meta.questions.find((q) => q.dir === info.dir)
    if (!rec) {
      rec = {
        dir: info.dir,
        questionId: info.question?.id ?? `FOLLOWUP-${info.followupLevel}`,
        type: info.question?.type ?? 'behavioral',
        state: 'pending',
        recordedSec: 0,
        followupLevel: info.followupLevel
      }
      meta.questions.push(rec)
    }
    rec.state = info.zeroed ? 'zeroed' : 'answered'
    rec.recordedSec = Math.round(info.recordedSec * 10) / 10
    rec.followupLevel = info.followupLevel
    saveMeta()
    // 渲染层正常路径会自己 finish；此兜底延迟回收，防止泄漏时占用句柄
    setTimeout(() => runtime.recording.forceClose(info.dir), 15000)

    // 后处理：ASR → 指标 → LLM 评分（练习题只转写与指标）
    const isPractice = info.dir === 'practice'
    const isFollowup = info.dir.startsWith('f')
    const targetSec = isPractice
      ? 60
      : isFollowup
        ? 60
        : (info.question?.answerSec ?? meta.profile_snapshot.answer_sec)
    if (!info.zeroed) {
      runtime.machine?.markProcessingStart()
      void postProcessor
        .enqueue({
          sessionRoot: sessionDir(meta.session_id),
          qDir: info.dir,
          question: info.question,
          targetSec,
          unscored: isPractice
        })
        .then(() => runtime.machine?.markProcessingDone())
    }
    // 追问归属：把层数写回所属正式题的记录
    if (isFollowup && info.ownerDir) {
      const owner = meta.questions.find((q) => q.dir === info.ownerDir)
      if (owner) owner.followupLevel = info.followupLevel
      saveMeta()
    }
    // 练习题答完立即预热 whisper（正式题前模型就绪）
    if (isPractice) {
      sidecar
        .request('asr_preload', {})
        .then(() => {
          send(CH.SidecarEvent, { type: 'whisper-loaded' })
        })
        .catch(() => undefined)
    }
  }

  const onFinish = (): void => {
    if (!runtime.meta) return
    runtime.meta.status = 'completed'
    saveMeta()
  }

  const onReportReady = (): void => {
    try {
      aggregateAndSave()
    } catch (e) {
      console.error('[Report] 汇总落盘失败', e)
    }
  }

  const aggregateAndSave = (): void => {
    const meta = runtime.meta
    if (!meta) return
    const formalDirs = meta.questions
      .filter((q) => /^q\d+$/.test(q.dir) && q.state === 'answered')
      .map((q) => q.dir)
    const agg = aggregateSession(sessionDir(meta.session_id), formalDirs)
    meta.total_score = agg.total_score
    meta.metrics_summary = agg.metrics_avg ? { ...agg } : null
    saveMeta()
    const entry: TrendEntry = {
      session_id: meta.session_id,
      ts: meta.created_at,
      vendor: meta.vendor,
      company: meta.company,
      position: meta.position,
      total_score: agg.total_score,
      expression_avg: agg.expression_avg,
      content_avg: agg.content_avg,
      metrics_avg: agg.metrics_avg,
      question_count: meta.profile_snapshot.question_count,
      abandoned: false
    }
    appendTrend(entry)
    broadcastSnapshot()
    // ★AI 教练总评：全部题转写+指标 → 全场诊断与行动项（异步，落盘后推事件）
    void generateCoachSummary(meta.session_id, formalDirs)
  }

  async function generateCoachSummary(sessionId: string, formalDirs: string[]): Promise<void> {
    const gw = getGateway()
    const root = sessionDir(sessionId)
    if (!gw) return
    try {
      const qa: Array<Record<string, unknown>> = []
      for (const dir of formalDirs) {
        const qPath = join(root, dir)
        const read = (f: string): unknown => {
          try {
            return JSON.parse(readFileSync(join(qPath, f), 'utf-8'))
          } catch {
            return null
          }
        }
        const tp = join(qPath, 'transcript.txt')
        const transcript = existsSync(tp) ? readFileSync(tp, 'utf-8') : ''
        const m = read('metrics.json') as Record<string, unknown> | null
        const meta2 = runtime.meta
        const rec = meta2?.questions.find((x) => x.dir === dir)
        qa.push({
          题: dir,
          题干: rec?.questionId ?? '',
          转写节选: transcript.slice(0, 260),
          语速: m?.speech_rate_cpm ?? null,
          停顿: m?.pauses_gt_1_5s ?? null,
          口头禅: (m?.filler_words as { total?: number } | undefined)?.total ?? null,
          逻辑词: (m?.connectives as { count?: number } | undefined)?.count ?? null,
          时长达成: m?.duration_ratio ?? null
        })
      }
      const trends = loadTrends().sessions.filter((t) => t.total_score !== null)
      const prev = trends.length > 1 ? trends[trends.length - 2] : null
      const curr = trends[trends.length - 1]
      const res = (await sidecar.request('llm', {
        gateway: { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, timeout_sec: Math.min(gw.timeoutSec, 120) },
        system: `你是面试教练。基于逐题数据给全场总评。输出单个JSON：{"overall":"3-5句总评，先说最突出进步或问题，再概括共性","actions":["3条具体可执行的行动，每条带数字目标（如语速降到240以下），结合具体题目举例"]}
规则：直陈问题不客套；引用数据说话；若与上一场对比有变化要点名对比；行动要能在一周内执行。`,
        user: JSON.stringify({ 本场概要: curr, 上一场: prev ?? '（首场）', 逐题: qa }, null, 1).slice(0, 9000),
        json_mode: true,
        temperature: 0.4,
        max_tokens: 1200
      })) as { parsed: { overall?: unknown; actions?: unknown } | null }
      const summary = {
        generated_at: new Date().toISOString(),
        overall: typeof res.parsed?.overall === 'string' ? res.parsed.overall : '',
        actions: Array.isArray(res.parsed?.actions) ? (res.parsed!.actions as unknown[]).map(String) : []
      }
      if (summary.overall) {
        writeFileSync(join(root, 'ai-coach-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
        send('report:summary-ready', { sessionId })
      }
    } catch (e) {
      console.warn('[Coach] 总评生成失败', e)
    }
  }

  const broadcastSnapshot = (): void => {
    const m = runtime.machine
    if (m) broadcast(m.snapshot())
  }

  // ---------- 题单抽取（base + 已启用的 generated 合并） ----------
  const pickQuestions = (vendorId: VendorId, count: number): { practice: Question; formal: Question[] } | { error: string } => {
    const bank = loadQuestionBank('base')
    const gen = loadQuestionBank('generated')
    const all = [...bank.questions, ...gen.questions]
    const practice = all.find((q) => q.type === 'practice' && q.enabled)
    if (!practice) return { error: '题库缺少练习题（QB-000）' }
    const pool = all.filter(
      (q) =>
        q.enabled &&
        q.type !== 'practice' &&
        (q.vendorTags.includes('all') || q.vendorTags.includes(vendorId)) &&
        // 朗读题：智联全开；其余模式只放开标注 all 的朗读题（如英文朗读，对应基础信息测评的中英文朗读）
        (VENDOR_PROFILES[vendorId].readingQuestion || q.type !== 'reading' || q.vendorTags.includes('all'))
    )
    if (pool.length < count) return { error: `题库可用题不足：需要 ${count}，实际 ${pool.length}` }
    // 顺序：自我介绍 → 求职动机 → 其余按稳定伪随机
    const byType = (t: string): Question[] => pool.filter((q) => q.type === t)
    const ordered: Question[] = []
    const intro = byType('intro')[0]
    if (intro) ordered.push(intro)
    const motivation = byType('motivation')
    if (motivation.length) ordered.push(motivation[0]) // 固定"为什么选择该分公司"（QB-002）
    const rest = pool.filter((q) => !ordered.includes(q))
    // 稳定洗牌（seed=session 时间），保证练习题序多样
    let seed = Date.now() % 100000
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j], rest[i]]
    }
    ordered.push(...rest)
    return { practice, formal: ordered.slice(0, count) }
  }

  // ===== 动态追问：等转写 → AI 生成针对性追问（失败/无网关回退固定三问） =====
  const generateDynamicFollowup = async (
    machine: SessionMachine,
    info: { qDir: string; level: number; question: Question | null }
  ): Promise<void> => {
    const fixed = FOLLOWUP_QUESTIONS[Math.min(info.level, 3) - 1]
    const gw = getGateway()
    if (!gw) {
      machine.setDynamicFollowup(fixed)
      return
    }
    try {
      const transcript = await postProcessor.waitForTranscript(info.qDir, 75_000)
      const res = (await sidecar.request('llm', {
        gateway: { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, timeout_sec: Math.min(gw.timeoutSec, 60) },
        system: `你是北森AI面试官的追问引擎（BEI行为事件访谈）。基于考生对原题的作答转写，生成第${info.level}层追问。追问目标按层递进：第1层=逼出具体事例，第2层=逼出本人具体行动，第3层=逼出结果与数据。若转写已含部分信息，就追没讲清的那部分。输出单个JSON：{"question":"追问一句话，25-60字，口语化"}。禁止复述原题；禁止一次问多个问题。`,
        user: JSON.stringify({
          原题: info.question?.text ?? '（行为经历题）',
          层级: info.level,
          作答转写: (transcript ?? '（转写未就绪，按层级通用追问）').slice(0, 2500)
        }),
        json_mode: true,
        temperature: 0.4,
        max_tokens: 600
      })) as { parsed: { question?: unknown } | null }
      const text = res.parsed?.question
      if (machine.state === 'FOLLOWUP_INTRO') {
        machine.setDynamicFollowup(typeof text === 'string' && text.trim().length > 5 ? text.trim() : fixed)
      }
    } catch {
      if (machine.state === 'FOLLOWUP_INTRO') machine.setDynamicFollowup(fixed)
    }
  }

  // ---------- 注册 ----------
  const ipc = ipcMain

  // ===== AI 出题官：单位事实卡 + 摘要 + 弱项趋势 → 定制题单 =====
  async function composeQuestionsByAI(
    cfg: { vendorId: VendorId; company: string; position: string; questionCount: number },
    profile: VendorProfile
  ): Promise<{ practice: Question; formal: Question[] } | null> {
    const gw = getGateway()
    if (!gw) return null
    const bank = loadQuestionBank('base')
    const practice = bank.questions.find((q) => q.type === 'practice' && q.enabled)
    if (!practice) return null

    // 单位事实卡（有则用）
    let cardText = ''
    try {
      const cards = readdirSync(companyCardsDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(companyCardsDir(), f), 'utf-8')) as CompanyCard)
      const card = cards.find((c) => cfg.company && (c.company === cfg.company || cfg.company.includes(c.short)))
      if (card) {
        cardText = `目标单位事实：${card.key_facts.map((f) => f.fact).join('；').slice(0, 600)}`
      }
    } catch {
      /* 无卡片忽略 */
    }

    // 弱项趋势（最近一场）
    let weakText = ''
    const trends = loadTrends().sessions.filter((t) => t.total_score !== null)
    const last = trends[trends.length - 1]
    if (last?.metrics_avg) {
      weakText = `该考生最近一场：总分${last.total_score}、表达${last.expression_avg}、内容${last.content_avg}、语速${last.metrics_avg.speech_rate_cpm ?? '?'}字/分、停顿${last.metrics_avg.pauses_gt_1_5s ?? '?'}次、逻辑词${last.metrics_avg.connectives?.count ?? '?'}个`
    }

    const system = `你是中石油AI面试出题官。根据目标单位事实与考生弱项，出一套有针对性的面试题。输出单个JSON对象：{"questions":[{"type":"motivation|behavioral|situational","text":"题干40-90字","target_keywords":["3个评分关键词"],"answer_sec":120}]}
规则：第一题必须是针对该单位的动机题（题干中点名单位或其业务）；行为题优先针对考生弱项出（如缺少逻辑结构就出需要分点论述的题，如动机题内容薄弱就再出一道单位认知题）；题型 mix 参考真实北森（动机1-2道+行为2-3道+情境0-1道）；题干口语化，像真实面试官提问；不出现考生姓名。`
    const user = JSON.stringify(
      {
        单位: cfg.company,
        岗位: cfg.position,
        模式: profile.label,
        题量: cfg.questionCount,
        单位事实: cardText || '（无事实卡，出通用动机题）',
        考生弱项: weakText || '（首场，出均衡题单）'
      },
      null,
      1
    )
    try {
      const res = (await sidecar.request('llm', {
        gateway: { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, timeout_sec: Math.min(gw.timeoutSec, 90) },
        system,
        user,
        json_mode: true,
        temperature: 0.5,
        max_tokens: 2500
      })) as { parsed: { questions?: Array<Record<string, unknown>> } | null }
      const raw = res.parsed?.questions
      if (!Array.isArray(raw) || raw.length < Math.min(3, cfg.questionCount)) return null
      const formal: Question[] = raw.slice(0, cfg.questionCount).map((x, i) => ({
        id: `AI-${String(i + 1).padStart(2, '0')}`,
        type: (['motivation', 'behavioral', 'situational'].includes(String(x.type))
          ? x.type
          : 'behavioral') as Question['type'],
        text: String(x.text ?? '').slice(0, 300),
        readingPassage: null,
        targetKeywords: Array.isArray(x.target_keywords) ? x.target_keywords.map(String).slice(0, 5) : [],
        answerSec: typeof x.answer_sec === 'number' ? x.answer_sec : profile.answerSec,
        vendorTags: ['all'] as ('all')[],
        source: 'generated' as const,
        digestAnchor: 'AI出题官',
        enabled: true
      })).filter((q) => q.text.length > 10)
      if (formal.length < Math.min(3, cfg.questionCount)) return null
      return { practice, formal }
    } catch {
      return null
    }
  }

  ipc.handle(CH.SessionStart, async (_e, cfg: {
    vendorId: VendorId
    company: string
    position: string
    cameraEnabled: boolean
    questionCount: number
    devFast: boolean
    drill?: 'intro' | 'star' | null
    drillStory?: { title: string; hint?: string } | null
    prepSec?: number // 0/缺省 = 厂商默认（各批次通知不一，30/60 均有）
    answerSec?: number
    aiCompose?: boolean // AI 出题官：按单位+弱项现场组卷（失败回退题库）
  }) => {
    if (runtime.machine && runtime.machine.state !== 'IDLE') {
      return { ok: false, reason: '已有进行中的会话，请先结束' }
    }
    disposeMachine()
    const baseProfile = VENDOR_PROFILES[cfg.vendorId]
    if (!baseProfile) return { ok: false, reason: `未知厂商 ${cfg.vendorId}` }
    const profile: VendorProfile = {
      ...baseProfile,
      prepSec: cfg.prepSec && cfg.prepSec > 0 ? cfg.prepSec : baseProfile.prepSec,
      answerSec: cfg.answerSec && cfg.answerSec > 0 ? cfg.answerSec : baseProfile.answerSec
    }

    // 特训模式：单题直入（自我介绍 90 秒 / STAR 点名），无练习题
    const isDrill = cfg.drill === 'intro' || cfg.drill === 'star'
    let picked: { practice: Question; formal: Question[] } | { error: string }
    if (isDrill) {
      const bank = loadQuestionBank('base')
      if (cfg.drill === 'intro') {
        const intro = bank.questions.find((q) => q.type === 'intro' && q.enabled)
        if (!intro) return { ok: false, reason: '题库缺少自我介绍题' }
        // 2026-11 实测：自我介绍 3 分钟且要素含年龄/自我评价——特训直接用题库真实时长
        picked = {
          practice: intro,
          formal: [intro]
        }
      } else {
        const story = cfg.drillStory
        if (!story?.title) return { ok: false, reason: '未指定 STAR 故事' }
        picked = {
          practice: bank.questions[0],
          formal: [
            {
              id: `STAR-${Date.now() % 100000}`,
              type: 'behavioral',
              text: `请用两分钟完整讲述这段经历（情境—任务—行动—结果都要讲到）：${story.title}${story.hint ? `\n（要点提示：${story.hint}）` : ''}`,
              readingPassage: null,
              targetKeywords: ['情境', '任务', '行动', '结果'],
              answerSec: 120,
              vendorTags: ['all'],
              source: 'base',
              enabled: true
            }
          ]
        }
      }
    } else if (cfg.aiCompose && getGateway()) {
      // ★AI 出题官：单位事实卡 + 弱项趋势 → 现场组卷；失败回退题库
      const fallback = pickQuestions(cfg.vendorId, cfg.questionCount)
      const composed = await composeQuestionsByAI(cfg, profile)
      picked = composed ?? fallback
    } else {
      picked = pickQuestions(cfg.vendorId, cfg.questionCount)
    }
    if ('error' in picked) return { ok: false, reason: picked.error }

    const sessionId = sessionTimestamp()
    runtime.sessionId = sessionId
    runtime.sessionRoot = sessionDir(sessionId)
    const qDirs = isDrill ? picked.formal.map((_, i) => `q${i + 1}`) : ['practice', ...picked.formal.map((_, i) => `q${i + 1}`)]
    runtime.meta = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      vendor: cfg.vendorId,
      company: isDrill ? (cfg.drill === 'intro' ? '自我介绍特训' : 'STAR特训') : cfg.company || '未填写',
      position: cfg.position || '未填写',
      camera: cfg.cameraEnabled,
      status: 'in_progress',
      profile_snapshot: {
        prep_sec: profile.prepSec,
        answer_sec: profile.answerSec,
        question_count: picked.formal.length,
        followup: isDrill ? false : profile.followup
      },
      questions: [
        ...(isDrill
          ? []
          : [{ dir: 'practice', questionId: picked.practice.id, type: 'practice' as const, state: 'pending' as const, recordedSec: 0, followupLevel: 0 }]),
        ...picked.formal.map((q, i) => ({
          dir: `q${i + 1}`,
          questionId: q.id,
          type: q.type,
          state: 'pending' as const,
          recordedSec: 0,
          followupLevel: 0
        }))
      ],
      total_score: null,
      metrics_summary: null,
      abandoned_reason: null
    }
    createSession(runtime.meta, qDirs)

    const machine = new SessionMachine({
      vendor: profile,
      sessionId,
      company: runtime.meta.company,
      position: runtime.meta.position,
      camera: cfg.cameraEnabled,
      practiceQ: picked.practice,
      formalQs: picked.formal,
      devFast: cfg.devFast,
      drill: isDrill,
      emit,
      broadcast,
      onQuestionEnd,
      onFinish,
      onReportReady,
      recordedSecProvider: (qDir) => runtime.recording.getRecordedSec(qDir),
      llmLacks: (dir) => postProcessor.verdict(dir),
      onFollowupGate: (info) => void generateDynamicFollowup(machine, info)
    })
    runtime.machine = machine
    runtime.recording.setGuard((qDir) => machine.canRecord(qDir))
    postProcessor.clearVerdicts()
    sidecar.ensureStarted()
    machine.start()
    return { ok: true, sessionId, snapshot: machine.snapshot() }
  })

  ipc.handle(CH.SessionAck, (_e, action: AckAction) => runtime.machine?.ack(action) ?? { ok: false, reason: '无会话' })
  ipc.handle(CH.SessionSubmitEarly, () => runtime.machine?.submitEarly() ?? { ok: false, reason: '无会话' })
  ipc.handle(CH.SessionAbandonQuestion, (_e, p: { confirm: boolean }) =>
    p?.confirm ? runtime.machine?.abandonQuestion() ?? { ok: false, reason: '无会话' } : { ok: false, reason: '需二次确认' }
  )
  ipc.handle(CH.SessionAbandon, (_e, p: { reason?: string }) => {
    if (!runtime.machine) return { ok: false, reason: '无会话' }
    runtime.machine.abort(p?.reason ?? '用户中止')
    if (runtime.meta) {
      runtime.meta.status = 'abandoned'
      runtime.meta.abandoned_reason = p?.reason ?? '用户中止'
      saveMeta()
    }
    setTimeout(disposeMachine, 3000)
    return { ok: true }
  })

  ipc.handle(CH.RecordingBegin, (_e, p: { qDir: string; withVideo: boolean }) =>
    runtime.sessionRoot ? runtime.recording.begin(runtime.sessionRoot, p.qDir, !!p.withVideo) : { ok: false, reason: '无会话' }
  )
  ipc.handle(CH.RecordingChunk, (_e, p: { qDir: string; track: 'audio' | 'video'; seq: number; data: ArrayBuffer }) =>
    runtime.recording.chunk(p.qDir, p.track, p.seq, p.data)
  )
  ipc.handle(CH.RecordingFinish, (_e, p: { qDir: string }) => runtime.recording.finish(p.qDir))

  ipc.handle(CH.SessionList, () => listSessions())
  ipc.handle(CH.SessionDetail, (_e, p: { sessionId: string }) => {
    const meta = loadSessionMeta(p.sessionId)
    if (!meta) return { ok: false, reason: '会话不存在' }
    const root = sessionDir(p.sessionId)
    const extras: Record<string, { transcript?: string; metrics?: unknown; llmScore?: unknown }> = {}
    for (const rec of meta.questions) {
      const qPath = join(root, rec.dir)
      const entry: { transcript?: string; metrics?: unknown; llmScore?: unknown } = {}
      try {
        const tp = join(qPath, 'transcript.txt')
        if (existsSync(tp)) entry.transcript = readFileSync(tp, 'utf-8')
        const mp = join(qPath, 'metrics.json')
        if (existsSync(mp)) entry.metrics = JSON.parse(readFileSync(mp, 'utf-8'))
        const lp = join(qPath, 'llm-score.json')
        if (existsSync(lp)) entry.llmScore = JSON.parse(readFileSync(lp, 'utf-8'))
      } catch (e) {
        console.warn('[SessionDetail] 读取题产物失败', rec.dir, e)
      }
      extras[rec.dir] = entry
    }
    let coachSummary: { overall: string; actions: string[] } | null = null
    try {
      const sp = join(root, 'ai-coach-summary.json')
      if (existsSync(sp)) coachSummary = JSON.parse(readFileSync(sp, 'utf-8'))
    } catch {
      /* 忽略 */
    }
    return { ok: true, meta, extras, coachSummary }
  })

  // ---------- 数据 ----------
  ipc.handle(CH.DataQuestionBankGet, (_e, p: { file: 'base' | 'generated' }) => loadQuestionBank(p.file))
  ipc.handle(CH.DataQuestionBankUpsert, (_e, p: { file: 'base' | 'generated'; questions: Question[] }) => {
    saveQuestionBank(p.file, { questions: p.questions })
    return { ok: true }
  })

  ipc.handle(CH.DataTrendsGet, () => loadTrends())

  ipc.handle(CH.DataCompanyCardsList, () => {
    const dir = companyCardsDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as CompanyCard)
  })
  ipc.handle(CH.DataCompanyCardsUpsert, (_e, card: CompanyCard) => {
    const dir = companyCardsDir()
    if (!existsSync(dir)) {
      // eslint-disable-next-line
      require('fs').mkdirSync(dir, { recursive: true })
    }
    const slug = card.company.replace(/[\\/:*?"<>|]/g, '_')
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify(card, null, 2), 'utf-8')
    return { ok: true }
  })

  ipc.handle(CH.DataStarStoriesGet, () => {
    const p = join(getDataRoot(), 'star-stories.json')
    if (!existsSync(p)) return { stories: [] }
    return JSON.parse(readFileSync(p, 'utf-8'))
  })
  ipc.handle(CH.DataStarStoriesUpsert, (_e, data: { stories: unknown[] }) => {
    writeFileSync(join(getDataRoot(), 'star-stories.json'), JSON.stringify(data, null, 2), 'utf-8')
    return { ok: true }
  })

  ipc.handle(CH.DataDigestGet, () => {
    const p = join(digestDir(), 'archive-digest.json')
    if (!existsSync(p)) return { missing: true }
    return { missing: false, digest: JSON.parse(readFileSync(p, 'utf-8')) }
  })

  // 摘要构建：主进程一次性 spawn 构建脚本（不占用边车）
  ipc.handle(CH.DigestBuild, () => {
    return new Promise((resolve) => {
      const script = join(app.getAppPath(), 'scripts', 'build-digest.py')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUTF8: '1',
        AICOACH_DATA_ROOT: getDataRoot()
      }
      // eslint-disable-next-line
      const { spawn } = require('child_process') as typeof import('child_process')
      const p = spawn('python', ['-X', 'utf8', script], { windowsHide: true, env })
      let err = ''
      p.stderr.on('data', (c) => {
        err += c.toString()
      })
      p.on('close', (code) => {
        if (code === 0) resolve({ ok: true })
        else resolve({ ok: false, reason: err.slice(-500) || `构建脚本退出码 ${code}` })
      })
      p.on('error', (e) => resolve({ ok: false, reason: e.message }))
    })
  })

  ipc.handle(CH.DigestReview, (_e, p: { reviewed: boolean }) => {
    const path = join(digestDir(), 'archive-digest.json')
    if (!existsSync(path)) return { ok: false, reason: '摘要不存在，请先构建' }
    try {
      const digest = JSON.parse(readFileSync(path, 'utf-8')) as { _meta: Record<string, unknown> }
      digest._meta.reviewed = !!p.reviewed
      writeFileSync(path, JSON.stringify(digest, null, 2), 'utf-8')
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  // 深挖题生成：LLM 基于已审阅的摘要出 8-10 道（合并入 generated.json，保留人工启停状态）
  ipc.handle(CH.QuestionsGenerate, async () => {
    const digestPath = join(digestDir(), 'archive-digest.json')
    if (!existsSync(digestPath)) return { ok: false, reason: '摘要不存在，请先在设置页构建' }
    const digest = JSON.parse(readFileSync(digestPath, 'utf-8')) as {
      _meta: { reviewed?: boolean }
    }
    if (!digest._meta.reviewed) return { ok: false, reason: '摘要尚未人工审阅，请先在设置页确认' }
    const gw = getGateway()
    if (!gw) return { ok: false, reason: '未配置 LLM 网关' }

    const digestObj = JSON.parse(readFileSync(digestPath, 'utf-8')) as Record<string, unknown>
    delete digestObj._meta
    const digestText = JSON.stringify(digestObj, null, 1)
    const system = `你是面试出题官。基于给定的候选人档案摘要，生成 10 道"简历深挖题"：每道题针对摘要中的一个具体事实（项目、经历、论文、成绩、竞赛、实习）做行为事件式追问（BEI 风格），要求候选人用具体情境—任务—行动—结果作答。输出单个 JSON 对象：{"questions":[{"id":"G-01","type":"behavioral|motivation|experience","text":"题干","target_keywords":["关键词1","关键词2","关键词3"],"digest_anchor":"摘要中对应的事实（短语）","answer_sec":120}]}
规则：题干 40-80 字；不出现候选人姓名；不问敏感信息（证件/联系方式）；关键词是评分时应命中的专业词。`
    try {
      const res = (await sidecar.request('llm', {
        gateway: { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, timeout_sec: gw.timeoutSec },
        system,
        user: digestText.slice(0, 12000),
        json_mode: true,
        temperature: 0.4,
        max_tokens: 3600
      })) as { parsed: { questions?: Array<Record<string, unknown>> } | null }
      const raw = res.parsed?.questions
      if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: '模型未返回题目列表' }

      const existing = loadQuestionBank('generated')
      const enabledMap = new Map(existing.questions.map((q) => [q.id, q.enabled]))
      const questions: Question[] = raw.slice(0, 12).map((x, i) => ({
        id: typeof x.id === 'string' && x.id ? x.id : `G-${String(i + 1).padStart(2, '0')}`,
        type: (['behavioral', 'motivation', 'experience'].includes(String(x.type)) ? x.type : 'behavioral') as Question['type'],
        text: String(x.text ?? '').slice(0, 300),
        readingPassage: null,
        targetKeywords: Array.isArray(x.target_keywords) ? x.target_keywords.map(String).slice(0, 5) : [],
        answerSec: typeof x.answer_sec === 'number' ? x.answer_sec : 120,
        vendorTags: ['all'] as ('all' | 'beisen' | 'zhilian' | 'qiancheng')[],
        source: 'generated' as const,
        digestAnchor: typeof x.digest_anchor === 'string' ? x.digest_anchor : null,
        enabled: enabledMap.get(String(x.id)) ?? true
      })).filter((q) => q.text.length > 8)
      saveQuestionBank('generated', { questions })
      return { ok: true, count: questions.length }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---------- 边车代理 ----------
  ipc.handle(CH.TtsGenerate, async (_e, p: { text: string; voice?: string }) => {
    try {
      const r = (await sidecar.request('tts', {
        text: p.text,
        voice: p.voice,
        out_dir: ttsCacheDir()
      })) as { audio_path: string }
      const name = r.audio_path.split(/[\\/]/).pop() ?? ''
      return { ok: true, url: `media://tts/${name}` }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  ipc.handle(CH.AsrPreload, async () => {
    try {
      const r = (await sidecar.request('asr_preload', { model: getWhisperModel() })) as {
        whisper_loaded: boolean
        whisper_model: string | null
      }
      return { ok: r.whisper_loaded, model: r.whisper_model }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  ipc.handle(
    CH.LlmRequest,
    async (
      _e,
      p: { system: string; user: string; jsonMode?: boolean; temperature?: number; maxTokens?: number }
    ) => {
      const gw = getGateway()
      if (!gw) return { ok: false, reason: '未配置网关' }
      try {
        const r = (await sidecar.request('llm', {
          gateway: { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, timeout_sec: gw.timeoutSec },
          system: p.system,
          user: p.user,
          json_mode: p.jsonMode ?? true,
          temperature: p.temperature ?? 0.3,
          max_tokens: p.maxTokens ?? 1500
        })) as { content: string; parsed: unknown }
        return { ok: true, content: r.content, parsed: r.parsed }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipc.handle(CH.SidecarStatus, async () => {
    const base = sidecar.status()
    try {
      const st = (await sidecar.request('status', {}, 8000)) as {
        whisper_loaded: boolean
        whisper_model: string | null
      }
      return { ...base, ...st }
    } catch {
      return { ...base, whisperLoaded: false, model: null }
    }
  })

  // ---------- 设置 ----------
  ipc.handle(CH.SettingsGatewayGet, () => {
    const p = gatewayConfigPath()
    if (!existsSync(p)) {
      return { baseUrl: '', apiKey: '', model: '', timeoutSec: 120 } as GatewayConfig
    }
    return JSON.parse(readFileSync(p, 'utf-8')) as GatewayConfig
  })
  ipc.handle(CH.SettingsGatewaySet, (_e, cfg: GatewayConfig) => {
    writeFileSync(gatewayConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8')
    return { ok: true }
  })

  // ---------- 通用（沿用 MultiChat） ----------
  ipc.handle(CH.StoreGet, (_e, key: string) => store.get(key))
  ipc.handle(CH.StoreSet, (_e, p: { key: string; value: unknown }) => {
    store.set(p.key, p.value)
  })
  ipc.handle(CH.StoreDelete, (_e, key: string) => {
    store.delete(key)
  })
  ipc.handle(CH.OpenPath, (_e, p: { path: string }) => shell.openPath(p.path).then(() => ({ ok: true })))
  ipc.handle(CH.SelectFile, async () => {
    const win = getMainWindow()
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipc.handle(CH.AppGetVersion, () => ({ ok: true, data: app.getVersion() }))

  // 应用退出收尾：关流、释放状态机与边车、进行中的场次标记中止
  runtime.finalizeOnQuit = (): void => {
    for (const d of runtime.recording.activeQDirs()) runtime.recording.forceClose(d)
    runtime.machine?.dispose()
    void sidecar.shutdown()
    if (runtime.meta && runtime.meta.status === 'in_progress') {
      runtime.meta.status = 'abandoned'
      runtime.meta.abandoned_reason = '应用退出'
      saveMeta()
    }
  }

  return runtime
}

export type { MachineState }

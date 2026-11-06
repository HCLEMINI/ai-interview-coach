// ============================================================
// 面试流程状态机（主进程权威，渲染层只展示）
// 计时用 deadline 差值法（抗系统睡眠）；所有推进类调用先做状态校验
// 纪律铁则：ANSWERING 无暂停无重录；到时强停；放弃计零
// ============================================================
import type {
  AckAction,
  MachineState,
  Question,
  SessionEvent,
  SessionSnapshot,
  SnapshotQuestion,
  VendorProfile
} from '../shared/types'
import { FOLLOWUP_QUESTIONS } from '../shared/vendorProfiles'

const PRACTICE_ANSWER_SEC = 60
const FOLLOWUP_PREP_SEC = 5
const BEEP_SEC = 1 // 提示音窗口（渲染层播 0.8s 音）
const PRECHECK_SEC = 3
const DEVICE_CHECK_TIMEOUT_SEC = 30
const ZEROED_PAUSE_SEC = 2

export interface QuestionEndInfo {
  dir: string
  question: Question | null // 追问层为 null（话术固定）
  recordedSec: number
  zeroed: boolean
  followupLevel: number
  ownerDir?: string // 追问层所属正式题（如 q2）
}

export interface MachineDeps {
  vendor: VendorProfile
  sessionId: string
  company: string
  position: string
  camera: boolean
  practiceQ: Question
  formalQs: Question[]
  devFast: boolean
  /** 特训模式：跳过核身与自检，直接进入唯一一题，不触发追问 */
  drill?: boolean
  /** 推送事件到渲染层 */
  emit: (ev: SessionEvent) => void
  /** 推送状态机快照到渲染层 */
  broadcast: (snap: SessionSnapshot) => void
  /** 每题收尾（answered/zeroed 均回调；追问层也有） */
  onQuestionEnd: (info: QuestionEndInfo) => void
  /** 全场结束（全部题落盘后） */
  onFinish: (answeredDirs: string[]) => void
  /** 全部异步处理完成、报告就绪时回调（汇总出分时机） */
  onReportReady?: (sessionId: string) => void
  /** 追问门触发时回调（AI 生成针对性追问；无实现则用固定三问） */
  onFollowupGate?: (info: { qDir: string; level: number; question: Question | null }) => void
  /** 从录制服务取实际录制秒数 */
  recordedSecProvider: (qDir: string) => number
  /** P2 起接入：LLM 追问判定；缺省只按时长判定 */
  llmLacks?: (dir: string) => { lacks_example: boolean; lacks_action: boolean; lacks_result: boolean } | null
}

export class SessionMachine {
  private d: MachineDeps
  private _state: MachineState = 'IDLE'
  private qIndex = 0 // 0=练习题；1..N=正式题
  private followupLevel = 0 // 当前题追问层数
  private deadline = 0
  private phaseTotal = 0
  private phaseTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private zeroedThisQuestion = false
  private answeredDirs: string[] = []
  private pendingProcessing = 0
  private lastFollowupShortfall = false
  private dynamicFollowup: string | null = null

  constructor(deps: MachineDeps) {
    this.d = deps
  }

  // ---------- 缩放（快速调试模式） ----------
  private scale(sec: number, fastCap: number): number {
    return this.d.devFast ? Math.min(sec, fastCap) : sec
  }

  get state(): MachineState {
    return this._state
  }

  get currentQDir(): string {
    if (this.qIndex === 0) return 'practice'
    if (this.followupLevel > 0) return `f${this.followupLevel}`
    return `q${this.qIndex}`
  }

  private currentQuestion(): Question | null {
    if (this.qIndex === 0) return this.d.practiceQ
    if (this.followupLevel > 0) return null
    return this.d.formalQs[this.qIndex - 1] ?? null
  }

  private snapshotQuestion(): SnapshotQuestion | null {
    const q = this.currentQuestion()
    if (q) {
      return { dir: this.currentQDir, id: q.id, type: q.type, text: q.text, readingPassage: q.readingPassage ?? null }
    }
    if (this.followupLevel > 0) {
      return {
        dir: this.currentQDir,
        id: `FOLLOWUP-${this.followupLevel}`,
        type: 'behavioral',
        text: this.dynamicFollowup ?? FOLLOWUP_QUESTIONS[Math.min(this.followupLevel, 3) - 1]
      }
    }
    return null
  }

  /** AI 追问文本就绪后注入（未就绪时快照 followupReady=false，界面显示生成中） */
  setDynamicFollowup(text: string): void {
    this.dynamicFollowup = text
    this.d.broadcast(this.snapshot())
  }

  private triggerFollowup(): void {
    this.followupLevel += 1
    this.dynamicFollowup = null
    this.d.emit({ type: 'followup-triggered', level: this.followupLevel })
    this.d.onFollowupGate?.({
      qDir: `q${this.qIndex}`,
      level: this.followupLevel,
      question: this.currentQuestion()
    })
    this.setState('FOLLOWUP_INTRO')
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.d.sessionId,
      state: this._state,
      vendorId: this.d.vendor.id,
      vendorLabel: this.d.vendor.label,
      company: this.d.company,
      position: this.d.position,
      qIndex: this.qIndex,
      qTotal: this.d.formalQs.length,
      followupLevel: this.followupLevel,
      followupReady: this.followupLevel === 0 || this.dynamicFollowup !== null,
      remainingSec: Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)),
      phaseTotalSec: this.phaseTotal,
      question: this.snapshotQuestion(),
      unscored: this.qIndex === 0
    }
  }

  // ---------- 计时 ----------
  private setState(s: MachineState, phaseSec?: number, onTimeout?: () => void): void {
    this.clearTimers()
    this._state = s
    if (phaseSec !== undefined && onTimeout) {
      this.phaseTotal = phaseSec
      this.deadline = Date.now() + phaseSec * 1000
      this.phaseTimer = setTimeout(() => {
        if (this._state === s) onTimeout()
      }, phaseSec * 1000 + 50)
      this.tickTimer = setInterval(() => {
        if (this._state !== s) return
        // tick 随快照的 remainingSec 走；此处只负责周期推送
        this.d.broadcast(this.snapshot())
      }, 1000)
    } else {
      this.phaseTotal = 0
      this.deadline = 0
    }
    this.d.broadcast(this.snapshot())
  }

  private clearTimers(): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.phaseTimer = null
    this.tickTimer = null
  }

  // ---------- 生命周期 ----------
  start(): void {
    if (this.d.drill) {
      this.qIndex = 1
      this.followupLevel = 0
      this.setState('QUESTION_INTRO')
      return
    }
    this.setState('PRECHECK', this.scale(PRECHECK_SEC, 2), () => this.enterDeviceCheck())
  }

  private enterDeviceCheck(): void {
    this.setState('DEVICE_CHECK', DEVICE_CHECK_TIMEOUT_SEC, () =>
      this.abort('设备自检超时')
    )
  }

  ack(action: AckAction): { ok: boolean; reason?: string } {
    switch (action) {
      case 'device-ok':
        if (this._state !== 'DEVICE_CHECK') return this.reject()
        this.enterPracticeIntro()
        return { ok: true }
      case 'device-fail':
        if (this._state !== 'DEVICE_CHECK') return this.reject()
        this.abort('设备自检失败')
        return { ok: true }
      case 'tts-played':
        if (this._state === 'PRACTICE_INTRO' || this._state === 'QUESTION_INTRO') {
          this.enterPreparing(this._state === 'PRACTICE_INTRO')
          return { ok: true }
        }
        if (this._state === 'FOLLOWUP_INTRO') {
          this.setState('FOLLOWUP_PREP', this.scale(FOLLOWUP_PREP_SEC, 3), () => this.enterBeep(false))
          return { ok: true }
        }
        return this.reject()
      case 'begin-answer':
        if (this._state !== 'PREPARING' || !this.d.vendor.skippablePrep) return this.reject()
        this.enterBeep(this.qIndex === 0)
        return { ok: true }
      case 'next-question':
        if (this._state === 'QUESTION_END') {
          this.afterQuestionEnd()
          return { ok: true }
        }
        if (this._state === 'FOLLOWUP_END') {
          this.afterFollowupEnd()
          return { ok: true }
        }
        if (this._state === 'QUESTION_ZEROED') {
          this.advanceToNextQuestion()
          return { ok: true }
        }
        return this.reject()
      case 'close-report':
        if (this._state === 'REPORT_READY') {
          this.setState('IDLE')
          return { ok: true }
        }
        return this.reject()
      default:
        return this.reject()
    }
  }

  private reject(): { ok: boolean; reason: string } {
    return { ok: false, reason: `当前状态 ${this._state} 不接受该操作` }
  }

  // ---------- 练习/正式题推进 ----------
  private enterPracticeIntro(): void {
    this.qIndex = 0
    this.followupLevel = 0
    this.zeroedThisQuestion = false
    this.setState('PRACTICE_INTRO')
  }

  private enterPreparing(isPractice: boolean): void {
    const prep = isPractice
      ? this.scale(Math.min(this.d.vendor.prepSec, 30), 5)
      : this.scale(this.d.vendor.prepSec, 5)
    this.setState('PREPARING', prep, () => this.enterBeep(isPractice))
  }

  private enterBeep(isPractice: boolean): void {
    this.setState('BEEP', 1, () => this.enterAnswering(isPractice))
    this.d.emit({ type: 'beep-now' })
  }

  private enterAnswering(isPractice: boolean): void {
    const q = this.currentQuestion()
    const baseSec = isPractice
      ? PRACTICE_ANSWER_SEC
      : this.followupLevel > 0
        ? this.d.vendor.followupAnswerSec
        : (q?.answerSec ?? this.d.vendor.answerSec)
    const sec = this.followupLevel > 0 ? this.scale(baseSec, 15) : this.scale(baseSec, 20)
    const state: MachineState = this.followupLevel > 0 ? 'FOLLOWUP_ANSWERING' : 'ANSWERING'
    this.setState(state, sec, () => this.autoStopAnswer())
    this.d.emit({ type: 'answer-window', qDir: this.currentQDir, answerSec: sec })
  }

  private autoStopAnswer(): void {
    const qDir = this.currentQDir
    this.d.emit({ type: 'auto-stopped', qDir })
    this.endAnswer(false)
  }

  submitEarly(): { ok: boolean; reason?: string } {
    if (this._state !== 'ANSWERING' && this._state !== 'FOLLOWUP_ANSWERING') {
      return this.reject()
    }
    this.d.emit({ type: 'window-closed', qDir: this.currentQDir })
    this.endAnswer(false)
    return { ok: true }
  }

  abandonQuestion(): { ok: boolean; reason?: string } {
    if (this._state !== 'ANSWERING' && this._state !== 'FOLLOWUP_ANSWERING') {
      return this.reject()
    }
    this.d.emit({ type: 'window-closed', qDir: this.currentQDir })
    this.endAnswer(true)
    return { ok: true }
  }

  private endAnswer(zeroed: boolean): void {
    const qDir = this.currentQDir
    const recordedSec = this.d.recordedSecProvider(qDir)
    const isPractice = this.qIndex === 0

    this.fireQuestionEnd(qDir, recordedSec, zeroed)

    if (this.followupLevel > 0) {
      if (zeroed) {
        // 放弃追问：与放弃正式题同路径，缓冲后直接下一题
        this.setState('QUESTION_ZEROED', ZEROED_PAUSE_SEC, () => this.advanceToNextQuestion())
        return
      }
      // 追问层收尾：时长不足 70% 或 LLM 判缺才追下一层
      const targetSec = this.scale(this.d.vendor.followupAnswerSec, 15)
      this.lastFollowupShortfall = recordedSec < targetSec * 0.7
      this.setState('FOLLOWUP_END')
      return
    }

    if (zeroed) {
      this.setState('QUESTION_ZEROED', ZEROED_PAUSE_SEC, () => this.advanceToNextQuestion())
      return
    }

    if (isPractice) {
      this.setState('QUESTION_END')
      return
    }

    // 正式题统一走 QUESTION_END；追问判定在 ack next-question 后内联进行
    this.setState('QUESTION_END')
  }

  /** QUESTION_END + ack next-question 后：北森走追问判定，其余进下一题；练习题与特训永不追问 */
  private afterQuestionEnd(): void {
    if (this.qIndex === 0 || !this.d.vendor.followup || this.d.drill) {
      this.advanceToNextQuestion()
      return
    }
    const rec = this.d.formalQs[this.qIndex - 1]
    const targetSec = this.scale(rec?.answerSec ?? this.d.vendor.answerSec, 20)
    const qDir = `q${this.qIndex}`
    const recorded = this.lastRecordedSec[qDir] ?? 0
    const llm = this.d.llmLacks?.(qDir) ?? null
    const shortDuration = recorded < targetSec * 0.7
    const lacks = llm ? llm.lacks_example || llm.lacks_action || llm.lacks_result : false
    if (shortDuration || lacks) {
      this.zeroedThisQuestion = false
      this.triggerFollowup()
    } else {
      this.advanceToNextQuestion()
    }
  }

  /** FOLLOWUP_END + ack 后：仍缺且未满三层 → 下一层；否则本题结束 */
  private afterFollowupEnd(): void {
    const llm = this.d.llmLacks?.(this.currentQDir) // f<level> 也查（P3 接入后生效）
    const lacksNow = llm ? llm.lacks_example || llm.lacks_action || llm.lacks_result : false
    // 时长缺口或 LLM 判缺任一为真即继续追问
    const shouldContinue = this.lastFollowupShortfall || lacksNow
    if (shouldContinue && this.followupLevel < 3) {
      this.triggerFollowup()
    } else {
      this.advanceToNextQuestion()
    }
  }

  private advanceToNextQuestion(): void {
    if (this.qIndex >= this.d.formalQs.length) {
      this.enterFinished()
      return
    }
    this.qIndex += 1
    this.followupLevel = 0
    this.zeroedThisQuestion = false
    this.setState('QUESTION_INTRO')
  }

  private enterFinished(): void {
    this.setState('FINISHED')
    this.d.onFinish(this.answeredDirs)
    // 异步处理全部完成 → REPORT_READY（无待处理任务则立即）
    this.tryReportReady()
  }

  markProcessingStart(): void {
    this.pendingProcessing += 1
  }

  markProcessingDone(): void {
    this.pendingProcessing = Math.max(0, this.pendingProcessing - 1)
    this.tryReportReady()
  }

  private tryReportReady(): void {
    if (this._state === 'FINISHED' && this.pendingProcessing === 0) {
      this.setState('REPORT_READY')
      this.d.onReportReady?.(this.d.sessionId)
      this.d.emit({ type: 'finished', sessionId: this.d.sessionId })
    }
  }

  // ---------- 整场中止 ----------
  abort(reason: string): void {
    if (this._state === 'ANSWERING' || this._state === 'FOLLOWUP_ANSWERING') {
      this.d.emit({ type: 'window-closed', qDir: this.currentQDir })
      this.fireQuestionEnd(this.currentQDir, this.d.recordedSecProvider(this.currentQDir), true)
    }
    this.d.emit({ type: 'finished', sessionId: this.d.sessionId }) // 渲染层据此退出面试页
    this.setState('ABORTED', 2, () => this.setState('IDLE'))
    this.abortedReason = reason
  }

  abortedReason: string | null = null

  // ---------- 录制纪律裁决（供 RecordingService 注入） ----------
  canRecord(qDir: string): { ok: boolean; reason?: string } {
    if (this._state !== 'ANSWERING' && this._state !== 'FOLLOWUP_ANSWERING') {
      return { ok: false, reason: `状态 ${this._state} 不允许录制（纪律：只在作答窗口可录）` }
    }
    if (qDir !== this.currentQDir) {
      return { ok: false, reason: `当前作答题 ${this.currentQDir}，拒绝 ${qDir}` }
    }
    return { ok: true }
  }

  // ---------- 收尾上报 ----------
  private lastRecordedSec: Record<string, number> = {}

  private fireQuestionEnd(qDir: string, recordedSec: number, zeroed: boolean): void {
    this.lastRecordedSec[qDir] = recordedSec
    if (!zeroed) this.answeredDirs.push(qDir)
    this.d.onQuestionEnd({
      dir: qDir,
      question: this.currentQuestion(),
      recordedSec,
      zeroed,
      followupLevel: this.followupLevel,
      ownerDir: this.followupLevel > 0 ? `q${this.qIndex}` : undefined
    })
  }

  dispose(): void {
    this.clearTimers()
  }
}

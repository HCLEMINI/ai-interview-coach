// ============================================================
// 全项目数据结构唯一来源（主进程 / preload / 渲染层共用）
// ============================================================

export type VendorId = 'beisen' | 'zhilian' | 'qiancheng'

export type QuestionType =
  | 'intro' // 自我介绍
  | 'motivation' // 求职动机（为什么选择该分公司）
  | 'behavioral' // 行为经历题（STAR）
  | 'situational' // 情境判断题
  | 'reading' // 文段朗读题（智联）
  | 'english' // 英语题
  | 'experience' // 行为经历类（基础信息测评风格）
  | 'practice' // 练习题（不计分）

// ---------- 厂商模式参数 ----------
export interface VendorProfile {
  id: VendorId
  label: string
  prepSec: number // 准备倒计时秒数
  answerSec: number // 作答倒计时秒数
  followup: boolean // 是否启用追问（北森）
  followupAnswerSec: number
  skippablePrep: boolean // 准备阶段可否手动开始作答（前程无忧）
  readingQuestion: boolean // 题单是否含朗读题
}

// ---------- 题库 ----------
export interface Question {
  id: string // QB-001
  type: QuestionType
  text: string
  readingPassage?: string | null // 仅朗读题：朗读原文
  readingLang?: 'zh' | 'en' // 朗读文段语言（默认 zh）；en 按词级准确率评分
  targetKeywords: string[]
  answerSec?: number | null // 覆盖厂商默认作答时长
  vendorTags: ('all' | VendorId)[]
  starHint?: string | null
  source: 'base' | 'generated'
  digestAnchor?: string | null
  enabled: boolean
}

export interface QuestionBankFile {
  questions: Question[]
}

// ---------- 会话 ----------
export type SessionStatus = 'in_progress' | 'completed' | 'abandoned'

export interface SessionQuestionRecord {
  dir: string // practice | q1..qN | f1..f3
  questionId: string
  type: QuestionType
  state: 'answered' | 'zeroed' | 'pending'
  recordedSec: number
  followupLevel: number // 本题实际触发的追问层数
}

export interface SessionMeta {
  session_id: string
  created_at: string // ISO
  vendor: VendorId
  company: string
  position: string
  camera: boolean
  status: SessionStatus
  profile_snapshot: {
    prep_sec: number
    answer_sec: number
    question_count: number
    followup: boolean
  }
  questions: SessionQuestionRecord[]
  total_score: number | null
  metrics_summary: Record<string, unknown> | null
  abandoned_reason: string | null
}

// ---------- 状态机 ----------
export type MachineState =
  | 'IDLE'
  | 'PRECHECK'
  | 'DEVICE_CHECK'
  | 'PRACTICE_INTRO'
  | 'PRACTICE_PREP'
  | 'QUESTION_INTRO'
  | 'PREPARING'
  | 'BEEP'
  | 'ANSWERING'
  | 'QUESTION_END'
  | 'QUESTION_ZEROED'
  | 'FOLLOWUP_GATE'
  | 'FOLLOWUP_INTRO'
  | 'FOLLOWUP_PREP'
  | 'FOLLOWUP_ANSWERING'
  | 'FOLLOWUP_END'
  | 'FINISHED'
  | 'REPORT_READY'
  | 'ABORTED'

export interface SnapshotQuestion {
  dir: string
  id: string
  type: QuestionType
  text: string
  readingPassage?: string | null
}

export interface SessionSnapshot {
  sessionId: string | null
  state: MachineState
  vendorId: VendorId | null
  vendorLabel: string
  company: string | null
  position: string | null
  qIndex: number // 当前正式题序号（1 起，0=练习/未开始）
  qTotal: number
  followupLevel: number // 0=非追问
  followupReady: boolean // 动态追问文本就绪（false=AI 生成中）
  remainingSec: number
  phaseTotalSec: number
  question: SnapshotQuestion | null
  unscored: boolean // 练习题
}

export type SessionEvent =
  | { type: 'answer-window'; qDir: string; answerSec: number } // 渲染层此刻开始录制
  | { type: 'auto-stopped'; qDir: string } // 到时强停
  | { type: 'beep-now' }
  | { type: 'followup-triggered'; level: number }
  | { type: 'zeroed'; qDir: string }
  | { type: 'finished'; sessionId: string }
  | { type: 'window-closed'; qDir: string } // 录制窗口关闭（渲染层应立即停录）

export type AckAction =
  | 'device-ok'
  | 'device-fail'
  | 'tts-played'
  | 'next-question'
  | 'begin-answer' // 仅前程无忧 PREPARING 可点
  | 'close-report'

// ---------- 录制 ----------
export interface RecordingBeginResult {
  ok: boolean
  reason?: string
}

export interface RecordingFinishResult {
  ok: boolean
  bytes: number
  recordedSec: number
}

// ---------- 表达层指标 ----------
export interface MetricsResult {
  q_dir: string
  audio_duration_s: number
  speech_duration_s: number
  char_count: number
  speech_rate_cpm: number
  rate_pass: boolean
  pauses_gt_1_5s: number
  pause_limit: number
  pause_pass: boolean
  filler_words: { total: number; top3: { word: string; count: number }[] }
  connectives: { count: number; hits: string[] }
  duration_ratio: number
  duration_pass: boolean
  ending_rms_ratio: number | null
  ending_pass: boolean | null
  reading_char_accuracy: number | null
  expression_score: number | null
  error?: string // 指标计算失败原因（音频太短等）
}

// ---------- LLM 评分 ----------
export interface LlmScore {
  q_dir: string
  model: string
  scored_at: string
  star: { situation: number; task: number; action: number; result: number; total: number } | null
  keyword_hits: { hit: string[]; miss: string[] } | null
  personal_experience: { count: number; matched: string[] } | null
  company_facts: { count: number; facts: string[] } | null
  sentence_comments: { quote: string; comment: string; severity: 'info' | 'warn' | 'danger' }[]
  redline: {
    triggered: boolean
    items: { type: string; quote: string; replacement: string }[]
  } | null
  followup_verdict: { lacks_example: boolean; lacks_action: boolean; lacks_result: boolean } | null
  content_score: number | null
  overall: number | null
  fallback_raw?: string // JSON 解析失败时的原始返回
  error?: string
}

// ---------- 趋势 ----------
export interface TrendEntry {
  session_id: string
  ts: string
  vendor: VendorId
  company: string
  position: string
  total_score: number | null
  expression_avg: number | null
  content_avg: number | null
  metrics_avg: Partial<MetricsResult> | null
  question_count: number
  abandoned: boolean
}

// ---------- 分公司事实卡 ----------
export interface CompanyCard {
  company: string
  short: string
  parent: string
  business_focus: string[]
  key_facts: { fact: string; note?: string }[]
  common_positions: string[]
  interview_tips: string[]
  updated_at: string
}

// ---------- 网关配置 ----------
export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutSec: number
}

// ---------- 边车 ----------
export interface SidecarStatus {
  alive: boolean
  whisperLoaded: boolean
  model: string | null
  restartCount: number
}

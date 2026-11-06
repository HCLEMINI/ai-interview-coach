import type { VendorId, VendorProfile } from './types'

// 三家厂商模式参数（据 2026-10 调研冻结；前程无忧参数可配置）
export const VENDOR_PROFILES: Record<VendorId, VendorProfile> = {
  beisen: {
    id: 'beisen',
    label: '北森 AI 面试官',
    prepSec: 30,
    answerSec: 120,
    followup: true,
    followupAnswerSec: 60,
    skippablePrep: false,
    readingQuestion: false
  },
  zhilian: {
    id: 'zhilian',
    label: '智联 AI 易面',
    prepSec: 60,
    answerSec: 180,
    followup: false,
    followupAnswerSec: 60,
    skippablePrep: false,
    readingQuestion: true
  },
  qiancheng: {
    id: 'qiancheng',
    label: '前程无忧',
    prepSec: 30,
    answerSec: 120,
    followup: false,
    followupAnswerSec: 60,
    skippablePrep: true,
    readingQuestion: false
  }
}

// 追问三层固定话术（北森三层递进）
export const FOLLOWUP_QUESTIONS = [
  '能举一个具体的例子吗？',
  '在这件事里你个人具体做了什么？',
  '最后的结果如何？有数据吗？'
] as const

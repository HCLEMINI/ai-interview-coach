import { useState } from 'react'
import type { VendorId } from '../../../shared/types'
import { VENDOR_PROFILES } from '../../../shared/vendorProfiles'
import { useUIStore } from '../store/sessionStore'

export default function SetupPage(): JSX.Element {
  const setPage = useUIStore((s) => s.setPage)
  const showToast = useUIStore((s) => s.showToast)
  const [vendorId, setVendorId] = useState<VendorId>('beisen')
  const [company, setCompany] = useState('某油田分公司')
  const [position, setPosition] = useState('油气田工程技术')
  const [questionCount, setQuestionCount] = useState(4)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [devFast, setDevFast] = useState(false)
  const [prepSec, setPrepSec] = useState(0) // 0 = 厂商默认（各批次通知不一，30/60 秒均有）
  const [answerSec, setAnswerSec] = useState(0)
  const [aiCompose, setAiCompose] = useState(true)
  const [coachMode, setCoachMode] = useState(false)
  const [starting, setStarting] = useState(false)

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      const res = await window.api.sessionStart({
        vendorId,
        company,
        position,
        cameraEnabled,
        questionCount,
        devFast,
        prepSec,
        answerSec,
        aiCompose
      })
      if (res.ok) {
        useUIStore.getState().setSessionCfg({ cameraEnabled, coachMode })
        setPage('interview')
      } else {
        showToast(`无法开始：${res.reason ?? '未知错误'}`)
      }
    } finally {
      setStarting(false)
    }
  }

  const profile = VENDOR_PROFILES[vendorId]

  return (
    <div className="max-w-3xl mx-auto py-8 px-6">
      <h1 className="text-2xl font-bold mb-6">模拟配置</h1>

      <div className="card p-5 mb-5">
        <h2 className="font-semibold mb-3">选择面试平台模式</h2>
        <div className="grid grid-cols-3 gap-3">
          {(Object.keys(VENDOR_PROFILES) as VendorId[]).map((vid) => {
            const p = VENDOR_PROFILES[vid]
            const active = vendorId === vid
            return (
              <button
                key={vid}
                onClick={() => setVendorId(vid)}
                className={`p-4 rounded-xl border-2 text-left transition-colors ${
                  active ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-blue-300'
                }`}
              >
                <div className="font-semibold">{p.label}</div>
                <div className="text-xs text-gray-500 mt-1">
                  准备 {p.prepSec}s / 作答 {p.answerSec}s
                </div>
                <div className="text-xs text-gray-500">
                  {p.followup ? '含三层追问' : p.readingQuestion ? '含朗读题' : '标准流程'}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="card p-5 mb-5 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">目标单位</label>
          <input className="input-box" value={company} onChange={(e) => setCompany(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">岗位</label>
          <input className="input-box" value={position} onChange={(e) => setPosition(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">正式题量</label>
          <select
            className="input-box"
            value={questionCount}
            onChange={(e) => setQuestionCount(Number(e.target.value))}
          >
            {[3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} 题
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">思考时长（通知不一，按收到邮件为准）</label>
          <select className="input-box" value={prepSec} onChange={(e) => setPrepSec(Number(e.target.value))}>
            <option value={0}>厂商默认（{profile.prepSec} 秒）</option>
            <option value={30}>30 秒</option>
            <option value={60}>60 秒</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">作答时长</label>
          <select className="input-box" value={answerSec} onChange={(e) => setAnswerSec(Number(e.target.value))}>
            <option value={0}>厂商默认（{profile.answerSec} 秒）</option>
            <option value={90}>90 秒</option>
            <option value={120}>120 秒</option>
            <option value={180}>180 秒</option>
          </select>
        </div>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cameraEnabled} onChange={(e) => setCameraEnabled(e.target.checked)} />
            开启摄像头（可模拟正脸核身）
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={aiCompose} onChange={(e) => setAiCompose(e.target.checked)} />
            AI 出题官（按单位与弱项现场组卷）
          </label>
          <label className="flex items-center gap-2 text-sm text-amber-700">
            <input type="checkbox" checked={coachMode} onChange={(e) => setCoachMode(e.target.checked)} />
            教练提示（准备阶段显示提纲，真实考试无此辅助）
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-500">
            <input type="checkbox" checked={devFast} onChange={(e) => setDevFast(e.target.checked)} />
            快速模式（调试用，倒计时缩短）
          </label>
        </div>
      </div>

      <div className="card p-5 mb-6 text-sm text-gray-600">
        <div className="font-semibold text-gray-800 mb-2">本场配置</div>
        {profile.label} · 练习 1 题 + 正式 {questionCount} 题 ·
        每题准备 {profile.prepSec}s、作答 {profile.answerSec}s
        {profile.followup ? ' · 答不足将触发三层追问' : ''}
        {devFast ? '（快速模式：倒计时已缩短）' : ''}
      </div>

      <div className="flex gap-4">
        <button className="btn-secondary" onClick={() => setPage('home')}>
          返回
        </button>
        <button className="btn-primary px-8" disabled={starting} onClick={() => void start()}>
          {starting ? '正在创建…' : '开始面试'}
        </button>
      </div>
    </div>
  )
}

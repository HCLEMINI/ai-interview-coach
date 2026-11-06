import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../../shared/types'
import { useUIStore } from '../store/sessionStore'

interface StarStory {
  id: string
  title: string
  hint?: string
}

export default function HomePage(): JSX.Element {
  const setPage = useUIStore((s) => s.setPage)
  const setReportSessionId = useUIStore((s) => s.setReportSessionId)
  const showToast = useUIStore((s) => s.showToast)
  const [recent, setRecent] = useState<SessionMeta[]>([])
  const [stories, setStories] = useState<StarStory[]>([])
  const [pickStar, setPickStar] = useState(false)

  useEffect(() => {
    window.api.sessionList().then((list) => setRecent(list.slice(0, 6)))
    window.api.starStoriesGet().then((s) => setStories(((s.stories as StarStory[]) ?? []).filter((x) => x.title)))
  }, [])

  const startDrill = async (drill: 'intro' | 'star', story?: StarStory): Promise<void> => {
    const r = await window.api.sessionStart({
      vendorId: 'beisen',
      company: drill === 'intro' ? '自我介绍特训' : 'STAR特训',
      position: '—',
      cameraEnabled: false,
      questionCount: 1,
      devFast: false,
      drill,
      drillStory: drill === 'star' ? { title: story?.title ?? '', hint: story?.hint } : null
    })
    if (r.ok) {
      useUIStore.getState().setSessionCfg({ cameraEnabled: false })
      setPage('interview')
    } else {
      showToast(`无法开始：${r.reason ?? '未知错误'}`)
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <h1 className="text-3xl font-bold mb-2">AI 面试模拟舱</h1>
      <p className="text-gray-500 mb-8">
        复刻智联 AI 易面 / 北森 AI 面试官 / 前程无忧三家录制式 AI 面试流程。
        纪律铁则：作答只录一次、不可回看、答满时长。
      </p>

      <div className="card p-6 mb-6">
        <div className="flex gap-4 flex-wrap">
          <button className="btn-primary text-lg px-8 py-3" onClick={() => setPage('setup')}>
            开始模拟面试
          </button>
          <button className="btn-secondary text-lg px-6 py-3" onClick={() => void startDrill('intro')}>
            自我介绍特训（90 秒）
          </button>
          <button className="btn-secondary text-lg px-6 py-3" onClick={() => setPickStar(true)}>
            STAR 故事特训
          </button>
          <button className="btn-secondary text-lg px-6 py-3" onClick={() => setPage('library')}>
            题库与素材
          </button>
        </div>
        <p className="text-sm text-gray-400 mt-3">
          完整流程：正脸核身 → 设备自检 → 练习题 → 正式题（准备倒计时 → 提示音 → 一次性录制）
        </p>
      </div>

      {pickStar && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="card p-6 max-w-lg mx-4 w-full">
            <h3 className="font-semibold text-lg mb-3">选择要练的 STAR 故事</h3>
            {stories.length === 0 ? (
              <p className="text-gray-500 text-sm mb-4">
                还没有登记故事。到「题库与素材 → STAR 故事」先把九个故事录进来。
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-2 mb-4">
                {stories.map((s) => (
                  <button
                    key={s.id}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 text-sm"
                    onClick={() => {
                      setPickStar(false)
                      void startDrill('star', s)
                    }}
                  >
                    {s.title}
                    {s.hint && <div className="text-xs text-gray-400 mt-0.5">{s.hint}</div>}
                  </button>
                ))}
              </div>
            )}
            <div className="text-right">
              <button className="btn-secondary" onClick={() => setPickStar(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card p-6">
        <h2 className="font-semibold text-lg mb-3">最近场次</h2>
        {recent.length === 0 ? (
          <p className="text-gray-400">还没有场次记录，先来一场。</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1.5">场次</th>
                <th>模式</th>
                <th>单位</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.session_id} className="border-t border-gray-100">
                  <td className="py-2 font-mono">{m.session_id}</td>
                  <td>{m.vendor === 'beisen' ? '北森' : m.vendor === 'zhilian' ? '智联' : '前程无忧'}</td>
                  <td>{m.company}</td>
                  <td>
                    {m.status === 'completed' ? (
                      <span className="text-green-600">已完成</span>
                    ) : m.status === 'abandoned' ? (
                      <span className="text-red-500">已中止</span>
                    ) : (
                      <span className="text-amber-500">进行中</span>
                    )}
                  </td>
                  <td className="text-right">
                    <button
                      className="text-blue-600 hover:underline"
                      onClick={() => {
                        setReportSessionId(m.session_id)
                        setPage('report')
                      }}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

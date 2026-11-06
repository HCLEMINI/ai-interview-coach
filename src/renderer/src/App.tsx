import { useEffect } from 'react'
import { useUIStore } from './store/sessionStore'
import HomePage from './pages/HomePage'
import SetupPage from './pages/SetupPage'
import InterviewPage from './pages/InterviewPage'
import ReportPage from './pages/ReportPage'
import SettingsPage from './pages/SettingsPage'
import LibraryPage from './pages/LibraryPage'

export default function App(): JSX.Element {
  const page = useUIStore((s) => s.page)
  const setSnapshot = useUIStore((s) => s.setSnapshot)
  const toast = useUIStore((s) => s.toast)

  // 全局订阅状态机快照（事件订阅在 InterviewPage 内）
  useEffect(() => {
    const off = window.api.onSessionState((snap) => setSnapshot(snap))
    return off
  }, [setSnapshot])

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="flex items-center gap-3 px-6 h-12 border-b border-gray-200 bg-white/70 backdrop-blur shrink-0">
        <span className="font-bold text-blue-700">AI面试模拟舱</span>
        <span className="text-xs text-gray-400">本地训练工具 · 只录一次 · 答满时长</span>
        <div className="flex-1" />
        {page !== 'home' && page !== 'interview' && (
          <button
            className="text-sm text-gray-500 hover:text-blue-600"
            onClick={() => useUIStore.getState().setPage('home')}
          >
            首页
          </button>
        )}
        <button
          className="text-sm text-gray-400 hover:text-blue-600 ml-4"
          onClick={() => useUIStore.getState().setPage('settings')}
        >
          设置
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        {page === 'home' && <HomePage />}
        {page === 'setup' && <SetupPage />}
        {page === 'interview' && <InterviewPage />}
        {page === 'report' && <ReportPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'library' && <LibraryPage />}
      </main>

      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-lg bg-gray-900 text-white text-sm shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

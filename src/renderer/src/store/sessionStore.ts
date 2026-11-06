// 渲染层 UI 状态：页面路由 + 主进程状态机快照镜像
import { create } from 'zustand'
import type { SessionEvent, SessionSnapshot } from '../../../shared/types'

export type Page = 'home' | 'setup' | 'interview' | 'report' | 'settings' | 'library'

interface UIState {
  page: Page
  snapshot: SessionSnapshot | null
  reportSessionId: string | null
  toast: string | null
  sessionCfg: { cameraEnabled: boolean; coachMode?: boolean } | null
  setPage: (p: Page) => void
  setSnapshot: (s: SessionSnapshot) => void
  clearSnapshot: () => void
  setReportSessionId: (id: string | null) => void
  setSessionCfg: (cfg: { cameraEnabled: boolean; coachMode?: boolean } | null) => void
  showToast: (msg: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useUIStore = create<UIState>((set) => ({
  page: 'home',
  snapshot: null,
  reportSessionId: null,
  toast: null,
  sessionCfg: null,
  setPage: (page) => set({ page }),
  setSnapshot: (snapshot) => set({ snapshot }),
  clearSnapshot: () => set({ snapshot: null }),
  setReportSessionId: (reportSessionId) => set({ reportSessionId }),
  setSessionCfg: (sessionCfg) => set({ sessionCfg }),
  showToast: (msg) => {
    set({ toast: msg })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  }
}))

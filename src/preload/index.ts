import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AckAction,
  CompanyCard,
  GatewayConfig,
  Question,
  QuestionBankFile,
  RecordingBeginResult,
  RecordingFinishResult,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  TrendEntry,
  VendorId
} from '../shared/types'

// 渲染层可用 API（与 env.d.ts 双写，保持签名一致）
const api = {
  platform: process.platform,

  // ---- 会话 ----
  sessionStart: (cfg: {
    vendorId: VendorId
    company: string
    position: string
    cameraEnabled: boolean
    questionCount: number
    devFast: boolean
    drill?: 'intro' | 'star' | null
    drillStory?: { title: string; hint?: string } | null
    prepSec?: number
    answerSec?: number
  }): Promise<{ ok: boolean; reason?: string; sessionId?: string; snapshot?: SessionSnapshot }> =>
    ipcRenderer.invoke('session:start', cfg),

  sessionAck: (action: AckAction): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:ack', action),

  sessionSubmitEarly: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:submit-early'),

  sessionAbandonQuestion: (confirm: boolean): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:abandon-question', { confirm }),

  sessionAbandon: (reason?: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:abandon', { reason }),

  sessionList: (): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list'),

  sessionDetail: (
    sessionId: string
  ): Promise<{
    ok: boolean
    reason?: string
    meta?: SessionMeta
    extras?: Record<string, { transcript?: string; metrics?: unknown; llmScore?: unknown }>
    coachSummary?: { overall: string; actions: string[] } | null
  }> => ipcRenderer.invoke('session:detail', { sessionId }),

  onReportSummaryReady: (cb: (p: { sessionId: string }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { sessionId: string }): void => cb(p)
    ipcRenderer.on('report:summary-ready', listener)
    return () => ipcRenderer.removeListener('report:summary-ready', listener)
  },

  onSessionState: (cb: (snap: SessionSnapshot) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, snap: SessionSnapshot): void => cb(snap)
    ipcRenderer.on('session:state', listener)
    return () => ipcRenderer.removeListener('session:state', listener)
  },

  onSessionEvent: (cb: (ev: SessionEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: SessionEvent): void => cb(ev)
    ipcRenderer.on('session:event', listener)
    return () => ipcRenderer.removeListener('session:event', listener)
  },

  // ---- 录制 ----
  recordingBegin: (qDir: string, withVideo: boolean): Promise<RecordingBeginResult> =>
    ipcRenderer.invoke('recording:begin', { qDir, withVideo }),

  recordingChunk: (
    qDir: string,
    track: 'audio' | 'video',
    seq: number,
    data: ArrayBuffer
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('recording:chunk', { qDir, track, seq, data }),

  recordingFinish: (qDir: string): Promise<RecordingFinishResult> =>
    ipcRenderer.invoke('recording:finish', { qDir }),

  // ---- 边车 ----
  ttsGenerate: (text: string, voice?: string): Promise<{ ok: boolean; url?: string; reason?: string }> =>
    ipcRenderer.invoke('tts:generate', { text, voice }),

  asrPreload: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('asr:preload'),

  llmRequest: (p: {
    system: string
    user: string
    jsonMode?: boolean
    temperature?: number
    maxTokens?: number
  }): Promise<{ ok: boolean; content?: string; parsed?: unknown; reason?: string }> =>
    ipcRenderer.invoke('llm:request', p),

  sidecarStatus: (): Promise<{
    alive: boolean
    restartCount: number
    whisper_loaded?: boolean
    whisper_model?: string | null
    whisperLoaded?: boolean
    model?: string | null
  }> => ipcRenderer.invoke('sidecar:status'),

  onSidecarEvent: (cb: (ev: { type: string; message?: string }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: { type: string; message?: string }): void => cb(ev)
    ipcRenderer.on('sidecar:event', listener)
    return () => ipcRenderer.removeListener('sidecar:event', listener)
  },

  onProcessingProgress: (
    cb: (p: { qDir: string; stage: string; error?: string }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { qDir: string; stage: string; error?: string }): void => cb(p)
    ipcRenderer.on('processing:progress', listener)
    return () => ipcRenderer.removeListener('processing:progress', listener)
  },

  // ---- 数据 ----
  questionBankGet: (file: 'base' | 'generated'): Promise<QuestionBankFile> =>
    ipcRenderer.invoke('data:question-bank:get', { file }),

  questionBankUpsert: (file: 'base' | 'generated', questions: Question[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('data:question-bank:upsert', { file, questions }),

  trendsGet: (): Promise<{ sessions: TrendEntry[] }> => ipcRenderer.invoke('data:trends:get'),

  companyCardsList: (): Promise<CompanyCard[]> => ipcRenderer.invoke('data:company-cards:list'),

  companyCardsUpsert: (card: CompanyCard): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('data:company-cards:upsert', card),

  starStoriesGet: (): Promise<{ stories: unknown[] }> => ipcRenderer.invoke('data:star-stories:get'),

  starStoriesUpsert: (stories: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('data:star-stories:upsert', { stories }),

  digestGet: (): Promise<{ missing: boolean; digest?: unknown }> =>
    ipcRenderer.invoke('data:digest:get'),

  digestBuild: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('digest:build'),

  digestReview: (reviewed: boolean): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('digest:review', { reviewed }),

  questionsGenerate: (): Promise<{ ok: boolean; count?: number; reason?: string }> =>
    ipcRenderer.invoke('questions:generate'),

  gatewayGet: (): Promise<GatewayConfig> => ipcRenderer.invoke('settings:gateway:get'),

  gatewaySet: (cfg: GatewayConfig): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('settings:gateway:set', cfg),

  // ---- 通用 ----
  storeGet: (key: string): Promise<unknown> => ipcRenderer.invoke('store-get', key),
  storeSet: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('store-set', { key, value }),
  openPath: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('open-path', { path }),
  getAppVersion: (): Promise<{ ok: boolean; data?: string }> => ipcRenderer.invoke('app:get-version')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

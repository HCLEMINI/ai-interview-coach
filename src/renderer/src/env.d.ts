/// <reference types="vite/client" />

import { ElectronAPI } from '@electron-toolkit/preload'
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
} from '../../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      platform: NodeJS.Platform
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
        aiCompose?: boolean
      }) => Promise<{ ok: boolean; reason?: string; sessionId?: string; snapshot?: SessionSnapshot }>
      sessionAck: (action: AckAction) => Promise<{ ok: boolean; reason?: string }>
      sessionSubmitEarly: () => Promise<{ ok: boolean; reason?: string }>
      sessionAbandonQuestion: (confirm: boolean) => Promise<{ ok: boolean; reason?: string }>
      sessionAbandon: (reason?: string) => Promise<{ ok: boolean; reason?: string }>
      sessionList: () => Promise<SessionMeta[]>
      sessionDetail: (
        sessionId: string
      ) => Promise<{
        ok: boolean
        reason?: string
        meta?: SessionMeta
        extras?: Record<string, { transcript?: string; metrics?: unknown; llmScore?: unknown }>
        coachSummary?: { overall: string; actions: string[] } | null
      }>
      onReportSummaryReady: (cb: (p: { sessionId: string }) => void) => () => void
      onSessionState: (cb: (snap: SessionSnapshot) => void) => () => void
      onSessionEvent: (cb: (ev: SessionEvent) => void) => () => void
      recordingBegin: (qDir: string, withVideo: boolean) => Promise<RecordingBeginResult>
      recordingChunk: (
        qDir: string,
        track: 'audio' | 'video',
        seq: number,
        data: ArrayBuffer
      ) => Promise<{ ok: boolean; reason?: string }>
      ttsGenerate: (text: string, voice?: string) => Promise<{ ok: boolean; url?: string; reason?: string }>
      asrPreload: () => Promise<{ ok: boolean; reason?: string }>
      llmRequest: (p: {
        system: string
        user: string
        jsonMode?: boolean
        temperature?: number
        maxTokens?: number
      }) => Promise<{ ok: boolean; content?: string; parsed?: unknown; reason?: string }>
      sidecarStatus: () => Promise<{
        alive: boolean
        restartCount: number
        whisper_loaded?: boolean
        whisper_model?: string | null
        whisperLoaded?: boolean
        model?: string | null
      }>
      onSidecarEvent: (cb: (ev: { type: string; message?: string }) => void) => () => void
      onProcessingProgress: (cb: (p: { qDir: string; stage: string; error?: string }) => void) => () => void
      recordingFinish: (qDir: string) => Promise<RecordingFinishResult>
      questionBankGet: (file: 'base' | 'generated') => Promise<QuestionBankFile>
      questionBankUpsert: (file: 'base' | 'generated', questions: Question[]) => Promise<{ ok: boolean }>
      trendsGet: () => Promise<{ sessions: TrendEntry[] }>
      companyCardsList: () => Promise<CompanyCard[]>
      companyCardsUpsert: (card: CompanyCard) => Promise<{ ok: boolean }>
      starStoriesGet: () => Promise<{ stories: unknown[] }>
      starStoriesUpsert: (stories: unknown[]) => Promise<{ ok: boolean }>
      digestGet: () => Promise<{ missing: boolean; digest?: unknown }>
      digestBuild: () => Promise<{ ok: boolean; reason?: string }>
      digestReview: (reviewed: boolean) => Promise<{ ok: boolean; reason?: string }>
      questionsGenerate: () => Promise<{ ok: boolean; count?: number; reason?: string }>
      gatewayGet: () => Promise<GatewayConfig>
      gatewaySet: (cfg: GatewayConfig) => Promise<{ ok: boolean }>
      storeGet: (key: string) => Promise<unknown>
      storeSet: (key: string, value: unknown) => Promise<void>
      openPath: (path: string) => Promise<{ ok: boolean }>
      getAppVersion: () => Promise<{ ok: boolean; data?: string }>
    }
  }
}

export { }

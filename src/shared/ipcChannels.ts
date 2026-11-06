// IPC 通道名常量（主进程 / preload / 渲染层三方共用，防手写错字）
export const CH = {
  // 会话控制（R→M invoke）
  SessionStart: 'session:start',
  SessionAck: 'session:ack',
  SessionSubmitEarly: 'session:submit-early',
  SessionAbandonQuestion: 'session:abandon-question',
  SessionAbandon: 'session:abandon',
  SessionList: 'session:list',
  SessionDetail: 'session:detail',
  // 会话推送（M→R）
  SessionState: 'session:state',
  SessionTick: 'session:tick',
  SessionEvent: 'session:event',
  // 录制（R→M invoke）
  RecordingBegin: 'recording:begin',
  RecordingChunk: 'recording:chunk',
  RecordingFinish: 'recording:finish',
  // 边车代理（R→M invoke；P1 接入）
  TtsGenerate: 'tts:generate',
  AsrTranscribe: 'asr:transcribe',
  AsrPreload: 'asr:preload',
  LlmRequest: 'llm:request',
  SidecarStatus: 'sidecar:status',
  SidecarEvent: 'sidecar:event',
  // 数据
  DataQuestionBankGet: 'data:question-bank:get',
  DataQuestionBankUpsert: 'data:question-bank:upsert',
  DataCompanyCardsList: 'data:company-cards:list',
  DataCompanyCardsGet: 'data:company-cards:get',
  DataCompanyCardsUpsert: 'data:company-cards:upsert',
  DataStarStoriesGet: 'data:star-stories:get',
  DataStarStoriesUpsert: 'data:star-stories:upsert',
  DataDigestGet: 'data:digest:get',
  DigestBuild: 'digest:build',
  DigestReview: 'digest:review',
  QuestionsGenerate: 'questions:generate',
  DataTrendsGet: 'data:trends:get',
  ProcessingProgress: 'processing:progress',
  SettingsGatewayGet: 'settings:gateway:get',
  SettingsGatewaySet: 'settings:gateway:set',
  // 沿用 MultiChat 的通用通道
  StoreGet: 'store-get',
  StoreSet: 'store-set',
  StoreDelete: 'store-delete',
  OpenPath: 'open-path',
  SelectFile: 'select-file',
  AppGetVersion: 'app:get-version'
} as const

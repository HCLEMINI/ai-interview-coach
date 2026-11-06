import { useEffect, useState } from 'react'
import type { GatewayConfig } from '../../../shared/types'
import { useUIStore } from '../store/sessionStore'

export default function SettingsPage(): JSX.Element {
  const setPage = useUIStore((s) => s.setPage)
  const showToast = useUIStore((s) => s.showToast)
  const [cfg, setCfg] = useState<GatewayConfig>({ baseUrl: '', apiKey: '', model: '', timeoutSec: 120 })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [scStatus, setScStatus] = useState<string>('检测中…')
  const [loading, setLoading] = useState(true)
  const [whisperModel, setWhisperModel] = useState('small')

  useEffect(() => {
    void window.api.gatewayGet().then((c) => {
      setCfg(c)
      setLoading(false)
    })
    void window.api.storeGet('whisperModel').then((m) => {
      if (m === 'medium' || m === 'small') setWhisperModel(m as string)
    })
    void refreshSidecar()
  }, [])

  const refreshSidecar = async (): Promise<void> => {
    try {
      const st = await window.api.sidecarStatus()
      const parts = [`进程: ${st.alive ? '运行中' : '未启动'}`]
      if (st.whisper_loaded || st.whisperLoaded) parts.push(`whisper 已加载(${st.whisper_model ?? st.model ?? 'small'})`)
      else parts.push('whisper 未加载（练习题答完后自动加载）')
      if (st.restartCount > 0) parts.push(`重启 ${st.restartCount} 次`)
      setScStatus(parts.join(' · '))
    } catch {
      setScStatus('状态获取失败')
    }
  }

  const save = async (): Promise<void> => {
    await window.api.gatewaySet(cfg)
    showToast('网关配置已保存')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.api.llmRequest({
        system: '你是连通性测试。只输出一个 JSON 对象。',
        user: '请返回 {"ok": true}',
        jsonMode: true,
        temperature: 0,
        maxTokens: 20
      })
      setTestResult(r.ok ? '✅ 连通正常，模型可返回 JSON' : `❌ ${r.reason}`)
    } finally {
      setTesting(false)
    }
  }

  const preload = async (): Promise<void> => {
    setTestResult('whisper 预加载中…（首次约 10-30 秒）')
    const r = await window.api.asrPreload()
    setTestResult(r.ok ? '✅ whisper 已加载' : `❌ ${r.reason}`)
    void refreshSidecar()
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">设置</h1>
        <button className="btn-secondary" onClick={() => setPage('home')}>
          返回首页
        </button>
      </div>

      <div className="card p-5 mb-5">
        <h2 className="font-semibold mb-1">LLM 评分网关（OpenAI 兼容）</h2>
        <p className="text-xs text-gray-400 mb-4">
          用于内容层评分与追问判定；密钥只存本机 app-data，不随工程入库。参考配置：DeepSeek 官方 API。
        </p>
        {loading ? (
          <p className="text-gray-400">加载中…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-500 mb-1">base_url</label>
              <input
                className="input-box font-mono text-sm"
                value={cfg.baseUrl}
                onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                placeholder="https://api.deepseek.com"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-500 mb-1">model</label>
                <input
                  className="input-box font-mono text-sm"
                  value={cfg.model}
                  onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
                  placeholder="deepseek-flash"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">超时（秒）</label>
                <input
                  className="input-box font-mono text-sm"
                  type="number"
                  value={cfg.timeoutSec}
                  onChange={(e) => setCfg({ ...cfg, timeoutSec: Number(e.target.value) || 120 })}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-500 mb-1">api_key</label>
              <input
                className="input-box font-mono text-sm"
                type="password"
                value={cfg.apiKey}
                onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                placeholder="sk-…"
              />
            </div>
            <div className="flex gap-3 pt-1">
              <button className="btn-primary" onClick={() => void save()}>
                保存
              </button>
              <button className="btn-secondary" disabled={testing} onClick={() => void test()}>
                {testing ? '测试中…' : '连通测试'}
              </button>
            </div>
            {testResult && <p className="text-sm mt-1">{testResult}</p>}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="font-semibold mb-2">语音边车状态</h2>
        <p className="text-sm text-gray-600 mb-3">{scStatus}</p>
        <div className="mb-3">
          <label className="block text-sm text-gray-500 mb-1">转写模型</label>
          <select
            className="input-box"
            value={whisperModel}
            onChange={(e) => {
              setWhisperModel(e.target.value)
              void window.api.storeSet('whisperModel', e.target.value)
            }}
          >
            <option value="small">small —— 快（每题约 40 秒，专有名词已带热词纠正）</option>
            <option value="medium">medium —— 更准但慢（正常频率约 2-3 分钟/题；CPU 降频时勿用）</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">切换后下一场生效；medium 模型已预下载。</p>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary" onClick={() => void refreshSidecar()}>
            刷新状态
          </button>
          <button className="btn-secondary" onClick={() => void preload()}>
            预加载 whisper
          </button>
        </div>
      </div>

      <DigestCard onToast={showToast} />
    </div>
  )
}

function DigestCard({ onToast }: { onToast: (msg: string) => void }): JSX.Element | null {
  const [state, setState] = useState<'missing' | 'unreviewed' | 'reviewed' | 'loading'>('loading')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<string>('')

  const refresh = async (): Promise<void> => {
    const r = await window.api.digestGet()
    if (r.missing) {
      setState('missing')
      return
    }
    const meta = (r.digest as { _meta?: { reviewed?: boolean; built_at?: string } })._meta
    setState(meta?.reviewed ? 'reviewed' : 'unreviewed')
    setDetail(new Date(meta?.built_at ?? '').toLocaleString())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const build = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.digestBuild()
    setBusy(false)
    if (r.ok) onToast('摘要已构建，请人工审阅')
    else onToast(`构建失败：${r.reason}`)
    void refresh()
  }

  const review = async (ok: boolean): Promise<void> => {
    const r = await window.api.digestReview(ok)
    if (r.ok) onToast(ok ? '已确认审阅，可用于出题' : '已标记未审阅')
    else onToast(r.reason ?? '操作失败')
    void refresh()
  }

  const label =
    state === 'loading'
      ? '检测中…'
      : state === 'missing'
        ? '未构建'
        : state === 'unreviewed'
          ? '已构建，待人工审阅'
          : '已审阅，可用于出题'

  return (
    <div className="card p-5 mt-5">
      <h2 className="font-semibold mb-1">个人档案脱敏摘要</h2>
      <p className="text-xs text-gray-400 mb-3">
        白名单正向抽取（教育/科研/项目/时间线/面试教训/成果标题），构建后经身份证/手机号/长数字串三重正则复核；必须人工审阅后才会用于个性化出题。
      </p>
      <p className="text-sm mb-3">
        状态：<span className={state === 'reviewed' ? 'text-green-600' : 'text-amber-600'}>{label}</span>
        {detail && <span className="text-gray-400 text-xs ml-2">（构建于 {detail}）</span>}
      </p>
      <div className="flex gap-3 flex-wrap">
        <button className="btn-secondary" disabled={busy} onClick={() => void build()}>
          {busy ? '构建中…' : '构建/重建摘要'}
        </button>
        {state === 'unreviewed' && (
          <button className="btn-primary" onClick={() => void review(true)}>
            我已人工审阅，确认无敏感内容
          </button>
        )}
      </div>
    </div>
  )
}

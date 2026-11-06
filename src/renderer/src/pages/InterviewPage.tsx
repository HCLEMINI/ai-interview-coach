import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionEvent, SessionSnapshot } from '../../../shared/types'
import { useUIStore } from '../store/sessionStore'
import { useMediaRecorder } from '../hooks/useMediaRecorder'
import CountdownRing from '../components/CountdownRing'
import CameraPreview from '../components/CameraPreview'

function playBeep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.25, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.8)
    osc.onended = () => ctx.close().catch(() => undefined)
  } catch (e) {
    console.warn('beep failed', e)
  }
}

const TYPE_LABEL: Record<string, string> = {
  practice: '练习题（不计分）',
  intro: '自我介绍',
  motivation: '求职动机',
  behavioral: '行为经历题',
  situational: '情境判断题',
  reading: '文段朗读题',
  english: '英语题',
  experience: '行为经历类'
}

export default function InterviewPage(): JSX.Element {
  const snapshot = useUIStore((s) => s.snapshot)
  const setPage = useUIStore((s) => s.setPage)
  const showToast = useUIStore((s) => s.showToast)
  const setReportSessionId = useUIStore((s) => s.setReportSessionId)
  const rec = useMediaRecorder()
  const sessionCfg = useUIStore((s) => s.sessionCfg)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [progress, setProgress] = useState<Record<string, { stage: string; error?: string }>>({})
  const [echoUrl, setEchoUrl] = useState<string | null>(null)
  const [echoBusy, setEchoBusy] = useState(false)
  const [coachHint, setCoachHint] = useState<{ id: string; points: string[]; keywords: string[] } | null>(null)

  // 教练提示：教练模式下进入准备阶段，取该题的答题提纲（真实考试无此辅助）
  useEffect(() => {
    if (snapshot?.state !== 'PREPARING' || !sessionCfg?.coachMode) return
    const q = snapshot.question
    if (!q || coachHint?.id === q.id) return
    setCoachHint({ id: q.id, points: [], keywords: [] })
    void window.api
      .llmRequest({
        system:
          '你是面试教练。给考生的准备阶段提示：针对题目给3点答题提纲（每点15字内，STAR或分点结构）和3个应命中的关键词。输出单个JSON：{"points":["..."],"keywords":["..."]}',
        user: JSON.stringify({ 题目: q.text, 题型: q.type }),
        jsonMode: true,
        temperature: 0.3,
        maxTokens: 500
      })
      .then((r) => {
        const p = r.parsed as { points?: unknown; keywords?: unknown } | null
        if (p && Array.isArray(p.points)) {
          setCoachHint({
            id: q.id,
            points: (p.points as unknown[]).map(String).slice(0, 3),
            keywords: Array.isArray(p.keywords) ? (p.keywords as unknown[]).map(String).slice(0, 3) : []
          })
        } else {
          setCoachHint(null)
        }
      })
      .catch(() => setCoachHint(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.state, snapshot?.question?.id, sessionCfg?.coachMode])
  const acquiringRef = useRef(false)
  const ttsAbortRef = useRef(0)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)

  // TTS 读题：进入出题态自动朗读，播完自动进准备；失败降级为手动按钮
  // 动态追问生成中（followupReady=false）不读题，就绪后自动开播
  useEffect(() => {
    if (!snapshot) return
    const st = snapshot.state
    if (st !== 'PRACTICE_INTRO' && st !== 'QUESTION_INTRO' && st !== 'FOLLOWUP_INTRO') return
    if (st === 'FOLLOWUP_INTRO' && !snapshot.followupReady) return
    const text = snapshot.question?.text
    if (!text) return
    const token = ++ttsAbortRef.current
    setTtsPlaying(true)
    void window.api.ttsGenerate(text).then((r) => {
      if (token !== ttsAbortRef.current) return
      if (!r.ok || !r.url) {
        setTtsPlaying(false) // TTS 失败：降级文字题干，手动按钮继续
        return
      }
      const audio = new Audio(r.url)
      ttsAudioRef.current = audio
      audio.onended = () => {
        if (token === ttsAbortRef.current) {
          setTtsPlaying(false)
          void window.api.sessionAck('tts-played')
        }
      }
      audio.onerror = () => {
        if (token === ttsAbortRef.current) setTtsPlaying(false)
      }
      audio.play().catch(() => {
        if (token === ttsAbortRef.current) setTtsPlaying(false)
      })
    })
    return () => {
      ttsAbortRef.current++ // 离开出题态即作废当前 TTS
      ttsAudioRef.current?.pause()
      ttsAudioRef.current = null
    }
  }, [snapshot?.state, snapshot?.question?.id, snapshot?.followupReady])

  const skipTts = (): void => {
    ttsAbortRef.current++
    ttsAudioRef.current?.pause()
    ttsAudioRef.current = null
    setTtsPlaying(false)
  }

  // 试录回听（复刻北森设备调试的"朗读一段→回听确认"）：本地录 5 秒直接回放，不落盘
  const echoTest = (): void => {
    const s = rec.stream
    if (!s || echoBusy) return
    setEchoBusy(true)
    setEchoUrl(null)
    try {
      const mr = new MediaRecorder(new MediaStream(s.getAudioTracks()), { mimeType: 'audio/webm' })
      const chunks: Blob[] = []
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data)
      }
      mr.onstop = () => {
        setEchoUrl(URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' })))
        setEchoBusy(false)
      }
      mr.start()
      setTimeout(() => {
        if (mr.state !== 'inactive') mr.stop()
      }, 5000)
    } catch (e) {
      console.warn('echo test failed', e)
      setEchoBusy(false)
    }
  }

  // 处理进度与边车事件
  useEffect(() => {
    const offP = window.api.onProcessingProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.qDir]: { stage: p.stage, error: p.error } }))
    })
    const offS = window.api.onSidecarEvent((ev) => {
      if (ev.message) showToast(ev.message)
    })
    return () => {
      offP()
      offS()
    }
  }, [showToast])

  // 设备流获取：PRECHECK 或特训模式的 QUESTION_INTRO 进入时取一次，是否带摄像头跟随会话配置
  const { stream, acquire, startMeter, stopMeter, startRecording, stopRecording } = rec
  useEffect(() => {
    const st = snapshot?.state
    const shouldAcquire = st === 'PRECHECK' || (st === 'QUESTION_INTRO' && snapshot?.qIndex === 1)
    if (!shouldAcquire || stream || acquiringRef.current) return
    acquiringRef.current = true
    acquire(sessionCfg?.cameraEnabled ?? false).finally(() => {
      acquiringRef.current = false
    })
  }, [snapshot?.state, snapshot?.qIndex, stream, acquire, sessionCfg])

  useEffect(() => {
    if (snapshot?.state === 'DEVICE_CHECK') {
      startMeter()
    } else {
      stopMeter()
    }
  }, [snapshot?.state, startMeter, stopMeter])

  // 事件订阅：录制窗口开启/关闭、提示音、收尾
  useEffect(() => {
    const off = window.api.onSessionEvent((ev: SessionEvent) => {
      switch (ev.type) {
        case 'answer-window':
          void startRecording(ev.qDir).then((ok) => {
            if (!ok) showToast('录制启动失败，本题无法保存音频')
          })
          break
        case 'auto-stopped':
        case 'window-closed':
          void stopRecording(ev.qDir)
          break
        case 'beep-now':
          playBeep()
          break
        case 'followup-triggered':
          showToast(`触发追问 第 ${ev.level} 层`)
          break
        case 'zeroed':
          showToast('本题已放弃，计零分')
          break
        default:
          break
      }
    })
    return off
  }, [startRecording, stopRecording, showToast])

  const ack = useCallback(
    (action: Parameters<typeof window.api.sessionAck>[0]): void => {
      window.api.sessionAck(action).then((r) => {
        if (!r.ok) showToast(r.reason ?? '操作无效')
      })
    },
    [showToast]
  )

  if (!snapshot) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-400">
        无进行中的会话
        <div className="mt-4">
          <button className="btn-secondary" onClick={() => setPage('home')}>
            返回首页
          </button>
        </div>
      </div>
    )
  }

  const s: SessionSnapshot = snapshot
  const isFollowup = s.followupLevel > 0
  const qLabel =
    s.qIndex === 0
      ? '练习题'
      : isFollowup
        ? `第 ${s.qIndex} 题 · 追问第 ${s.followupLevel} 层`
        : `第 ${s.qIndex} / ${s.qTotal} 题`

  const header = (
    <div className="flex items-center justify-between mb-4">
      <div>
        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">{s.vendorLabel}</span>
        <span className="ml-2 text-sm text-gray-500">
          {s.company} · {s.position}
        </span>
      </div>
      <div className="text-sm text-gray-400">{qLabel}</div>
    </div>
  )

  const stateBody = (): JSX.Element => {
    switch (s.state) {
      case 'PRECHECK':
        return (
          <div className="text-center py-8">
            <h2 className="text-xl font-semibold mb-3">正脸核身</h2>
            <p className="text-gray-500 mb-4">请正对摄像头，保持正脸，3 秒后进入设备自检</p>
            {rec.stream && rec.stream.getVideoTracks().length > 0 ? (
              <CameraPreview stream={rec.stream} className="w-80 rounded-xl border mx-auto" />
            ) : (
              <div className="text-gray-400 text-sm">（未开启摄像头，纯音频模式）</div>
            )}
            <div className="mt-4 text-3xl font-bold tabular-nums">{s.remainingSec}</div>
          </div>
        )

      case 'DEVICE_CHECK':
        return (
          <div className="text-center py-8">
            <h2 className="text-xl font-semibold mb-3">设备自检</h2>
            <p className="text-gray-500 mb-4">对着麦克风说几句话，观察音量条是否跳动</p>
            <div className="w-80 mx-auto h-4 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all duration-100"
                style={{ width: `${rec.micLevel}%` }}
              />
            </div>
            <div className="mt-4">
              <button className="btn-secondary" disabled={echoBusy || !rec.stream} onClick={echoTest}>
                {echoBusy ? '试录中，请朗读 5 秒…' : '试录 5 秒并回听（复刻北森回听确认）'}
              </button>
              {echoUrl && (
                <div className="mt-3">
                  <audio src={echoUrl} controls autoPlay className="mx-auto" />
                  <p className="text-xs text-gray-400 mt-1">听不清/声音小？换个麦克风或靠近一点再试</p>
                </div>
              )}
            </div>
            {rec.streamError && <p className="text-amber-600 text-sm mt-3">{rec.streamError}</p>}
            {rec.stream && rec.stream.getVideoTracks().length > 0 && (
              <CameraPreview stream={rec.stream} className="w-64 rounded-xl border mt-4 mx-auto" />
            )}
            <div className="flex gap-4 justify-center mt-6">
              <button className="btn-primary" onClick={() => ack('device-ok')}>
                设备正常，开始练习题
              </button>
              <button className="btn-danger" onClick={() => ack('device-fail')}>
                设备异常
              </button>
            </div>
          </div>
        )

      case 'PRACTICE_INTRO':
      case 'QUESTION_INTRO':
      case 'FOLLOWUP_INTRO': {
        const q = s.question
        if (s.state === 'FOLLOWUP_INTRO' && !s.followupReady) {
          return (
            <div className="text-center py-16">
              <div className="text-4xl mb-4 animate-pulse">🤔</div>
              <h2 className="text-lg font-semibold mb-2">AI 面试官正在分析你的作答</h2>
              <p className="text-gray-500 text-sm">转写与追问生成中，约 30-90 秒……</p>
            </div>
          )
        }
        return (
          <div className="py-6">
            <div className="card p-6">
              <div className="text-sm text-gray-400 mb-2">
                {q ? TYPE_LABEL[q.type] ?? q.type : ''}
                {s.unscored ? ' · 不计分' : ''}
              </div>
              <div className="text-lg leading-8">{q?.text}</div>
              {q?.readingPassage && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg max-h-52 overflow-y-auto text-base leading-7 whitespace-pre-wrap">
                  {q.readingPassage}
                </div>
              )}
            </div>
            <div className="flex justify-center gap-4 mt-6">
              {ttsPlaying ? (
                <>
                  <span className="inline-flex items-center gap-2 text-blue-600">
                    <span className="animate-pulse">🔊</span> 面试官读题中…（读毕自动进入准备）
                  </span>
                  <button className="btn-secondary" onClick={skipTts}>
                    跳过读题
                  </button>
                </>
              ) : (
                <button className="btn-primary px-8" onClick={() => ack('tts-played')}>
                  已听清，开始准备
                </button>
              )}
            </div>
            {!ttsPlaying && (
              <p className="text-center text-xs text-gray-400 mt-2">（语音读题不可用或已跳过，直接点按钮继续）</p>
            )}
          </div>
        )
      }

      case 'PRACTICE_PREP':
      case 'PREPARING':
      case 'FOLLOWUP_PREP':
        return (
          <div className="text-center py-8">
            <h2 className="text-xl font-semibold mb-1">准备中</h2>
            <p className="text-gray-500 mb-6">倒计时结束自动开始作答，提示音响后开始说话</p>
            <CountdownRing remaining={s.remainingSec} total={s.phaseTotalSec} dangerBelow={6} />
            {sessionCfg?.coachMode && s.question && (
              <div className="card p-4 mt-4 max-w-lg mx-auto text-left">
                <div className="text-xs text-amber-600 mb-2">教练提示（真实考试无此辅助）</div>
                {coachHint?.id === s.question.id && coachHint.points.length > 0 ? (
                  <div>
                    <ol className="list-decimal list-inside text-sm text-gray-700 space-y-1">
                      {coachHint.points.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ol>
                    {coachHint.keywords.length > 0 && (
                      <div className="text-xs text-gray-500 mt-2">关键词：{coachHint.keywords.join(' · ')}</div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">提纲生成中……</p>
                )}
              </div>
            )}
            {s.vendorId === 'qiancheng' && (
              <div className="mt-6">
                <button className="btn-primary" onClick={() => ack('begin-answer')}>
                  直接开始作答
                </button>
              </div>
            )}
          </div>
        )

      case 'BEEP':
        return (
          <div className="text-center py-16">
            <div className="text-5xl font-bold text-blue-600 mb-3">“滴——”</div>
            <p className="text-gray-500">提示音响起，开始作答</p>
          </div>
        )

      case 'ANSWERING':
      case 'FOLLOWUP_ANSWERING':
        return (
          <div className="text-center py-6">
            <div className="flex items-center justify-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-full bg-red-600 rec-dot" />
              <span className="text-red-600 font-semibold">录制中</span>
            </div>
            <p className="text-xs text-gray-400 mb-4">只录一次 · 不可回看 · 答满时长可防追问</p>
            <CountdownRing remaining={s.remainingSec} total={s.phaseTotalSec} dangerBelow={15} />
            {s.question && (
              <div className="card p-4 mt-6 text-left max-w-xl mx-auto text-sm text-gray-600">
                <div className="text-gray-400 text-xs mb-1">题目</div>
                {s.question.text}
              </div>
            )}
            <div className="flex gap-4 justify-center mt-6">
              <button className="btn-secondary" onClick={() => void window.api.sessionSubmitEarly()}>
                提前交卷
              </button>
              <button className="btn-danger" onClick={() => setConfirmAbandon(true)}>
                放弃此题（计零分）
              </button>
            </div>
          </div>
        )

      case 'QUESTION_END':
      case 'FOLLOWUP_END':
        return (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">✓</div>
            <h2 className="text-xl font-semibold mb-2">本题已提交</h2>
            <p className="text-gray-500 mb-6 text-sm">音频已保存，转写与指标稍后在报告中查看</p>
            <button className="btn-primary px-8" onClick={() => ack('next-question')}>
              {s.qIndex >= s.qTotal && s.followupLevel >= 0 ? '完成本场' : '下一题'}
            </button>
          </div>
        )

      case 'QUESTION_ZEROED':
        return (
          <div className="text-center py-16">
            <h2 className="text-xl font-semibold text-red-600 mb-2">本题已放弃，计零分</h2>
            <p className="text-gray-500">即将进入下一题…</p>
          </div>
        )

      case 'FOLLOWUP_GATE':
        return (
          <div className="text-center py-16">
            <p className="text-gray-500">作答评估中…</p>
          </div>
        )

      case 'FINISHED': {
        const pending = Object.entries(progress).filter(([, v]) => v.stage !== 'done')
        const all = Object.entries(progress).filter(([dir]) => /^q\d+|^f\d+/.test(dir))
        return (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🎉</div>
            <h2 className="text-xl font-semibold mb-2">本场完成</h2>
            {all.length === 0 || pending.length > 0 ? (
              <div>
                <p className="text-gray-500 mb-2">正在处理作答（转写 · 指标 · 评分）…</p>
                <div className="text-xs text-gray-400 space-y-1">
                  {all.map(([dir, v]) => (
                    <div key={dir}>
                      {dir}：{v.stage}
                      {v.error ? `（${v.error}）` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-gray-500">全部处理完成</p>
            )}
          </div>
        )
      }

      case 'REPORT_READY':
        return (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🎉</div>
            <h2 className="text-xl font-semibold mb-2">本场完成</h2>
            <div className="flex gap-4 justify-center mt-6">
              <button
                className="btn-primary px-8"
                onClick={() => {
                  if (s.sessionId) setReportSessionId(s.sessionId)
                  window.api.sessionAck('close-report')
                  setPage('report')
                }}
              >
                查看报告
              </button>
            </div>
          </div>
        )

      case 'ABORTED':
        return (
          <div className="text-center py-16">
            <h2 className="text-xl font-semibold text-red-600 mb-2">本场已中止</h2>
            <p className="text-gray-500 mb-6">已录内容保留在本地，可从首页查看</p>
            <button className="btn-secondary" onClick={() => setPage('home')}>
              返回首页
            </button>
          </div>
        )

      default:
        return <div className="text-center py-16 text-gray-400">状态 {s.state}</div>
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-6">
      {header}
      {stateBody()}

      {confirmAbandon && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="card p-6 max-w-sm mx-4">
            <h3 className="font-semibold text-lg mb-2">确认放弃此题？</h3>
            <p className="text-gray-500 text-sm mb-5">
              放弃后本题计零分，不可恢复。真实面试中同样没有重录机会。
            </p>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setConfirmAbandon(false)}>
                继续作答
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmAbandon(false)
                  void window.api.sessionAbandonQuestion(true)
                }}
              >
                确认放弃
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
        <button
          className="text-xs text-gray-400 hover:text-red-500"
          onClick={() => void window.api.sessionAbandon('用户主动中止')}
        >
          中止整场面试
        </button>
      </div>
    </div>
  )
}

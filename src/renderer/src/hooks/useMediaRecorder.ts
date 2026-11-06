// MediaRecorder 录制钩子：
// - 预检阶段获取流（麦必需/摄可选）+ 电平表
// - 作答窗口开始录制：timeslice 1s 分块，经 IPC 串行发块（防序号乱序）
// - 停止后等最后一块 flush 再 finish
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseMediaRecorder {
  stream: MediaStream | null
  streamError: string | null
  acquiring: boolean
  acquire: (withVideo: boolean) => Promise<boolean>
  micLevel: number // 0-100，电平表
  startMeter: () => void
  stopMeter: () => void
  startRecording: (qDir: string) => Promise<boolean>
  stopRecording: (qDir: string) => Promise<void>
  release: () => void
  recording: boolean
}

export function useMediaRecorder(withVideoDefault = false): UseMediaRecorder {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [acquiring, setAcquiring] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [recording, setRecording] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const recordersRef = useRef<{ qDir: string; recs: MediaRecorder[] } | null>(null)
  const seqRef = useRef({ audio: 0, video: 0 })
  const chainRef = useRef(Promise.resolve())
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const acquire = useCallback(
    async (withVideo: boolean): Promise<boolean> => {
      setAcquiring(true)
      setStreamError(null)
      try {
        // 先释放旧流
        streamRef.current?.getTracks().forEach((t) => t.stop())
        const constraints: MediaStreamConstraints = withVideo
          ? { audio: true, video: { width: 640, height: 480, facingMode: 'user' } }
          : { audio: true }
        const s = await navigator.mediaDevices.getUserMedia(constraints)
        streamRef.current = s
        setStream(s)
        return true
      } catch (e) {
        // 摄像头失败时降级纯音频
        if (withVideo) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = s
            setStream(s)
            setStreamError('摄像头不可用，已降级为纯音频模式（练习不受影响）')
            return true
          } catch (e2) {
            setStreamError(`麦克风不可用：${String(e2)}`)
            return false
          }
        }
        setStreamError(`设备不可用：${String(e)}`)
        return false
      } finally {
        setAcquiring(false)
      }
    },
    []
  )

  const startMeter = useCallback((): void => {
    const s = streamRef.current
    if (!s) return
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext()
      const src = audioCtxRef.current.createMediaStreamSource(s)
      const analyser = audioCtxRef.current.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      analyserRef.current = analyser
    }
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.frequencyBinCount)
    if (meterTimerRef.current) clearInterval(meterTimerRef.current)
    meterTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)
      setMicLevel(Math.min(100, Math.round(rms * 300)))
    }, 120)
  }, [])

  const stopMeter = useCallback((): void => {
    if (meterTimerRef.current) {
      clearInterval(meterTimerRef.current)
      meterTimerRef.current = null
    }
    setMicLevel(0)
  }, [])

  const startRecording = useCallback(async (qDir: string): Promise<boolean> => {
    const s = streamRef.current
    if (!s) {
      console.error('[Recorder] 无媒体流')
      return false
    }
    if (recordersRef.current) {
      console.warn('[Recorder] 已有录制进行中，忽略重复开始')
      return false
    }
    const withVideo = s.getVideoTracks().length > 0
    const beginRes = await window.api.recordingBegin(qDir, withVideo)
    if (!beginRes.ok) {
      console.error('[Recorder] 主进程拒绝录制：', beginRes.reason)
      return false
    }

    seqRef.current = { audio: 0, video: 0 }
    chainRef.current = Promise.resolve()
    const recs: MediaRecorder[] = []

    const makeRec = (track: 'audio' | 'video', tr: MediaStreamTrack): MediaRecorder => {
      const trackStream = new MediaStream([tr])
      const rec = new MediaRecorder(trackStream, {
        mimeType: track === 'audio' ? 'audio/webm' : 'video/webm'
      })
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          const seq = seqRef.current[track]++
          const dataPromise = ev.data.arrayBuffer()
          // 串行链：保证分块按 seq 顺序送达主进程
          chainRef.current = chainRef.current.then(async () => {
            try {
              const buf = await dataPromise
              await window.api.recordingChunk(qDir, track, seq, buf)
            } catch (e) {
              console.error('[Recorder] 分块发送失败', qDir, track, seq, e)
            }
          })
        }
      }
      rec.start(1000) // timeslice 1 秒
      return rec
    }

    recs.push(makeRec('audio', s.getAudioTracks()[0]))
    if (withVideo) recs.push(makeRec('video', s.getVideoTracks()[0]))

    recordersRef.current = { qDir, recs }
    setRecording(true)
    return true
  }, [])

  const stopRecording = useCallback(async (qDir: string): Promise<void> => {
    const cur = recordersRef.current
    if (!cur || cur.qDir !== qDir) return
    recordersRef.current = null
    setRecording(false)
    try {
      await Promise.all(
        cur.recs.map(
          (rec) =>
            new Promise<void>((resolve) => {
              if (rec.state === 'inactive') return resolve()
              rec.onstop = () => resolve()
              rec.stop()
            })
        )
      )
      await chainRef.current // 等全部分块送达
      await window.api.recordingFinish(qDir)
    } catch (e) {
      console.error('[Recorder] 停止失败', qDir, e)
      await window.api.recordingFinish(qDir).catch(() => undefined)
    }
  }, [])

  const release = useCallback((): void => {
    stopMeter()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
    audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null
    analyserRef.current = null
  }, [stopMeter])

  useEffect(() => {
    return () => {
      // 组件卸载兜底
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (meterTimerRef.current) clearInterval(meterTimerRef.current)
      audioCtxRef.current?.close().catch(() => undefined)
    }
  }, [])

  return {
    stream,
    streamError,
    acquiring,
    acquire,
    micLevel,
    startMeter,
    stopMeter,
    startRecording,
    stopRecording,
    release,
    recording
  }
}

// 录制落盘：渲染层 MediaRecorder 分块经 IPC 追加写文件
// 纪律约束：begin 是否允许由状态机裁决（isRecordingAllowed 注入）
import { createWriteStream, WriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

interface TrackState {
  ws: WriteStream
  bytes: number
  expectedSeq: number
}

interface RecordingState {
  dir: string // 绝对路径
  startedAt: number
  tracks: Map<'audio' | 'video', TrackState>
}

export class RecordingService {
  private recordings = new Map<string, RecordingState>() // qDir → state
  private isRecordingAllowed: (qDir: string) => { ok: boolean; reason?: string }

  constructor(isRecordingAllowed: (qDir: string) => { ok: boolean; reason?: string }) {
    this.isRecordingAllowed = isRecordingAllowed
  }

  /** 状态机实例建立后更新裁决函数 */
  setGuard(fn: (qDir: string) => { ok: boolean; reason?: string }): void {
    this.isRecordingAllowed = fn
  }

  begin(sessionRoot: string, qDir: string, withVideo: boolean): { ok: boolean; reason?: string } {
    if (this.recordings.has(qDir)) {
      return { ok: false, reason: `qDir ${qDir} 已在录制` }
    }
    const guard = this.isRecordingAllowed(qDir)
    if (!guard.ok) return guard

    if (!existsSync(sessionRoot)) mkdirSync(sessionRoot, { recursive: true })
    const qPath = join(sessionRoot, qDir)
    if (!existsSync(qPath)) mkdirSync(qPath, { recursive: true })

    const tracks = new Map<'audio' | 'video', TrackState>()
    const mk = (file: string): TrackState => ({
      ws: createWriteStream(join(qPath, file), { flags: 'w' }),
      bytes: 0,
      expectedSeq: 0
    })
    tracks.set('audio', mk('audio.webm'))
    if (withVideo) tracks.set('video', mk('video.webm'))

    this.recordings.set(qDir, { dir: qPath, startedAt: Date.now(), tracks })
    return { ok: true }
  }

  chunk(
    qDir: string,
    track: 'audio' | 'video',
    seq: number,
    data: ArrayBuffer
  ): { ok: boolean; reason?: string } {
    const rec = this.recordings.get(qDir)
    if (!rec) return { ok: false, reason: `qDir ${qDir} 未开始录制` }
    const t = rec.tracks.get(track)
    if (!t) return { ok: false, reason: `轨道 ${track} 未开启` }
    if (seq !== t.expectedSeq) {
      // 序号断档：MediaRecorder 分块偶发乱序/丢失，记录告警但继续写（webm 轨道可容忍少量缺块）
      console.warn(`[Recording] 序号断档 qDir=${qDir} track=${track} 期望=${t.expectedSeq} 实收=${seq}`)
    }
    t.expectedSeq = seq + 1
    const buf = Buffer.from(data)
    t.bytes += buf.length
    t.ws.write(buf)
    return { ok: true }
  }

  /** 结束并落盘关闭；返回字节数与录制秒数 */
  finish(qDir: string): { ok: boolean; bytes: number; recordedSec: number } {
    const rec = this.recordings.get(qDir)
    if (!rec) return { ok: false, bytes: 0, recordedSec: 0 }
    this.closeRecording(qDir)
    const bytes = [...rec.tracks.values()].reduce((s, t) => s + t.bytes, 0)
    return { ok: true, bytes, recordedSec: (Date.now() - rec.startedAt) / 1000 }
  }

  /** 状态机强停兜底：渲染层未调 finish 时也要关流（幂等） */
  forceClose(qDir: string): void {
    if (this.recordings.has(qDir)) this.closeRecording(qDir)
  }

  getRecordedSec(qDir: string): number {
    const rec = this.recordings.get(qDir)
    if (!rec) return 0
    return (Date.now() - rec.startedAt) / 1000
  }

  activeQDirs(): string[] {
    return [...this.recordings.keys()]
  }

  private closeRecording(qDir: string): void {
    const rec = this.recordings.get(qDir)
    if (!rec) return
    for (const t of rec.tracks.values()) {
      try {
        t.ws.end()
      } catch (e) {
        console.warn('[Recording] 关流失败', qDir, e)
      }
    }
    this.recordings.delete(qDir)
  }
}

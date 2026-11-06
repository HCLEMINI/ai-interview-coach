// Python 边车进程管理：行协议、超时看门狗、崩溃重启（10 分钟内最多 3 次）
import { ChildProcess, spawn } from 'child_process'
import { app } from 'electron'
import { createInterface } from 'readline'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { logsDir } from './paths'

export interface SidecarEvent {
  type: 'dead' | 'restarted' | 'whisper-loaded' | 'tts-failed'
  message?: string
}

const MAX_LINE_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUTS: Record<string, number> = {
  tts: 60_000,
  asr: 900_000,
  asr_preload: 600_000,
  llm: 150_000,
  ping: 15_000,
  status: 15_000,
  shutdown: 15_000
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: SidecarError) => void
  timer: NodeJS.Timeout
}

export class SidecarError extends Error {
  code: string
  detail?: unknown
  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

interface SidecarResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; detail?: unknown }
}

export class SidecarManager {
  private proc: ChildProcess | null = null
  private pending = new Map<string, Pending>()
  private reqSeq = 0
  private restartCount = 0
  private restartWindowStart = Date.now()
  private manualShutdown = false
  private logStream: ReturnType<typeof createWriteStream> | null = null
  onEvent: ((ev: SidecarEvent) => void) | null = null

  get alive(): boolean {
    return this.proc !== null
  }

  status(): { alive: boolean; restartCount: number } {
    return { alive: this.alive, restartCount: this.restartCount }
  }

  ensureStarted(): void {
    if (this.proc) return
    this.start()
  }

  private start(): void {
    this.manualShutdown = false
    const sidecarPath = join(app.getAppPath(), 'sidecar', 'sidecar_main.py')
    if (!existsSync(sidecarPath)) {
      this.onEvent?.({ type: 'dead', message: `边车脚本不存在: ${sidecarPath}` })
      return
    }
    const dir = logsDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (!this.logStream) this.logStream = createWriteStream(join(dir, 'sidecar.log'), { flags: 'a' })

    const python = process.env.AICOACH_PYTHON || 'python'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      // 与 scripts/download-whisper-model.py 同一缓存目录，模型只下一次
      AICOACH_MODELS_DIR:
        process.env.AICOACH_MODELS_DIR || join(homedir(), '.cache', 'aicoach-models')
    }

    const proc = spawn(python, ['-u', sidecarPath], {
      windowsHide: true,
      env
    })
    this.proc = proc

    // stdout：按行解析（readline 自带分帧，长度防御靠接收前检查）
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      if (line.length > MAX_LINE_BYTES) {
        console.error('[Sidecar] 响应行超长，丢弃')
        return
      }
      this.handleResponse(line)
    })

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      this.logStream?.write(text)
      if (/Traceback|Error/i.test(text)) {
        console.warn('[Sidecar]', text.trim().split('\n').slice(-3).join(' | '))
      }
    })

    proc.on('exit', (code) => {
      this.proc = null
      // 未决请求全部死信
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new SidecarError('E_SIDECAR_DEAD', `边车已退出(code=${code})`))
        this.pending.delete(id)
      }
      if (this.manualShutdown) return
      // 自动重启：10 分钟窗口内最多 3 次
      if (Date.now() - this.restartWindowStart > 10 * 60_000) {
        this.restartWindowStart = Date.now()
        this.restartCount = 0
      }
      if (this.restartCount >= 3) {
        this.onEvent?.({ type: 'dead', message: '边车反复崩溃（10 分钟内 3 次），已停止自动重启，请到设置页手动重启。' })
        return
      }
      this.restartCount += 1
      console.warn(`[Sidecar] 退出(code=${code})，第 ${this.restartCount} 次自动重启…`)
      this.onEvent?.({ type: 'restarted', message: `边车异常退出，自动重启（第 ${this.restartCount} 次）` })
      setTimeout(() => this.start(), 1000)
    })
  }

  request(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    this.ensureStarted()
    if (!this.proc) {
      return Promise.reject(new SidecarError('E_SIDECAR_DEAD', '边车不可用'))
    }
    const id = `r-${++this.reqSeq}`
    const timeout = timeoutMs ?? DEFAULT_TIMEOUTS[cmd] ?? 60_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 只回错误不杀进程（可能只是慢）
        reject(new SidecarError(`E_TIMEOUT_${cmd.toUpperCase()}`, `命令 ${cmd} 超时(${timeout}ms)`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      const line = JSON.stringify({ id, cmd, params })
      this.proc!.stdin!.write(line + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new SidecarError('E_SIDECAR_DEAD', `写入边车失败: ${err.message}`))
        }
      })
    })
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return
    this.manualShutdown = true
    try {
      await this.request('shutdown', {}, 8000)
    } catch {
      // 忽略：下面强杀兜底
    }
    setTimeout(() => {
      if (this.proc) {
        try {
          // Windows 下杀进程树
          // eslint-disable-next-line
          const { exec } = require('child_process') as typeof import('child_process')
          exec(`taskkill /pid ${this.proc!.pid} /T /F`)
        } catch {
          this.proc?.kill()
        }
      }
    }, 2000)
  }

  private handleResponse(line: string): void {
    let resp: SidecarResponse
    try {
      resp = JSON.parse(line) as SidecarResponse
    } catch (e) {
      console.error('[Sidecar] 响应解析失败', line.slice(0, 200), e)
      return
    }
    const p = this.pending.get(resp.id)
    if (!p) return
    this.pending.delete(resp.id)
    clearTimeout(p.timer)
    if (resp.ok) {
      p.resolve(resp.result)
    } else {
      p.reject(new SidecarError(resp.error?.code ?? 'E_INTERNAL', resp.error?.message ?? '未知错误', resp.error?.detail))
    }
  }
}

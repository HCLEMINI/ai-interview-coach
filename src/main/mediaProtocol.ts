// media:// 协议：把 app-data 下的 tts-cache 与 sessions 音频映射给渲染层 <audio>/<video> 播放
import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { getDataRoot, ttsCacheDir, sessionsDir } from './paths'

/** app ready 前调用（注册特权 scheme，允许流式播放） */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { stream: true, secure: true, supportFetchAPI: true } }
  ])
}

/** app ready 后调用 */
export function handleMediaProtocol(): void {
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const host = url.hostname // tts | session
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    if (parts.some((p) => p === '..' || p === '.')) {
      return new Response('bad path', { status: 400 })
    }

    let filePath: string | null = null
    if (host === 'tts') {
      if (parts.length !== 1) return new Response('bad tts path', { status: 400 })
      filePath = join(ttsCacheDir(), parts[0])
    } else if (host === 'session') {
      if (parts.length < 2) return new Response('bad session path', { status: 400 })
      filePath = join(sessionsDir(), ...parts)
    } else {
      return new Response('unknown host', { status: 404 })
    }

    // 双保险：最终路径必须仍在数据根目录下
    if (!filePath.startsWith(getDataRoot())) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

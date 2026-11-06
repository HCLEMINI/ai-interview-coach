// 数据目录唯一来源：便携版在 exe 旁 data\，安装版在 %APPDATA%\ai-interview-coach(-dev)
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'

let dataRoot: string | null = null

export function isPortableMode(): boolean {
  try {
    // eslint-disable-next-line
    const fs = require('fs')
    return fs.existsSync(join(app.getAppPath(), '..', 'portable.txt'))
  } catch {
    return false
  }
}

/** 必须在 app ready 前调用（配置 userData 路径） */
export function configurePaths(): void {
  if (isPortableMode()) {
    const portableData = join(app.getAppPath(), '..', 'data')
    if (!existsSync(portableData)) mkdirSync(portableData, { recursive: true })
    app.setPath('userData', join(portableData, 'session'))
    app.setPath('sessionData', join(portableData, 'session'))
    dataRoot = portableData
  } else {
    dataRoot = app.getPath('userData')
  }
}

export function getDataRoot(): string {
  if (!dataRoot) throw new Error('getDataRoot called before configurePaths')
  return dataRoot
}

export const DATA_SUBDIRS = [
  'sessions',
  'tts-cache',
  'models',
  'question-bank',
  'company-cards',
  'digest',
  'logs'
] as const

/** app ready 后调用：确保数据目录树存在 */
export function ensureDataTree(): void {
  const root = getDataRoot()
  for (const dir of DATA_SUBDIRS) {
    const p = join(root, dir)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }
}

export function sessionsDir(): string {
  return join(getDataRoot(), 'sessions')
}

export function sessionDir(sessionId: string): string {
  return join(sessionsDir(), sessionId)
}

export function questionBankDir(): string {
  return join(getDataRoot(), 'question-bank')
}

export function ttsCacheDir(): string {
  return join(getDataRoot(), 'tts-cache')
}

export function companyCardsDir(): string {
  return join(getDataRoot(), 'company-cards')
}

export function digestDir(): string {
  return join(getDataRoot(), 'digest')
}

export function gatewayConfigPath(): string {
  return join(getDataRoot(), 'gateway.json')
}

export function trendsPath(): string {
  return join(getDataRoot(), 'trends.json')
}

export function logsDir(): string {
  return join(getDataRoot(), 'logs')
}

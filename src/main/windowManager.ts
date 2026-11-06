// 单主窗口管理（标准系统标题栏）
import { BrowserWindow } from 'electron'
import { join } from 'path'

let mainWindow: BrowserWindow | null = null

export function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'AI面试模拟舱',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

import { app, BrowserWindow, nativeTheme } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { registerIpcHandlers } from './ipcHandlers'
import { createWindow, getMainWindow } from './windowManager'
import { configurePaths, ensureDataTree, getDataRoot } from './paths'
import { registerMediaScheme, handleMediaProtocol } from './mediaProtocol'
import type { Runtime } from './ipcHandlers'

// media:// 协议须在 app ready 前注册
registerMediaScheme()

// Windows GPU 后端修复（沿用 MultiChat 实测经验）
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('use-angle', 'gl')
}

let runtimeRef: Runtime | null = null

// ============ 单实例锁定 ============
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  // 路径配置必须在 app ready 前
  configurePaths()

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'light'

    ensureDataTree()
    console.log('[Main] 数据目录:', getDataRoot())

    electronApp.setAppUserModelId('com.aicoach.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // media:// 文件映射
    handleMediaProtocol()

    // electron-store（dev/prod 文件名分离）
    const store = new Store({
      name: is.dev ? 'config-dev' : 'config',
      cwd: getDataRoot()
    })

    runtimeRef = registerIpcHandlers(store, getMainWindow)

    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    runtimeRef?.finalizeOnQuit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

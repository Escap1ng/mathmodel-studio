import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'

// 开发时 electron-vite 会注入 ELECTRON_RENDERER_URL；打包后走 out/renderer/index.html。
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    // 主色调是白：窗口底色先于首帧就位，避免 Windows 上黑底闪一下
    backgroundColor: '#ffffff',
    title: 'mathmodel-studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => win.show())

  if (DEV_SERVER_URL && !app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 渲染层拿不到 Node 能力，也不该拿到：外部链接一律走 shell.openExternal，且只放 https。
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const allowedOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : 'file:'
    const origin = url.startsWith('file://') ? 'file:' : new URL(url).origin
    if (origin !== allowedOrigin) event.preventDefault()
  })
})

ipcMain.handle('app:meta', () => ({
  version: app.getVersion(),
  platform: process.platform,
  Electron: process.versions.electron,
  chrome: process.versions.chrome
}))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

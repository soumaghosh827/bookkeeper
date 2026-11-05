import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { vault } from './vault'

function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 840, minWidth: 1080, minHeight: 640, show: false, autoHideMenuBar: true,
    backgroundColor: '#f3f4f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // renderer cannot reach Node/Electron
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  // Offline app: never navigate away or open new windows from inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Single instance: two copies must never open the same database.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.whenReady().then(() => {
    registerIpc()
    createWindow()
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  })
  app.on('window-all-closed', () => { vault.lock(); if (process.platform !== 'darwin') app.quit() })
}

import { app, BrowserWindow, shell, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "path";
import { registerIpc } from "./ipc";
import { vault } from "./vault";

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1080,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f4f7",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, // renderer cannot reach Node/Electron
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Offline app: never navigate away or open new windows from inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  if (process.env["ELECTRON_RENDERER_URL"])
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
}

// ---- Updates: checked against the GitHub releases named in electron-builder.yml ----
function startUpdateChecks() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // "Later" installs on the next close
  autoUpdater.on("error", (err) =>
    console.error("Update check failed:", err?.message || err),
  );
  // Close the database cleanly before the installer takes over
  app.on("before-quit", () => vault.lock());

  let asked = false;
  autoUpdater.on("update-downloaded", async (info) => {
    if (asked) return; // one question per session
    asked = true;
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 1, // Enter picks "Later", so an update never interrupts work by accident
      cancelId: 1,
      title: "Update ready",
      message: `BookKeeper ${info.version} is ready to install.`,
      detail: "Choose Later to install it the next time you close the app.",
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true);
  });

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e) => console.error("Check failed:", e?.message || e));
  setTimeout(check, 15 * 1000); // let the app settle first
  setInterval(check, 60 * 60 * 1000);
}

// Single instance: two copies must never open the same database.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    if (app.isPackaged) startUpdateChecks(); // not while running from source
    app.on(
      "activate",
      () => BrowserWindow.getAllWindows().length === 0 && createWindow(),
    );
  });
  app.on("window-all-closed", () => {
    vault.lock();
    if (process.platform !== "darwin") app.quit();
  });
}

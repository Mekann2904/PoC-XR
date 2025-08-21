const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const STORE_FILE = 'store.json';

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function loadStore() {
  try {
    const p = getStorePath();
    if (!fs.existsSync(p)) return { settings: {}, recents: [] };
    const raw = fs.readFileSync(p, 'utf-8');
    const obj = JSON.parse(raw);
    return { settings: obj.settings || {}, recents: obj.recents || [] };
  } catch {
    return { settings: {}, recents: [] };
  }
}

function saveStore(data) {
  try {
    const p = getStorePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('store save error', e);
  }
}

function addRecent(filePath) {
  const store = loadStore();
  const list = store.recents || [];
  const next = [filePath, ...list.filter(p => p !== filePath)].slice(0, 10);
  saveStore({ ...store, recents: next });
  return next;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 追加の安全設定とログ
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  win.webContents.on('did-fail-load', (e, errorCode, errorDesc, validatedURL) => {
    console.error('did-fail-load', { errorCode, errorDesc, validatedURL });
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const lvl = ['log','warn','error'][Math.min(2, Math.max(0, level-1))] || 'log';
    console[lvl](`[renderer:${lvl}]`, message, `(${sourceId}:${line})`);
  });

  return win;
}

// Camera permission: allow only media
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    return callback(false);
  });

  const win = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // IPC: dialog to open PMX
  ipcMain.handle('dialog:open-model', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'MikuMikuDance Model', extensions: ['pmx'] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return null;
    const fp = filePaths[0];
    addRecent(fp);
    return fp;
  });

  // IPC: store get/set
  ipcMain.handle('store:get', async (e, key) => {
    const store = loadStore();
    if (!key) return store;
    return store[key];
  });

  ipcMain.handle('store:set', async (e, partial) => {
    const store = loadStore();
    const next = { ...store, ...partial };
    saveStore(next);
    return next;
  });

  ipcMain.handle('recent:list', async () => {
    const store = loadStore();
    return store.recents || [];
  });

  ipcMain.handle('recent:add', async (e, filePath) => {
    return addRecent(filePath);
  });

  // Restricted FS read: allow only under allowedBaseDir
  let allowedBaseDir = null;
  ipcMain.handle('fs:set-base', async (e, baseDir) => {
    try {
      const norm = fs.realpathSync(path.resolve(baseDir || ''));
      if (!fs.existsSync(norm) || !fs.statSync(norm).isDirectory()) return false;
      allowedBaseDir = norm;
      return true;
    } catch { return false; }
  });

  ipcMain.handle('fs:read', async (e, absPath) => {
    try {
      if (!allowedBaseDir) throw new Error('base not set');
      const norm = fs.realpathSync(path.resolve(absPath));
      if (!norm.startsWith(allowedBaseDir)) throw new Error('out of base');
      return fs.readFileSync(norm);
    } catch (err) {
      console.error('fs:read error', err);
      return null;
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

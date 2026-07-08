'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const usage = require('./usage');

// ─── 경로 설정 ───────────────────────────────────────────────────────────────
const CLAUDE_LOG_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_LOG_DIR  = path.join(os.homedir(), '.codex', 'sessions');

// ─── 상태 ─────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
const watchers = new Map(); // dir -> FSWatcher

// ─── 윈도우 생성 ──────────────────────────────────────────────────────────────
const WIN_W = 420;
const WIN_MARGIN = 12;
const COMPACT_H = 112; // 타이틀바 + TODAY 요약만

function normalHeight() {
  const wa = screen.getPrimaryDisplay().workArea;
  return Math.min(410, wa.height - WIN_MARGIN * 2);
}

function applyWindowBounds(compact) {
  if (!mainWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const H = compact ? COMPACT_H : normalHeight();
  mainWindow.setBounds({
    x: wa.x + wa.width - WIN_W - WIN_MARGIN,
    y: wa.y + wa.height - H - WIN_MARGIN,
    width: WIN_W,
    height: H,
  });
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = WIN_W;
  const MARGIN = WIN_MARGIN;
  const H = normalHeight();

  mainWindow = new BrowserWindow({
    width: W,
    height: H,
    x: wa.x + wa.width - W - MARGIN,
    y: wa.y + wa.height - H - MARGIN,
    icon: appIcon(),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    hasShadow: true,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── 트레이 ───────────────────────────────────────────────────────────────────
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');

function appIcon() {
  const img = nativeImage.createFromPath(ICON_PATH);
  if (!img.isEmpty()) return img;
  // 폴백: 투명 16x16 PNG
  return nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
    'AAALEgAACxIB0t1+/AAAABx0RVh0U29mdHdhcmUAQWRvYmUgRmlyZXdvcmtzIENTNui8sowAAAAW' +
    'SURBVDiNY2AYBaNgFAxzwH8GBgABBAABaQ4HGgAAAABJRU5ErkJggg==',
    'base64'
  ));
}

function createTray() {
  tray = new Tray(appIcon().resize({ width: 16, height: 16 }));

  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleVisibility },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('AI Token Monitor');
  tray.on('click', toggleVisibility);
}

function toggleVisibility() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) { mainWindow.restore(); mainWindow.show(); return; }
  if (mainWindow.isVisible()) { mainWindow.hide(); } else { mainWindow.show(); }
}

// ─── 환율 (USD → KRW) ─────────────────────────────────────────────────────────
const FX_FALLBACK = 1520;
const FX_TTL = 6 * 3600_000;       // 성공 시 6시간 캐시
const FX_RETRY = 10 * 60_000;      // 실패 시 10분 후 재시도
let fxCache = { rate: FX_FALLBACK, source: 'fallback', fetchedAt: 0 };
let fxInFlight = null;

function fetchFxRate() {
  return new Promise((resolve) => {
    const req = https.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const rate = Number(json?.rates?.KRW);
          if (rate > 0) return resolve({ rate, source: 'live', fetchedAt: Date.now() });
        } catch {}
        resolve(null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function getFx() {
  const age = Date.now() - fxCache.fetchedAt;
  const ttl = fxCache.source === 'live' ? FX_TTL : FX_RETRY;
  if (age > ttl) {
    if (!fxInFlight) {
      fxInFlight = fetchFxRate()
        .then((fresh) => {
          fxCache = fresh || { rate: FX_FALLBACK, source: 'fallback', fetchedAt: Date.now() };
        })
        .finally(() => { fxInFlight = null; });
    }
    await fxInFlight;
  }
  return fxCache;
}

// ─── IPC 핸들러 ───────────────────────────────────────────────────────────────
ipcMain.handle('get-data', (_, provider) => {
  try {
    const claudeEntries = provider === 'codex'  ? [] : usage.parseClaudeLogs(CLAUDE_LOG_DIR);
    const codexEntries  = provider === 'claude' ? [] : usage.parseCodexLogs(CODEX_LOG_DIR);
    return usage.aggregate([...claudeEntries, ...codexEntries]);
  } catch (err) {
    console.error('get-data failed:', err);
    return usage.aggregate([]);
  }
});

ipcMain.handle('get-fx', () => getFx());

ipcMain.handle('get-log-paths', () => ({
  claude: CLAUDE_LOG_DIR,
  codex:  CODEX_LOG_DIR,
  claudeExists: fs.existsSync(CLAUDE_LOG_DIR),
  codexExists:  fs.existsSync(CODEX_LOG_DIR),
}));

ipcMain.on('set-compact', (_, compact) => {
  applyWindowBounds(Boolean(compact));
});
ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.hide();
});
ipcMain.on('toggle-window', toggleVisibility);

// ─── 파일 감시 (디바운스) ─────────────────────────────────────────────────────
let notifyTimer = null;
function notifyDataChanged() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    if (mainWindow) mainWindow.webContents.send('data-changed');
  }, 500);
}

function watchLogs() {
  for (const dir of [CLAUDE_LOG_DIR, CODEX_LOG_DIR]) {
    if (watchers.has(dir) || !fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { recursive: true }, (_e, filename) => {
        if (!filename) return;
        if (filename.endsWith('.jsonl') || filename.endsWith('.json')) notifyDataChanged();
      });
      // 디렉토리 삭제/권한 변경 시 감시 해제 → 5분 재시도 주기에서 재등록
      w.on('error', () => {
        try { w.close(); } catch {}
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {}
  }
}

// ─── 앱 라이프사이클 ──────────────────────────────────────────────────────────
// 단일 인스턴스: 이미 실행 중이면 기존 창을 앞으로
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    watchLogs();
    getFx(); // 초기 환율 프리페치
    // 나중에 생성되는 로그 디렉토리 감시 재시도
    setInterval(watchLogs, 5 * 60_000);
  });
}

app.on('window-all-closed', () => {
  // Tray 앱이므로 모든 윈도우가 닫혀도 종료 안 함 (Tray 메뉴로만 종료)
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  for (const w of watchers.values()) { try { w.close(); } catch {} }
  watchers.clear();
});

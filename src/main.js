"use strict";
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, nativeTheme, systemPreferences, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { LocalUsage } = require("./local-usage");
const { fetchLimits } = require("./limits");
const installer = require("./installer");
const demo = process.env.HUD_DEMO ? require("./demo") : null;

// 資料夾名稱沿用最早的 claude-hud-zh，改了會找不到既有的用量紀錄
app.setName("claude-hud-zh");
app.setPath("userData", path.join(app.getPath("appData"), "claude-hud-zh"));
app.setAppUserModelId("ClaudeUsageHUD");
// 「已安裝的應用程式」裡按解除安裝會用 --uninstall 啟動；若程式正在執行，交給執行中的那一個處理
if (!app.requestSingleInstanceLock({ argv: process.argv })) { app.quit(); return; }

const TITLE = "Claude Usage HUD";
// 尺寸與座標一律取 4 的倍數：Windows 縮放 125%／150%／175% 時才會剛好是整數像素，
// 否則 Electron 換算時會多進位幾個像素，視窗會變大或被推出螢幕外。
const COLLAPSED = { w: 64, h: 172 };
const EXPANDED = { w: 388, h: 700 };
const q4 = (v) => Math.round(v / 4) * 4;
const LIMITS_EVERY = 5 * 60 * 1000;
const SCAN_EVERY = 60 * 1000;

// ---------- 設定 ----------
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const settings = Object.assign({ posFrac: 0.35, range: "7", importedLegacy: false, theme: "system", color: null, lang: "system" }, readJson(settingsFile));
// 設定檔第 2 版：語言預設改成跟隨系統。舊版會把當時的預設值 "zh" 寫進檔案，那不是使用者選的，改回跟隨系統。
if (!settings.version || settings.version < 2) {
  if (settings.lang === "zh") settings.lang = "system";
  settings.version = 2;
}

// 「跟隨系統」：Windows 的顯示語言是中文就用中文，其他一律英文
function systemLang() {
  const prefs = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()) || [];
  const l = String(prefs[0] || app.getLocale() || "").toLowerCase();
  return l.startsWith("zh") ? "zh" : "en";
}
function uiLang() {
  const l = process.env.HUD_LANG || settings.lang;
  return l === "zh" || l === "en" ? l : systemLang();
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch {}
}

// ---------- 狀態 ----------
const usage = new LocalUsage(path.join(app.getPath("userData"), "usage-cache.json")).load();
const limitsFile = path.join(app.getPath("userData"), "limits-cache.json");
let limits = readJson(limitsFile).windows ? readJson(limitsFile) : null; // 最近一次成功取得的上限資料
let limitsError = null;     // 最近一次失敗原因
let limitsBusy = false;
let nextAllowedAt = process.env.HUD_OFFLINE || process.env.HUD_DEMO ? Infinity : 0; // 被限流時，這個時間之前不再查詢（HUD_OFFLINE：測試時不查詢）
let backoff = 0;
let expanded = false;
let win = null, tray = null;

function state() {
  return {
    expanded,
    // HUD_DEMO：用假資料（給 README 截圖用，不會露出真實用量）
    limits: demo ? demo.limits() : limits, limitsError: demo ? null : limitsError, limitsBusy: demo ? false : limitsBusy,
    summary: demo ? demo.summary(settings.range) : usage.summary(settings.range),
    settings: { range: settings.range, openAtLogin: app.getLoginItemSettings().openAtLogin, theme: settings.theme, color: settings.color, lang: settings.lang, uiLang: uiLang() },
    accent: accentColor(),
  };
}
// Windows 的強調色（使用者在「個人化 → 色彩」選的顏色），用在選取狀態
function accentColor() {
  try { const c = systemPreferences.getAccentColor(); return c ? "#" + c.slice(0, 6) : null; } catch { return null; }
}
function push() { if (win && !win.isDestroyed()) win.webContents.send("state", state()); }

// ---------- 視窗位置 ----------
function workArea() { return screen.getPrimaryDisplay().workArea; }

function boundsFor(isExpanded) {
  const wa = workArea();
  const size = isExpanded ? { w: EXPANDED.w, h: Math.min(EXPANDED.h, q4(wa.height - 26)) } : COLLAPSED;
  const centerY = wa.y + wa.height * settings.posFrac;
  let y = isExpanded ? centerY - COLLAPSED.h / 2 - 40 : centerY - size.h / 2;
  y = q4(Math.max(wa.y + 12, Math.min(y, wa.y + wa.height - size.h - 12)));
  return { x: wa.x + wa.width - size.w, y, width: size.w, height: size.h };
}

function place() { if (win) win.setBounds(boundsFor(expanded)); }

// 收起時視窗大小不變，只露出邊緣的把手；透明的部分讓滑鼠穿透到後面的視窗。
// 滑鼠碰到把手時由畫面通知主程式接手滑鼠（capture）。
function setCapture(on) { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); }

let closing = false, closeTimer = null;
let openedAt = 0, blurClosedAt = 0;
let holdOpen = false; // 選色視窗開著時，失焦不收回
function setExpanded(v) {
  if (v) {
    if (expanded && !closing) return;
    clearTimeout(closeTimer); closing = false;
    expanded = true;
    openedAt = Date.now();
    setCapture(true);
    push(); place(); win.focus(); refreshLimits(false);
  } else {
    if (!expanded || closing) return;
    // 先讓畫面播放收起動畫，播完（或逾時）再縮回小標籤
    closing = true;
    win.webContents.send("closing");
    closeTimer = setTimeout(finishCollapse, 500);
  }
  updateTrayMenu();
}
function finishCollapse() {
  if (!closing) return;
  clearTimeout(closeTimer); closing = false;
  expanded = false;
  place(); setCapture(false); push();
  updateTrayMenu();
}

function createWindow() {
  win = new BrowserWindow({
    ...(() => { const b = boundsFor(false); return { x: b.x, y: b.y, width: b.width, height: b.height }; })(),
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, title: TITLE,
    icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // 建立視窗時的尺寸換算可能有誤差，建好後再用 setBounds 校正一次
  win.setBounds(boundsFor(false));
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.once("ready-to-show", () => { setCapture(false); win.showInactive(); push(); });
  // 不讓面板開任何外部網頁
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // 點面板以外的地方（面板失去焦點）就自動收回。
  // 剛展開的瞬間 Windows 可能還在切換焦點，忽略前 300 毫秒的失焦。
  win.on("blur", () => {
    if (!expanded || closing || holdOpen || Date.now() - openedAt < 300 || process.env.HUD_SHOT) return;
    // 稍等一下再確認：打開選色視窗時，「暫停收回」的通知可能比失焦晚一點到
    setTimeout(() => {
      if (!expanded || closing || holdOpen || win.isFocused()) return;
      blurClosedAt = Date.now();
      setExpanded(false);
    }, 150);
  });
}

// ---------- 系統匣 ----------
function iconPath() { return path.join(__dirname, "..", "build", "icon.png"); }

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(TITLE);
  // 點系統匣圖示時，面板會先因失焦而收起；這一下點擊不要又把它打開
  tray.on("click", () => { if (Date.now() - blurClosedAt < 400) return; setExpanded(!expanded || closing); });
  updateTrayMenu();
}

// 系統匣選單的文字（面板的文字在 ui/i18n.js）
const TRAY_TEXT = {
  zh: { title: "Claude 用量監視器", hide: "收起面板", show: "展開面板", refresh: "立即更新", login: "開機時自動啟動",
    resetPos: "面板位置重設", folder: "開啟資料夾", uninstall: "解除安裝…", quit: "結束", sep: "：",
    win: { five_hour: "5 小時", seven_day: "每週" } },
  en: { title: "Claude Usage HUD", hide: "Hide panel", show: "Show panel", refresh: "Refresh now", login: "Start with Windows",
    resetPos: "Reset panel position", folder: "Open data folder", uninstall: "Uninstall…", quit: "Quit", sep: ": ",
    win: { five_hour: "5-hour", seven_day: "Weekly" } },
};

function updateTrayMenu() {
  if (!tray) return;
  const t = TRAY_TEXT[uiLang()];
  const lim = limits && limits.windows;
  const tip = lim ? t.title + "\n" + lim.slice(0, 2).map((w) => (t.win[w.key] || w.key) + t.sep + Math.round(w.percent) + "%").join("\n") : t.title;
  tray.setToolTip(tip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: expanded ? t.hide : t.show, click: () => setExpanded(!expanded) },
    { label: t.refresh, click: () => refreshAll() },
    { type: "separator" },
    { label: t.login, type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (m) => setLogin(m.checked) },
    { label: t.resetPos, click: () => { settings.posFrac = 0.35; saveSettings(); place(); } },
    { label: t.folder, click: () => shell.openPath(app.getPath("userData")) },
    ...(installer.isInstalled() ? [{ label: t.uninstall, click: () => uninstallFlow() }] : []),
    { type: "separator" },
    { label: t.quit, click: () => app.quit() },
  ]));
}

// ---------- 安裝／解除安裝 ----------
const DIALOG_TEXT = {
  zh: {
    installQ: "要把 Claude Usage HUD 安裝到這台電腦嗎？",
    installD: "會複製到你的使用者程式資料夾，並建立開始功能表和桌面捷徑，也會出現在「設定 → 應用程式」裡可以解除安裝。不需要系統管理員權限。\n\n安裝好之後，下載的這個資料夾就可以刪掉了。",
    install: "安裝", portable: "不安裝，直接執行", dontAsk: "不要再問（直接執行這個資料夾裡的版本）",
    installFail: "安裝失敗", installFailD: "改用直接執行的方式開啟。\n\n",
    uninstallQ: "要解除安裝 Claude Usage HUD 嗎？",
    uninstallD: "會移除程式、捷徑和開機自動啟動。",
    uninstall: "解除安裝", cancel: "取消", removeData: "同時刪除用量紀錄和設定",
  },
  en: {
    installQ: "Install Claude Usage HUD on this computer?",
    installD: "It will be copied to your user Programs folder, with Start menu and desktop shortcuts, and listed in Settings → Apps so you can uninstall it. No administrator rights needed.\n\nAfter installing, you can delete this downloaded folder.",
    install: "Install", portable: "Just run it", dontAsk: "Don't ask again (run this folder's copy)",
    installFail: "Installation failed", installFailD: "Running from this folder instead.\n\n",
    uninstallQ: "Uninstall Claude Usage HUD?",
    uninstallD: "This removes the app, its shortcuts and the start-with-Windows entry.",
    uninstall: "Uninstall", cancel: "Cancel", removeData: "Also delete usage history and settings",
  },
};

// 從下載的資料夾第一次執行時，問要不要安裝。回傳 true 表示已安裝並交給新位置的程式，這個要結束。
async function offerInstall() {
  if (!app.isPackaged || installer.isInstalled() || settings.skipInstallPrompt) return false;
  const t = DIALOG_TEXT[uiLang()];
  const r = await dialog.showMessageBox({
    type: "question", title: "Claude Usage HUD", message: t.installQ, detail: t.installD,
    buttons: [t.install, t.portable], defaultId: 0, cancelId: 1, checkboxLabel: t.dontAsk, noLink: true,
  });
  if (r.response !== 0) {
    if (r.checkboxChecked) { settings.skipInstallPrompt = true; saveSettings(); }
    return false;
  }
  try {
    const exe = installer.install();
    app.releaseSingleInstanceLock(); // 讓安裝好的那一個能啟動
    await shell.openPath(exe);
    return true;
  } catch (e) {
    dialog.showErrorBox(t.installFail, t.installFailD + (e && e.message || e));
    return false;
  }
}

async function uninstallFlow() {
  const t = DIALOG_TEXT[uiLang()];
  const r = await dialog.showMessageBox({
    type: "warning", title: "Claude Usage HUD", message: t.uninstallQ, detail: t.uninstallD,
    buttons: [t.uninstall, t.cancel], defaultId: 1, cancelId: 1, checkboxLabel: t.removeData, noLink: true,
  });
  if (r.response !== 0) return;
  installer.uninstall({ removeData: r.checkboxChecked });
  app.exit(0);
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
  updateTrayMenu();
  push();
}

// ---------- 更新資料 ----------
async function refreshLimits(force) {
  if (limitsBusy || Date.now() < nextAllowedAt) return;
  if (limits && Date.now() - limits.fetchedAt < (force ? 30 * 1000 : 2 * 60 * 1000)) return;
  limitsBusy = true; push();
  try {
    const r = await fetchLimits();
    if (r.ok) {
      limits = r; limitsError = null; backoff = 0;
      try { fs.writeFileSync(limitsFile, JSON.stringify(r)); } catch {}
    } else {
      if (r.error === "rate-limited") {
        // 被限流：照伺服器說的時間等，並且每次加倍，最多 30 分鐘
        backoff = Math.min(backoff ? backoff * 2 : LIMITS_EVERY, 30 * 60 * 1000);
        nextAllowedAt = Date.now() + Math.max(backoff, r.retryAfterMs || 0);
        r.retryAt = nextAllowedAt;
      }
      limitsError = r;
    }
  } finally {
    limitsBusy = false;
    updateTrayMenu();
    push();
  }
}

async function scan() {
  try { if (await usage.scan()) push(); } catch (e) { console.error(e); }
}

function refreshAll() { refreshLimits(true); scan().then(push); }

// ---------- IPC ----------
let drag = null;
ipcMain.on("toggle", () => setExpanded(!expanded || closing));
ipcMain.on("collapse", () => setExpanded(false));
ipcMain.on("collapse-done", () => finishCollapse());
ipcMain.on("capture", (_e, on) => { if (!expanded) setCapture(!!on); });
ipcMain.on("refresh", () => refreshAll());
ipcMain.on("set-range", (_e, r) => { if (["today", "7", "30", "all"].includes(r)) { settings.range = r; saveSettings(); push(); } });
ipcMain.on("set-login", (_e, on) => setLogin(on));
ipcMain.on("set-theme", (_e, t) => {
  if (!["system", "light", "dark"].includes(t)) return;
  settings.theme = t; saveSettings();
  nativeTheme.themeSource = t; // 畫面的 prefers-color-scheme 會跟著切換
  push();
});
ipcMain.on("hold-open", (_e, on) => { holdOpen = !!on; });
ipcMain.on("set-lang", (_e, l) => {
  if (!["system", "zh", "en"].includes(l)) return;
  settings.lang = l; saveSettings();
  updateTrayMenu();
  push();
});
ipcMain.on("set-color", (_e, c) => {
  if (c !== null && !/^#[0-9a-f]{6}$/i.test(c)) return;
  settings.color = c; saveSettings();
  push();
});
ipcMain.on("quit", () => app.quit());
// 拖曳時一律用固定尺寸設定視窗：在 Windows 縮放比例不是 100% 時，
// 讀回 getBounds() 再設回去會讓尺寸每次多一點，越拖越大。
ipcMain.on("drag-start", (_e, screenY) => { if (!expanded) drag = { screenY, y: boundsFor(false).y }; });
ipcMain.on("drag-move", (_e, screenY) => {
  if (!drag || expanded) return;
  const wa = workArea();
  let y = drag.y + (screenY - drag.screenY);
  y = q4(Math.max(wa.y + 12, Math.min(y, wa.y + wa.height - COLLAPSED.h - 12)));
  drag.lastY = y;
  win.setBounds({ x: wa.x + wa.width - COLLAPSED.w, y, width: COLLAPSED.w, height: COLLAPSED.h });
});
ipcMain.on("drag-end", () => {
  if (!drag) return;
  if (drag.lastY != null) {
    const wa = workArea();
    settings.posFrac = (drag.lastY + COLLAPSED.h / 2 - wa.y) / wa.height;
    saveSettings();
  }
  drag = null;
  place();
});
ipcMain.handle("get-state", () => state());

// ---------- 啟動 ----------
app.on("second-instance", (_e, argv, _cwd, data) => {
  const args = (data && data.argv) || argv || [];
  if (args.includes("--uninstall")) uninstallFlow();
  else setExpanded(true);
});
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
  if (process.argv.includes("--uninstall")) { await uninstallFlow(); app.quit(); return; }
  // --install：開發用，安靜地安裝後啟動已安裝的版本（npm run install-app）
  if (process.argv.includes("--install")) {
    const exe = installer.install();
    app.releaseSingleInstanceLock();
    await shell.openPath(exe);
    app.exit(0); return;
  }
  if (await offerInstall()) { app.exit(0); return; }

  if (!settings.importedLegacy) {
    const legacy = path.join(app.getPath("appData"), "claude-hud", "usage-cache.json");
    const n = usage.importLegacy(legacy);
    if (n) usage.save();
    settings.importedLegacy = true;
    saveSettings();
  }
  createWindow();
  createTray();
  // 跟著系統切換深淺色與強調色（HUD_THEME=light|dark：測試用）
  nativeTheme.themeSource = process.env.HUD_THEME || settings.theme;
  nativeTheme.on("updated", push);
  systemPreferences.on && systemPreferences.on("accent-color-changed", push);
  screen.on("display-metrics-changed", place);
  screen.on("display-added", place);
  screen.on("display-removed", place);
  refreshLimits(true);
  await scan();
  push();
  setInterval(() => refreshLimits(true), LIMITS_EVERY);
  setInterval(scan, SCAN_EVERY);
  // 跨日時讓「今天」的統計換日
  setInterval(push, 5 * 60 * 1000);
  // 第一次啟動時自動展開一次，讓人知道它在螢幕右邊
  if (!settings.welcomed && !process.env.HUD_SHOT && !process.env.HUD_BLURTEST) {
    settings.welcomed = true; saveSettings();
    setTimeout(() => setExpanded(true), 1200);
  }
  if (process.env.HUD_SHOT) selfShot(process.env.HUD_SHOT);
  if (process.env.HUD_BLURTEST) blurTest(process.env.HUD_BLURTEST);
});

// 開發用：展開面板 → 開另一個視窗搶走焦點（模擬點了面板以外的地方）→ 確認面板自動收回
function blurTest(file) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(async () => {
    setExpanded(true);
    await wait(800);
    const before = { expanded, focused: win.isFocused() };
    const other = new BrowserWindow({ width: 300, height: 200, x: 100, y: 100, show: true, title: "other" });
    other.focus();
    await wait(1000);
    const after = { expanded, closing, focused: win.isFocused(), bounds: win.getBounds() };
    other.destroy();
    fs.writeFileSync(file, JSON.stringify({ before, after }, null, 1));
    app.quit();
  }, 2500);
}

// 開發用：截下收起與展開兩種畫面後結束（HUD_SHOT=輸出資料夾）
function selfShot(dir) {
  const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(async () => {
    await shot("1-hidden.png");
    await win.webContents.executeJavaScript("window.__peek(true)");
    await wait(220); await shot("2-peek-mid.png");
    await wait(900); await shot("3-peek.png");
    // 模擬拖曳：上下來回 60 次，確認視窗尺寸不會跑掉
    const before = win.getBounds(), sizes = new Set();
    await win.webContents.executeJavaScript(`(async () => {
      window.hud.dragStart(500);
      for (let i = 0; i < 60; i++) { window.hud.dragMove(500 + Math.round(Math.sin(i / 5) * 120)); await new Promise(r => setTimeout(r, 16)); }
      window.hud.dragMove(500); window.hud.dragEnd();
    })()`);
    await wait(300);
    sizes.add(win.getBounds().width + "x" + win.getBounds().height);
    fs.writeFileSync(path.join(dir, "drag.json"), JSON.stringify({ before, after: win.getBounds(), scale: screen.getPrimaryDisplay().scaleFactor }));
    setExpanded(true);
    await wait(150); await shot("4-open-mid.png");
    await wait(1400); await shot("5-expanded.png");
    fs.writeFileSync(path.join(dir, "expanded.json"), JSON.stringify({ want: boundsFor(true), got: win.getBounds() }));
    await win.webContents.executeJavaScript('document.getElementById("scroll").scrollTop = 1e5');
    await wait(500); await shot("6-expanded-bottom.png");
    // 顏色設定：打開設定 → 選紫色 → 切深色，測完還原使用者原本的設定
    const orig = { theme: settings.theme, color: settings.color, lang: settings.lang };
    const js = (s) => win.webContents.executeJavaScript(s);
    await js('document.getElementById("scroll").scrollTop = 0; document.getElementById("btn-settings").click()');
    await wait(600); await shot("6a-settings.png");
    await js('document.querySelector(".swatch[data-c=\\"#8b5cf6\\"]").click()');
    await wait(600); await shot("6b-purple.png");
    await js('document.querySelector("#opt-theme button[data-t=\\"' + (nativeTheme.shouldUseDarkColors ? "light" : "dark") + '\\"]").click()');
    await wait(700); await shot("6c-purple-other-theme.png");
    if (!process.env.HUD_LANG) {
      await js('document.querySelector("#opt-lang button[data-l=\\"' + (uiLang() === "en" ? "zh" : "en") + '\\"]").click()');
      await wait(700); await shot("6e-lang-switched.png");
    }
    await js('document.getElementById("btn-settings").click(); document.getElementById("scroll").scrollTop = 1e5');
    await wait(600); await shot("6d-purple-bottom.png");
    settings.theme = orig.theme; settings.color = orig.color; settings.lang = orig.lang; saveSettings(); updateTrayMenu();
    nativeTheme.themeSource = process.env.HUD_THEME || orig.theme; push();
    await wait(300);
    setExpanded(false);
    await wait(120); await shot("7-closing-mid.png");
    await wait(800); await shot("8-closed.png");
    app.quit();
  }, 3000);
}

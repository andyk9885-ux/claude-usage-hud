"use strict";
// 內建安裝／解除安裝：不另外做安裝程式（沒簽章的新 exe 會被 Windows「智慧型應用程式控制」擋下），
// 而是讓程式自己把整個資料夾複製到 %LOCALAPPDATA%\Programs、建立捷徑、登記到「已安裝的應用程式」。
// 全部在使用者自己的資料夾和 HKCU 裡完成，不需要系統管理員權限。
const { app, shell } = require("electron");
const ofs = require("original-fs"); // 不把 app.asar 當資料夾處理，才能原封不動複製
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const NAME = "Claude Usage HUD";
const EXE = "ClaudeUsageHUD.exe";
const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ClaudeUsageHUD";

const installDir = () => path.join(process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"), "Programs", NAME);
const installedExe = () => path.join(installDir(), EXE);
const shortcuts = () => [
  path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", NAME + ".lnk"),
  path.join(app.getPath("desktop"), NAME + ".lnk"),
];

function isInstalled() {
  return path.resolve(path.dirname(process.execPath)).toLowerCase() === path.resolve(installDir()).toLowerCase();
}

function reg(args) { try { execFileSync("reg", args, { stdio: "ignore", windowsHide: true }); } catch {} }

// 安裝（或更新）。回傳安裝後的 exe 路徑。
function install() {
  const src = path.dirname(process.execPath), dest = installDir();
  if (path.resolve(src).toLowerCase() !== path.resolve(dest).toLowerCase()) {
    ofs.rmSync(dest, { recursive: true, force: true });
    ofs.mkdirSync(path.dirname(dest), { recursive: true });
    ofs.cpSync(src, dest, { recursive: true });
  }
  const exe = installedExe(), icon = path.join(dest, "icon.ico");
  for (const lnk of shortcuts()) {
    shell.writeShortcutLink(lnk, "create", { target: exe, cwd: dest, icon: ofs.existsSync(icon) ? icon : exe, iconIndex: 0, description: NAME });
  }
  // 登記到「設定 → 應用程式 → 已安裝的應用程式」，可以從那裡解除安裝
  const add = (name, type, data) => reg(["add", REG_KEY, "/v", name, "/t", type, "/d", data, "/f"]);
  add("DisplayName", "REG_SZ", NAME);
  add("DisplayVersion", "REG_SZ", app.getVersion());
  add("Publisher", "REG_SZ", "andyk9885-ux");
  add("DisplayIcon", "REG_SZ", ofs.existsSync(icon) ? icon : exe);
  add("InstallLocation", "REG_SZ", dest);
  add("UninstallString", "REG_SZ", `"${exe}" --uninstall`);
  add("URLInfoAbout", "REG_SZ", "https://github.com/andyk9885-ux/claude-usage-hud");
  add("NoModify", "REG_DWORD", "1");
  add("NoRepair", "REG_DWORD", "1");
  return exe;
}

// 解除安裝：移除捷徑、開機啟動、登錄項目，程式結束後再刪掉程式資料夾。
// 用量紀錄和設定（%APPDATA%\claude-hud-zh）預設保留，除非 removeData 為 true。
function uninstall({ removeData = false } = {}) {
  for (const lnk of shortcuts()) { try { ofs.rmSync(lnk, { force: true }); } catch {} }
  try { app.setLoginItemSettings({ openAtLogin: false, path: process.execPath }); } catch {}
  reg(["delete", REG_KEY, "/f"]);
  const targets = [installDir()];
  if (removeData) targets.push(app.getPath("userData"));
  // 等這個程式結束（約 3 秒）再刪資料夾，否則檔案還被占用。
  // 延遲用 ping（timeout 指令在沒有主控台時會失敗）；命令列要原封不動交給 cmd，
  // 否則 Node 會把引號跳脫成 \"，cmd 看不懂，路徑有空白就刪不掉。
  const cmd = "ping -n 4 127.0.0.1 >nul & " + targets.map((t) => `rmdir /s /q "${t}"`).join(" & ");
  spawn("cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
}

function launch(exe) {
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

module.exports = { NAME, isInstalled, install, uninstall, launch, installDir };

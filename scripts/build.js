"use strict";
// 打包到 dist/Claude Usage HUD/。
// 刻意「不修改」官方的 electron.exe（不改圖示、不改版本資訊），只改檔名：
// Windows「智慧型應用程式控制」會依檔案指紋判斷信譽，官方 electron.exe 的指紋很常見所以會放行；
// 一旦用 rcedit 改過圖示，指紋就變成全新的，會被擋下來無法執行。
// 程式圖示改由捷徑指向的 icon.ico 和執行時設定的視窗圖示提供。
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const out = path.join(root, "dist", "Claude Usage HUD");
const stage = path.join(root, "dist", "_app");

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });

  // 1. 原封不動複製官方 Electron，只把 electron.exe 改名
  fs.cpSync(electronDist, out, { recursive: true });
  fs.renameSync(path.join(out, "electron.exe"), path.join(out, "ClaudeUsageHUD.exe"));
  fs.rmSync(path.join(out, "resources", "default_app.asar"), { force: true });

  // 2. 把程式碼打包成 resources/app.asar
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.mkdirSync(path.join(stage, "build"), { recursive: true });
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  fs.cpSync(path.join(root, "src"), path.join(stage, "src"), { recursive: true });
  fs.rmSync(path.join(stage, "src", "demo.js"), { force: true }); // 示範資料只給截圖用
  fs.copyFileSync(path.join(root, "build", "icon.png"), path.join(stage, "build", "icon.png"));
  await asar.createPackage(stage, path.join(out, "resources", "app.asar"));
  fs.rmSync(stage, { recursive: true, force: true });

  // 3. 捷徑用的圖示、給下載者看的說明
  fs.copyFileSync(path.join(root, "build", "icon.ico"), path.join(out, "icon.ico"));
  fs.writeFileSync(path.join(out, "README.txt"), [
    "Claude Usage HUD " + pkg.version,
    "",
    "1. Make sure Claude Code is installed and you have signed in once (run `claude` in a terminal).",
    "2. Double-click ClaudeUsageHUD.exe. Choose \"Install\" to add Start menu / desktop shortcuts,",
    "   or \"Just run it\" to use it from this folder.",
    "3. Move the mouse to the right edge of the screen to see your usage.",
    "",
    "1. 先確認已安裝 Claude Code 並登入過一次（在終端機執行 claude）。",
    "2. 雙擊 ClaudeUsageHUD.exe，選「安裝」會建立開始功能表和桌面捷徑；選「不安裝，直接執行」則從這個資料夾執行。",
    "3. 把滑鼠移到螢幕右側邊緣就能看到用量。",
    "",
    "https://github.com/andyk9885-ux/claude-usage-hud",
    "",
  ].join("\r\n"));
  console.log("已打包到", out);
})().catch((e) => { console.error(e); process.exit(1); });

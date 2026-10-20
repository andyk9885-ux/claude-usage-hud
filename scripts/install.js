"use strict";
// 開發用：把 dist/ 裡剛打包好的版本安裝到這台電腦（等同使用者在對話框按「安裝」）。
// 實際的安裝邏輯在 src/installer.js，由程式自己執行 --install 完成。
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const exe = path.join(__dirname, "..", "dist", "Claude Usage HUD", "ClaudeUsageHUD.exe");
if (!fs.existsSync(exe)) {
  console.error("找不到打包結果，請先執行 npm run pack");
  process.exit(1);
}

// 先關掉正在執行的版本，否則檔案會被鎖住
try { execFileSync("taskkill", ["/IM", "ClaudeUsageHUD.exe", "/F"], { stdio: "ignore" }); } catch {}
const wait = Date.now() + 1500; while (Date.now() < wait) {}

spawn(exe, ["--install"], { detached: true, stdio: "ignore" }).unref();
console.log("安裝中：完成後會自動啟動已安裝的版本");

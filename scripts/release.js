"use strict";
// 把 dist/Claude Usage HUD 壓成 release/ClaudeUsageHUD-v<版本>-win-x64.zip，供 GitHub Releases 下載。
// 用 Windows 內建的 tar.exe（bsdtar）產生 zip。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const src = path.join(root, "dist", "Claude Usage HUD");
if (!fs.existsSync(path.join(src, "ClaudeUsageHUD.exe"))) { console.error("請先執行 npm run pack"); process.exit(1); }

const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `ClaudeUsageHUD-v${version}-win-x64.zip`);
fs.rmSync(zip, { force: true });
const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", path.join(root, "dist"), "Claude Usage HUD"], { stdio: "inherit" });
console.log("已產生", zip, `(${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);

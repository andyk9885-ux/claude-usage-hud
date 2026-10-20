"use strict";
// 每百萬 Token 的美元價格（Anthropic 官方 API 牌價，2026-10）。
// 訂閱方案不是按 Token 計費，這裡只用來換算「等值 API 費用」做參考。
// 寫入快取：5 分鐘 = 輸入價 × 1.25，1 小時 = 輸入價 × 2。
const TABLE = [
  // [模型 ID 前綴, 輸入, 輸出, 快取讀取]
  ["claude-fable-5-1", 10, 50, 0.25],
  ["claude-mythos-5-1", 10, 50, 0.25],
  ["claude-fable-5", 10, 50, 1],
  ["claude-mythos-5", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-opus-5", 5, 25, 0.5],
  ["claude-opus-4-8", 5, 25, 0.5],
  ["claude-opus-4-7", 5, 25, 0.5],
  ["claude-opus-4-6", 5, 25, 0.5],
  ["claude-opus-4-5", 5, 25, 0.5],
  ["claude-opus-4", 15, 75, 1.5],
  ["claude-sonnet-5-5", 2, 10, 0.2],
  ["claude-sonnet-5", 2, 10, 0.2],
  ["claude-sonnet-4", 3, 15, 0.3],
  ["claude-3-7-sonnet", 3, 15, 0.3],
  ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ["claude-haiku-4-5", 1, 5, 0.1],
  ["claude-3-5-haiku", 0.8, 4, 0.08],
];

function priceFor(model) {
  const id = String(model || "").toLowerCase();
  for (const [prefix, input, output, read] of TABLE) {
    if (id.startsWith(prefix)) return { input, output, read, w5m: input * 1.25, w1h: input * 2 };
  }
  return null;
}

// t = { in, out, c5, c1, cr }
function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return 0;
  return ((t.in || 0) * p.input + (t.out || 0) * p.output + (t.c5 || 0) * p.w5m +
    (t.c1 || 0) * p.w1h + (t.cr || 0) * p.read) / 1e6;
}

// claude-opus-5-5 → Opus 5.5
function prettyModel(model) {
  const id = String(model || "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  let m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (m) return cap(m[1]) + " " + m[2] + (m[3] ? "." + m[3] : "");
  m = id.match(/^claude-(\d+)(?:-(\d+))?-([a-z]+)$/);
  if (m) return cap(m[3]) + " " + m[1] + (m[2] ? "." + m[2] : "");
  return id || "unknown";
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { priceFor, costOf, prettyModel };

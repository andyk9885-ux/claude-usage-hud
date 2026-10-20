"use strict";
// HUD_DEMO=1 時使用的假資料：給 README 截圖用，格式和真實資料相同。
const H = 3600e3, D = 24 * H;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 固定種子的亂數，每次截圖都一樣
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

function limits() {
  const now = Date.now();
  return {
    ok: true, plan: "Max 5x", fetchedAt: now - 60e3, extra: null,
    windows: [
      { key: "five_hour", label: "5 小時", percent: 64, resetsAt: new Date(now + 2 * H + 10 * 60e3).toISOString(), locked: null },
      { key: "seven_day", label: "每週（全部模型）", percent: 31, resetsAt: new Date(now + 3 * D + 5 * H).toISOString(), locked: null },
    ],
    breakdown: [{ key: "claude_code", name: "Claude Code", percent: 82 }, { key: "chat", name: "聊天", percent: 18 }],
  };
}

function dailyTokens() {
  const r = rng(7), out = {}, today = new Date();
  for (let i = 0; i < 26 * 7; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const active = r() < (weekend ? 0.35 : 0.85);
    out[ymd(d)] = active ? Math.round((weekend ? 6e6 : 18e6) * (0.3 + r() * 1.4)) : 0;
  }
  return out;
}

function summary(range) {
  const days = dailyTokens(), today = new Date();
  const n = range === "today" ? 1 : range === "7" ? 7 : range === "30" ? 30 : 182;
  let tokens = 0, active = 0;
  for (let i = 0; i < n; i++) { const d = new Date(today); d.setDate(d.getDate() - i); const v = days[ymd(d)]; tokens += v; if (v) active++; }
  const costPerTok = 0.38 / 1e6;
  const chartDays = range === "30" ? 30 : range === "all" ? 60 : 7;
  const daily = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    daily.push({ date: ymd(d), tokens: days[ymd(d)], cost: days[ymd(d)] * costPerTok, inRange: i < n });
  }
  const heat = [];
  const start = new Date(today); start.setDate(start.getDate() - 7 * 25 - start.getDay());
  for (let d = new Date(start); ymd(d) <= ymd(today); d.setDate(d.getDate() + 1)) heat.push({ date: ymd(d), dow: d.getDay(), tokens: days[ymd(d)] || 0 });
  const opus = tokens * 0.86, sonnet = tokens * 0.12, haiku = tokens * 0.02;
  return {
    range, total: { in: tokens * 0.0001, out: tokens * 0.004, c5: tokens * 0.002, c1: tokens * 0.03, cr: tokens * 0.9639, n: Math.round(tokens / 2.6e5) },
    tokens, cost: tokens * costPerTok, replies: Math.round(tokens / 2.6e5), prompts: Math.round(tokens / 3.1e6), sessions: Math.max(1, Math.round(active * 2.4)),
    activeDays: active, favorite: "Opus 5.5", peakHour: 14, hours: [],
    models: [
      { name: "Opus 5.5", tokens: opus, out: 0, cost: opus * 0.42 / 1e6, n: 0 },
      { name: "Sonnet 5.5", tokens: sonnet, out: 0, cost: sonnet * 0.21 / 1e6, n: 0 },
      { name: "Haiku 5.5", tokens: haiku, out: 0, cost: haiku * 0.011 / 1e6, n: 0 },
    ],
    daily, heat, fileCount: 0, lastScan: Date.now(),
  };
}

module.exports = { limits, summary };

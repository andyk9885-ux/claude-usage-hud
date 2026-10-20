"use strict";
// 掃描 Claude Code 在本機留下的對話紀錄（~/.claude/projects/**/*.jsonl），
// 逐檔統計 Token 用量。結果存在自己的快取檔裡，就算 Claude Code 之後把舊紀錄清掉，
// 已經記下來的用量也不會消失。
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { costOf, prettyModel } = require("./pricing");

const CACHE_VERSION = 1;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function pad(n) { return String(n).padStart(2, "0"); }
function localDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

function listJsonl(dir, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) listJsonl(p, out);
    else if (it.isFile() && it.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function isPrompt(content) {
  if (typeof content === "string") return !content.startsWith("<local-command-stdout");
  if (!Array.isArray(content)) return false;
  let text = false;
  for (const part of content) {
    if (!part) continue;
    if (part.type === "tool_result") return false;
    if (part.type === "text" || part.type === "image") text = true;
  }
  return text;
}

async function parseFile(file) {
  const entry = {
    kind: /[\\/]subagents[\\/]/.test(file) ? "sub" : "main",
    days: {},   // 日期 → 模型 → { in, out, c5, c1, cr, n }
    prompts: {}, // 日期 → 使用者送出的訊息數
    hrs: {},    // 日期 → 小時 → 回覆數
  };
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.timestamp) continue;
    const ts = new Date(j.timestamp);
    if (isNaN(ts)) continue;
    const date = localDate(ts);

    if (j.type === "assistant" && j.message && j.message.usage) {
      const key = j.message.id || j.requestId || j.uuid;
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      const model = j.message.model;
      if (!model || model.startsWith("<")) continue;
      const u = j.message.usage;
      const cc = u.cache_creation || {};
      let c5 = cc.ephemeral_5m_input_tokens, c1 = cc.ephemeral_1h_input_tokens;
      if (c5 == null && c1 == null) { c5 = u.cache_creation_input_tokens || 0; c1 = 0; }
      const day = entry.days[date] || (entry.days[date] = {});
      const t = day[model] || (day[model] = { in: 0, out: 0, c5: 0, c1: 0, cr: 0, n: 0 });
      t.in += u.input_tokens || 0;
      t.out += u.output_tokens || 0;
      t.c5 += c5 || 0;
      t.c1 += c1 || 0;
      t.cr += u.cache_read_input_tokens || 0;
      t.n += 1;
      const h = ts.getHours();
      const hd = entry.hrs[date] || (entry.hrs[date] = {});
      hd[h] = (hd[h] || 0) + 1;
    } else if (j.type === "user" && !j.isSidechain && !j.isMeta && j.message && isPrompt(j.message.content)) {
      entry.prompts[date] = (entry.prompts[date] || 0) + 1;
    }
  }
  return entry;
}

class LocalUsage {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.cache = { version: CACHE_VERSION, files: {} };
    this.scanning = null;
    this.lastScan = 0;
  }

  load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (c && c.version === CACHE_VERSION && c.files) this.cache = c;
    } catch {}
    return this;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.cache));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) { console.error("儲存用量快取失敗", e); }
  }

  get hasData() { return Object.keys(this.cache.files).length > 0; }

  // 匯入舊版「HUD for Claude」的累計用量（只匯入本機已經不存在的紀錄檔，存在的會直接重新掃描）。
  importLegacy(file) {
    let old;
    try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return 0; }
    if (!old || !old.files) return 0;
    let n = 0;
    for (const [p, e] of Object.entries(old.files)) {
      if (this.cache.files[p] || fs.existsSync(p) || !e || !e.days) continue;
      const days = {};
      for (const [date, models] of Object.entries(e.days)) {
        days[date] = {};
        for (const [model, t] of Object.entries(models || {})) {
          days[date][model] = { in: t.input || 0, out: t.output || 0, c5: t.cache5m || 0, c1: t.cache1h || 0, cr: t.cacheRead || 0, n: 0 };
        }
      }
      this.cache.files[p] = { legacy: true, kind: (e.act && e.act.kind) === "sub" ? "sub" : "main", days, prompts: {}, hrs: {} };
      n++;
    }
    this.cache.importedLegacy = new Date().toISOString();
    return n;
  }

  // 只重新解析有變動的檔案。回傳是否有任何變動。
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      let changed = false;
      const files = listJsonl(path.join(claudeDir(), "projects"));
      for (const f of files) {
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        const old = this.cache.files[f];
        if (old && !old.legacy && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
        try {
          const entry = await parseFile(f);
          entry.mtimeMs = st.mtimeMs;
          entry.size = st.size;
          this.cache.files[f] = entry;
          changed = true;
        } catch (e) { console.error("解析失敗", f, e); }
      }
      this.lastScan = Date.now();
      if (changed) this.save();
      return changed;
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  // range: "today" | "7" | "30" | "all"
  summary(range) {
    const today = new Date();
    const todayStr = localDate(today);
    const nDays = range === "today" ? 1 : range === "7" ? 7 : range === "30" ? 30 : null;
    let since = null;
    if (nDays) { const d = new Date(today); d.setDate(d.getDate() - (nDays - 1)); since = localDate(d); }
    const inRange = (date) => !since || date >= since;

    const total = { in: 0, out: 0, c5: 0, c1: 0, cr: 0, n: 0 };
    let cost = 0, prompts = 0, sessions = 0;
    const byModel = {}, hours = new Array(24).fill(0), activeDays = new Set();
    const allDays = {}, allCost = {}; // 熱力圖和長條圖用，不受區間限制

    for (const e of Object.values(this.cache.files)) {
      let touched = false;
      for (const [date, models] of Object.entries(e.days || {})) {
        for (const [model, t] of Object.entries(models)) {
          const tok = t.in + t.out + t.c5 + t.c1 + t.cr;
          const c = costOf(model, t);
          allDays[date] = (allDays[date] || 0) + tok;
          allCost[date] = (allCost[date] || 0) + c;
          if (!inRange(date)) continue;
          touched = true;
          activeDays.add(date);
          for (const k in total) total[k] += t[k] || 0;
          cost += c;
          const name = prettyModel(model);
          const m = byModel[name] || (byModel[name] = { name, tokens: 0, out: 0, cost: 0, n: 0 });
          m.tokens += tok; m.out += t.out; m.cost += c; m.n += t.n || 0;
        }
      }
      for (const [date, n] of Object.entries(e.prompts || {})) if (inRange(date)) { prompts += n; touched = true; activeDays.add(date); }
      for (const [date, hs] of Object.entries(e.hrs || {})) if (inRange(date)) for (const [h, n] of Object.entries(hs)) hours[h] += n;
      if (touched && e.kind === "main") sessions++;
    }

    // 長條圖：今天／7 天 → 最近 7 天；30 天 → 30 天；全部 → 最近 60 天
    const chartDays = range === "30" ? 30 : range === "all" ? 60 : 7;
    const daily = [];
    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ds = localDate(d);
      daily.push({ date: ds, tokens: allDays[ds] || 0, cost: allCost[ds] || 0, inRange: inRange(ds) });
    }

    // 熱力圖：最近 26 週，從星期日開始
    const heat = [];
    const start = new Date(today); start.setDate(start.getDate() - 7 * 25 - start.getDay());
    for (let d = new Date(start); localDate(d) <= todayStr; d.setDate(d.getDate() + 1)) {
      const ds = localDate(d);
      heat.push({ date: ds, dow: d.getDay(), tokens: allDays[ds] || 0 });
    }

    const models = Object.values(byModel).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    let peakHour = -1, peak = 0;
    hours.forEach((n, h) => { if (n > peak) { peak = n; peakHour = h; } });

    return {
      range, since, total, tokens: total.in + total.out + total.c5 + total.c1 + total.cr, cost,
      replies: total.n, prompts, sessions, activeDays: activeDays.size,
      favorite: models.length ? models.slice().sort((a, b) => b.n - a.n || b.tokens - a.tokens)[0].name : null,
      peakHour, hours, models, daily, heat,
      fileCount: Object.keys(this.cache.files).length,
      lastScan: this.lastScan,
    };
  }
}

module.exports = { LocalUsage, claudeDir };

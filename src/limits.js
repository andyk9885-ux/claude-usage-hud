"use strict";
// 讀取 Claude Code 的登入資訊，向 Anthropic 查詢 5 小時／每週用量上限。
// 這是 Claude Code 自己在用、沒有公開文件的介面，之後可能會變動。
// 為了不弄壞 Claude Code 的登入狀態，這裡「只讀」登入檔，不會自己更新 token；
// token 過期時會請使用者打開 Claude Code（它會自動更新）。
const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./local-usage");

const API = "https://api.anthropic.com/api/oauth/usage";

const PLAN_NAMES = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

function readCredentials() {
  const file = path.join(claudeDir(), ".credentials.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { error: "no-login" }; }
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    if (!o || !o.accessToken) return { error: "no-login" };
    return { token: o.accessToken, expiresAt: o.expiresAt || 0, plan: o.subscriptionType || "", tier: o.rateLimitTier || "" };
  } catch { return { error: "bad-login" }; }
}

function planLabel(plan, tier) {
  let s = PLAN_NAMES[plan] || plan || "";
  const m = String(tier || "").match(/(\d+)x/);
  if (m && s) s += " " + m[1] + "x";
  return s;
}

function window_(w) {
  if (!w || typeof w.utilization !== "number") return null;
  return { percent: w.utilization, resetsAt: w.resets_at || null, locked: w.locked_reason || null };
}

const BREAKDOWN_NAMES = { claude_code: "Claude Code", chat: "聊天", cowork: "Cowork", other: "其他" };

async function fetchLimits() {
  const cred = readCredentials();
  if (cred.error) return { ok: false, error: cred.error };
  const plan = planLabel(cred.plan, cred.tier);
  if (cred.expiresAt && cred.expiresAt < Date.now()) return { ok: false, error: "expired", plan };

  let res;
  try {
    res = await fetch(API, {
      headers: {
        Authorization: "Bearer " + cred.token,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-hud-zh/1.0",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, error: "network", detail: String(e && e.message || e), plan };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "expired", plan };
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return { ok: false, error: "rate-limited", plan, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0 };
  }
  if (!res.ok) return { ok: false, error: "http", detail: "HTTP " + res.status, plan };

  let j;
  try { j = await res.json(); } catch { return { ok: false, error: "http", detail: "bad JSON", plan }; }

  const windows = [];
  const add = (key, label, w) => { const v = window_(w); if (v) windows.push({ key, label, ...v }); };
  add("five_hour", "5 小時", j.five_hour);
  add("seven_day", "每週（全部模型）", j.seven_day);
  add("seven_day_opus", "每週 Opus", j.seven_day_opus);
  add("seven_day_sonnet", "每週 Sonnet", j.seven_day_sonnet);

  let breakdown = null;
  const rows = j.seven_day_breakdown && j.seven_day_breakdown.rows;
  if (Array.isArray(rows)) {
    breakdown = rows.filter((r) => r && r.percent > 0)
      .map((r) => ({ key: r.key, name: BREAKDOWN_NAMES[r.key] || r.display_name || r.key, percent: r.percent }));
  }

  let extra = null;
  const ex = j.extra_usage;
  if (ex && ex.is_enabled) {
    const div = Math.pow(10, ex.decimal_places || 0);
    extra = {
      used: ex.used_credits != null ? ex.used_credits / div : null,
      limit: ex.monthly_limit != null ? ex.monthly_limit / div : null,
      percent: ex.utilization,
      currency: ex.currency || "USD",
    };
  }

  if (!windows.length) return { ok: false, error: "http", detail: "no usage data", plan };
  return { ok: true, plan, windows, breakdown, extra, fetchedAt: Date.now() };
}

module.exports = { fetchLimits };

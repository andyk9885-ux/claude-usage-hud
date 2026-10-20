"use strict";
// 讀取 Claude Code 的登入資訊，向 Anthropic 查詢 5 小時／每週用量上限。
// 這是 Claude Code 自己在用、沒有公開文件的介面，之後可能會變動。
//
// 登入 token 大約 8 小時過期。終端機裡的 claude 會自己換新並寫回登入檔，但 Claude 桌面版
// 的 Code 分頁用的是桌面版自己的登入，不會更新這個檔案，所以過期後要由這裡用 refresh token
// 換新，做法和 Claude Code 完全相同（同一個端點、client ID、權限範圍），並寫回登入檔讓
// Claude Code 也能繼續用。為了不和 Claude Code 互相干擾：
//   - 只在 token 真的過期（或快過期）時才換；Claude Code 正在使用時它會先換好，這裡就不會動。
//   - 寫回前重讀登入檔：若 refresh token 已被別人換過，就用別人的、不覆蓋。
//   - 先寫暫存檔再整個替換，並保留檔案裡的其他欄位。
const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./local-usage");

const API = "https://api.anthropic.com/api/oauth/usage";
// 與 Claude Code 相同的 OAuth 設定（取自 Claude Code 本身）
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_EARLY_MS = 2 * 60 * 1000; // 剩不到 2 分鐘就視為過期

const PLAN_NAMES = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

const credFile = () => path.join(claudeDir(), ".credentials.json");

function readCredentials() {
  let raw;
  try { raw = fs.readFileSync(credFile(), "utf8"); } catch { return { error: "no-login" }; }
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    if (!o || !o.accessToken) return { error: "no-login" };
    return {
      token: o.accessToken, refreshToken: o.refreshToken || null, expiresAt: o.expiresAt || 0,
      scopes: Array.isArray(o.scopes) ? o.scopes : null, plan: o.subscriptionType || "", tier: o.rateLimitTier || "",
    };
  } catch { return { error: "bad-login" }; }
}

// 用 refresh token 換新 token 並寫回登入檔。回傳新的 cred，或 { error }。
let refreshing = null;
function refreshCredentials(cred) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!cred.refreshToken) return { error: "expired" };
    const body = { grant_type: "refresh_token", refresh_token: cred.refreshToken, client_id: CLIENT_ID };
    if (cred.scopes && cred.scopes.length) body.scope = cred.scopes.join(" ");
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch (e) { return { error: "network", detail: String(e && e.message || e) }; }

    if (!res.ok) {
      // 可能是 Claude Code 剛好同時換過了（舊的 refresh token 失效）：重讀檔案，若已是新 token 就直接用
      const now = readCredentials();
      if (!now.error && now.refreshToken !== cred.refreshToken && now.expiresAt > Date.now() + REFRESH_EARLY_MS) return now;
      return { error: res.status === 429 ? "rate-limited" : "expired" };
    }
    let j;
    try { j = await res.json(); } catch { return { error: "expired" }; }
    if (!j.access_token) return { error: "expired" };

    // 寫回前重讀：若這段時間內別人已經換過，就不覆蓋
    let file;
    try { file = JSON.parse(fs.readFileSync(credFile(), "utf8")); } catch { return { error: "bad-login" }; }
    const cur = file.claudeAiOauth || {};
    if (cur.refreshToken && cur.refreshToken !== cred.refreshToken) return readCredentials();

    const now = Date.now();
    const next = { ...cur, accessToken: j.access_token, refreshToken: j.refresh_token || cred.refreshToken, expiresAt: now + (j.expires_in || 3600) * 1000 };
    if (j.refresh_token_expires_in) next.refreshTokenExpiresAt = now + j.refresh_token_expires_in * 1000;
    if (j.scope) next.scopes = String(j.scope).split(" ").filter(Boolean);
    file.claudeAiOauth = next;
    try {
      const tmp = credFile() + ".hud-tmp";
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, credFile());
    } catch (e) {
      // 寫不回去的話，新的 refresh token 會遺失、Claude Code 也得重新登入；這種情況要讓使用者知道
      return { error: "http", detail: "can't save login: " + (e && e.message || e) };
    }
    return readCredentials();
  })().finally(() => { refreshing = null; });
  return refreshing;
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
  let cred = readCredentials();
  if (cred.error) return { ok: false, error: cred.error };
  const plan = planLabel(cred.plan, cred.tier);
  if (cred.expiresAt && cred.expiresAt < Date.now() + REFRESH_EARLY_MS) {
    cred = await refreshCredentials(cred);
    if (cred.error) return { ok: false, error: cred.error, detail: cred.detail, plan };
  }

  const query = (token) => fetch(API, {
    headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-usage-hud/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  let res;
  try {
    res = await query(cred.token);
    // 還沒到期卻被拒（例如在別處登出又登入過）：換一次新 token 再試
    if (res.status === 401) {
      const fresh = await refreshCredentials(cred);
      if (fresh.error) return { ok: false, error: fresh.error, detail: fresh.detail, plan };
      res = await query(fresh.token);
    }
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

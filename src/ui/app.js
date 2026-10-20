"use strict";
const $ = (id) => document.getElementById(id);
const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
let S = null;

// ---------- 格式（文字來自 i18n.js 的 T()） ----------
const fmtTok = (n) => T().big(n || 0);
function fmtCost(c) {
  c = c || 0;
  if (c < 10) return "$" + c.toFixed(2);
  if (c < 1000) return "$" + c.toFixed(1);
  return "$" + Math.round(c).toLocaleString("en-US");
}
const fmtInt = (n) => T().int(n);
const hm = (t) => `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
// 17:40／明天 09:00／週二 13:00
function fmtWhen(t) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const days = Math.floor((new Date(t).setHours(0, 0, 0, 0) - d0) / 864e5);
  return (days === 0 ? "" : days === 1 ? T().tomorrow + " " : T().weekday(t.getDay()) + " ") + hm(t);
}
function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return T().left(Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60);
}
function ago(ts) {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? T().agoNow : m < 60 ? T().agoMin(m) : T().agoHour(Math.floor(m / 60));
}
function level(p) { return p >= 90 ? "crit" : p >= 70 ? "warn" : "ok"; }
const lvVar = (p) => `var(--${level(p)})`;
const clamp = (p) => Math.max(0, Math.min(100, p || 0));
const winLabel = (w) => T().win[w.key] || w.label || w.key;
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

// 錯誤：說清楚發生什麼、該怎麼做
function errMsg(e) {
  const err = T().err;
  if (e.error === "rate-limited") return err["rate-limited"](e.retryAt ? Math.max(1, Math.ceil((e.retryAt - Date.now()) / 60000)) : 5);
  return err[e.error] && typeof err[e.error] !== "function" ? err[e.error] : err.other(e.detail);
}

// ---------- 數字滾動（只在滑出／展開那一刻使用） ----------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function countTo(el, to, fmt, dur = 900) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (reduceMotion || from === to) { el.innerHTML = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.innerHTML = fmt(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
// 先瞬間歸零，下一個畫格再過場到目標值
function replayTo(el, prop, value) {
  el.style.transition = "none";
  el.style[prop] = prop === "width" ? "0%" : "100";
  el.getBoundingClientRect();
  el.style.transition = "";
  raf2(() => { el.style[prop] = value; });
}

// ---------- 配速：用量是否跑在時間前面 ----------
const DURATION = { five_hour: 5 * 3600e3, seven_day: 7 * 864e5, seven_day_opus: 7 * 864e5, seven_day_sonnet: 7 * 864e5 };
function pace(w) {
  const dur = DURATION[w.key], reset = w.resetsAt ? new Date(w.resetsAt) : null, p = w.percent || 0;
  if (!dur || !reset) return { text: "" };
  const start = reset - dur, now = Date.now();
  const elapsed = Math.max(0, Math.min(1, (now - start) / dur));
  if (p >= 100 || w.locked) return { elapsed, over: true, text: T().paceOut(fmtWhen(reset)) };
  if (p < 1) return { elapsed, text: T().paceNone };
  if (elapsed < 0.04) return { elapsed, text: T().paceEarly };
  const rate = p / 100 / elapsed;
  if (rate <= 1) return { elapsed, text: T().paceOk };
  const full = new Date(start + dur / rate);
  return { elapsed, over: true, text: T().paceOver(fmtWhen(full)) };
}

// ======================= 收起：把手與小標籤 =======================
const dock = $("dock"), tab = $("tab"), handle = $("handle");
let peeking = false, hideTimer = null, press = null;
const limitWin = (key) => (S && S.limits ? S.limits.windows.find((w) => w.key === key) : null);

function renderMini(id, w, replay) {
  const el = $(id), arc = el.querySelector(".arc"), b = el.querySelector("b");
  if (!w) { b.textContent = "–"; b._v = 0; arc.style.strokeDashoffset = 100; return; }
  const p = clamp(w.percent);
  el.style.setProperty("--lv", lvVar(p));
  if (replay) { b._v = 0; replayTo(arc, "strokeDashoffset", String(100 - p)); } else arc.style.strokeDashoffset = 100 - p;
  countTo(b, Math.round(w.percent), (v) => Math.round(v) + "%", replay ? 900 : 500);
}

function renderDock(replay) {
  const w5 = limitWin("five_hour"), w7 = limitWin("seven_day");
  const p = w5 ? clamp(w5.percent) : 0;
  handle.style.setProperty("--lv", w5 ? lvVar(p) : "var(--text-3)");
  handle.classList.toggle("crit", !!w5 && p >= 90);
  if (peeking || replay) { renderMini("mini-5h", w5, replay); renderMini("mini-7d", w7, replay); }
  const wins = S && S.limits ? S.limits.windows : [];
  const summary = wins.slice(0, 2).map((x) => `${winLabel(x)} ${Math.round(x.percent)}%`).join(T().listSep);
  tab.title = (summary ? summary + "\n" : "") + T().tabHint;
  tab.setAttribute("aria-label", T().tabAria + (summary ? ": " + summary : ""));
}

function setPeek(on) {
  if (on === peeking || !S || S.expanded) return;
  peeking = on;
  clearTimeout(hideTimer);
  window.hud.capture(on);
  dock.classList.toggle("peek", on);
  if (on) renderDock(true);
}
window.__peek = setPeek; // 自我測試用

// 收起時視窗大部分透明、滑鼠可穿透，但滑鼠移動仍會傳進來：碰到右側邊緣就滑出
document.addEventListener("mousemove", (e) => {
  if (S && !S.expanded && !peeking && e.clientX >= innerWidth - 16) setPeek(true);
});
document.addEventListener("mouseleave", () => {
  if (!peeking || press) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => setPeek(false), 380);
});
document.addEventListener("mouseenter", () => clearTimeout(hideTimer));

tab.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  press = { y: e.screenY, dragging: false };
  tab.setPointerCapture(e.pointerId);
});
tab.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!press.dragging && Math.abs(e.screenY - press.y) > 4) {
    press.dragging = true;
    tab.classList.add("dragging");
    window.hud.dragStart(press.y);
  }
  if (press.dragging) window.hud.dragMove(e.screenY);
});
tab.addEventListener("pointerup", () => {
  if (!press) return;
  const wasDrag = press.dragging;
  press = null;
  tab.classList.remove("dragging");
  if (wasDrag) window.hud.dragEnd(); else window.hud.toggle();
});
tab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); window.hud.toggle(); } });

// ======================= 展開：面板 =======================
const panel = $("panel");

function openPanel() {
  peeking = false;
  dock.classList.remove("peek");
  panel.classList.remove("out", "in");
  render(true);
  raf2(() => panel.classList.add("in"));
}
window.hud.onClosing(() => {
  panel.classList.remove("in");
  panel.classList.add("out");
  setTimeout(() => window.hud.collapseDone(), reduceMotion ? 0 : 250);
});

// ---------- 用量上限 ----------
// 舊版快取的用量來源只存了中文名稱，沒有 key；用名稱對回 key 才能翻譯
const SOURCE_BY_NAME = { "Claude Code": "claude_code", "聊天": "chat", "Cowork": "cowork", "其他": "other" };
function renderLimits(replay) {
  const L = S.limits, E = S.limitsError;
  const wins = L ? L.windows : [];
  $("plan").textContent = (L && L.plan) || (E && E.plan) || "";
  $("btn-refresh").classList.toggle("busy", !!S.limitsBusy);
  $("limits-time").textContent = L ? ago(L.fetchedAt) : "";

  let msg = "";
  if (E) {
    const [what, how] = errMsg(E);
    msg = `<div class="msg" style="--lv:var(--${E.error === "rate-limited" ? "text-3" : "warn"})">${esc(what)}<small>${esc(how)}${L ? esc(T().staleNote) : ""}</small></div>`;
  } else if (!L) msg = `<p class="empty">${esc(T().loading)}</p>`;
  $("limits-msg").innerHTML = msg;

  const box = $("meters"), keys = wins.map((w) => w.key).join() + "|" + LANG;
  if (box.dataset.keys !== keys) {
    const sameWins = box.dataset.keys && box.dataset.keys.split("|")[0] === keys.split("|")[0];
    box.dataset.keys = keys;
    box.innerHTML = wins.map((w, i) => `<div class="meter${i > 1 ? " small" : ""}" data-k="${w.key}">
        <div class="meter-top"><span class="meter-name">${esc(winLabel(w))}</span><b class="meter-val"></b></div>
        <div class="meter-track"><div class="meter-fill"></div><i class="meter-now"></i></div>
        <p class="meter-pace"></p><p class="meter-reset"></p>
      </div>`).join("") + (wins.length ? `<p class="legend-now"><i></i>${esc(T().legendNow)}</p>` : "");
    if (!sameWins) replay = true; // 只換語言時不重播動畫
    else for (const w of wins) {
      const el = box.querySelector(`[data-k="${w.key}"]`);
      el.querySelector(".meter-fill").style.transition = "none"; // 直接顯示目前數值，不從 0 長出來
      el.querySelector(".meter-val")._v = Math.round(w.percent);
    }
  }
  for (const w of wins) {
    const el = box.querySelector(`[data-k="${w.key}"]`), p = clamp(w.percent), lv = level(p), pc = pace(w);
    el.style.setProperty("--lv", `var(--${lv})`);
    const fill = el.querySelector(".meter-fill"), now = el.querySelector(".meter-now"), val = el.querySelector(".meter-val");
    if (replay) { val._v = 0; replayTo(fill, "width", p + "%"); } else fill.style.width = p + "%";
    now.style.left = (pc.elapsed != null ? pc.elapsed * 100 : 0) + "%";
    now.hidden = pc.elapsed == null;
    countTo(val, Math.round(w.percent), (v) => `${Math.round(v)}<small>%</small>`, replay ? 1000 : 500);
    const paceEl = el.querySelector(".meter-pace");
    paceEl.className = "meter-pace" + (pc.over ? " over" : "");
    // 狀態字只在偏高／快用完時出現，避免「正常」和「會提早用完」同時出現互相矛盾
    paceEl.innerHTML = (lv === "ok" ? "" : `<span class="lvl">${esc(T().lvl[lv])}</span>`) + esc(pc.text);
    if (pc.over && lv === "ok") paceEl.style.setProperty("--lv", "var(--warn)"); else paceEl.style.removeProperty("--lv");
    const reset = w.resetsAt ? new Date(w.resetsAt) : null;
    el.querySelector(".meter-reset").textContent = reset ? T().resetLine(fmtWhen(reset), fmtLeft(reset - Date.now())) : "";
    if (fill.style.transition === "none") raf2(() => { fill.style.transition = ""; });
  }

  const bd = L && L.breakdown;
  $("breakdown").innerHTML = bd && bd.length
    ? esc(T().breakdown(bd.map((r) => `${T().source[r.key || SOURCE_BY_NAME[r.name]] || r.name} \u0001${r.percent}%\u0002`))).replace(/\u0001/g, "<b>").replace(/\u0002/g, "</b>")
    : "";
}

// ---------- Token 用量 ----------

function movePill() {
  const on = document.querySelector('#range button[aria-pressed="true"]'), pill = document.querySelector(".seg-pill");
  if (!on) return;
  pill.style.width = on.offsetWidth + "px";
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
new ResizeObserver(movePill).observe($("range"));
document.fonts && document.fonts.ready.then(movePill);

function renderUsage() {
  const s = S.summary;
  document.querySelectorAll("#range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.r === S.settings.range)));
  movePill();
  $("tok-total").textContent = fmtTok(s.tokens);
  $("tok-cost").textContent = fmtCost(s.cost);
  const t = s.total;
  const sp = T().split;
  $("tok-split").innerHTML = [[sp[0], t.in], [sp[1], t.out], [sp[2], t.c5 + t.c1], [sp[3], t.cr]]
    .map(([k, v]) => `<span>${esc(k)}<b>${fmtTok(v)}</b></span>`).join("");
  const peak = s.peakHour >= 0 ? T().peak(s.peakHour) : "–";
  const f = T().facts;
  $("facts").innerHTML = [
    [f[0], fmtInt(s.prompts)], [f[1], fmtInt(s.replies)],
    [f[2], fmtInt(s.sessions)], [f[3], T().days(s.activeDays)],
    [f[4], esc(s.favorite || "–")], [f[5], peak],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("");

  // 每日長條圖：根數相同時就地更新高度，切換區間時才有過場
  const daily = s.daily, max = Math.max(1, ...daily.map((d) => d.tokens));
  $("daily-title").textContent = T().dailyTitle(daily.length);
  const bars = $("daily");
  const hOf = (d) => (d.tokens ? Math.max(3, (d.tokens / max) * 100) : 0) + "%";
  if (bars.children.length === daily.length) {
    daily.forEach((d, i) => { const el = bars.children[i].firstChild; el.style.height = hOf(d); el.classList.toggle("out", !d.inRange); });
  } else {
    bars.innerHTML = daily.map((d, i) => `<div class="hit" data-i="${i}"><i class="${d.inRange ? "" : "out"}" style="height:${hOf(d)}"></i></div>`).join("");
  }
  const md = (ds) => { const [, m, d] = ds.split("-"); return `${+m}/${+d}`; };
  $("daily-axis").innerHTML = `<span>${md(daily[0].date)}</span><span>${daily.length > 7 ? md(daily[Math.floor(daily.length / 2)].date) : ""}</span><span>${esc(T().today)}</span>`;

  const models = s.models, mmax = Math.max(1e-9, ...models.map((m) => m.tokens));
  $("models").innerHTML = models.length ? models.map((m) => `<div class="model">
      <div class="model-top"><span>${esc(m.name)}</span><span>${fmtTok(m.tokens)} · ${fmtCost(m.cost)}</span></div>
      <div class="model-trk"><div class="model-bar" style="width:${(m.tokens / mmax) * 100}%"></div></div>
    </div>`).join("") : `<p class="empty">${esc(T().empty[S.settings.range])}</p>`;

  // 熱力圖：用有資料日子的四分位數分級
  const vals = s.heat.map((d) => d.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(f * vals.length))] : 0);
  const cut = [q(0.25), q(0.5), q(0.75)];
  const lvl = (v) => (!v ? 0 : v <= cut[0] ? 1 : v <= cut[1] ? 2 : v <= cut[2] ? 3 : 4);
  $("heat").innerHTML = s.heat.map((d, i) => `<i class="l${lvl(d.tokens)}" data-h="${i}"></i>`).join("")
    + Array.from({ length: 6 - s.heat[s.heat.length - 1].dow }, () => `<i class="future"></i>`).join("");
}

// ---------- 外觀與主色 ----------
// [存檔的值, 顯示的顏色]；名稱依語言取 T().colors
const PRESETS = [
  [null, "#e8835a"], ["#3b82f6", "#3b82f6"], ["#22a06b", "#22a06b"],
  ["#14b8c4", "#14b8c4"], ["#8b5cf6", "#8b5cf6"], ["#e8508a", "#e8508a"], ["#8c8c8c", "#8c8c8c"],
];
const colorBox = $("opt-color");
colorBox.innerHTML = PRESETS.map(([v, c]) => `<button class="swatch" role="radio" data-c="${v ?? ""}" style="--c:${c}"></button>`).join("")
  + `<label class="swatch custom"><input type="color" id="opt-custom"></label>`;
function labelSwatches() {
  colorBox.querySelectorAll(".swatch[data-c]").forEach((b, i) => { b.title = T().colors[i]; b.setAttribute("aria-label", T().colors[i]); });
  colorBox.querySelector(".custom").title = T().customColor;
  $("opt-custom").setAttribute("aria-label", T().customColor);
}

// ---------- 語言 ----------
// lang：實際顯示的語言（zh／en）；choice：使用者的選擇（system／zh／en）
let appliedLang = null;
function applyLang(lang, choice) {
  document.querySelectorAll("#opt-lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.l === choice)));
  LANG = STRINGS[lang] ? lang : "en";
  if (appliedLang === LANG) return;
  appliedLang = LANG;
  applyStaticText();
  labelSwatches();
  movePill(); // 按鈕文字長度變了，滑塊要重新對齊
}
$("opt-lang").onclick = (e) => { const l = e.target.dataset && e.target.dataset.l; if (l) window.hud.setLang(l); };

function applyColor(c) {
  if (c) document.documentElement.style.setProperty("--brand", c);
  else document.documentElement.style.removeProperty("--brand");
}
function renderAppearance() {
  const { theme, color } = S.settings;
  document.querySelectorAll("#opt-theme button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.t === theme)));
  const isPreset = PRESETS.some(([v]) => (v ?? null) === (color ?? null));
  colorBox.querySelectorAll(".swatch[data-c]").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.c || null) === (color ?? null))));
  const custom = colorBox.querySelector(".custom");
  custom.setAttribute("aria-checked", String(!isPreset));
  custom.style.setProperty("--c", isPreset ? "transparent" : color);
  if (!isPreset && document.activeElement !== $("opt-custom")) $("opt-custom").value = color;
  if (!picking) applyColor(color);
}

$("opt-theme").onclick = (e) => { const t = e.target.dataset && e.target.dataset.t; if (t) window.hud.setTheme(t); };
colorBox.onclick = (e) => {
  const b = e.target.closest(".swatch[data-c]");
  if (b) window.hud.setColor(b.dataset.c || null);
};
// 自訂顏色：拖動時即時預覽，選定後才存檔。
// 選色視窗打開時面板會失去焦點，先請主程式暫停「點外面就收回」。
let picking = false;
const customInput = $("opt-custom");
customInput.addEventListener("click", () => { picking = true; window.hud.holdOpen(true); });
customInput.addEventListener("input", (e) => applyColor(e.target.value));
customInput.addEventListener("change", (e) => { picking = false; window.hud.holdOpen(false); window.hud.setColor(e.target.value.toLowerCase()); });
window.addEventListener("focus", () => {
  if (!picking) return;
  picking = false;
  window.hud.holdOpen(false);
  if (S) applyColor(S.settings.color); // 取消選色時還原
});

let wasExpanded = false;
function render(replay) {
  if (!S) return;
  if (S.accent) document.documentElement.style.setProperty("--accent", S.accent);
  applyLang(S.settings.uiLang, S.settings.lang);
  renderAppearance();
  document.body.classList.toggle("expanded", S.expanded);
  $("opt-login").checked = !!S.settings.openAtLogin;
  renderDock(false);
  if (!S.expanded) return;
  renderLimits(replay);
  renderUsage();
}

function onState(s) {
  S = s;
  if (s.expanded && !wasExpanded) { wasExpanded = true; openPanel(); return; }
  if (!s.expanded && wasExpanded) { wasExpanded = false; panel.classList.remove("in", "out"); }
  render(false);
}

// ---------- 提示框 ----------
const tip = $("tip");
function showTip(e, html) {
  tip.innerHTML = html; tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 12, y = e.clientY - r.height - 10;
  if (x + r.width > innerWidth - 4) x = e.clientX - r.width - 12;
  if (y < 4) y = e.clientY + 16;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
document.addEventListener("mousemove", (e) => {
  if (!S || !S.expanded) return;
  const bar = e.target.closest && e.target.closest(".hit");
  const cell = e.target.closest && e.target.closest("#heat i[data-h]");
  if (bar) {
    const d = S.summary.daily[+bar.dataset.i];
    return showTip(e, `${d.date}<br><b>${fmtTok(d.tokens)}</b> ${esc(T().totTokens)} · <b>${fmtCost(d.cost)}</b>`);
  }
  if (cell) {
    const d = S.summary.heat[+cell.dataset.h];
    return showTip(e, `${esc(T().tipDay(d.date, d.dow))}<br>${d.tokens ? `<b>${fmtTok(d.tokens)}</b> ${esc(T().totTokens)}` : esc(T().noUse)}`);
  }
  tip.classList.remove("show");
});
document.addEventListener("mouseleave", () => tip.classList.remove("show"));

// ---------- 面板按鈕 ----------
$("btn-collapse").onclick = () => window.hud.collapse();
$("btn-refresh").onclick = () => window.hud.refresh();
$("btn-settings").onclick = () => {
  const open = $("settings").classList.toggle("open");
  $("btn-settings").setAttribute("aria-expanded", String(open));
};
$("opt-login").onchange = (e) => window.hud.setLogin(e.target.checked);
$("btn-quit").onclick = () => window.hud.quit();
$("range").onclick = (e) => { const r = e.target.dataset && e.target.dataset.r; if (r) window.hud.setRange(r); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S && S.expanded) window.hud.collapse(); });

window.hud.onState(onState);
window.hud.getState().then(onState);
setInterval(() => S && S.expanded && renderLimits(false), 30 * 1000); // 更新倒數與配速

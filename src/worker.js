/**
 * Windscribe Traffic Reporter — Cloudflare Worker + Telegram Bot (v10)
 * ------------------------------------------------------------------
 * - هر ۱۵ دقیقه ۱ اکانت بررسی و در دیتابیس KV ذخیره می‌شود
 * - پایان دور: فقط یک گزارش کامل (بدون پیام خلاصهٔ یک‌خطی)
 * - فرمت گزارش: نوار پیشرفت + کل/مصرف + باقی‌مانده + روزهای مانده تا ریست
 * - صف خود-ترمیم + ثبت وضعیت آخرین اجرا
 */

// ───────────────────────────── تنظیمات ─────────────────────────────
const API_BASE = "https://api.windscribe.net"; // ⚠️ .net نه .com

const CFG = {
  MIN_GAP_MS: 5000,
  LOGIN_GAP_MS: 12000,
  WAIT_ON_429_S: 120,
  COOLDOWN_S: 30 * 60,
  MAX_RETRIES: 2,
  BACKOFF_BASE_MS: 5000,
  BACKOFF_MAX_MS: 30000,
  TG_GAP_MS: 1500,
  TIMEOUT_MS: 20000,
};

const KV = {
  accounts: "accounts",
  queueIdx: "queue:idx",
  cycle: "cycle:results",
  cooldown: "rl:cooldown",
  lastLogin: "rl:lastLogin",
  lastRun: "state:lastRun",
  rlStreak: "rl:streak",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) " +
  "Gecko/20100101 Firefox/155.0";

function webHeaders(authHash = null) {
  return {
    authorization: authHash ? `Bearer ${authHash}` : "Bearer anonymous",
    "content-type": "application/json",
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://windscribe.net",
    Referer: "https://windscribe.net/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    DNT: "1",
  };
}

// ───────────────────────────── ابزارها ─────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

const fa = (s) =>
  String(s).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]).replace(/\./g, "٫");

/** حجم خوانا — عددهای صحیح بدون اعشار (11GB)، بقیه با دو رقم (7.92GB) */
function humanBytes(n) {
  n = Number(n || 0);
  if (n < 0) return "نامحدود";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const v = n >= 100 || Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
  return `${v}${units[i]}`;
}

function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round((pct || 0) / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─────────────── محاسبهٔ روز مانده تا ریست ───────────────
function daysUntilReset(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!d || isNaN(d)) return null;
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000));
}

// ───────────────────── محدودکنندهٔ نرخ ─────────────────────
class Limiter {
  constructor(kv) {
    this.kv = kv;
    this.lastReq = 0;
  }
  async gap(ms) {
    const jitter = Math.floor(Math.random() * 2000);
    const wait = this.lastReq + ms + jitter - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastReq = Date.now();
  }
  async cooldownLeft() {
    const v = await this.kv.get(KV.cooldown);
    const until = v ? Number(v) : 0;
    return until > now() ? until - now() : 0;
  }
  async setCooldown(seconds = CFG.COOLDOWN_S) {
    await this.kv.put(KV.cooldown, String(now() + seconds), {
      expirationTtl: seconds + 60,
    });
  }
  async loginGate() {
    const v = Number((await this.kv.get(KV.lastLogin)) || 0);
    const waitMs = v + CFG.LOGIN_GAP_MS - Date.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, CFG.LOGIN_GAP_MS));
    await this.kv.put(KV.lastLogin, String(Date.now()), { expirationTtl: 600 });
  }
}

class RateLimited extends Error {
  constructor(retryAfter) {
    super("rate_limited");
    this.retryAfter = retryAfter;
  }
}

async function apiFetch(limiter, url, init) {
  let attempt = 0;
  for (;;) {
    attempt++;
    await limiter.gap(CFG.MIN_GAP_MS);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CFG.TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      clearTimeout(t);
      if (attempt > CFG.MAX_RETRIES) throw new Error(`network: ${e.message}`);
      await sleep(Math.min(CFG.BACKOFF_BASE_MS * attempt, CFG.BACKOFF_MAX_MS));
      continue;
    }
    clearTimeout(t);

    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after") || 0);
      if (attempt > CFG.MAX_RETRIES) {
        await limiter.setCooldown(Math.max(ra, CFG.COOLDOWN_S));
        throw new RateLimited(ra || CFG.COOLDOWN_S);
      }
      await sleep((ra || CFG.WAIT_ON_429_S) * 1000 + 1000);
      continue;
    }
    if (res.status >= 500 && attempt <= CFG.MAX_RETRIES) {
      await sleep(Math.min(CFG.BACKOFF_BASE_MS * attempt, CFG.BACKOFF_MAX_MS));
      continue;
    }
    return res;
  }
}

// ───────────────────────────── TOTP (2FA) ─────────────────────────────
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  s = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = A.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
async function totp(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code =
    (((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) |
     (sig[off + 2] << 8) | sig[off + 3]) % 1000000;
  return String(code).padStart(6, "0");
}

// ─────────────── رمزنگاری پسوردها در KV (اختیاری) ───────────────
async function encKey(env) {
  if (!env.ENC_KEY) return null;
  const raw = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(env.ENC_KEY)
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt", "decrypt",
  ]);
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function encrypt(env, text) {
  const key = await encKey(env);
  if (!key) return { v: 0, d: text };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(text)
  );
  return { v: 1, iv: b64(iv), d: b64(ct) };
}
async function decrypt(env, obj) {
  if (!obj || typeof obj !== "object") return String(obj ?? "");
  if (obj.v !== 1) return obj.d ?? "";
  const key = await encKey(env);
  if (!key) return "";
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(obj.iv) }, key, unb64(obj.d)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return "";
  }
}

// ───────────────────────────── ذخیره‌سازی ─────────────────────────────
async function loadAccounts(env) {
  const raw = await env.WS_KV.get(KV.accounts, "json");
  return Array.isArray(raw) ? raw : [];
}
async function saveAccounts(env, accounts) {
  await env.WS_KV.put(KV.accounts, JSON.stringify(accounts));
}
async function loadCycle(env) {
  const raw = await env.WS_KV.get(KV.cycle, "json");
  return raw && typeof raw === "object" ? raw : {};
}
async function saveCycle(env, cycle) {
  await env.WS_KV.put(KV.cycle, JSON.stringify(cycle));
}

// ─────────────────── تحلیل خطای API ───────────────────
function apiErrorText(json, status) {
  if (!json || typeof json !== "object") return `HTTP ${status}`;
  const e = json.error;
  return String(
    json.errorMessage || json.error_message || json.message ||
    (Array.isArray(json.errors) && json.errors[0]?.message) ||
    (e && typeof e === "object" ? e.message || e.code : e) ||
    `HTTP ${status}`
  );
}
function classifyError(json, status) {
  const blob = JSON.stringify(json ?? {}).toLowerCase();
  const has = (...ws) => ws.some((w) => blob.includes(w));
  if (has("2fa", "totp", "two_factor", "authenticator")) return "2fa";
  if (has("banned", "blocked", "suspended")) return "banned";
  if (has("password", "credential", "invalid username", "unknown user",
          "user not found", "login failed", "incorrect")) return "credential";
  return "other";
}

// ───────────────────────────── منطق ویندزسکرایب ─────────────────────────────
async function wsLogin(env, limiter, acc) {
  const password = await decrypt(env, acc.password);
  if (!password) throw new Error("پسورد قابل بازگشایی نیست (ENC_KEY عوض شده؟)");

  const code2fa = acc.totp_secret ? await totp(acc.totp_secret) : null;
  const H = webHeaders();
  const fa2 = () => (code2fa ? { "2fa_code": code2fa } : {});

  await limiter.loginGate();
  const tokRes = await apiFetch(limiter, `${API_BASE}/AuthToken/login`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ username: acc.username, password, ...fa2() }),
  });
  const tokJson = await tokRes.json().catch(() => ({}));
  const tokData = tokJson?.data || {};

  if (!tokRes.ok) {
    const kind = classifyError(tokJson, tokRes.status);
    if (kind === "credential") throw new Error("نام کاربری یا رمز اشتباه است");
    if (kind === "2fa")
      throw new Error(code2fa ? "کد 2FA رد شد" : "اکانت 2FA دارد؛ سکرت را اضافه کنید");
    throw new Error(`AuthToken: ${apiErrorText(tokJson, tokRes.status)}`);
  }
  if (!tokData.success || !tokData.token)
    throw new Error(`AuthToken ناموفق: ${JSON.stringify(tokJson).slice(0, 150)}`);

  const platforms = [
    { platform: "web", session_type_id: 3 },
    { platform: "legacy-web", session_type_id: 1 },
  ];
  let lastErr = "نامشخص";
  for (const p of platforms) {
    const res = await apiFetch(limiter, `${API_BASE}/Session`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        username: acc.username,
        password,
        session_type_id: p.session_type_id,
        platform: p.platform,
        secure_token: tokData.token,
        secure_token_sig: tokData.token_sig,
        ...fa2(),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json?.data?.session_auth_hash)
      return { hash: json.data.session_auth_hash, data: json.data };

    lastErr = `${p.platform}: ${apiErrorText(json, res.status)}`;
    const kind = classifyError(json, res.status);
    if (kind === "credential") throw new Error("نام کاربری یا رمز اشتباه است");
    if (kind === "2fa") throw new Error("کد 2FA رد شد");
  }
  throw new Error(`Session ناموفق → ${lastErr}`);
}

function normalize(username, data) {
  const max = Number(data.traffic_max ?? 0);
  const used = Number(data.traffic_used ?? 0);
  const unlimited = max < 0;

  let reset = null;
  const cand = data.reset_date || data.rst || null;
  if (cand) {
    const d = typeof cand === "number" ? new Date(cand * 1000) : new Date(cand);
    if (!isNaN(d)) reset = d;
  }
  if (!reset && data.last_reset) {
    const lr = typeof data.last_reset === "number"
      ? new Date(data.last_reset * 1000) : new Date(data.last_reset);
    if (!isNaN(lr)) {
      reset = new Date(lr);
      reset.setUTCMonth(reset.getUTCMonth() + 1);
    }
  }

  return {
    username: data.username || username,
    used,
    max,
    unlimited,
    remaining: unlimited ? -1 : Math.max(0, max - used),
    percent: unlimited || !max ? 0 : Math.min(100, (used / max) * 100),
    is_premium: !!data.is_premium,
    status: Number(data.status ?? 0),
    reset: reset ? reset.toISOString() : null,
  };
}

async function fetchAccountFresh(env, limiter, acc) {
  const { hash, data } = await wsLogin(env, limiter, acc);

  const res = await apiFetch(limiter, `${API_BASE}/Session`, {
    headers: webHeaders(hash),
  });
  if (res.ok) {
    const json = await res.json().catch(() => ({}));
    if (json?.data) return normalize(acc.username, json.data);
  }
  if (data && data.traffic_max !== undefined)
    return normalize(acc.username, data);

  throw new Error(`Session HTTP ${res.status}`);
}

// ─────────────── فرمت بلوک اکانت (فرمت جدید) ───────────────
/**
 * ✅ 22) dayeho6318
 * ░░░░░░░░░░ 0.0٪
 * ▫️ کل: 11GB | مصرف شده: 0.00B
 * ▫️ حجم باقی‌مانده: 11.00GB
 * ▫️ 8 روز تا ریست اکانت باقی مانده
 * 🔑 user : pass
 */
function fullBlock(r, i, password) {
  if (r.error)
    return `❌ ${i}) ${escapeHtml(r.username)}\n▫️ ${escapeHtml(r.error)}\n`;

  const icon = r.status === 1 ? "✅" : "⛔️";
  const premium = r.is_premium ? " 💎" : "";

  let s = `${icon} ${i}) ${escapeHtml(r.username)}${premium}\n`;
  s += `<code>${bar(r.percent)}</code> ${r.percent.toFixed(1)}٪\n`;

  if (r.unlimited) {
    s += `▫️ کل: نامحدود | مصرف شده: ${humanBytes(r.used)}\n`;
  } else {
    s += `▫️ کل: ${humanBytes(r.max)} | مصرف شده: ${humanBytes(r.used)}\n`;
    s += `▫️ حجم باقی‌مانده: ${humanBytes(r.remaining)}\n`;
  }

  const days = daysUntilReset(r.reset);
  if (days !== null)
    s += `▫️ ${days} روز تا ریست اکانت باقی مانده\n`;

  if (password !== undefined)
    s += `🔑 ${escapeHtml(r.username)} : ${escapeHtml(password || "-")}\n`;

  return s + "\n";
}

/** پیام گزارش کامل دور (تکه‌تکه برای سقف ۴۰۹۶ تلگرام) */
async function buildFullReportChunks(env, cycle) {
  const accounts = await loadAccounts(env);
  const showPass = env.SHOW_PASSWORDS !== "false";

  const ok = accounts.filter((a) => {
    const r = cycle[String(a.username).toLowerCase()];
    return r && !r.error;
  }).length;
  const err = accounts.filter((a) => {
    const r = cycle[String(a.username).toLowerCase()];
    return r && r.error;
  }).length;

  let head = `📊 <b>گزارش کامل اکانت‌ها</b>\n`;
  head += `✅ ${ok} سالم | ❌ ${err} خطا | 👥 ${accounts.length} اکانت\n\n`;

  const blocks = [];
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const r = cycle[String(a.username).toLowerCase()];
    if (r && !r.error) {
      const pass = showPass ? await decrypt(env, a.password) : undefined;
      blocks.push(fullBlock(r, i + 1, pass));
    } else if (r && r.error) {
      blocks.push(fullBlock(r, i + 1));
    } else {
      blocks.push(`⚪️ ${i + 1}) ${escapeHtml(a.username)}\n▫️ در این دور بررسی نشد\n`);
    }
  }

  const chunks = [];
  let cur = head;
  for (const b of blocks) {
    if (cur.length + b.length > 3500) {
      chunks.push(cur);
      cur = "";
    }
    cur += b;
  }
  chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

/** ارسال گزارش پایان دور و پاک‌سازی برای دور جدید */
async function finishCycle(env, cycle) {
  const chunks = await buildFullReportChunks(env, cycle);
  for (const c of chunks) {
    await send(env, env.TELEGRAM_CHANNEL_ID, c);
    await sleep(CFG.TG_GAP_MS);
  }

  await env.WS_KV.delete(KV.cycle);
  await env.WS_KV.put(KV.queueIdx, "0", { expirationTtl: 7 * 86400 });
}

// ───────────────────────────── چرخهٔ اصلی (خود-ترمیم) ─────────────────────────────
async function runCycleStep(env) {
  const accounts = (await loadAccounts(env)).filter((a) => a.enabled !== false);
  if (!accounts.length) return { empty: true };

  const limiter = new Limiter(env.WS_KV);
  const mark = (obj) =>
    env.WS_KV.put(KV.lastRun, JSON.stringify({ at: now(), ...obj }), {
      expirationTtl: 86400,
    });

  const cd = await limiter.cooldownLeft();
  if (cd > 0) {
    await mark({ status: "cooldown", left: cd });
    return { cooldown: true, left: cd };
  }

  const cycle = await loadCycle(env);

  // دور قبلی کامل شده ولی گزارش ارسال نشده؟ (ریست وسط کار)
  const remaining = accounts.filter((a) => !cycle[a.username.toLowerCase()]);
  if (!remaining.length) {
    await finishCycle(env, cycle);
    await mark({ status: "cycle-complete" });
    return { cycleComplete: true };
  }

  // اولین اکانتِ بدون نتیجه را از محل اشاره‌گر پیدا کن (خود-ترمیم)
  const startIdx = Number((await env.WS_KV.get(KV.queueIdx)) || 0) % accounts.length;
  let pos = -1;
  for (let k = 0; k < accounts.length; k++) {
    const p = (startIdx + k) % accounts.length;
    if (!cycle[accounts[p].username.toLowerCase()]) { pos = p; break; }
  }
  if (pos === -1) pos = startIdx;

  const acc = accounts[pos];

  try {
    const r = await fetchAccountFresh(env, limiter, acc);
    cycle[acc.username.toLowerCase()] = r;
    await env.WS_KV.put(KV.rlStreak, "0", { expirationTtl: 86400 });
    await mark({ status: "ok", username: acc.username });
  } catch (e) {
    if (e instanceof RateLimited) {
      const streak = Number((await env.WS_KV.get(KV.rlStreak)) || 0) + 1;
      await env.WS_KV.put(KV.rlStreak, String(streak), { expirationTtl: 86400 });
      await mark({ status: "429", username: acc.username, streak });

      if (streak === 3 || streak % 10 === 0) {
        await send(
          env,
          env.TELEGRAM_CHANNEL_ID,
          `⚠️ ${fa(streak)} اجرای پیاپی محدودیت نرخ (429). ` +
            `بررسی خودکار ادامه دارد — اکانت جاری: <b>${escapeHtml(acc.username)}</b>`
        );
      }
      return { rateLimited: true, username: acc.username };
    }
    cycle[acc.username.toLowerCase()] = { username: acc.username, error: e.message };
    await mark({ status: "error", username: acc.username, error: e.message });
  }

  await saveCycle(env, cycle);

  await env.WS_KV.put(
    KV.queueIdx,
    String((pos + 1) % accounts.length),
    { expirationTtl: 7 * 86400 }
  );

  const allDone = accounts.every((a) => cycle[a.username.toLowerCase()]);
  if (allDone) {
    await finishCycle(env, cycle);
    await mark({ status: "cycle-complete" });
    return { cycleComplete: true };
  }

  return { checked: acc.username };
}

// ───────────────────────────── تلگرام ─────────────────────────────
async function tg(env, method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!json.ok && json.parameters?.retry_after) {
    await sleep((json.parameters.retry_after + 1) * 1000);
    return tg(env, method, payload);
  }
  return json;
}
async function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function isAdmin(env, userId) {
  const list = String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(String(userId));
}

const HELP = `<b>دستورات ربات</b>

/check <code>username</code> — بررسی فوری یک اکانت
/next — اجرای دستی یک گام بررسی
/resync — همگام‌سازی صف با دیتابیس
/report — نمایش نتایج ذخیره‌شدهٔ دور جاری
/add <code>username password [totp]</code>
/del <code>username</code>
/list — فهرست اکانت‌ها
/status — وضعیت کامل سیستم
/help — راهنما

<i>هر ۱۵ دقیقه ۱ اکانت بررسی و ذخیره می‌شود؛ پایان هر دور: گزارش کامل.</i>`;

async function handleUpdate(env, update, ctx) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isAdmin(env, userId)) {
    if (msg.chat.type === "private")
      await send(env, chatId, `⛔️ دسترسی ندارید.\nآی‌دی شما: <code>${userId}</code>`);
    return;
  }

  const text = msg.text.trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const limiter = new Limiter(env.WS_KV);

  switch (cmd) {
    case "/start":
    case "/help":
      await send(env, chatId, HELP);
      break;

    case "/add": {
      if (args.length < 2) {
        await send(env, chatId, "فرمت: <code>/add username password [totp]</code>");
        break;
      }
      const [username, password, totpSecret] = args;
      const accounts = await loadAccounts(env);
      const enc = await encrypt(env, password);
      const idx = accounts.findIndex(
        (a) => a.username.toLowerCase() === username.toLowerCase()
      );
      const rec = {
        username, password: enc, totp_secret: totpSecret || null,
        enabled: true, added_at: now(),
      };
      if (idx >= 0) accounts[idx] = rec;
      else accounts.push(rec);
      await saveAccounts(env, accounts);
      ctx.waitUntil(tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }));
      await send(env, chatId,
        `✅ <code>${escapeHtml(username)}</code> ${idx >= 0 ? "به‌روزرسانی" : "افزوده"} شد.`);
      break;
    }

    case "/del": {
      if (!args[0]) { await send(env, chatId, "فرمت: <code>/del username</code>"); break; }
      const accounts = await loadAccounts(env);
      const left = accounts.filter(
        (a) => a.username.toLowerCase() !== args[0].toLowerCase()
      );
      if (left.length === accounts.length) {
        await send(env, chatId, "اکانتی با این نام پیدا نشد.");
        break;
      }
      await saveAccounts(env, left);
      const cycle = await loadCycle(env);
      delete cycle[args[0].toLowerCase()];
      await saveCycle(env, cycle);
      await send(env, chatId, `🗑 <code>${escapeHtml(args[0])}</code> حذف شد.`);
      break;
    }

    case "/list": {
      const accounts = await loadAccounts(env);
      if (!accounts.length) { await send(env, chatId, "لیست خالی است."); break; }
      const lines = accounts.map((a, i) =>
        `${fa(i + 1)}. <code>${escapeHtml(a.username)}</code>${a.totp_secret ? " 🔐" : ""}`
      );
      await send(env, chatId,
        `<b>اکانت‌ها (${fa(accounts.length)})</b>\n` + lines.join("\n"));
      break;
    }

    case "/check": {
      if (!args[0]) { await send(env, chatId, "فرمت: <code>/check username</code>"); break; }
      const accounts = await loadAccounts(env);
      const acc = accounts.find(
        (a) => a.username.toLowerCase() === args[0].toLowerCase()
      );
      if (!acc) { await send(env, chatId, "اکانت پیدا نشد."); break; }
      await send(env, chatId, "⏳ ...");
      try {
        const r = await fetchAccountFresh(env, limiter, acc);
        const cycle = await loadCycle(env);
        cycle[acc.username.toLowerCase()] = r;
        await saveCycle(env, cycle);
        const pass = await decrypt(env, acc.password);
        await send(env, chatId, fullBlock(r, 1, pass));
      } catch (e) {
        if (e instanceof RateLimited) {
          await send(env, chatId, "⚠️ محدودیت نرخ — کمی بعد دوباره امتحان کن");
        } else {
          await send(env, chatId, `❌ 1) ${escapeHtml(acc.username)}\n▫️ ${escapeHtml(e.message)}`);
        }
      }
      break;
    }

    case "/next": {
      const r = await runCycleStep(env);
      if (r.empty) { await send(env, chatId, "لیست اکانت‌ها خالی است."); break; }
      if (r.cooldown) {
        await send(env, chatId, `⏸ استراحت — ${fa(Math.ceil(r.left / 60))} دقیقه دیگر`); break;
      }
      if (r.rateLimited) {
        await send(env, chatId, `⚠️ محدودیت نرخ روی <code>${escapeHtml(r.username)}</code>`); break;
      }
      if (r.cycleComplete) {
        await send(env, chatId, "✅ دور کامل شد؛ گزارش کامل به کانال ارسال شد."); break;
      }
      await send(env, chatId, `✔️ <code>${escapeHtml(r.checked)}</code> بررسی و ذخیره شد.`);
      break;
    }

    case "/resync": {
      const accounts = await loadAccounts(env);
      const cycle = await loadCycle(env);
      const stored = Object.keys(cycle).length;
      let target = 0;
      for (let i = 0; i < accounts.length; i++) {
        if (!cycle[accounts[i].username.toLowerCase()]) { target = i; break; }
      }
      await env.WS_KV.put(KV.queueIdx, String(target), { expirationTtl: 7 * 86400 });
      await send(env, chatId,
        `🔧 صف همگام شد\n` +
        `💾 ذخیره‌شده: ${fa(stored)} از ${fa(accounts.length)}\n` +
        `▶️ نوبت بعدی: <code>${escapeHtml(accounts[target]?.username || "-")}</code>`);
      break;
    }

    case "/report": {
      const cycle = await loadCycle(env);
      const chunks = await buildFullReportChunks(env, cycle);
      for (const c of chunks) {
        await send(env, chatId, c);
        await sleep(CFG.TG_GAP_MS);
      }
      break;
    }

    case "/status": {
      const accounts = await loadAccounts(env);
      const cycle = await loadCycle(env);
      const done = accounts.filter((a) => cycle[a.username.toLowerCase()]).length;
      const cd = await limiter.cooldownLeft();
      const streak = Number((await env.WS_KV.get(KV.rlStreak)) || 0);
      const last = await env.WS_KV.get(KV.lastRun, "json");
      const nextAcc = accounts.find((a) => !cycle[a.username.toLowerCase()]);

      let lastLine = "هنوز اجرایی ثبت نشده";
      if (last) {
        const ago = now() - last.at;
        const agoStr =
          ago < 90 ? `${fa(ago)} ثانیه پیش` : `${fa(Math.round(ago / 60))} دقیقه پیش`;
        lastLine =
          `<code>${escapeHtml(String(last.status))}</code> — ${agoStr}` +
          (last.username ? ` — <code>${escapeHtml(last.username)}</code>` : "") +
          (last.error ? `\n   ↳ ${escapeHtml(last.error)}` : "");
      }

      await send(
        env,
        chatId,
        `<b>وضعیت</b>\n` +
          `👥 اکانت‌ها: ${fa(accounts.length)}\n` +
          `💾 این دور: ${fa(done)} از ${fa(accounts.length)} بررسی شده\n` +
          `▶️ نوبت بعدی: <code>${escapeHtml(nextAcc?.username || "-")}</code>\n` +
          `🕓 آخرین اجرای خودکار: ${lastLine}\n` +
          `🔁 429های پیاپی: ${fa(streak)}\n` +
          `⏸ cooldown: ${cd ? fa(Math.ceil(cd / 60)) + " دقیقه" : "ندارد ✅"}`
      );
      break;
    }

    default:
      if (msg.chat.type === "private") await send(env, chatId, HELP);
  }
}

// ───────────────────────────── ورودی ورکر ─────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/tg/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await request.json().catch(() => ({}));
      if (update) ctx.waitUntil(handleUpdate(env, update, ctx).catch(console.error));
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/tg/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      return Response.json(r);
    }

    if (url.pathname === "/run") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      ctx.waitUntil(runCycleStep(env).catch(console.error));
      return new Response("started");
    }

    return new Response("Windscribe reporter v10 — new report format.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycleStep(env).catch(console.error));
  },
};
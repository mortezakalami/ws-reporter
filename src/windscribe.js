import { API_BASE, webHeaders } from "./config.js";
import { decrypt, totp } from "./crypto.js";
import { apiFetch } from "./limiter.js";
import { addMonthsUTC, now } from "./utils.js";

function apiErrorText(json, status) {
  if (!json || typeof json !== "object") return `HTTP ${status}`;
  const e = json.error;
  return String(
    json.errorMessage ||
      json.error_message ||
      json.message ||
      (Array.isArray(json.errors) && json.errors[0]?.message) ||
      (e && typeof e === "object" ? e.message || e.code : e) ||
      `HTTP ${status}`,
  );
}

function classifyError(json) {
  const blob = JSON.stringify(json ?? {}).toLowerCase();
  const has = (...ws) => ws.some((w) => blob.includes(w));
  if (has("2fa", "totp", "two_factor", "authenticator")) return "2fa";
  if (has("banned", "blocked", "suspended")) return "banned";
  if (
    has(
      "password",
      "credential",
      "invalid username",
      "unknown user",
      "user not found",
      "login failed",
      "incorrect",
    )
  ) {
    return "credential";
  }
  return "other";
}

function parseApiDate(cand) {
  if (cand === null || cand === undefined || cand === "") return null;
  if (typeof cand === "number" || /^\d+$/.test(String(cand))) {
    const num = Number(cand);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  const d = new Date(cand);
  return isNaN(d) ? null : d;
}

export function normalize(username, data) {
  const max = Number(data.traffic_max ?? 0);
  const used = Number(data.traffic_used ?? 0);
  const unlimited = max < 0;

  let reset = parseApiDate(data.reset_date || data.rst || null);
  if (!reset && data.last_reset) {
    const lr = parseApiDate(data.last_reset);
    if (lr) {
      reset = addMonthsUTC(lr, 1);
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

async function get2faPayload(acc) {
  if (!acc.totp_secret) return {};
  return { "2fa_code": await totp(acc.totp_secret) };
}

export async function wsLogin(env, limiter, acc) {
  const password = await decrypt(env, acc.password);
  if (!password) throw new Error("پسورد قابل بازگشایی نیست (ENC_KEY عوض شده؟)");

  const H = webHeaders();
  const faLogin = await get2faPayload(acc);

  await limiter.loginGate();
  const tokRes = await apiFetch(limiter, `${API_BASE}/AuthToken/login`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ username: acc.username, password, ...faLogin }),
  });
  const tokJson = await tokRes.json().catch(() => ({}));
  const tokData = tokJson?.data || {};

  if (!tokRes.ok) {
    const kind = classifyError(tokJson);
    if (kind === "credential") throw new Error("نام کاربری یا رمز اشتباه است");
    if (kind === "2fa") {
      throw new Error(
        acc.totp_secret ? "کد 2FA رد شد" : "اکانت 2FA دارد؛ سکرت را اضافه کنید",
      );
    }
    throw new Error(`AuthToken: ${apiErrorText(tokJson, tokRes.status)}`);
  }
  if (!tokData.success || !tokData.token) {
    throw new Error(`AuthToken ناموفق: ${JSON.stringify(tokJson).slice(0, 150)}`);
  }

  const platforms = [
    { platform: "web", session_type_id: 3 },
    { platform: "legacy-web", session_type_id: 1 },
  ];
  let lastErr = "نامشخص";
  for (const p of platforms) {
    // Re-generate TOTP right before each Session attempt so retries never send an expired code
    const faSession = await get2faPayload(acc);
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
        ...faSession,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json?.data?.session_auth_hash) {
      return { hash: json.data.session_auth_hash, data: json.data };
    }

    lastErr = `${p.platform}: ${apiErrorText(json, res.status)}`;
    const kind = classifyError(json);
    if (kind === "credential") throw new Error("نام کاربری یا رمز اشتباه است");
    if (kind === "2fa") throw new Error("کد 2FA رد شد");
  }
  throw new Error(`Session ناموفق ← ${lastErr}`);
}

/**
 * Fetch fresh traffic stats for an account.
 * Reuses cached session_auth_hash when available, falling back to full login only when expired.
 */
export async function fetchAccountFresh(env, limiter, acc, sessionsCache = null) {
  const key = String(acc.username).toLowerCase();
  const cachedHash = sessionsCache?.[key]?.hash;
  let sessionsDirty = false;

  if (cachedHash) {
    const cachedRes = await apiFetch(limiter, `${API_BASE}/Session`, {
      headers: webHeaders(cachedHash),
    });
    if (cachedRes.ok) {
      const json = await cachedRes.json().catch(() => ({}));
      if (json?.data && json.data.traffic_max !== undefined) {
        return { result: normalize(acc.username, json.data), sessionsDirty };
      }
    }
    if (cachedRes.status === 401 || cachedRes.status === 403 || !cachedRes.ok) {
      delete sessionsCache[key];
      sessionsDirty = true;
    }
  }

  const { hash, data } = await wsLogin(env, limiter, acc);
  if (sessionsCache && hash) {
    sessionsCache[key] = { hash, savedAt: now() };
    sessionsDirty = true;
  }

  if (data && data.traffic_max !== undefined) {
    return { result: normalize(acc.username, data), sessionsDirty };
  }

  const res = await apiFetch(limiter, `${API_BASE}/Session`, {
    headers: webHeaders(hash),
  });
  if (res.ok) {
    const json = await res.json().catch(() => ({}));
    if (json?.data) {
      return { result: normalize(acc.username, json.data), sessionsDirty };
    }
  }

  throw new Error(`Session HTTP ${res.status}`);
}

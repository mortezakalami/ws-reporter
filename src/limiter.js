import { CFG, KV } from "./config.js";
import { now, sleep } from "./utils.js";

export class Limiter {
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
    const sec = Math.max(60, Math.ceil(Number(seconds) || CFG.COOLDOWN_S));
    await this.kv.put(KV.cooldown, String(now() + sec), {
      expirationTtl: sec + 60,
    });
    return sec;
  }

  async loginGate() {
    const v = Number((await this.kv.get(KV.lastLogin)) || 0);
    const waitMs = v + CFG.LOGIN_GAP_MS - Date.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, CFG.LOGIN_GAP_MS));
    await this.kv.put(KV.lastLogin, String(Date.now()), { expirationTtl: 600 });
  }
}

export class RateLimited extends Error {
  constructor(retryAfter) {
    super("rate_limited");
    this.retryAfter = retryAfter;
  }
}

export async function apiFetch(limiter, url, init) {
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

    // Fail fast on 429/503 and persist cooldown in KV instead of blocking the Worker for minutes
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after") || 0);
      const cooldownSec = await limiter.setCooldown(Math.max(ra, CFG.COOLDOWN_S));
      throw new RateLimited(cooldownSec);
    }

    if (res.status >= 500 && attempt <= CFG.MAX_RETRIES) {
      await sleep(Math.min(CFG.BACKOFF_BASE_MS * attempt, CFG.BACKOFF_MAX_MS));
      continue;
    }

    return res;
  }
}

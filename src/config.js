export const API_BASE = "https://api.windscribe.net"; // .net (not .com)

export const CFG = {
  MIN_GAP_MS: 5000,
  LOGIN_GAP_MS: 12000,
  COOLDOWN_S: 30 * 60,
  MAX_RETRIES: 2,
  BACKOFF_BASE_MS: 5000,
  BACKOFF_MAX_MS: 30000,
  TG_GAP_MS: 1500,
  TG_MAX_RETRIES: 3,
  TIMEOUT_MS: 20000,
  LOCK_TTL_S: 90,
};

export const KV = {
  accounts: "accounts",
  queueIdx: "queue:idx",
  cycle: "cycle:results",
  cooldown: "rl:cooldown",
  lastLogin: "rl:lastLogin",
  lastRun: "state:lastRun",
  rlStreak: "rl:streak",
  sessions: "auth:sessions",
  lock: "state:lock",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) " +
  "Gecko/20100101 Firefox/155.0";

export function webHeaders(authHash = null) {
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

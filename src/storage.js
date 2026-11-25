import { CFG, KV } from "./config.js";

export async function loadAccounts(env) {
  const raw = await env.WS_KV.get(KV.accounts, "json");
  return Array.isArray(raw) ? raw : [];
}

export async function saveAccounts(env, accounts) {
  await env.WS_KV.put(KV.accounts, JSON.stringify(accounts));
}

export function getActiveAccounts(accounts) {
  return accounts.filter((a) => a.enabled !== false);
}

export async function loadCycle(env) {
  const raw = await env.WS_KV.get(KV.cycle, "json");
  return raw && typeof raw === "object" ? raw : {};
}

export async function saveCycle(env, cycle) {
  await env.WS_KV.put(KV.cycle, JSON.stringify(cycle));
}

export async function loadSessions(env) {
  const raw = await env.WS_KV.get(KV.sessions, "json");
  return raw && typeof raw === "object" ? raw : {};
}

export async function saveSessions(env, sessions) {
  await env.WS_KV.put(KV.sessions, JSON.stringify(sessions));
}

/** Soft distributed lock in KV to prevent concurrent cron + manual command races */
export async function withCycleLock(env, fn) {
  const existing = await env.WS_KV.get(KV.lock);
  if (existing) {
    return { busy: true };
  }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.WS_KV.put(KV.lock, token, { expirationTtl: CFG.LOCK_TTL_S });
  try {
    return await fn();
  } finally {
    const current = await env.WS_KV.get(KV.lock);
    if (current === token) {
      await env.WS_KV.delete(KV.lock);
    }
  }
}

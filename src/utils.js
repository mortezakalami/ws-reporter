export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Math.floor(Date.now() / 1000);

export const fa = (s) =>
  String(s).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]).replace(/\./g, "٫");

/** Human-readable byte formatter (integers without decimals, others with 2 decimals) */
export function humanBytes(n) {
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

export function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round((pct || 0) / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function daysUntilReset(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!d || isNaN(d)) return null;
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000));
}

/** Add UTC months without overflowing month-end dates (e.g. Jan 31 -> Feb 28/29) */
export function addMonthsUTC(date, months) {
  const d = new Date(date.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return d;
}

export function isAdmin(env, userId) {
  const list = String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(String(userId));
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

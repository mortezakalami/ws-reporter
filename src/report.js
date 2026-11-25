import { decrypt } from "./crypto.js";
import { getActiveAccounts, loadAccounts } from "./storage.js";
import { bar, daysUntilReset, escapeHtml, humanBytes } from "./utils.js";

export function fullBlock(r, i, password) {
  if (r.error) {
    return `❌ ${i}) ${escapeHtml(r.username)}\n▫️ ${escapeHtml(r.error)}\n\n`;
  }

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
  if (days !== null) {
    s += `▫️ ${days} روز تا ریست اکانت باقی مانده\n`;
  }

  if (password !== undefined) {
    s += `🔑 ${escapeHtml(r.username)} : ${escapeHtml(password || "-")}\n`;
  }

  return s + "\n";
}

/** Build chunked report messages respecting Telegram's 4096-character limit */
export async function buildFullReportChunks(env, cycle) {
  const accounts = getActiveAccounts(await loadAccounts(env));
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
      blocks.push(
        `⚪️ ${i + 1}) ${escapeHtml(a.username)}\n▫️ در این دور بررسی نشد\n\n`,
      );
    }
  }

  const chunks = [];
  let cur = head;
  for (const b of blocks) {
    if (cur && cur.length + b.length > 3500) {
      chunks.push(cur);
      cur = "";
    }
    cur += b;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

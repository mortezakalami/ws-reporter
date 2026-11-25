import { CFG } from "./config.js";
import { sleep } from "./utils.js";

export async function tg(env, method, payload, attempt = 0) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN تنظیم نشده است");
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const json = await res.json().catch(() => ({}));

  if (!json.ok && json.parameters?.retry_after && attempt < CFG.TG_MAX_RETRIES) {
    await sleep((json.parameters.retry_after + 1) * 1000);
    return tg(env, method, payload, attempt + 1);
  }

  if (!res.ok || !json.ok) {
    const desc = json?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram ${method}: ${desc}`);
  }

  return json;
}

export async function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

import { KV } from "./config.js";
import { decrypt, encrypt, isValidTotpSecret } from "./crypto.js";
import { runCycleStep } from "./cycle.js";
import { Limiter, RateLimited } from "./limiter.js";
import { buildFullReportChunks, fullBlock } from "./report.js";
import {
  getActiveAccounts,
  loadAccounts,
  loadCycle,
  loadSessions,
  saveAccounts,
  saveCycle,
  saveSessions,
} from "./storage.js";
import { send, tg } from "./telegram.js";
import { escapeHtml, fa, isAdmin, now, sleep } from "./utils.js";
import { fetchAccountFresh } from "./windscribe.js";
import { CFG } from "./config.js";

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

export async function handleUpdate(env, update, ctx) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isAdmin(env, userId)) {
    if (msg.chat.type === "private") {
      await send(env, chatId, `⛔️ دسترسی ندارید.\nآی‌دی شما: <code>${userId}</code>`);
    }
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
      if (totpSecret && !isValidTotpSecret(totpSecret)) {
        await send(env, chatId, "❌ سکرت TOTP معتبر نیست (باید Base32 باشد).");
        break;
      }

      const accounts = await loadAccounts(env);
      const enc = await encrypt(env, password);
      const idx = accounts.findIndex(
        (a) => a.username.toLowerCase() === username.toLowerCase(),
      );
      const rec = {
        username,
        password: enc,
        totp_secret: totpSecret || null,
        enabled: true,
        added_at: now(),
      };
      if (idx >= 0) accounts[idx] = rec;
      else accounts.push(rec);
      await saveAccounts(env, accounts);

      // Clear any cached session hash when credentials are updated
      const sessions = await loadSessions(env);
      if (sessions[username.toLowerCase()]) {
        delete sessions[username.toLowerCase()];
        await saveSessions(env, sessions);
      }

      ctx.waitUntil(
        tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(
          () => {},
        ),
      );
      await send(
        env,
        chatId,
        `✅ <code>${escapeHtml(username)}</code> ${idx >= 0 ? "به‌روزرسانی" : "افزوده"} شد.`,
      );
      break;
    }

    case "/del": {
      if (!args[0]) {
        await send(env, chatId, "فرمت: <code>/del username</code>");
        break;
      }
      const target = args[0].toLowerCase();
      const accounts = await loadAccounts(env);
      const left = accounts.filter((a) => a.username.toLowerCase() !== target);
      if (left.length === accounts.length) {
        await send(env, chatId, "اکانتی با این نام پیدا نشد.");
        break;
      }
      await saveAccounts(env, left);

      const cycle = await loadCycle(env);
      delete cycle[target];
      await saveCycle(env, cycle);

      const sessions = await loadSessions(env);
      if (sessions[target]) {
        delete sessions[target];
        await saveSessions(env, sessions);
      }

      await send(env, chatId, `🗑 <code>${escapeHtml(args[0])}</code> حذف شد.`);
      break;
    }

    case "/list": {
      const accounts = await loadAccounts(env);
      if (!accounts.length) {
        await send(env, chatId, "لیست خالی است.");
        break;
      }
      const lines = accounts.map(
        (a, i) =>
          `${fa(i + 1)}. <code>${escapeHtml(a.username)}</code>` +
          `${a.totp_secret ? " 🔐" : ""}` +
          `${a.enabled === false ? " ⏸" : ""}`,
      );
      await send(
        env,
        chatId,
        `<b>اکانت‌ها (${fa(accounts.length)})</b>\n` + lines.join("\n"),
      );
      break;
    }

    case "/check": {
      if (!args[0]) {
        await send(env, chatId, "فرمت: <code>/check username</code>");
        break;
      }
      const accounts = await loadAccounts(env);
      const acc = accounts.find(
        (a) => a.username.toLowerCase() === args[0].toLowerCase(),
      );
      if (!acc) {
        await send(env, chatId, "اکانت پیدا نشد.");
        break;
      }
      await send(env, chatId, "⏳ ...");
      const sessions = await loadSessions(env);
      try {
        const { result, sessionsDirty } = await fetchAccountFresh(
          env,
          limiter,
          acc,
          sessions,
        );
        if (sessionsDirty) await saveSessions(env, sessions);

        const cycle = await loadCycle(env);
        cycle[acc.username.toLowerCase()] = result;
        await saveCycle(env, cycle);

        const showPass = env.SHOW_PASSWORDS !== "false";
        const pass = showPass ? await decrypt(env, acc.password) : undefined;
        await send(env, chatId, fullBlock(result, 1, pass));
      } catch (e) {
        if (e instanceof RateLimited) {
          await send(env, chatId, "⚠️ محدودیت نرخ — کمی بعد دوباره امتحان کن");
        } else {
          await send(
            env,
            chatId,
            `❌ 1) ${escapeHtml(acc.username)}\n▫️ ${escapeHtml(e.message)}`,
          );
        }
      }
      break;
    }

    case "/next": {
      const r = await runCycleStep(env);
      if (r.busy) {
        await send(env, chatId, "⏳ یک بررسی دیگر در حال اجراست، کمی بعد امتحان کن.");
        break;
      }
      if (r.empty) {
        await send(env, chatId, "لیست اکانت‌ها خالی است.");
        break;
      }
      if (r.cooldown) {
        await send(
          env,
          chatId,
          `⏸ استراحت — ${fa(Math.ceil(r.left / 60))} دقیقه دیگر`,
        );
        break;
      }
      if (r.rateLimited) {
        await send(
          env,
          chatId,
          `⚠️ محدودیت نرخ روی <code>${escapeHtml(r.username)}</code>`,
        );
        break;
      }
      if (r.cycleComplete) {
        await send(env, chatId, "✅ دور کامل شد؛ گزارش کامل به کانال ارسال شد.");
        break;
      }
      await send(env, chatId, `✔️ <code>${escapeHtml(r.checked)}</code> بررسی و ذخیره شد.`);
      break;
    }

    case "/resync": {
      const accounts = getActiveAccounts(await loadAccounts(env));
      const cycle = await loadCycle(env);
      const stored = accounts.filter((a) => cycle[a.username.toLowerCase()]).length;
      let target = 0;
      for (let i = 0; i < accounts.length; i++) {
        if (!cycle[accounts[i].username.toLowerCase()]) {
          target = i;
          break;
        }
      }
      await env.WS_KV.put(KV.queueIdx, String(target), {
        expirationTtl: 7 * 86400,
      });
      await send(
        env,
        chatId,
        `🔧 صف همگام شد\n` +
          `💾 ذخیره‌شده: ${fa(stored)} از ${fa(accounts.length)}\n` +
          `▶️ نوبت بعدی: <code>${escapeHtml(accounts[target]?.username || "-")}</code>`,
      );
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
      const allAccounts = await loadAccounts(env);
      const accounts = getActiveAccounts(allAccounts);
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
          ago < 90
            ? `${fa(ago)} ثانیه پیش`
            : `${fa(Math.round(ago / 60))} دقیقه پیش`;
        lastLine =
          `<code>${escapeHtml(String(last.status))}</code> — ${agoStr}` +
          (last.username ? ` — <code>${escapeHtml(last.username)}</code>` : "") +
          (last.error ? `\n   ↳ ${escapeHtml(last.error)}` : "");
      }

      await send(
        env,
        chatId,
        `<b>وضعیت</b>\n` +
          `👥 اکانت‌های فعال: ${fa(accounts.length)}` +
          (allAccounts.length !== accounts.length
            ? ` (کل: ${fa(allAccounts.length)})`
            : "") +
          `\n` +
          `💾 این دور: ${fa(done)} از ${fa(accounts.length)} بررسی شده\n` +
          `▶️ نوبت بعدی: <code>${escapeHtml(nextAcc?.username || "-")}</code>\n` +
          `🕓 آخرین اجرای خودکار: ${lastLine}\n` +
          `🔁 429های پیاپی: ${fa(streak)}\n` +
          `⏸ cooldown: ${cd ? fa(Math.ceil(cd / 60)) + " دقیقه" : "ندارد ✅"}`,
      );
      break;
    }

    default:
      if (msg.chat.type === "private") await send(env, chatId, HELP);
  }
}

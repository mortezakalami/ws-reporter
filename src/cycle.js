import { CFG, KV } from "./config.js";
import { Limiter, RateLimited } from "./limiter.js";
import { buildFullReportChunks } from "./report.js";
import {
  getActiveAccounts,
  loadAccounts,
  loadCycle,
  loadSessions,
  saveCycle,
  saveSessions,
  withCycleLock,
} from "./storage.js";
import { send } from "./telegram.js";
import { escapeHtml, fa, now, sleep } from "./utils.js";
import { fetchAccountFresh } from "./windscribe.js";

/** Send final cycle report; only clears cycle state after all Telegram messages succeed */
export async function finishCycle(env, cycle) {
  const chunks = await buildFullReportChunks(env, cycle);
  for (const c of chunks) {
    await send(env, env.TELEGRAM_CHANNEL_ID, c);
    await sleep(CFG.TG_GAP_MS);
  }

  await env.WS_KV.delete(KV.cycle);
  await env.WS_KV.put(KV.queueIdx, "0", { expirationTtl: 7 * 86400 });
}

export async function runCycleStep(env) {
  return withCycleLock(env, async () => {
    const accounts = getActiveAccounts(await loadAccounts(env));
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

    // Finish pending report if previous cycle completed but Telegram send had failed
    const remaining = accounts.filter((a) => !cycle[a.username.toLowerCase()]);
    if (!remaining.length) {
      await finishCycle(env, cycle);
      await mark({ status: "cycle-complete" });
      return { cycleComplete: true };
    }

    const startIdx =
      Number((await env.WS_KV.get(KV.queueIdx)) || 0) % accounts.length;
    let pos = -1;
    for (let k = 0; k < accounts.length; k++) {
      const p = (startIdx + k) % accounts.length;
      if (!cycle[accounts[p].username.toLowerCase()]) {
        pos = p;
        break;
      }
    }
    if (pos === -1) pos = startIdx;

    const acc = accounts[pos];
    const sessions = await loadSessions(env);
    let sessionsDirty = false;

    try {
      const res = await fetchAccountFresh(env, limiter, acc, sessions);
      sessionsDirty = res.sessionsDirty;
      cycle[acc.username.toLowerCase()] = res.result;
      await env.WS_KV.put(KV.rlStreak, "0", { expirationTtl: 86400 });
      await mark({ status: "ok", username: acc.username });
    } catch (e) {
      if (e instanceof RateLimited) {
        if (sessionsDirty) await saveSessions(env, sessions);
        const streak = Number((await env.WS_KV.get(KV.rlStreak)) || 0) + 1;
        await env.WS_KV.put(KV.rlStreak, String(streak), { expirationTtl: 86400 });
        await mark({ status: "429", username: acc.username, streak });

        if (streak === 3 || streak % 10 === 0) {
          await send(
            env,
            env.TELEGRAM_CHANNEL_ID,
            `⚠️ ${fa(streak)} اجرای پیاپی محدودیت نرخ (429). ` +
              `بررسی خودکار ادامه دارد — اکانت جاری: <b>${escapeHtml(acc.username)}</b>`,
          ).catch(console.error);
        }
        return { rateLimited: true, username: acc.username };
      }
      cycle[acc.username.toLowerCase()] = {
        username: acc.username,
        error: e.message,
      };
      await mark({ status: "error", username: acc.username, error: e.message });
    }

    if (sessionsDirty) await saveSessions(env, sessions);
    await saveCycle(env, cycle);

    await env.WS_KV.put(
      KV.queueIdx,
      String((pos + 1) % accounts.length),
      { expirationTtl: 7 * 86400 },
    );

    const allDone = accounts.every((a) => cycle[a.username.toLowerCase()]);
    if (allDone) {
      await finishCycle(env, cycle);
      await mark({ status: "cycle-complete" });
      return { cycleComplete: true };
    }

    return { checked: acc.username };
  });
}

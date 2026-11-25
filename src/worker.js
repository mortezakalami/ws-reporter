import { handleUpdate } from "./bot.js";
import { runCycleStep } from "./cycle.js";
import { tg } from "./telegram.js";
import { timingSafeEqualStr } from "./utils.js";

function isAuthorizedControlRequest(request, url, env) {
  if (!env.WEBHOOK_SECRET) return false;
  const provided =
    request.headers.get("x-webhook-secret") ||
    url.searchParams.get("key") ||
    "";
  return timingSafeEqualStr(provided, env.WEBHOOK_SECRET);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/tg/webhook" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET) {
        return new Response("misconfigured", { status: 503 });
      }
      const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (!timingSafeEqualStr(secret, env.WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => ({}));
      if (update) ctx.waitUntil(handleUpdate(env, update, ctx).catch(console.error));
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      if (!isAuthorizedControlRequest(request, url, env)) {
        return new Response("forbidden", { status: 403 });
      }
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/tg/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      return Response.json(r);
    }

    if (url.pathname === "/run") {
      if (!isAuthorizedControlRequest(request, url, env)) {
        return new Response("forbidden", { status: 403 });
      }
      ctx.waitUntil(runCycleStep(env).catch(console.error));
      return new Response("started");
    }

    return new Response("Windscribe reporter v10.1 — modular.");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCycleStep(env).catch(console.error));
  },
};

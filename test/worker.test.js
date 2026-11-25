import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decrypt, encrypt, isValidTotpSecret, totp } from "../src/crypto.js";
import { finishCycle } from "../src/cycle.js";
import { Limiter, RateLimited, apiFetch } from "../src/limiter.js";
import { buildFullReportChunks, fullBlock } from "../src/report.js";
import { addMonthsUTC, timingSafeEqualStr } from "../src/utils.js";
import { fetchAccountFresh, normalize } from "../src/windscribe.js";

function createMemoryKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const val = store.get(key);
      return type === "json" ? JSON.parse(val) : val;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    has(key) {
      return store.has(key);
    },
  };
}

describe("ws-reporter fixes & optimizations", () => {
  it("adds blank line after error blocks so accounts do not stick together", () => {
    const errOut = fullBlock({ username: "baduser", error: "invalid password" }, 7);
    assert.ok(errOut.endsWith("\n\n"));
  });

  it("handles month-end overflow cleanly in addMonthsUTC", () => {
    const jan31 = new Date("2026-01-31T12:00:00.000Z");
    const next = addMonthsUTC(jan31, 1);
    assert.equal(next.toISOString(), "2026-02-28T12:00:00.000Z");
  });

  it("validates TOTP Base32 secrets and rejects invalid strings", async () => {
    assert.equal(isValidTotpSecret("JBSWY3DPEHPK3PXP"), true);
    assert.equal(isValidTotpSecret("not-valid-189!"), false);
    const code = await totp("JBSWY3DPEHPK3PXP");
    assert.match(code, /^\d{6}$/);
  });

  it("encrypts and decrypts passwords with ENC_KEY", async () => {
    const env = { ENC_KEY: "test-secret-passphrase" };
    const enc = await encrypt(env, "p@ssword123!");
    assert.equal(enc.v, 1);
    assert.equal(await decrypt(env, enc), "p@ssword123!");
  });

  it("excludes disabled accounts from full report counts", async () => {
    const kv = createMemoryKV({
      accounts: JSON.stringify([
        { username: "active1", password: { v: 0, d: "pw" }, enabled: true },
        { username: "paused1", password: { v: 0, d: "pw" }, enabled: false },
      ]),
    });
    const chunks = await buildFullReportChunks(
      { WS_KV: kv, SHOW_PASSWORDS: "false" },
      {
        active1: normalize("active1", {
          traffic_max: 1024,
          traffic_used: 0,
          status: 1,
        }),
      },
    );
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].includes("👥 1 اکانت"));
    assert.ok(!chunks[0].includes("paused1"));
  });

  it("preserves cycle KV if Telegram delivery fails in finishCycle", async () => {
    const kv = createMemoryKV({
      accounts: JSON.stringify([
        { username: "u1", password: { v: 0, d: "pw" }, enabled: true },
      ]),
      "cycle:results": JSON.stringify({ u1: { username: "u1", status: 1, used: 0, max: 10, percent: 0, remaining: 10 } }),
    });
    const env = {
      WS_KV: kv,
      TELEGRAM_BOT_TOKEN: "fake-token",
      TELEGRAM_CHANNEL_ID: "-100123",
      SHOW_PASSWORDS: "false",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
        status: 502,
      });
    try {
      await assert.rejects(
        () => finishCycle(env, { u1: { username: "u1", status: 1, used: 0, max: 10, percent: 0, remaining: 10 } }),
        /Telegram sendMessage/,
      );
      assert.equal(kv.has("cycle:results"), true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("reuses cached session_auth_hash without logging in again", async () => {
    const kv = createMemoryKV();
    const limiter = new Limiter(kv);
    const sessionsCache = { u1: { hash: "cached-hash-123", savedAt: 1 } };
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, auth: init?.headers?.authorization });
      return new Response(
        JSON.stringify({
          data: { username: "u1", traffic_max: 1000, traffic_used: 200, status: 1 },
        }),
        { status: 200 },
      );
    };
    try {
      const { result, sessionsDirty } = await fetchAccountFresh(
        {},
        limiter,
        { username: "u1", password: { v: 0, d: "pw" } },
        sessionsCache,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].auth, "Bearer cached-hash-123");
      assert.equal(result.used, 200);
      assert.equal(sessionsDirty, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fails fast on 429 and sets KV cooldown", async () => {
    const kv = createMemoryKV();
    const limiter = new Limiter(kv);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "1800" } });
    try {
      await assert.rejects(
        () => apiFetch(limiter, "https://example.test", {}),
        RateLimited,
      );
      assert.ok((await limiter.cooldownLeft()) > 1700);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("compares webhook secrets safely", () => {
    assert.equal(timingSafeEqualStr("abc", "abc"), true);
    assert.equal(timingSafeEqualStr("abc", "abd"), false);
    assert.equal(timingSafeEqualStr("abc", "ab"), false);
  });
});

import { bindings, defineConfig, triggers } from "@cloudflare/config";

try {
  process.loadEnvFile?.(".env");
} catch {
  // .env is optional (e.g. in CI/CD or when env vars are injected directly)
}

export default defineConfig({
  worker: {
    name: "ws-reporter",
    entrypoint: "./src/worker.js",
    compatibilityDate: "2026-09-15",
    workersDev: true,
    previewUrls: false,
    triggers: [
      triggers.scheduled({ schedule: "*/15 * * * *" }),
    ],
    observability: {
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
        invocationLogs: true,
      },
      traces: {
        enabled: false,
        headSamplingRate: 1,
        persist: true,
      },
    },
    env: {
      WS_KV: bindings.kv(
        process.env.WS_KV_ID ? { id: process.env.WS_KV_ID } : undefined,
      ),
      ADMIN_IDS: bindings.text(process.env.ADMIN_IDS ?? ""),
      TELEGRAM_CHANNEL_ID: bindings.text(process.env.TELEGRAM_CHANNEL_ID ?? ""),
      SHOW_PASSWORDS: bindings.text(process.env.SHOW_PASSWORDS ?? "false"),
      ENC_KEY: bindings.secret(),
      TELEGRAM_BOT_TOKEN: bindings.secret(),
      WEBHOOK_SECRET: bindings.secret(),
    },
  },
});

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function isValidTotpSecret(s) {
  const clean = String(s || "").replace(/[\s=]+/g, "").toUpperCase();
  return clean.length >= 8 && /^[A-Z2-7]+$/.test(clean);
}

export function base32Decode(s) {
  const clean = String(s || "").replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error("سکرت 2FA نامعتبر است");
  const counter = Math.floor(Date.now() / 30000);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code =
    (((sig[off] & 0x7f) << 24) |
      (sig[off + 1] << 16) |
      (sig[off + 2] << 8) |
      sig[off + 3]) %
    1000000;
  return String(code).padStart(6, "0");
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encKey(env) {
  if (!env.ENC_KEY) return null;
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.ENC_KEY),
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(env, text) {
  const key = await encKey(env);
  if (!key) return { v: 0, d: text };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return { v: 1, iv: b64(iv), d: b64(ct) };
}

export async function decrypt(env, obj) {
  if (!obj || typeof obj !== "object") return String(obj ?? "");
  if (obj.v !== 1) return obj.d ?? "";
  const key = await encKey(env);
  if (!key) return "";
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(obj.iv) },
      key,
      unb64(obj.d),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return "";
  }
}

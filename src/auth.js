// PIN-Login, signierte Session-Cookies, serverseitige Sperre gegen Raten.

import { HttpError } from "./lib.js";

const COOKIE = "kasse_session";
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

/** Vergleich in konstanter Zeit: beide Seiten werden zuerst auf feste Länge gehasht. */
async function safeEqual(secret, a, b) {
  const [ha, hb] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function requireSecrets(env) {
  if (!env.KASSE_PIN || !env.SESSION_SECRET) throw new HttpError(500, "Server nicht konfiguriert (Secrets fehlen)");
}

function readCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export async function isAuthenticated(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = readCookie(request);
  if (!token) return false;
  const [exp, sig] = token.split(".");
  const expNum = Number(exp);
  if (!sig || !Number.isInteger(expNum) || expNum * 1000 < Date.now()) return false;
  const expected = b64url(await hmac(env.SESSION_SECRET, `v1.${exp}`));
  return safeEqual(env.SESSION_SECRET, sig, expected);
}

async function sessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sig = b64url(await hmac(env.SESSION_SECRET, `v1.${exp}`));
  return `${COOKIE}=${exp}.${sig}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export const clearCookie = () => `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

/** Prüft die PIN. Gibt bei Erfolg das Set-Cookie zurück, sonst wirft sie 401 oder 429. */
export async function login(request, env, pin) {
  requireSecrets(env);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `ip:${ip}`;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, locked_until FROM login_attempts WHERE key = ?").bind(key).first();
  if (row && row.locked_until > now) {
    const wait = Math.ceil((row.locked_until - now) / 1000);
    throw new HttpError(429, `Zu viele Fehlversuche. Bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen.`);
  }
  const ok = typeof pin === "string" && pin.length <= 32 && (await safeEqual(env.SESSION_SECRET, pin, env.KASSE_PIN));
  if (!ok) {
    const count = (row && row.locked_until <= now && row.locked_until > 0 ? 0 : row?.count || 0) + 1;
    const lockedUntil = count >= MAX_ATTEMPTS ? now + LOCK_MS : 0;
    await env.DB.prepare(
      "INSERT INTO login_attempts (key, count, locked_until) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET count = ?2, locked_until = ?3",
    )
      .bind(key, lockedUntil ? 0 : count, lockedUntil)
      .run();
    if (lockedUntil) throw new HttpError(429, "Zu viele Fehlversuche. Anmeldung für 15 Minuten gesperrt.");
    throw new HttpError(401, `Falsche PIN – noch ${MAX_ATTEMPTS - count} Versuche`);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
  return sessionCookie(env);
}

// auth.js — minimal staff authentication.
//
// Moderation needs persistent identity across requests, which means a cookie.
// A cookie is an HTTP mechanism, so it works with JavaScript fully disabled:
// the browser attaches it to every request on its own. We sign the cookie with
// an HMAC so a user cannot forge "I am a mod" by editing the cookie value.
//
// Credentials are intentionally hardcoded to admin/admin "for now" per the
// current requirement. The clear upgrade path later is env vars + a users
// table, but that is out of scope today.

import crypto from "node:crypto";

export const MOD_USER = process.env.MOD_USER || "admin";
export const MOD_PASS = process.env.MOD_PASS || "admin";

// The signing secret should be stable across restarts in production (set via
// env) but a random per-process secret is a safe default — it just logs mods
// out when the server restarts.
const SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const COOKIE = "nojs_staff";
// Session lifetime in ms (8 hours).
const TTL = 8 * 60 * 60 * 1000;

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

// Timing-safe compare of two strings.
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function checkCredentials(user, pass) {
  // Compare both fields in constant time regardless of which is wrong.
  const okUser = safeEqual(String(user || ""), MOD_USER);
  const okPass = safeEqual(String(pass || ""), MOD_PASS);
  return okUser && okPass;
}

// Build the Set-Cookie value for a fresh staff session.
export function makeSessionCookie() {
  const payload = `${MOD_USER}.${Date.now() + TTL}`;
  const token = `${payload}.${sign(payload)}`;
  const attrs = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(TTL / 1000)}`,
  ];
  return attrs.join("; ");
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// Parse the Cookie request header (no cookie-parser dependency).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Returns true if the request carries a valid, unexpired staff cookie.
export function isStaff(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  const expiry = Number(payload.split(".")[1]);
  if (!expiry || Date.now() > expiry) return false;
  return true;
}

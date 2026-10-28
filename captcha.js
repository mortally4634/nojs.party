// captcha.js — a self-contained, JavaScript-free CAPTCHA.
//
// The whole site forbids client scripts, which rules out reCAPTCHA/hCaptcha and
// anything canvas-based. Instead we generate the challenge as an SVG image on
// the server — SVG is just XML text, so we can "draw" distorted glyphs by
// concatenating strings, with no image library and no native dependencies.
//
// The answer is kept server-side in a Map keyed by an unguessable random token.
// The page only ever carries the token (a hidden field) and an <img> that points
// at /captcha/<token>, so the plaintext answer never reaches the client and the
// challenge is single-use.

import crypto from "node:crypto";

// Ambiguous characters (I/O/0/1/etc.) are omitted so a human isn't penalised for
// a glyph the distortion makes unreadable.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 5;
const TTL_MS = 15 * 60 * 1000; // a challenge is valid for 15 minutes
const MAX_ENTRIES = 5000; // crude flood cap on the in-memory store

const challenges = new Map(); // token -> { answer, expires }

function sweep() {
  const now = Date.now();
  for (const [token, c] of challenges) {
    if (c.expires < now) challenges.delete(token);
  }
  // If we're still over the cap (e.g. a scraping flood), drop the oldest.
  if (challenges.size > MAX_ENTRIES) {
    const overflow = challenges.size - MAX_ENTRIES;
    let i = 0;
    for (const token of challenges.keys()) {
      challenges.delete(token);
      if (++i >= overflow) break;
    }
  }
}

function randomCode() {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

// Mint a new challenge and return its token (to embed in the form).
export function newChallenge() {
  sweep();
  const token = crypto.randomBytes(12).toString("hex");
  challenges.set(token, { answer: randomCode(), expires: Date.now() + TTL_MS });
  return token;
}

// Check a submitted answer and CONSUME the challenge (single use), so a token
// can't be replayed or brute-forced. Returns true only on an exact, unexpired,
// case-insensitive match.
export function verify(token, answer) {
  if (!token) return false;
  const c = challenges.get(token);
  challenges.delete(token);
  if (!c || c.expires < Date.now()) return false;
  return String(answer || "").trim().toUpperCase() === c.answer;
}

const rnd = (min, max) => min + Math.random() * (max - min);
const BG = "#f2efe6";

function glyphSvg({ ch, x, y, size, rot, fill }) {
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size.toFixed(1)}" ` +
    `font-family="monospace" font-weight="bold" fill="${fill}" ` +
    `transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`
  );
}

// Fisher–Yates shuffle so the glyphs don't appear in answer order in the source.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Render the challenge for a token as an SVG string, or null if it's unknown or
// expired. This READS the challenge (the browser fetches the image after the
// page loads) but never consumes it — only verify() does that.
export function renderSvg(token) {
  const c = challenges.get(token);
  if (!c || c.expires < Date.now()) return null;
  const answer = c.answer;

  const W = 190;
  const H = 60;

  // Real glyphs: each character gets its own position, rotation, size and dark
  // shade. The alphabet is strictly alphanumeric, so no XML escaping is needed.
  const elems = [...answer].map((ch, i) => {
    const shade = Math.floor(rnd(20, 95));
    return glyphSvg({
      ch,
      x: 22 + i * 32 + rnd(-4, 4),
      y: 40 + rnd(-7, 7),
      size: 30 + rnd(-3, 7),
      rot: rnd(-30, 30),
      fill: `rgb(${shade},${shade},${shade})`,
    });
  });

  // Decoy glyphs: invisible to a human (drawn in the background colour, or off
  // the visible canvas) but, in the raw markup, indistinguishable from the real
  // characters — so a bot that simply reads the <text> nodes can't tell which
  // ones count. Combined with the shuffle below, source order reveals nothing.
  const decoyCount = 4 + crypto.randomInt(3);
  for (let i = 0; i < decoyCount; i++) {
    const offCanvas = i % 2 === 0;
    elems.push(
      glyphSvg({
        ch: ALPHABET[crypto.randomInt(ALPHABET.length)],
        x: offCanvas ? rnd(-40, -15) : rnd(10, W - 15),
        y: offCanvas ? rnd(-20, -8) : rnd(12, H - 6),
        size: 28 + rnd(-4, 8),
        rot: rnd(-30, 30),
        fill: offCanvas ? `rgb(${Math.floor(rnd(20, 95))},0,0)` : BG,
      })
    );
  }
  const glyphs = shuffle(elems).join("");

  // Noise: crossing lines plus speckle, to frustrate naive OCR.
  let noise = "";
  for (let i = 0; i < 7; i++) {
    const s = Math.floor(rnd(120, 200));
    noise +=
      `<line x1="${rnd(0, W).toFixed(0)}" y1="${rnd(0, H).toFixed(0)}" ` +
      `x2="${rnd(0, W).toFixed(0)}" y2="${rnd(0, H).toFixed(0)}" ` +
      `stroke="rgb(${s},${s},${s})" stroke-width="1"/>`;
  }
  for (let i = 0; i < 45; i++) {
    const s = Math.floor(rnd(120, 210));
    noise +=
      `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" ` +
      `r="${rnd(0.5, 1.6).toFixed(1)}" fill="rgb(${s},${s},${s})"/>`;
  }

  // A fixed light background keeps the text legible regardless of the page's
  // light/dark theme (the image is themed by itself, not by the page).
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#f2efe6"/>${noise}${glyphs}</svg>`
  );
}

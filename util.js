// util.js — text processing and small helpers.
//
// Everything here runs on the server. Because the client never executes any
// JavaScript, ALL untrusted input must be HTML-escaped here before it is placed
// into a page. This is our single most important security boundary: an
// imageboard is a firehose of anonymous input, so a missed escape is a stored
// XSS. We escape first, THEN layer our own safe markup (greentext, quote links)
// on top of already-escaped text.

import crypto from "node:crypto";

const ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Format a Unix-ms timestamp the way imageboards traditionally do.
export function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` (${days[d.getDay()]}) ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function humanSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n % 1 === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// A "tripcode" is the imageboard convention for proving post authorship without
// accounts: a user types "name#secret" and we hash the secret into a short code
// that only someone knowing the secret can reproduce. It is intentionally weak
// (it is a pseudonym, not real auth), so a fast hash is fine.
export function parseName(raw) {
  const input = (raw || "").trim();
  if (!input) return { name: "Anonymous", tripcode: "" };
  const hash = input.indexOf("#");
  if (hash === -1) return { name: input.slice(0, 50), tripcode: "" };
  const name = input.slice(0, hash).trim() || "Anonymous";
  const secret = input.slice(hash + 1);
  const digest = crypto
    .createHash("sha256")
    .update("nojs.party:trip:" + secret)
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 10);
  return { name: name.slice(0, 50), tripcode: digest };
}

// Hash a deletion password. Salted with the post concept; again, this guards a
// low-value action (deleting your own post), so we keep it simple but not plain.
export function hashDeletePassword(pw) {
  if (!pw) return "";
  return crypto.createHash("sha256").update("nojs.party:del:" + pw).digest("hex");
}

// Render a comment body into safe HTML.
//
// Pipeline:
//   1. Escape the entire string (now it is safe, inert text).
//   2. Turn ">>123" into an internal link to that post.
//   3. Turn bare http(s) URLs into links (with rel=noopener noreferrer).
//   4. Turn lines beginning with ">" into greentext spans.
// Because step 1 already neutralized every angle bracket, the regexes in later
// steps operate on the escaped forms (e.g. ">" is "&gt;"), so user text can
// never inject a real tag.
// Single source of truth for what counts as an external link.
export const URL_RE = /\bhttps?:\/\/[^\s<]+/;

// Does a comment contain at least one external URL? Used to decide whether the
// Link-Pending-Approval gate applies to a post at creation time.
export function hasLink(raw) {
  return new RegExp(URL_RE).test(String(raw || ""));
}

export function renderComment(raw, { board, threadId, holdLinks } = {}) {
  let html = escapeHtml(raw || "");

  // Post references: >>123  (escaped as &gt;&gt;123). These are internal
  // navigation, NOT external links, so LPA never holds them.
  html = html.replace(/(&gt;&gt;)(\d+)/g, (m, _arrows, num) => {
    const href =
      board && threadId
        ? `/${board}/thread/${threadId}#p${num}`
        : `#p${num}`;
    return `<a class="quotelink" href="${href}">&gt;&gt;${num}</a>`;
  });

  // External URLs. When this post's links are held (LPA), we do NOT emit a
  // clickable anchor at all — the URL is replaced by an inert placeholder, so a
  // no-JS visitor cannot reach or even read the pending link. When approved, we
  // autolink as usual. We match the escaped text, so "&" in querystrings is
  // "&amp;" — fine, the browser decodes it back in the href.
  const urlRe = new RegExp(URL_RE.source, "g");
  if (holdLinks) {
    html = html.replace(
      urlRe,
      () => `<span class="link-pending">[external link pending approval]</span>`
    );
  } else {
    html = html.replace(
      urlRe,
      (url) => `<a href="${url}" rel="noopener noreferrer nofollow">${url}</a>`
    );
  }

  // Greentext: any line starting with ">" (but not a ">>" quotelink we already
  // wrapped). Process per line.
  html = html
    .split("\n")
    .map((line) => {
      if (/^&gt;(?!&gt;)/.test(line)) {
        return `<span class="greentext">${line}</span>`;
      }
      return line;
    })
    .join("\n");

  // Preserve newlines as <br> so posts keep their shape without a <pre>.
  return html.replace(/\n/g, "<br>");
}

// Collapse a comment to a short teaser for board-index previews is not needed;
// we show full comments in previews like classic boards. Kept intentionally.

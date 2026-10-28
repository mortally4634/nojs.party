// server.js — the HTTP server, routes, and request handling.
//
// Design rule for the whole app: NOTHING here assumes the client runs
// JavaScript. State changes happen via <form method="post"> submissions and we
// respond with a 303 redirect (Post/Redirect/Get) so refreshes don't re-submit.
// Navigation is plain links. Native <details>/<summary> elements provide the
// only "interactivity" (collapsible forms), and those are pure HTML.

import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, unlink } from "node:fs";

import { Boards, Threads, Posts, Settings } from "./db.js";
import { parseName, hashDeletePassword, hasLink } from "./util.js";
import { imageSize } from "./imagesize.js";
import * as view from "./render.js";
import {
  isStaff,
  checkCredentials,
  makeSessionCookie,
  clearSessionCookie,
} from "./auth.js";

// Shared urlencoded parser for the script-less POST forms (login, mod, delete).
const form = express.urlencoded({ extended: false });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7002;

const UPLOAD_DIR = join(__dirname, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Tunable board rules ----------------------------------------------------
const THREADS_PER_PAGE = 10;
const PREVIEW_REPLIES = 3; // replies shown under each thread on the index
const BUMP_LIMIT = 300; // after this many replies, replies stop bumping
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// --- Upload handling (multer, pure JS — no native deps) ---------------------
const ALLOWED = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Never trust the client filename for the stored name. Generate a random,
    // collision-free name and derive the extension solely from the MIME type
    // we already whitelisted. This prevents path traversal and double
    // extensions like "evil.php.jpg".
    const ext = ALLOWED[file.mimetype] || extname(file.originalname) || ".bin";
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(null, false); // silently drop disallowed files; handler checks
  },
});

// Wrap multer so a thrown limit error becomes a friendly message instead of a
// 500. `field` is the form file field name.
function acceptImage(field) {
  const mw = upload.single(field);
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === "LIMIT_FILE_SIZE"
            ? "Image is too large (5 MB maximum)."
            : "Could not process the uploaded file.";
      }
      next();
    });
}

// --- App --------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");

// Serve static assets. Uploaded files are served read-only; the Content-Type is
// set from our known extensions. We set a strict CSP that forbids scripts
// entirely — a fitting default for a site that uses none, and defense in depth
// against any escaping mistake.
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Resolve staff status once per request so every rendered page can reflect it.
  res.locals.isMod = isStaff(req);
  next();
});

app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: "7d",
    setHeaders: (res) => {
      // Images should never be treated as documents.
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);
app.use(express.static(join(__dirname, "public"), { maxAge: "1h" }));

// Small helper to send a full page.
function page(res, { title, body, board, status = 200 }) {
  const boards = Boards.all();
  res
    .status(status)
    .type("html")
    .send(view.layout({ title, boards, body, board, isMod: res.locals.isMod }));
}

// --- Home -------------------------------------------------------------------
app.get("/", (_req, res) => {
  const boards = Boards.all();
  let threads = 0;
  let posts = 0;
  for (const b of boards) threads += Threads.count(b.slug);
  // Cheap total-posts count.
  posts = postsTotal();
  page(res, {
    title: "nojs.party — a javascript-free imageboard",
    body: view.homePage(boards, { threads, posts }),
  });
});

import db from "./db.js";
function postsTotal() {
  return db.prepare("SELECT COUNT(*) AS n FROM posts").get().n;
}

// --- Board index ------------------------------------------------------------
app.get("/:slug/", (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();

  const seeAll = res.locals.isMod; // mods see PPA-held threads/replies too
  const page_ = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = Threads.count(board.slug, seeAll);
  const pageCount = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const offset = (page_ - 1) * THREADS_PER_PAGE;

  const threads = Threads.page(board.slug, THREADS_PER_PAGE, offset, seeAll).map((t) => ({
    ...t,
    op: Posts.op(t.id),
    previews: Posts.previewReplies(t.id, PREVIEW_REPLIES, seeAll),
  }));

  page(res, {
    title: `/${board.slug}/ — ${board.title}`,
    board: board.slug,
    body: view.boardPage({
      board,
      threads,
      page: page_,
      pageCount,
      error: req.query.error,
      isMod: res.locals.isMod,
    }),
  });
});

// --- Create thread ----------------------------------------------------------
app.post("/:slug/thread", acceptImage("image"), (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();

  const comment = (req.body.comment || "").trim();
  const subject = (req.body.subject || "").trim().slice(0, 120);

  const fail = (msg) => {
    cleanupUpload(req.file);
    return res.redirect(303, `/${board.slug}/?error=${encodeURIComponent(msg)}`);
  };

  if (req.uploadError) return fail(req.uploadError);
  // Threads MUST have an image — this is the core rule of the board.
  if (!req.file) return fail("A thread requires an image.");
  if (comment.length > 8000) return fail("Comment is too long.");

  const now = Date.now();
  const flags = buildFlags(comment, true);
  const threadId = Threads.create(board.slug, subject, now, !flags.ppaHeld);
  const { name, tripcode } = parseName(req.body.name);
  const img = fileMeta(req.file);

  Posts.create({
    thread_id: threadId,
    board: board.slug,
    name,
    tripcode,
    comment,
    image: img.image,
    image_orig: img.image_orig,
    image_w: img.w,
    image_h: img.h,
    image_size: img.size,
    is_op: 1,
    del_hash: hashDeletePassword(req.body.delpw),
    created_at: now,
    approved: flags.approved,
    media_approved: flags.media_approved,
    links_approved: flags.links_approved,
    has_link: flags.has_link,
  });

  // A thread held by PPA stays hidden until approved, so don't count it yet.
  if (!flags.ppaHeld) Threads.touchImageOnOp(threadId, true);

  if (flags.ppaHeld) return res.redirect(303, pendingUrl(board.slug));
  res.redirect(303, `/${board.slug}/thread/${threadId}`);
});

// --- Thread view ------------------------------------------------------------
app.get("/:slug/thread/:id", (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();
  const thread = Threads.get(parseInt(req.params.id, 10));
  if (!thread || thread.board !== board.slug) return next();
  // A thread whose OP is still pending (PPA) is invisible to the public.
  if (!thread.approved && !res.locals.isMod) return next();

  const posts = Posts.forThread(thread.id, res.locals.isMod);
  page(res, {
    title: `${thread.subject || "Thread No." + thread.id} — /${board.slug}/`,
    board: board.slug,
    body: view.threadPage({ board, thread, posts, error: req.query.error, isMod: res.locals.isMod }),
  });
});

// --- Reply ------------------------------------------------------------------
app.post("/:slug/thread/:id/reply", acceptImage("image"), (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();
  const thread = Threads.get(parseInt(req.params.id, 10));
  if (!thread || thread.board !== board.slug) return next();

  const base = `/${board.slug}/thread/${thread.id}`;
  const fail = (msg) => {
    cleanupUpload(req.file);
    return res.redirect(303, `${base}?error=${encodeURIComponent(msg)}#reply`);
  };

  if (thread.locked) return fail("This thread is locked.");
  if (req.uploadError) return fail(req.uploadError);

  const comment = (req.body.comment || "").trim();
  if (!comment && !req.file) return fail("A reply needs a comment or an image.");
  if (comment.length > 8000) return fail("Comment is too long.");

  const now = Date.now();
  const flags = buildFlags(comment, !!req.file);
  const { name, tripcode } = parseName(req.body.name);
  const img = fileMeta(req.file);

  const postId = Posts.create({
    thread_id: thread.id,
    board: board.slug,
    name,
    tripcode,
    comment,
    image: img.image,
    image_orig: img.image_orig,
    image_w: img.w,
    image_h: img.h,
    image_size: img.size,
    is_op: 0,
    del_hash: hashDeletePassword(req.body.delpw),
    created_at: now,
    approved: flags.approved,
    media_approved: flags.media_approved,
    links_approved: flags.links_approved,
    has_link: flags.has_link,
  });

  // A reply held by PPA does not bump or count until a mod approves it, so spam
  // can't float a thread before review. Otherwise, bump/count immediately.
  if (!flags.ppaHeld) revealReply(thread, now, !!req.file);

  if (flags.ppaHeld) return res.redirect(303, pendingUrl(board.slug));
  res.redirect(303, `${base}#p${postId}`);
});

// --- Delete a post (with the password set at post time) ---------------------
app.post("/:slug/delete", express.urlencoded({ extended: false }), (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();

  const postId = parseInt(req.body.post_id, 10);
  const post = Posts.get(postId);
  const back = `/${board.slug}/`;

  if (!post || post.board !== board.slug) {
    return res.redirect(303, `${back}?error=${encodeURIComponent("Post not found.")}`);
  }

  const supplied = hashDeletePassword(req.body.delpw);
  if (!post.del_hash || supplied !== post.del_hash) {
    const where = post.is_op
      ? back
      : `/${board.slug}/thread/${post.thread_id}`;
    return res.redirect(
      303,
      `${where}?error=${encodeURIComponent("Wrong delete password.")}`
    );
  }

  if (post.is_op) {
    // Deleting the OP removes the whole thread (and its posts' images).
    for (const p of Posts.forThread(post.thread_id)) removeImage(p.image);
    Threads.delete(post.thread_id); // cascades to posts
    return res.redirect(303, back);
  } else {
    removeImage(post.image);
    Posts.delete(post.id);
    db.prepare(
      "UPDATE threads SET reply_count = MAX(0, reply_count - 1), image_count = MAX(0, image_count - ?) WHERE id = ?"
    ).run(post.image ? 1 : 0, post.thread_id);
    return res.redirect(303, `/${board.slug}/thread/${post.thread_id}`);
  }
});

// --- Staff: login page / panel ---------------------------------------------
app.get("/staff", (req, res) => {
  // When signed in, show live pending counts per board for the queue links.
  const queues = res.locals.isMod
    ? Boards.all().map((b) => ({
        slug: b.slug,
        posts: Posts.pendingPosts(b.slug).length,
        media: Posts.pendingMedia(b.slug).length,
        links: Posts.pendingLinks(b.slug).length,
      }))
    : [];
  page(res, {
    title: "Staff — nojs.party",
    body: view.staffPage({
      isMod: res.locals.isMod,
      error: req.query.error,
      settings: Settings.all(),
      queues,
      boards: res.locals.isMod ? Boards.all() : [],
    }),
  });
});

// --- Staff: board management (create / edit / delete) ----------------------
// Slugs are lowercase alphanumeric, 1–16 chars, and must not collide with the
// site's own top-level routes.
const SLUG_RE = /^[a-z0-9]{1,16}$/;
const RESERVED_SLUGS = new Set([
  "staff",
  "submitted",
  "uploads",
  "style.css",
  "favicon.svg",
]);
const staffError = (msg) => "/staff?error=" + encodeURIComponent(msg);

app.post("/staff/boards/create", form, (req, res) => {
  if (!res.locals.isMod) return res.redirect(303, staffError("Staff only."));

  const slug = String(req.body.slug || "").trim().toLowerCase();
  const title = String(req.body.title || "").trim().slice(0, 60);
  const description = String(req.body.description || "").trim().slice(0, 200);

  if (!SLUG_RE.test(slug))
    return res.redirect(303, staffError("Slug must be 1–16 lowercase letters/digits."));
  if (RESERVED_SLUGS.has(slug))
    return res.redirect(303, staffError(`"/${slug}/" is a reserved name.`));
  if (Boards.get(slug))
    return res.redirect(303, staffError(`Board /${slug}/ already exists.`));
  if (!title) return res.redirect(303, staffError("Board title is required."));

  Boards.create(slug, title, description);
  res.redirect(303, "/staff");
});

app.post("/staff/boards/edit", form, (req, res) => {
  if (!res.locals.isMod) return res.redirect(303, staffError("Staff only."));

  const slug = String(req.body.slug || "").trim().toLowerCase();
  const title = String(req.body.title || "").trim().slice(0, 60);
  const description = String(req.body.description || "").trim().slice(0, 200);

  if (!Boards.get(slug)) return res.redirect(303, staffError("No such board."));
  if (!title) return res.redirect(303, staffError("Board title is required."));

  Boards.update(slug, title, description);
  res.redirect(303, "/staff");
});

app.post("/staff/boards/delete", form, (req, res) => {
  if (!res.locals.isMod) return res.redirect(303, staffError("Staff only."));

  const slug = String(req.body.slug || "").trim().toLowerCase();
  const confirm = String(req.body.confirm || "").trim().toLowerCase();

  if (!Boards.get(slug)) return res.redirect(303, staffError("No such board."));
  // Require re-typing the slug — a no-JS guard against accidental deletion.
  if (confirm !== slug)
    return res.redirect(303, staffError(`Type "${slug}" to confirm deleting /${slug}/.`));

  // Remove every uploaded file in the board before the rows cascade away.
  for (const t of Threads.page(slug, 1e9, 0, true)) {
    for (const p of Posts.forThread(t.id, true)) removeImage(p.image);
  }
  Boards.delete(slug);
  res.redirect(303, "/staff");
});

// Toggle the three approval systems. Unchecked checkboxes are simply absent
// from the POST body, which is exactly how we read each on/off state.
app.post("/staff/settings", form, (req, res) => {
  if (!res.locals.isMod)
    return res.redirect(303, "/staff?error=" + encodeURIComponent("Staff only."));
  Settings.set("ppa_enabled", req.body.ppa === "on");
  Settings.set("mpa_enabled", req.body.mpa === "on");
  Settings.set("lpa_enabled", req.body.lpa === "on");
  res.redirect(303, "/staff");
});

// --- Staff: per-board moderation queue -------------------------------------
app.get("/:slug/queue", (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();
  if (!res.locals.isMod)
    return res.redirect(303, "/staff?error=" + encodeURIComponent("Staff only."));

  // Attach each OP's thread row so the queue can render pin/lock controls.
  const withThread = (p) => (p.is_op ? { ...p, _thread: Threads.get(p.thread_id) } : p);

  page(res, {
    title: `/${board.slug}/ queue — nojs.party`,
    board: board.slug,
    body: view.queuePage({
      board,
      pendingPosts: Posts.pendingPosts(board.slug).map(withThread),
      pendingMedia: Posts.pendingMedia(board.slug).map(withThread),
      pendingLinks: Posts.pendingLinks(board.slug).map(withThread),
    }),
  });
});

app.post("/staff", form, (req, res) => {
  if (checkCredentials(req.body.user, req.body.pass)) {
    res.setHeader("Set-Cookie", makeSessionCookie());
    return res.redirect(303, "/staff");
  }
  return res.redirect(303, "/staff?error=" + encodeURIComponent("Invalid credentials."));
});

app.post("/staff/logout", form, (_req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.redirect(303, "/");
});

// --- Staff: moderation actions ---------------------------------------------
app.post("/:slug/mod", form, (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();
  // Authorization gate: ignore the action entirely unless the request is staff.
  if (!res.locals.isMod) {
    return res.redirect(303, "/staff?error=" + encodeURIComponent("Staff only."));
  }

  const action = String(req.body.action || "");
  const post = Posts.get(parseInt(req.body.post_id, 10));
  if (!post || post.board !== board.slug) {
    return res.redirect(303, `/${board.slug}/`);
  }
  const threadHome = `/${board.slug}/thread/${post.thread_id}`;
  // Return the mod to wherever they clicked (queue, thread, or board).
  const back = backTo(req, post.is_op && action === "delete" ? `/${board.slug}/` : threadHome);

  switch (action) {
    case "delete":
      if (post.is_op) {
        for (const p of Posts.forThread(post.thread_id, true)) removeImage(p.image);
        Threads.delete(post.thread_id);
        return res.redirect(303, backTo(req, `/${board.slug}/`));
      }
      removeImage(post.image);
      Posts.delete(post.id);
      // Only decrement the public counters if this reply was actually counted
      // (an approved reply). A still-pending reply never added to them.
      if (post.approved) {
        db.prepare(
          "UPDATE threads SET reply_count = MAX(0, reply_count - 1), image_count = MAX(0, image_count - ?) WHERE id = ?"
        ).run(post.image ? 1 : 0, post.thread_id);
      }
      return res.redirect(303, back);

    // --- Approval actions (PPA / MPA / LPA) ---
    case "approve": // PPA: reveal the whole post
      if (!post.approved) {
        Posts.approveField(post.id, "approved");
        const now = Date.now();
        if (post.is_op) {
          Threads.approve(post.thread_id, now);
          Threads.touchImageOnOp(post.thread_id, !!post.image);
        } else {
          revealReply(Threads.get(post.thread_id), now, !!post.image);
        }
      }
      return res.redirect(303, back);
    case "approve_media": // MPA: reveal the image
      Posts.approveField(post.id, "media_approved");
      return res.redirect(303, back);
    case "approve_links": // LPA: make external links live
      Posts.approveField(post.id, "links_approved");
      return res.redirect(303, back);

    case "sticky":
      Threads.setFlag(post.thread_id, "sticky", 1);
      return res.redirect(303, back);
    case "unsticky":
      Threads.setFlag(post.thread_id, "sticky", 0);
      return res.redirect(303, back);
    case "lock":
      Threads.setFlag(post.thread_id, "locked", 1);
      return res.redirect(303, back);
    case "unlock":
      Threads.setFlag(post.thread_id, "locked", 0);
      return res.redirect(303, back);

    default:
      return res.redirect(303, back);
  }
});

// --- "Submitted, pending approval" confirmation ----------------------------
// Shown after a post is held by PPA, since it won't appear publicly yet.
app.get("/submitted", (req, res) => {
  const slug = String(req.query.board || "");
  const board = Boards.get(slug);
  page(res, {
    title: "Submitted — pending approval",
    body: view.messagePage({
      heading: "Submitted — pending approval",
      message:
        "Thanks! Your post was received and is now awaiting staff approval. " +
        "It will appear once a moderator approves it.",
      backHref: board ? `/${board.slug}/` : "/",
      backLabel: board ? `Back to /${board.slug}/` : "Return home",
    }),
  });
});

// --- 404 --------------------------------------------------------------------
app.use((req, res) => {
  page(res, {
    title: "404 — not found",
    status: 404,
    body: view.messagePage({
      heading: "404 — Not Found",
      message: "There is no such board, thread, or page.",
      backHref: "/",
      backLabel: "Return home",
    }),
  });
});

// --- Error handler ----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  page(res, {
    title: "500 — server error",
    status: 500,
    body: view.messagePage({
      heading: "500 — Server Error",
      message: "Something went wrong handling that request.",
      backHref: "/",
      backLabel: "Return home",
    }),
  });
});

// --- helpers ----------------------------------------------------------------
function fileMeta(file) {
  if (!file) return { image: "", image_orig: "", w: 0, h: 0, size: 0 };
  const dims = imageSize(file.path) || { w: 0, h: 0 };
  return {
    image: file.filename,
    image_orig: (file.originalname || "").slice(0, 120),
    w: dims.w,
    h: dims.h,
    size: file.size,
  };
}

function cleanupUpload(file) {
  if (file && file.path) unlink(file.path, () => {});
}

function removeImage(filename) {
  if (filename) unlink(join(UPLOAD_DIR, filename), () => {});
}

// Compute the three approval gates for a new post given the current settings.
// `ppaHeld` is pulled out separately because it also governs thread visibility
// and whether we defer bump/count until approval.
function buildFlags(comment, hasImage) {
  const s = Settings.all();
  const linkPresent = hasLink(comment);
  const ppaHeld = s.ppa;
  return {
    ppaHeld,
    approved: ppaHeld ? 0 : 1,
    media_approved: s.mpa && hasImage ? 0 : 1,
    links_approved: s.lpa && linkPresent ? 0 : 1,
    has_link: linkPresent ? 1 : 0,
  };
}

function pendingUrl(slug) {
  return `/submitted?board=${encodeURIComponent(slug)}`;
}

// Apply the public ranking/count effects of a reply becoming visible.
function revealReply(thread, now, hasImage) {
  if (thread.reply_count < BUMP_LIMIT) {
    Threads.bump(thread.id, now, hasImage);
  } else {
    // Past the bump limit the thread stops rising, but we still count the reply.
    db.prepare(
      "UPDATE threads SET reply_count = reply_count + 1, image_count = image_count + ? WHERE id = ?"
    ).run(hasImage ? 1 : 0, thread.id);
  }
}

// Resolve a safe same-origin redirect target from the Referer header, so a mod
// action returns the mod to the page they clicked from. Falls back when the
// header is missing or points off-site (guards against open redirects).
function backTo(req, fallback) {
  const ref = req.get("referer");
  if (!ref) return fallback;
  try {
    const base = `${req.protocol}://${req.get("host")}`;
    const u = new URL(ref, base);
    if (u.origin !== new URL(base).origin) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

app.listen(PORT, () => {
  console.log(`nojs.party listening on http://localhost:${PORT}`);
});

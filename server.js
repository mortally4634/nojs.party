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

import { Boards, Threads, Posts } from "./db.js";
import { parseName, hashDeletePassword } from "./util.js";
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

  const page_ = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = Threads.count(board.slug);
  const pageCount = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const offset = (page_ - 1) * THREADS_PER_PAGE;

  const threads = Threads.page(board.slug, THREADS_PER_PAGE, offset).map((t) => ({
    ...t,
    op: Posts.op(t.id),
    previews: Posts.previewReplies(t.id, PREVIEW_REPLIES),
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
  if (!comment && !req.file)
    return fail("A thread needs a comment or an image.");
  if (comment.length > 8000) return fail("Comment is too long.");

  const now = Date.now();
  const threadId = Threads.create(board.slug, subject, now);
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
  });
  Threads.touchImageOnOp(threadId, !!req.file);

  res.redirect(303, `/${board.slug}/thread/${threadId}`);
});

// --- Thread view ------------------------------------------------------------
app.get("/:slug/thread/:id", (req, res, next) => {
  const board = Boards.get(req.params.slug);
  if (!board) return next();
  const thread = Threads.get(parseInt(req.params.id, 10));
  if (!thread || thread.board !== board.slug) return next();

  const posts = Posts.forThread(thread.id);
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
  });

  // Bump the thread unless it has hit the bump limit (sage-like behavior).
  if (thread.reply_count < BUMP_LIMIT) {
    Threads.bump(thread.id, now, !!req.file);
  } else {
    // Still count the reply/image, just don't move the thread up.
    db.prepare(
      "UPDATE threads SET reply_count = reply_count + 1, image_count = image_count + ? WHERE id = ?"
    ).run(req.file ? 1 : 0, thread.id);
  }

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
  page(res, {
    title: "Staff — nojs.party",
    body: view.staffPage({ isMod: res.locals.isMod, error: req.query.error }),
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

  switch (action) {
    case "delete":
      if (post.is_op) {
        for (const p of Posts.forThread(post.thread_id)) removeImage(p.image);
        Threads.delete(post.thread_id);
        return res.redirect(303, `/${board.slug}/`);
      }
      removeImage(post.image);
      Posts.delete(post.id);
      db.prepare(
        "UPDATE threads SET reply_count = MAX(0, reply_count - 1), image_count = MAX(0, image_count - ?) WHERE id = ?"
      ).run(post.image ? 1 : 0, post.thread_id);
      return res.redirect(303, threadHome);

    case "sticky":
      Threads.setFlag(post.thread_id, "sticky", 1);
      return res.redirect(303, threadHome);
    case "unsticky":
      Threads.setFlag(post.thread_id, "sticky", 0);
      return res.redirect(303, threadHome);
    case "lock":
      Threads.setFlag(post.thread_id, "locked", 1);
      return res.redirect(303, threadHome);
    case "unlock":
      Threads.setFlag(post.thread_id, "locked", 0);
      return res.redirect(303, threadHome);

    default:
      return res.redirect(303, threadHome);
  }
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

app.listen(PORT, () => {
  console.log(`nojs.party listening on http://localhost:${PORT}`);
});

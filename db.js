// db.js — persistence layer backed by Node's built-in SQLite (node:sqlite).
//
// Using the built-in driver means no native module compilation is needed,
// which keeps the project trivially installable on any machine with Node 22.5+.
// The driver is synchronous, which actually suits a server-rendered, no-JS site:
// each request does a few quick queries and renders a full page, so we never
// need async DB plumbing.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The data directory is configurable so operators who deploy this software can
// put the database wherever they like (e.g. a mounted volume). Defaults to
// ./data next to the code.
const DATA_DIR = process.env.DATA_DIR
  ? (process.env.DATA_DIR.match(/^([a-zA-Z]:[\\/]|[\\/])/) // absolute?
      ? process.env.DATA_DIR
      : join(__dirname, process.env.DATA_DIR))
  : join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "nojs.db"));

// WAL gives better concurrency for the read-heavy workload of an imageboard.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    slug        TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS threads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    board        TEXT NOT NULL REFERENCES boards(slug) ON DELETE CASCADE,
    subject      TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    bumped_at    INTEGER NOT NULL,
    reply_count  INTEGER NOT NULL DEFAULT 0,
    image_count  INTEGER NOT NULL DEFAULT 0,
    sticky       INTEGER NOT NULL DEFAULT 0,
    locked       INTEGER NOT NULL DEFAULT 0,
    approved     INTEGER NOT NULL DEFAULT 1   -- 0 = OP held by PPA, thread hidden
  );

  CREATE TABLE IF NOT EXISTS posts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    board          TEXT NOT NULL,
    name           TEXT NOT NULL DEFAULT 'Anonymous',
    tripcode       TEXT NOT NULL DEFAULT '',
    comment        TEXT NOT NULL DEFAULT '',
    image          TEXT NOT NULL DEFAULT '',   -- stored filename on disk
    image_orig     TEXT NOT NULL DEFAULT '',   -- original upload name (for display)
    image_w        INTEGER NOT NULL DEFAULT 0,
    image_h        INTEGER NOT NULL DEFAULT 0,
    image_size     INTEGER NOT NULL DEFAULT 0,
    is_op          INTEGER NOT NULL DEFAULT 0,
    del_hash       TEXT NOT NULL DEFAULT '',   -- hashed deletion password
    created_at     INTEGER NOT NULL,
    approved       INTEGER NOT NULL DEFAULT 1, -- PPA: 0 = whole post hidden
    media_approved INTEGER NOT NULL DEFAULT 1, -- MPA: 0 = image hidden
    links_approved INTEGER NOT NULL DEFAULT 1, -- LPA: 0 = external links held
    has_link       INTEGER NOT NULL DEFAULT 0  -- whether the comment has a URL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_threads_board_bump ON threads(board, bumped_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, id);
`);

// --- Lightweight migrations -------------------------------------------------
// The CREATE TABLE statements above only run for a fresh DB (IF NOT EXISTS), so
// an existing database created before these features needs its new columns
// added explicitly. ADD COLUMN is idempotent here because we swallow the
// "duplicate column name" error — the standard way to evolve SQLite in place.
function addColumn(table, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}
addColumn("threads", "approved INTEGER NOT NULL DEFAULT 1");
addColumn("posts", "approved INTEGER NOT NULL DEFAULT 1");
addColumn("posts", "media_approved INTEGER NOT NULL DEFAULT 1");
addColumn("posts", "links_approved INTEGER NOT NULL DEFAULT 1");
addColumn("posts", "has_link INTEGER NOT NULL DEFAULT 0");

// --- Seed default boards if the table is empty ------------------------------
const boardCount = db.prepare("SELECT COUNT(*) AS n FROM boards").get().n;
if (boardCount === 0) {
  const seed = db.prepare(
    "INSERT INTO boards (slug, title, description) VALUES (?, ?, ?)"
  );
  const defaults = [
    ["js", "JavaScript-Free", "The one and only board. No scripts, ever."],
  ];
  for (const row of defaults) seed.run(...row);
}

// --- Settings (key/value) ---------------------------------------------------
// Distribution defaults for the three approval gates — the moderation posture a
// FRESH install ships with:
//
//   PPA (post approval)  OFF — posts appear immediately.
//   MPA (media approval)  ON — every uploaded image is held for review.
//   LPA (link approval)   ON — every external link is held for review.
//
// These are seeded only when the settings table is empty (INSERT OR IGNORE), so
// they set the INITIAL state; after that the staff panel is the source of truth
// and toggling there does not change what a fresh install gets. Operators who
// package/deploy the software can override the initial posture at launch with
// the DEFAULT_PPA / DEFAULT_MPA / DEFAULT_LPA env vars (1/0, true/false, on/off)
// without editing this file; unset means the defaults above.
const envDefault = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|on|yes)$/i.test(v.trim()) ? "1" : "0";
};
const SETTING_DEFAULTS = {
  ppa_enabled: envDefault("DEFAULT_PPA", "0"), // Post Pending Approval
  mpa_enabled: envDefault("DEFAULT_MPA", "1"), // Media Pending Approval
  lpa_enabled: envDefault("DEFAULT_LPA", "1"), // Link Pending Approval
};
{
  const ins = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) ins.run(k, v);
}

export const Settings = {
  get(key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : SETTING_DEFAULTS[key] ?? null;
  },
  bool: (key) => Settings.get(key) === "1",
  set(key, value) {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value ? "1" : "0");
  },
  all() {
    return {
      ppa: Settings.bool("ppa_enabled"),
      mpa: Settings.bool("mpa_enabled"),
      lpa: Settings.bool("lpa_enabled"),
    };
  },
};

// --- Prepared statements / helpers ------------------------------------------

export const Boards = {
  all: () => db.prepare("SELECT * FROM boards ORDER BY slug").all(),
  get: (slug) => db.prepare("SELECT * FROM boards WHERE slug = ?").get(slug),
  create(slug, title, description) {
    db.prepare(
      "INSERT INTO boards (slug, title, description) VALUES (?, ?, ?)"
    ).run(slug, title, description);
  },
  // Only title/description are editable — the slug is an immutable identity key
  // (it is the primary key and appears in every thread/post row and URL).
  update(slug, title, description) {
    db.prepare(
      "UPDATE boards SET title = ?, description = ? WHERE slug = ?"
    ).run(title, description, slug);
  },
  // Deleting a board cascades to its threads and (via those) its posts.
  delete: (slug) => db.prepare("DELETE FROM boards WHERE slug = ?").run(slug),
};

export const Threads = {
  create(board, subject, now, approved) {
    const info = db
      .prepare(
        `INSERT INTO threads (board, subject, created_at, bumped_at, approved)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(board, subject, now, now, approved ? 1 : 0);
    return Number(info.lastInsertRowid);
  },
  get: (id) => db.prepare("SELECT * FROM threads WHERE id = ?").get(id),
  // One page of threads for a board, newest-bumped first, stickies pinned on
  // top. Public callers pass includePending=false to hide PPA-held threads.
  page(board, limit, offset, includePending) {
    const vis = includePending ? "" : "AND approved = 1";
    return db
      .prepare(
        `SELECT * FROM threads
         WHERE board = ? ${vis}
         ORDER BY sticky DESC, bumped_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(board, limit, offset);
  },
  count(board, includePending) {
    const vis = includePending ? "" : "AND approved = 1";
    return db
      .prepare(`SELECT COUNT(*) AS n FROM threads WHERE board = ? ${vis}`)
      .get(board).n;
  },
  bump(id, now, addedImage) {
    db.prepare(
      `UPDATE threads
       SET reply_count = reply_count + 1,
           image_count = image_count + ?,
           bumped_at = ?
       WHERE id = ?`
    ).run(addedImage ? 1 : 0, now, id);
  },
  touchImageOnOp(id, addedImage) {
    if (addedImage)
      db.prepare("UPDATE threads SET image_count = image_count + 1 WHERE id = ?").run(id);
  },
  // Approve a held OP: reveal the thread and give it its first bump timestamp.
  approve(id, now) {
    db.prepare("UPDATE threads SET approved = 1, bumped_at = ? WHERE id = ?").run(now, id);
  },
  setFlag(id, field, value) {
    // field is validated by the caller against a whitelist.
    db.prepare(`UPDATE threads SET ${field} = ? WHERE id = ?`).run(value ? 1 : 0, id);
  },
  delete: (id) => db.prepare("DELETE FROM threads WHERE id = ?").run(id),
};

export const Posts = {
  create(p) {
    const info = db
      .prepare(
        `INSERT INTO posts
           (thread_id, board, name, tripcode, comment, image, image_orig,
            image_w, image_h, image_size, is_op, del_hash, created_at,
            approved, media_approved, links_approved, has_link)
         VALUES
           (@thread_id, @board, @name, @tripcode, @comment, @image, @image_orig,
            @image_w, @image_h, @image_size, @is_op, @del_hash, @created_at,
            @approved, @media_approved, @links_approved, @has_link)`
      )
      .run(p);
    return Number(info.lastInsertRowid);
  },
  get: (id) => db.prepare("SELECT * FROM posts WHERE id = ?").get(id),
  forThread(threadId, includePending) {
    // The OP is always returned (its visibility is governed by the thread); for
    // public callers we additionally hide PPA-held replies.
    const vis = includePending ? "" : "AND (is_op = 1 OR approved = 1)";
    return db
      .prepare(`SELECT * FROM posts WHERE thread_id = ? ${vis} ORDER BY id ASC`)
      .all(threadId);
  },
  // The OP plus the last N visible replies — used for board index previews.
  previewReplies(threadId, n, includePending) {
    const vis = includePending ? "" : "AND approved = 1";
    const rows = db
      .prepare(
        `SELECT * FROM posts
         WHERE thread_id = ? AND is_op = 0 ${vis}
         ORDER BY id DESC LIMIT ?`
      )
      .all(threadId, n);
    return rows.reverse();
  },
  // Count of visible replies for a thread (for accurate public counts).
  visibleReplyCount: (threadId) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND is_op = 0 AND approved = 1"
      )
      .get(threadId).n,
  op: (threadId) =>
    db.prepare("SELECT * FROM posts WHERE thread_id = ? AND is_op = 1").get(threadId),
  // Approve one aspect of a post. `field` is whitelisted by the caller.
  approveField(id, field) {
    db.prepare(`UPDATE posts SET ${field} = 1 WHERE id = ?`).run(id);
  },
  // Moderation queues.
  pendingPosts: (board) =>
    db
      .prepare(
        "SELECT * FROM posts WHERE board = ? AND approved = 0 ORDER BY id ASC"
      )
      .all(board),
  pendingMedia: (board) =>
    db
      .prepare(
        "SELECT * FROM posts WHERE board = ? AND image <> '' AND media_approved = 0 ORDER BY id ASC"
      )
      .all(board),
  pendingLinks: (board) =>
    db
      .prepare(
        "SELECT * FROM posts WHERE board = ? AND has_link = 1 AND links_approved = 0 ORDER BY id ASC"
      )
      .all(board),
  delete: (id) => db.prepare("DELETE FROM posts WHERE id = ?").run(id),
};

export default db;

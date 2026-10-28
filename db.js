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
const DATA_DIR = join(__dirname, "data");
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
    locked       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    board       TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT 'Anonymous',
    tripcode    TEXT NOT NULL DEFAULT '',
    comment     TEXT NOT NULL DEFAULT '',
    image       TEXT NOT NULL DEFAULT '',      -- stored filename on disk
    image_orig  TEXT NOT NULL DEFAULT '',      -- original upload name (for display)
    image_w     INTEGER NOT NULL DEFAULT 0,
    image_h     INTEGER NOT NULL DEFAULT 0,
    image_size  INTEGER NOT NULL DEFAULT 0,
    is_op       INTEGER NOT NULL DEFAULT 0,
    del_hash    TEXT NOT NULL DEFAULT '',      -- hashed deletion password
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_threads_board_bump ON threads(board, bumped_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, id);
`);

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

// --- Prepared statements / helpers ------------------------------------------

export const Boards = {
  all: () => db.prepare("SELECT * FROM boards ORDER BY slug").all(),
  get: (slug) => db.prepare("SELECT * FROM boards WHERE slug = ?").get(slug),
};

export const Threads = {
  create(board, subject, now) {
    const info = db
      .prepare(
        `INSERT INTO threads (board, subject, created_at, bumped_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(board, subject, now, now);
    return Number(info.lastInsertRowid);
  },
  get: (id) => db.prepare("SELECT * FROM threads WHERE id = ?").get(id),
  // One page of threads for a board, newest-bumped first, stickies pinned on top.
  page(board, limit, offset) {
    return db
      .prepare(
        `SELECT * FROM threads
         WHERE board = ?
         ORDER BY sticky DESC, bumped_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(board, limit, offset);
  },
  count: (board) =>
    db.prepare("SELECT COUNT(*) AS n FROM threads WHERE board = ?").get(board).n,
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
            image_w, image_h, image_size, is_op, del_hash, created_at)
         VALUES
           (@thread_id, @board, @name, @tripcode, @comment, @image, @image_orig,
            @image_w, @image_h, @image_size, @is_op, @del_hash, @created_at)`
      )
      .run(p);
    return Number(info.lastInsertRowid);
  },
  get: (id) => db.prepare("SELECT * FROM posts WHERE id = ?").get(id),
  forThread: (threadId) =>
    db.prepare("SELECT * FROM posts WHERE thread_id = ? ORDER BY id ASC").all(threadId),
  // The OP plus the last N replies — used for board index previews.
  previewReplies(threadId, n) {
    const rows = db
      .prepare(
        `SELECT * FROM posts
         WHERE thread_id = ? AND is_op = 0
         ORDER BY id DESC LIMIT ?`
      )
      .all(threadId, n);
    return rows.reverse();
  },
  op: (threadId) =>
    db.prepare("SELECT * FROM posts WHERE thread_id = ? AND is_op = 1").get(threadId),
  delete: (id) => db.prepare("DELETE FROM posts WHERE id = ?").run(id),
};

export default db;

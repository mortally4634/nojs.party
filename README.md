# nojs.party

**Free and open-source imageboard software.** Licensed under the MIT License.

An imageboard that is **completely usable with JavaScript disabled**. Every
action — browsing boards, creating threads, replying, uploading images,
paginating, moderating, and managing boards — works through plain HTML forms and
links with full server-side rendering. There is not a single line of
client-side JavaScript, and a `Content-Security-Policy` of `script-src 'none'`
enforces it.

## Features

- **Anonymous posting** with optional names and `name#secret` **tripcodes**
- **Threads and replies** with **image uploads** (PNG / JPEG / GIF / WebP, 5 MB).
  An image is **required** to start a thread.
- **Greentext** (`>text`) and **post quote links** (`>>123`)
- **Bump ordering** with a configurable bump limit, stickies, and locks
- **Delete-with-password** per post (OP deletion removes the whole thread)
- **Pagination**, **dark mode** (follows your OS), and a mobile layout
- Collapsible forms via native `<details>` — no JS even for that

### Staff / moderation

Staff log in at **`/staff`** (default credentials `admin` / `admin`). A signed,
`HttpOnly` session cookie keeps them logged in — so moderation works without
JavaScript too. The staff panel provides:

- **Board management** — create, edit (title/description), and delete boards.
  Slugs are `1–16` lowercase alphanumerics, validated and reserved-name-checked;
  a slug is permanent once created. Deleting requires re-typing the slug.
- **Inline controls** — delete any post (no password), pin/unpin, lock/unlock.
- **Three toggleable approval gates**, each holding only *new* content created
  while it is on:
  - **PPA** — Post Pending Approval: the whole post is hidden until a mod clears
    it. Held posts don't bump or count until approved. *(default: off)*
  - **MPA** — Media Pending Approval: uploaded images are held; the public sees a
    placeholder, staff see the real image. *(default: on)*
  - **LPA** — Link Pending Approval: external `http(s)` links are held; the
    public sees a placeholder. Internal `>>123` quotes are never gated.
    *(default: on)*
- **Per-board moderation queue** at `/<board>/queue` listing everything pending,
  with one-click approve / delete.

Override the defaults with env vars: `MOD_USER`, `MOD_PASS`, and `SESSION_SECRET`
(set a stable secret in production so sessions survive restarts).

## Tech

- **Node.js ≥ 22.5** with the built-in `node:sqlite` driver — no native builds
- **express** for routing, **multer** for multipart uploads (both pure JS)
- Image dimensions parsed from file headers in pure JS (`imagesize.js`)

## Run

```bash
npm install
npm start          # listens on http://localhost:7002
```

Set a different port with `PORT=8080 npm start`.

## Configuration & default settings

A **fresh install ships with this moderation posture** (the staff panel can
change it per-instance afterwards):

| Gate | Default | Meaning |
| ---- | ------- | ------- |
| **PPA** (Post Pending Approval)  | **off** | posts appear immediately |
| **MPA** (Media Pending Approval) | **on**  | every uploaded image is held for review |
| **LPA** (Link Pending Approval)  | **on**  | every external link is held for review |

These defaults are seeded only on first run. Operators packaging or deploying
the software can override the initial posture at launch — no source edits
needed — via environment variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `7002` | HTTP port |
| `DATA_DIR` | `./data` | where the SQLite database lives |
| `DEFAULT_PPA` / `DEFAULT_MPA` / `DEFAULT_LPA` | `0` / `1` / `1` | initial state of each approval gate (`1`/`0`, `true`/`false`, `on`/`off`) |
| `MOD_USER` / `MOD_PASS` | `admin` / `admin` | staff credentials |
| `SESSION_SECRET` | random per start | signs staff session cookies (set a stable value in production) |

## Layout

| File           | Responsibility                                      |
| -------------- | --------------------------------------------------- |
| `server.js`    | HTTP routes, uploads, approval gating, Post/Redirect/Get |
| `db.js`        | SQLite schema, migrations, settings & query helpers |
| `render.js`    | Server-side HTML templates                          |
| `util.js`      | HTML escaping, comment formatting, tripcodes, links |
| `auth.js`      | Staff credentials + signed session cookies          |
| `imagesize.js` | Pure-JS image header parser                         |
| `public/`      | `style.css`, `favicon.svg`                          |

Data persists in `data/` (SQLite) and uploads in `uploads/` — both gitignored.
Boards are seeded with a single board, `/js/`, on first run.

## License

nojs.party is open-source imageboard software released under the
[MIT License](LICENSE) — free to use, modify, and distribute.

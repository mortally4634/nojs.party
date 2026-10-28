# nojs.party

An imageboard that is **completely usable with JavaScript disabled**. Every
action — browsing boards, creating threads, replying, uploading images,
paginating, and deleting your own posts — works through plain HTML forms and
links with full server-side rendering. There is not a single line of
client-side JavaScript, and a `Content-Security-Policy` of `script-src 'none'`
enforces it.

## Features

- **Multiple boards** (seeded: `/b/`, `/tech/`, `/art/`, `/meta/`)
- **Anonymous posting** with optional names and `name#secret` **tripcodes**
- **Threads and replies** with **image uploads** (PNG / JPEG / GIF / WebP, 5 MB)
- **Greentext** (`>text`) and **post quote links** (`>>123`)
- **Bump ordering** with a configurable bump limit, stickies, and locks
- **Delete-with-password** per post (OP deletion removes the whole thread)
- **Pagination**, **dark mode** (follows your OS), and a mobile layout
- Collapsible forms via native `<details>` — no JS even for that

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

## Layout

| File           | Responsibility                                  |
| -------------- | ----------------------------------------------- |
| `server.js`    | HTTP routes, uploads, Post/Redirect/Get flow    |
| `db.js`        | SQLite schema + query helpers (seeds boards)    |
| `render.js`    | Server-side HTML templates                      |
| `util.js`      | HTML escaping, comment formatting, tripcodes    |
| `imagesize.js` | Pure-JS image header parser                     |
| `public/`      | `style.css`, `favicon.svg`                      |

Data persists in `data/` (SQLite) and uploads in `uploads/` — both gitignored.

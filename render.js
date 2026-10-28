// render.js — server-side HTML templates.
//
// There is no templating engine and no client framework: each function returns
// a string of HTML. This is deliberate. For a no-JS site the server IS the
// renderer, so plain template literals are the most direct tool and have zero
// runtime cost. Every dynamic value funnels through util.escapeHtml (or
// renderComment, which escapes internally) before interpolation.

import { escapeHtml, formatDate, humanSize, renderComment } from "./util.js";

// --- Page shell -------------------------------------------------------------

export function layout({ title, boards, body, board, isMod }) {
  const boardLinks = boards
    .map(
      (b) =>
        `<a href="/${escapeHtml(b.slug)}/"${
          board && b.slug === board ? ' class="active"' : ""
        }>/${escapeHtml(b.slug)}/</a>`
    )
    .join(" ");

  const staffLink = isMod
    ? `<span class="staff-badge">staff</span> <a class="home" href="/staff">panel</a>`
    : `<a class="home" href="/staff">staff</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<nav class="boardbar">[ ${boardLinks} ] ${staffLink} <a class="home" href="/">home</a></nav>
<header class="masthead">
  <a href="/"><h1>nojs.party</h1></a>
  <p class="tagline">an imageboard that needs no javascript whatsoever</p>
</header>
<main>
${body}
</main>
<footer>
  <p>nojs.party &mdash; runs entirely on HTML forms and server-side rendering.
  Disable JavaScript and everything still works.</p>
</footer>
</body>
</html>`;
}

// --- Home page --------------------------------------------------------------

export function homePage(boards, stats) {
  const cards = boards
    .map(
      (b) => `
    <li class="board-card">
      <a class="board-link" href="/${escapeHtml(b.slug)}/">
        <span class="board-slug">/${escapeHtml(b.slug)}/</span>
        <span class="board-title">${escapeHtml(b.title)}</span>
      </a>
      <p class="board-desc">${escapeHtml(b.description)}</p>
    </li>`
    )
    .join("");

  return `
  <section class="intro">
    <h2>Welcome</h2>
    <p>This is a classic textboard/imageboard. Post anonymously, reply to
    threads, and upload images &mdash; all without a single line of client-side
    JavaScript. Pick a board to get started.</p>
    <p class="stat">${stats.threads} threads &middot; ${stats.posts} posts across ${boards.length} boards.</p>
  </section>
  <ul class="board-list">${cards}</ul>`;
}

// --- Post form (shared by new-thread and reply) -----------------------------

export function postForm({ action, isThread, locked }) {
  if (locked) {
    return `<div class="locked-note">🔒 This thread is locked. No new replies.</div>`;
  }
  return `
  <form class="post-form" action="${action}" method="post" enctype="multipart/form-data">
    <table class="form-table">
      <tr>
        <th><label for="name">Name</label></th>
        <td><input type="text" id="name" name="name" placeholder="Anonymous (use name#secret for a tripcode)" maxlength="60"></td>
      </tr>
      ${
        isThread
          ? `<tr>
        <th><label for="subject">Subject</label></th>
        <td><input type="text" id="subject" name="subject" maxlength="120">
            <input type="submit" value="${isThread ? "Create Thread" : "Post"}" class="submit-inline"></td>
      </tr>`
          : ""
      }
      <tr>
        <th><label for="comment">Comment</label></th>
        <td><textarea id="comment" name="comment" rows="5" maxlength="8000" required placeholder="Use &gt;text for greentext and &gt;&gt;123 to quote a post."></textarea></td>
      </tr>
      <tr>
        <th><label for="image">Image</label></th>
        <td>
          <input type="file" id="image" name="image" accept="image/png,image/jpeg,image/gif,image/webp">
          <span class="hint">PNG, JPEG, GIF or WebP, up to 5 MB${isThread ? "" : " (optional)"}.</span>
        </td>
      </tr>
      <tr>
        <th><label for="delpw">Delete password</label></th>
        <td>
          <input type="password" id="delpw" name="delpw" maxlength="64" placeholder="optional, lets you delete this post later">
          ${isThread ? "" : `<input type="submit" value="Post Reply" class="submit-inline">`}
        </td>
      </tr>
    </table>
  </form>`;
}

// --- A single post ----------------------------------------------------------

export function renderPost(post, { board, threadId, showReplyLink, isMod, thread }) {
  const name = escapeHtml(post.name || "Anonymous");
  const trip = post.tripcode
    ? `<span class="trip">!${escapeHtml(post.tripcode)}</span>`
    : "";
  const comment = renderComment(post.comment, { board, threadId });

  let fileBlock = "";
  if (post.image) {
    const dims = post.image_w ? `${post.image_w}×${post.image_h}, ` : "";
    fileBlock = `
      <div class="file">
        <span class="file-info">File:
          <a href="/uploads/${escapeHtml(post.image)}" rel="noopener">${escapeHtml(post.image_orig || post.image)}</a>
          (${dims}${humanSize(post.image_size)})
        </span>
        <a class="thumb-link" href="/uploads/${escapeHtml(post.image)}">
          <img class="thumb" src="/uploads/${escapeHtml(post.image)}" alt="post image" loading="lazy">
        </a>
      </div>`;
  }

  const replyLink = showReplyLink
    ? ` <a class="replylink" href="/${board}/thread/${threadId}#p${post.id}">No.${post.id}</a>`
    : ` <span class="postno">No.${post.id}</span>`;

  // Staff get no-password moderation controls; everyone gets the password box.
  let modControls = "";
  if (isMod) {
    const act = (action, label) =>
      `<form class="mod-form" action="/${board}/mod" method="post">
         <input type="hidden" name="action" value="${action}">
         <input type="hidden" name="post_id" value="${post.id}">
         <input type="submit" value="${label}">
       </form>`;
    const threadActions =
      post.is_op && thread
        ? act(thread.sticky ? "unsticky" : "sticky", thread.sticky ? "unpin" : "pin") +
          act(thread.locked ? "unlock" : "lock", thread.locked ? "unlock" : "lock")
        : "";
    modControls = `<span class="mod-controls">${act("delete", "del")}${threadActions}</span>`;
  }

  return `
  <div class="post ${post.is_op ? "op" : "reply"}" id="p${post.id}">
    <div class="post-head">
      ${post.is_op && post.subject ? `<span class="subject">${escapeHtml(post.subject)}</span> ` : ""}
      <span class="name">${name}</span>${trip}
      <span class="date">${formatDate(post.created_at)}</span>
      ${replyLink}
      <details class="delbox">
        <summary>×</summary>
        <form class="del-form" action="/${board}/delete" method="post">
          <input type="hidden" name="post_id" value="${post.id}">
          <input type="password" name="delpw" placeholder="delete password" required>
          <input type="submit" value="Delete">
        </form>
      </details>
      ${modControls}
    </div>
    ${fileBlock}
    <blockquote class="comment">${comment}</blockquote>
  </div>`;
}

// --- Board index (list of threads with previews) ----------------------------

export function boardPage({ board, threads, page, pageCount, error, isMod }) {
  const threadHtml = threads
    .map((t) => {
      const op = renderPost(t.op, {
        board: board.slug,
        threadId: t.id,
        showReplyLink: true,
        isMod,
        thread: t,
      });
      const omitted =
        t.reply_count > t.previews.length
          ? `<div class="omitted">${t.reply_count - t.previews.length} replies omitted. <a href="/${board.slug}/thread/${t.id}">Click to view.</a></div>`
          : "";
      const previews = t.previews
        .map((p) =>
          renderPost(p, { board: board.slug, threadId: t.id, showReplyLink: false, isMod })
        )
        .join("");
      const badges =
        (t.sticky ? '<span class="badge sticky">📌 sticky</span>' : "") +
        (t.locked ? '<span class="badge locked">🔒 locked</span>' : "");
      return `
      <div class="thread">
        <div class="thread-actions">
          <a class="view-thread" href="/${board.slug}/thread/${t.id}">View thread (${t.reply_count} replies)</a>
          ${badges}
        </div>
        ${op}
        ${omitted}
        <div class="previews">${previews}</div>
      </div>
      <hr class="thread-sep">`;
    })
    .join("");

  const pager = renderPager(`/${board.slug}/`, page, pageCount);

  return `
  <section class="board-head">
    <h2>/${escapeHtml(board.slug)}/ &mdash; ${escapeHtml(board.title)}</h2>
    <p class="board-desc">${escapeHtml(board.description)}</p>
  </section>

  <details class="new-thread" ${error ? "open" : ""}>
    <summary>Start a new thread</summary>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${postForm({ action: `/${board.slug}/thread`, isThread: true, locked: false })}
  </details>

  <hr class="thread-sep">
  ${threadHtml || '<p class="empty">No threads yet. Be the first to post!</p>'}
  ${pager}`;
}

// --- Single thread page -----------------------------------------------------

export function threadPage({ board, thread, posts, error, isMod }) {
  const op = posts.find((p) => p.is_op);
  const replies = posts.filter((p) => !p.is_op);

  const opHtml = renderPost(op, {
    board: board.slug,
    threadId: thread.id,
    showReplyLink: false,
    isMod,
    thread,
  });
  const repliesHtml = replies
    .map((p) =>
      renderPost(p, { board: board.slug, threadId: thread.id, showReplyLink: false, isMod })
    )
    .join("");

  const badges =
    (thread.sticky ? '<span class="badge sticky">📌 sticky</span>' : "") +
    (thread.locked ? '<span class="badge locked">🔒 locked</span>' : "");

  return `
  <section class="board-head">
    <h2><a href="/${board.slug}/">/${escapeHtml(board.slug)}/</a> &mdash; ${escapeHtml(thread.subject || "Thread No." + thread.id)}</h2>
    <p class="thread-meta">${thread.reply_count} replies, ${thread.image_count} images. ${badges}
      <a class="back" href="/${board.slug}/">[Return to board]</a></p>
  </section>

  <div class="thread single">
    ${opHtml}
    <div class="replies">${repliesHtml}</div>
  </div>

  <hr class="thread-sep">
  <details class="reply-box" ${error ? "open" : ""} id="reply">
    <summary>Post a reply</summary>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${postForm({
      action: `/${board.slug}/thread/${thread.id}/reply`,
      isThread: false,
      locked: !!thread.locked,
    })}
  </details>`;
}

// --- Pagination controls ----------------------------------------------------

function renderPager(base, page, pageCount) {
  if (pageCount <= 1) return "";
  const links = [];
  for (let i = 1; i <= pageCount; i++) {
    if (i === page) links.push(`<span class="pg current">${i}</span>`);
    else links.push(`<a class="pg" href="${base}?page=${i}">${i}</a>`);
  }
  const prev =
    page > 1 ? `<a class="pg" href="${base}?page=${page - 1}">‹ prev</a>` : "";
  const next =
    page < pageCount
      ? `<a class="pg" href="${base}?page=${page + 1}">next ›</a>`
      : "";
  return `<nav class="pager">${prev} ${links.join(" ")} ${next}</nav>`;
}

// --- Generic message / error page ------------------------------------------

// --- Staff login / panel ----------------------------------------------------

export function staffPage({ isMod, error }) {
  if (isMod) {
    return `
    <section class="message-page">
      <h2>Staff Panel</h2>
      <p>You are signed in as staff. Moderation controls (del / pin / lock) now
      appear on every post and thread.</p>
      <ul class="staff-howto">
        <li><strong>del</strong> — remove any post without its delete password
        (removing an OP deletes the whole thread).</li>
        <li><strong>pin / unpin</strong> — stick a thread to the top of the board.</li>
        <li><strong>lock / unlock</strong> — stop or allow new replies.</li>
      </ul>
      <form class="post-form" action="/staff/logout" method="post">
        <input type="submit" value="Log out">
      </form>
    </section>`;
  }
  return `
  <section class="message-page">
    <h2>Staff Login</h2>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form class="post-form" action="/staff" method="post">
      <table class="form-table">
        <tr><th><label for="user">Username</label></th>
            <td><input type="text" id="user" name="user" autocomplete="username" required></td></tr>
        <tr><th><label for="pass">Password</label></th>
            <td><input type="password" id="pass" name="pass" autocomplete="current-password" required></td></tr>
        <tr><th></th><td><input type="submit" value="Log in"></td></tr>
      </table>
    </form>
  </section>`;
}

export function messagePage({ heading, message, backHref, backLabel }) {
  return `
  <section class="message-page">
    <h2>${escapeHtml(heading)}</h2>
    <p>${escapeHtml(message)}</p>
    <p><a href="${backHref || "/"}">${escapeHtml(backLabel || "Go back")}</a></p>
  </section>`;
}

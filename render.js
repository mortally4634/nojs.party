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
        <th><label for="image">Image${isThread ? " <span class=\"req\">*</span>" : ""}</label></th>
        <td>
          <input type="file" id="image" name="image" accept="image/png,image/jpeg,image/gif,image/webp"${isThread ? " required" : ""}>
          <span class="hint">PNG, JPEG, GIF or WebP, up to 5 MB${isThread ? " — required to start a thread." : " (optional)."}</span>
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

  // Pending states. Public viewers never see a post held by PPA (the queries
  // exclude it), so a rendered-but-unapproved post only ever reaches a mod.
  const postPending = !post.approved;
  const mediaPending = !!post.image && !post.media_approved;
  const linksPending = !!post.has_link && !post.links_approved;

  // Links: hold them from the public, but let a trusted mod see the real URL so
  // they can judge it in context before approving.
  const comment = renderComment(post.comment, {
    board,
    threadId,
    holdLinks: linksPending && !isMod,
  });

  // Media: the public sees a placeholder; a mod sees the actual image (marked
  // pending) so they can review it. Once approved, everyone sees it.
  let fileBlock = "";
  if (post.image) {
    if (mediaPending && !isMod) {
      fileBlock = `<div class="file"><div class="media-pending">[ media pending approval ]</div></div>`;
    } else {
      const dims = post.image_w ? `${post.image_w}×${post.image_h}, ` : "";
      const pendNote = mediaPending
        ? ` <span class="pending-tag">media pending</span>`
        : "";
      fileBlock = `
      <div class="file">
        <span class="file-info">File:
          <a href="/uploads/${escapeHtml(post.image)}" rel="noopener">${escapeHtml(post.image_orig || post.image)}</a>
          (${dims}${humanSize(post.image_size)})${pendNote}
        </span>
        <a class="thumb-link" href="/uploads/${escapeHtml(post.image)}">
          <img class="thumb${mediaPending ? " held" : ""}" src="/uploads/${escapeHtml(post.image)}" alt="post image" loading="lazy">
        </a>
      </div>`;
    }
  }

  const replyLink = showReplyLink
    ? ` <a class="replylink" href="/${board}/thread/${threadId}#p${post.id}">No.${post.id}</a>`
    : ` <span class="postno">No.${post.id}</span>`;

  // Badges that explain a post's pending status (shown to mods, who are the
  // only ones who can see partially-held posts in full).
  const statusBadges = isMod
    ? (postPending ? '<span class="pending-badge ppa">PPA · post pending</span>' : "") +
      (mediaPending ? '<span class="pending-badge mpa">MPA · media pending</span>' : "") +
      (linksPending ? '<span class="pending-badge lpa">LPA · link pending</span>' : "")
    : "";

  // Staff get no-password moderation controls; everyone gets the password box.
  let modControls = "";
  if (isMod) {
    const act = (action, label, cls = "") =>
      `<form class="mod-form ${cls}" action="/${board}/mod" method="post">
         <input type="hidden" name="action" value="${action}">
         <input type="hidden" name="post_id" value="${post.id}">
         <input type="submit" value="${label}">
       </form>`;
    const approvals =
      (postPending ? act("approve", "✓ post", "approve") : "") +
      (mediaPending ? act("approve_media", "✓ media", "approve") : "") +
      (linksPending ? act("approve_links", "✓ link", "approve") : "");
    const threadActions =
      post.is_op && thread
        ? act(thread.sticky ? "unsticky" : "sticky", thread.sticky ? "unpin" : "pin") +
          act(thread.locked ? "unlock" : "lock", thread.locked ? "unlock" : "lock")
        : "";
    modControls = `<span class="mod-controls">${approvals}${act("delete", "del")}${threadActions}</span>`;
  }

  return `
  <div class="post ${post.is_op ? "op" : "reply"}${postPending ? " is-pending" : ""}" id="p${post.id}">
    <div class="post-head">
      ${post.is_op && post.subject ? `<span class="subject">${escapeHtml(post.subject)}</span> ` : ""}
      <span class="name">${name}</span>${trip}
      <span class="date">${formatDate(post.created_at)}</span>
      ${replyLink}
      ${statusBadges}
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

export function staffPage({ isMod, error, settings, queues, boards }) {
  if (isMod) {
    const chk = (on) => (on ? " checked" : "");
    const errBanner = error ? `<p class="error">${escapeHtml(error)}</p>` : "";

    // One edit + delete form per existing board. Slug is shown read-only; delete
    // requires re-typing the slug as a no-JS confirmation guard.
    const boardRows = (boards || [])
      .map(
        (b) => `
      <div class="board-admin">
        <form class="post-form board-edit" action="/staff/boards/edit" method="post">
          <input type="hidden" name="slug" value="${escapeHtml(b.slug)}">
          <span class="board-admin-slug">/${escapeHtml(b.slug)}/</span>
          <input type="text" name="title" value="${escapeHtml(b.title)}" maxlength="60" required>
          <input type="text" name="description" value="${escapeHtml(b.description)}" maxlength="200" placeholder="description">
          <input type="submit" value="Save">
        </form>
        <form class="post-form board-delete" action="/staff/boards/delete" method="post">
          <input type="hidden" name="slug" value="${escapeHtml(b.slug)}">
          <input type="text" name="confirm" placeholder="type ${escapeHtml(b.slug)} to delete" maxlength="16">
          <input type="submit" value="Delete board" class="danger">
        </form>
      </div>`
      )
      .join("");
    const queueRows = (queues || [])
      .map((q) => {
        const total = q.posts + q.media + q.links;
        return `<li>
          <a href="/${escapeHtml(q.slug)}/queue">/${escapeHtml(q.slug)}/ queue</a>
          — ${total} pending
          <span class="qbreak">(${q.posts} posts, ${q.media} media, ${q.links} links)</span>
        </li>`;
      })
      .join("");

    return `
    <section class="message-page">
      <h2>Staff Panel</h2>
      ${errBanner}

      <h3>Boards</h3>
      <p>Create a new board or edit an existing one's title and description.
      A board's slug is permanent once created.</p>
      <form class="post-form board-create" action="/staff/boards/create" method="post">
        <span class="slug-prefix">/</span>
        <input type="text" name="slug" placeholder="slug" pattern="[a-z0-9]{1,16}" maxlength="16" required
               title="lowercase letters and digits, 1–16 characters">
        <span class="slug-prefix">/</span>
        <input type="text" name="title" placeholder="Board title" maxlength="60" required>
        <input type="text" name="description" placeholder="Short description" maxlength="200">
        <input type="submit" value="Create board">
      </form>
      <div class="board-admin-list">${boardRows}</div>

      <h3>Approval systems</h3>
      <p>Toggle the three review gates. A gate only holds new content created
      while it is on; already-approved content is unaffected.</p>
      <form class="post-form settings-form" action="/staff/settings" method="post">
        <label class="toggle"><input type="checkbox" name="ppa"${chk(settings.ppa)}>
          <strong>PPA</strong> — Post Pending Approval: hide every new post until a mod clears it.</label>
        <label class="toggle"><input type="checkbox" name="mpa"${chk(settings.mpa)}>
          <strong>MPA</strong> — Media Pending Approval: hide every uploaded image until a mod clears it.</label>
        <label class="toggle"><input type="checkbox" name="lpa"${chk(settings.lpa)}>
          <strong>LPA</strong> — Link Pending Approval: hold every external link until a mod clears it.</label>
        <input type="submit" value="Save settings">
      </form>

      <h3>Moderation queue</h3>
      <ul class="staff-howto queue-links">${queueRows || "<li>No boards.</li>"}</ul>

      <h3>Inline controls</h3>
      <ul class="staff-howto">
        <li><strong>✓ post / ✓ media / ✓ link</strong> — approve a held post, image, or link.</li>
        <li><strong>del</strong> — remove any post without its delete password
        (removing an OP deletes the whole thread).</li>
        <li><strong>pin / unpin</strong>, <strong>lock / unlock</strong> — manage threads.</li>
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

// --- Moderation queue -------------------------------------------------------

export function queuePage({ board, pendingPosts, pendingMedia, pendingLinks }) {
  // Each queued item reuses renderPost in mod mode, so the approve/delete
  // controls and the real (held) media/links are all visible for review.
  const section = (title, hint, rows) => {
    const body =
      rows.length === 0
        ? `<p class="empty">Nothing pending.</p>`
        : rows
            .map((p) =>
              renderPost(p, {
                board: board.slug,
                threadId: p.thread_id,
                showReplyLink: true,
                isMod: true,
                thread: p.is_op ? p._thread : undefined,
              })
            )
            .join('<hr class="thread-sep">');
    return `
      <section class="queue-section">
        <h3>${escapeHtml(title)} <span class="qcount">(${rows.length})</span></h3>
        <p class="board-desc">${escapeHtml(hint)}</p>
        ${body}
      </section>`;
  };

  return `
  <section class="board-head">
    <h2>/${escapeHtml(board.slug)}/ &mdash; moderation queue</h2>
    <p class="thread-meta"><a class="back" href="/staff">[Staff panel]</a>
      <a class="back" href="/${board.slug}/">[Board]</a></p>
  </section>
  ${section("Posts pending (PPA)", "Entire posts hidden from the public until approved.", pendingPosts)}
  <hr class="thread-sep">
  ${section("Media pending (MPA)", "Posts whose image is held. The public sees a placeholder.", pendingMedia)}
  <hr class="thread-sep">
  ${section("Links pending (LPA)", "Posts with an external link held from the public.", pendingLinks)}`;
}

export function messagePage({ heading, message, backHref, backLabel }) {
  return `
  <section class="message-page">
    <h2>${escapeHtml(heading)}</h2>
    <p>${escapeHtml(message)}</p>
    <p><a href="${backHref || "/"}">${escapeHtml(backLabel || "Go back")}</a></p>
  </section>`;
}

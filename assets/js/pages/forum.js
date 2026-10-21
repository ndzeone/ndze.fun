// Форум: обзор (новости, разделы, свежие темы), раздел со списком тем, тема с ответами.
// Маршруты в адресе: #/  ·  #/s/<раздел>[/<проект>]  ·  #/t/<id>[/<страница>]  ·  #/q/<поиск>
import { SITE } from "../config.js";
import { mountLayout, onUserChange, getUser, openAuth } from "../core/layout.js";
import { api } from "../data/api.js";
import { setupModal, shake } from "../core/modal.js";
import { $, $$, esc, avatarHTML, plural, timeAgo, formatDate, toast, userUrl } from "../core/util.js";
import { renderMarkdown, preloadMarkdown } from "../core/markdown.js";
import { initMagnetic } from "../core/fx.js";

await mountLayout("forum");

const root = $("#forumRoot");
const ICONS = { news: "📢", rules: "📜", ideas: "💡", help: "❓", talk: "💬" };
const SECTION_HINT = {
  news: "Анонсы стримов, запуски и обновления проектов — пишет только ndze.",
  rules: "Правила Penta SMP, MythosMC и будущих проектов. Прочитай перед тем, как заходить.",
  ideas: "Предлагай фичи для сайта, серверов и стримов.",
  help: "Не получается зайти на сервер или что-то сломалось — спрашивай здесь.",
  talk: "Обо всём: игры, мемы, творчество.",
};
// проекты для меток тем: из config.js + «будущие»
const PROJECTS = [...(SITE.projects || []).map((p) => ({ id: p.id, title: p.title })), { id: "future", title: "Будущие проекты" }];
const projectTitle = (id) => PROJECTS.find((p) => p.id === id)?.title || id;
let overview = null; // ответ api.forum() — нужен для названий разделов и прав
let seq = 0;

const sectionOf = (id) => overview?.sections.find((s) => s.id === id);
const sectionLabel = (id) => sectionOf(id)?.label || id;
const loginBtn = (reason, label = "Войти") => `<button class="btn btn-primary btn-sm" type="button" data-open-auth="login" data-reason="${esc(reason)}">${esc(label)}</button>`;

/* ---------- Маршрутизация ---------- */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  if (parts[0] === "s" && parts[1]) return { view: "section", section: parts[1], project: parts[2] || "", page: Number(parts[3]) || 1 };
  if (parts[0] === "t" && parts[1]) return { view: "thread", id: parts[1], page: parts[2] === "last" ? "last" : Number(parts[2]) || 1 };
  if (parts[0] === "q" && parts[1]) return { view: "search", q: parts[1], page: Number(parts[2]) || 1 };
  return { view: "home" };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

async function render() {
  const my = ++seq;
  const r = parseRoute();
  try {
    overview ??= await api.forum();
    if (r.view === "section") await renderSection(my, r);
    else if (r.view === "thread") await renderThread(my, r);
    else if (r.view === "search") await renderSearch(my, r);
    else await renderHome(my);
  } catch (err) {
    if (my !== seq) return;
    root.innerHTML = `<div class="empty fr-error"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p><a class="btn btn-ghost btn-sm" href="#/">К форуму</a></div>`;
  }
  if (my === seq) initMagnetic();
}
window.addEventListener("hashchange", () => { render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
onUserChange(() => { overview = null; render(); });

/* ---------- Общие куски ---------- */
function headHTML(title, sub, crumbs = []) {
  return `<header class="page-head fr-head">
    <nav class="fr-crumbs" aria-label="Навигация по форуму"><a href="#/">Форум</a>${crumbs.map((c) => ` <span aria-hidden="true">›</span> ${c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`}`).join("")}</nav>
    <h1>${esc(title)}</h1>
    ${sub ? `<p>${esc(sub)}</p>` : ""}
  </header>`;
}

function toolbarHTML({ section = "", q = "" } = {}) {
  const canNew = overview.sections.some((s) => s.canPost);
  const user = getUser();
  return `<div class="fr-toolbar">
    <form class="fr-search" role="search" data-search>
      <input type="search" name="q" placeholder="Поиск по темам…" value="${esc(q)}" maxlength="60" aria-label="Поиск по темам">
      <button class="btn btn-ghost btn-sm" type="submit">Найти</button>
    </form>
    ${user ? (canNew ? `<button class="btn btn-primary btn-sm magnetic" type="button" data-new="${esc(section)}">+ Новая тема</button>` : "")
      : loginBtn("Войди, чтобы создавать темы и отвечать", "Войти, чтобы писать")}
  </div>`;
}

function badgesHTML(t) {
  return `${t.pinned ? '<span class="fr-flag" title="Закреплено">📌</span>' : ""}${t.locked ? '<span class="fr-flag" title="Закрыто для ответов">🔒</span>' : ""}`;
}
function projectTagHTML(id) {
  return id ? `<a class="fr-proj" href="#/s/rules/${encodeURIComponent(id)}">${esc(projectTitle(id))}</a>` : "";
}

function threadRowHTML(t, { showSection = false } = {}) {
  return `<li class="fr-row${t.pinned ? " is-pinned" : ""}">
    ${avatarHTML(t.author.nick, t.author.avatarUrl, { size: "sm" })}
    <div class="fr-row-main">
      <a class="fr-row-title" href="#/t/${esc(t.id)}">${badgesHTML(t)}${esc(t.title)}</a>
      <span class="fr-row-meta">
        ${showSection ? `<a class="fr-sec-tag" href="#/s/${esc(t.section)}">${ICONS[t.section] || ""} ${esc(sectionLabel(t.section))}</a>` : ""}
        ${projectTagHTML(t.project)}
        <a class="fr-nick" href="${esc(userUrl(t.author.nick))}">${esc(t.author.nick)}</a>${t.author.isAdmin ? ' <span class="role-badge">admin</span>' : ""}
        <time datetime="${esc(t.createdAt)}">${esc(timeAgo(t.createdAt))}</time>
      </span>
    </div>
    <div class="fr-row-stats" aria-label="${t.replies} ответов, ${t.views} просмотров">
      <span title="Ответы">💬 ${t.replies}</span><span title="Просмотры">👁 ${t.views}</span>${t.likes ? `<span title="Лайки">♥ ${t.likes}</span>` : ""}
    </div>
    <div class="fr-row-last"><small>${t.lastNick ? esc(t.lastNick) : ""}</small><time datetime="${esc(t.lastPostAt)}">${esc(timeAgo(t.lastPostAt))}</time></div>
  </li>`;
}

function pagerHTML(page, pages, base) {
  if (pages <= 1) return "";
  const btn = (p, label = p) => `<a class="fr-page${p === page ? " is-current" : ""}" href="${base}/${p}"${p === page ? ' aria-current="page"' : ""}>${label}</a>`;
  const list = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 2) list.push(p);
  return `<nav class="fr-pager" aria-label="Страницы">${list.map((p, i) => (i && p - list[i - 1] > 1 ? '<span class="fr-gap">…</span>' : "") + btn(p)).join("")}</nav>`;
}

/* ---------- Обзор ---------- */
async function renderHome(my) {
  const o = overview = await api.forum();
  if (my !== seq) return;
  const news = o.news.map((t) => `<a class="fr-news glass" href="#/t/${esc(t.id)}">
      <span class="fr-news-kicker">${t.pinned ? "📌 Важно" : "📢 Новость"} · ${esc(formatDate(t.createdAt))}</span>
      <h3>${esc(t.title)}</h3>
      <p>${esc(t.excerpt)}</p>
      <span class="fr-news-foot">💬 ${t.replies} · 👁 ${t.views}${projectTagHTML(t.project) ? " · " + esc(projectTitle(t.project)) : ""}</span>
    </a>`).join("");
  root.innerHTML = `${headHTML("Форум", "Новости, правила проектов и общение зрителей. Читай свежие анонсы первым и обсуждай идеи для стримов и серверов.")}
    ${toolbarHTML()}
    <section class="fr-block" aria-labelledby="newsTitle">
      <div class="section-head"><span class="section-index">01</span><h2 id="newsTitle">Свежие новости</h2><span class="spacer"></span><a class="btn btn-ghost btn-sm" href="#/s/news">Все новости →</a></div>
      ${news ? `<div class="fr-news-grid">${news}</div>` : `<div class="empty"><span class="empty-icon">📢</span><p>Новостей пока нет — первая появится совсем скоро.</p></div>`}
    </section>
    <section class="fr-block" aria-labelledby="secTitle">
      <div class="section-head"><span class="section-index">02</span><h2 id="secTitle">Разделы</h2></div>
      <div class="fr-sections">${o.sections.map((s) => `<a class="fr-section glass" href="#/s/${esc(s.id)}">
          <span class="fr-sec-icon" aria-hidden="true">${ICONS[s.id] || "💬"}</span>
          <span class="fr-sec-text"><b>${esc(s.label)}</b><small>${esc(SECTION_HINT[s.id] || "")}</small></span>
          <span class="fr-sec-stats"><b>${s.threads}</b> ${plural(s.threads, ["тема", "темы", "тем"])} · ${s.posts} ${plural(s.posts, ["сообщение", "сообщения", "сообщений"])}
            ${s.lastPostAt ? `<small>последнее ${esc(timeAgo(s.lastPostAt))}</small>` : ""}${s.adminOnly ? '<small class="fr-only">пишет только ndze</small>' : ""}</span>
        </a>`).join("")}</div>
    </section>
    <section class="fr-block" aria-labelledby="rulesTitle">
      <div class="section-head"><span class="section-index">03</span><h2 id="rulesTitle">Правила проектов</h2></div>
      <div class="fr-rules-chips">${PROJECTS.map((p) => `<a class="chip" href="#/s/rules/${encodeURIComponent(p.id)}">📜 ${esc(p.title)}</a>`).join("")}</div>
    </section>
    <section class="fr-block" aria-labelledby="lastTitle">
      <div class="section-head"><span class="section-index">04</span><h2 id="lastTitle">Свежие темы</h2></div>
      ${o.latest.length ? `<ul class="fr-list glass">${o.latest.map((t) => threadRowHTML(t, { showSection: true })).join("")}</ul>` : `<div class="empty"><span class="empty-icon">💬</span><p>Тем пока нет — создай первую!</p></div>`}
    </section>`;
}

/* ---------- Раздел ---------- */
async function renderSection(my, r) {
  const sec = sectionOf(r.section);
  if (!sec) throw new Error("Нет такого раздела");
  const data = await api.forumThreads({ section: r.section, project: r.project, page: r.page });
  if (my !== seq) return;
  const base = `#/s/${r.section}`;
  const chips = r.section === "rules" || r.section === "news" || r.section === "ideas"
    ? `<div class="chips fr-chips"><a class="chip" href="${base}" aria-pressed="${!r.project}">Все</a>${PROJECTS.map((p) => `<a class="chip" href="${base}/${encodeURIComponent(p.id)}" aria-pressed="${r.project === p.id}">${esc(p.title)}</a>`).join("")}</div>`
    : "";
  root.innerHTML = `${headHTML(`${ICONS[sec.id] || ""} ${sec.label}`, SECTION_HINT[sec.id] || "", [{ label: sec.label, href: r.project ? base : "" }, ...(r.project ? [{ label: projectTitle(r.project) }] : [])])}
    ${toolbarHTML({ section: sec.canPost ? sec.id : "" })}
    ${chips}
    ${data.items.length ? `<ul class="fr-list glass">${data.items.map((t) => threadRowHTML(t)).join("")}</ul>`
      : `<div class="empty"><span class="empty-icon">${ICONS[sec.id] || "💬"}</span><p>${r.project ? "По этому проекту тем пока нет." : "В разделе пока пусто."}</p>
          ${sec.canPost ? `<button class="btn btn-primary btn-sm" type="button" data-new="${esc(sec.id)}" data-project="${esc(r.project)}">Создать тему</button>` : ""}</div>`}
    ${pagerHTML(data.page, data.pages, r.project ? `${base}/${encodeURIComponent(r.project)}` : `${base}/`)}`;
  // у пагинации раздела без проекта путь вида #/s/ideas//2 — третий сегмент пуст
}

/* ---------- Поиск ---------- */
async function renderSearch(my, r) {
  const data = await api.forumThreads({ q: r.q, page: r.page });
  if (my !== seq) return;
  root.innerHTML = `${headHTML(`Поиск: «${r.q}»`, `${data.total} ${plural(data.total, ["тема", "темы", "тем"])}`, [{ label: "Поиск" }])}
    ${toolbarHTML({ q: r.q })}
    ${data.items.length ? `<ul class="fr-list glass">${data.items.map((t) => threadRowHTML(t, { showSection: true })).join("")}</ul>`
      : `<div class="empty"><span class="empty-icon">🔍</span><p>Ничего не нашлось.</p></div>`}
    ${pagerHTML(data.page, data.pages, `#/q/${encodeURIComponent(r.q)}`)}`;
}

/* ---------- Тема ---------- */
let current = null; // { thread, posts }

function postHTML(p, { first = false, threadLocked = false } = {}) {
  const t = current.thread;
  return `<article class="fr-post glass${first ? " is-first" : ""}${p.author.isAdmin ? " is-admin" : ""}" id="${first ? "top" : `p-${esc(p.id)}`}" data-kind="${first ? "thread" : "post"}" data-id="${esc(first ? t.id : p.id)}">
    <aside class="fr-author">
      ${avatarHTML(p.author.nick, p.author.avatarUrl, { size: "lg" })}
      <a class="fr-nick" href="${esc(userUrl(p.author.nick))}"><b>${esc(p.author.nick)}</b></a>
      ${p.author.isAdmin ? '<span class="role-badge">admin</span>' : ""}
    </aside>
    <div class="fr-post-main">
      <header class="fr-post-head">
        <time datetime="${esc(p.createdAt)}" title="${esc(formatDate(p.createdAt))}">${esc(timeAgo(p.createdAt))}</time>
        ${p.edited ? '<span class="faint">· изменено</span>' : ""}
        <span class="spacer"></span>
        ${p.canEdit ? `<button class="link-btn" type="button" data-edit>Изменить</button><button class="link-btn fr-danger" type="button" data-delete>Удалить</button>` : ""}
      </header>
      <div class="md-body fr-body" data-md></div>
      <footer class="fr-post-foot">
        <button class="fr-like${p.myLike ? " is-on" : ""}" type="button" data-like aria-pressed="${p.myLike}" aria-label="Нравится">♥ <span>${p.likes}</span></button>
        ${!first && !threadLocked && t.canReply ? '<button class="link-btn" type="button" data-quote>Цитировать</button>' : ""}
      </footer>
    </div>
  </article>`;
}

async function renderThread(my, r) {
  const data = await api.forumThread(r.id, r.page);
  if (my !== seq) return;
  current = data;
  const t = data.thread;
  const sec = sectionOf(t.section);
  const user = getUser();
  const first = { ...t, author: t.author, likes: t.likes, myLike: t.myLike, createdAt: t.createdAt, edited: t.edited, canEdit: t.canEdit };
  root.innerHTML = `${headHTML(t.title, "", [{ label: sec?.label || t.section, href: `#/s/${t.section}` }, ...(t.project ? [{ label: projectTitle(t.project), href: `#/s/${t.section}/${encodeURIComponent(t.project)}` }] : [])])}
    <div class="fr-thread-meta">
      ${t.pinned ? '<span class="badge lime">📌 закреплено</span>' : ""}${t.locked ? '<span class="badge warn">🔒 закрыто</span>' : ""}
      ${t.project ? `<span class="badge plain">${esc(projectTitle(t.project))}</span>` : ""}
      <span class="faint">💬 ${t.replies} · 👁 ${t.views}</span>
      <span class="spacer"></span>
      ${t.canModerate ? `<button class="btn btn-ghost btn-xs" type="button" data-mod="pinned">${t.pinned ? "Открепить" : "Закрепить"}</button>
        <button class="btn btn-ghost btn-xs" type="button" data-mod="locked">${t.locked ? "Открыть" : "Закрыть"} ответы</button>` : ""}
    </div>
    ${data.posts.page === 1 ? postHTML(first, { first: true }) : `<p class="fr-back-top"><a href="#/t/${esc(t.id)}">↑ К началу темы</a></p>`}
    ${data.posts.items.length ? `<h2 class="fr-replies-title">Ответы <span class="tab-n">${t.replies}</span></h2>` : ""}
    <div class="fr-posts">${data.posts.items.map((p) => postHTML(p, { threadLocked: t.locked })).join("")}</div>
    ${pagerHTML(data.posts.page, data.posts.pages, `#/t/${encodeURIComponent(t.id)}`)}
    ${t.canReply ? `<form class="fr-reply glass" id="replyForm" novalidate>
        <div class="fr-editor-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-rmode="write">Ответ</button><button type="button" role="tab" aria-selected="false" data-rmode="preview">Предпросмотр</button></div>
        <div class="field"><textarea id="rBody" name="body" placeholder=" " rows="5" maxlength="5000" aria-describedby="rBody-err"></textarea><label for="rBody">Твой ответ</label>
          <span class="hint">Markdown поддерживается · Ctrl + Enter — отправить</span><span class="error-msg" id="rBody-err"></span></div>
        <div class="fr-preview md-body" id="rPreview" hidden></div>
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-sm" type="submit"><span>Ответить</span><span class="spinner" aria-hidden="true"></span></button>
      </form>`
      : user ? `<p class="fr-locked glass">🔒 Тема закрыта для ответов.</p>`
        : `<div class="fr-locked glass"><p>Войди, чтобы ответить в теме.</p>${loginBtn("Войди, чтобы отвечать на форуме")}</div>`}`;
  // Markdown: картинки разрешены только в сообщениях админа
  const firstEl = $(".fr-post.is-first [data-md]", root);
  if (firstEl) renderMarkdown(firstEl, t.body, { images: t.author.isAdmin });
  for (const p of data.posts.items) {
    const el = $(`#p-${CSS.escape(p.id)} [data-md]`, root);
    if (el) renderMarkdown(el, p.body, { images: p.author.isAdmin });
  }
  if (location.hash.endsWith("/last")) $(".fr-posts .fr-post:last-child", root)?.scrollIntoView({ block: "center" });
}

/* ---------- Действия ---------- */
root.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.matches("[data-search]")) {
    e.preventDefault();
    const q = form.elements.q.value.trim();
    if (q) go(`#/q/${encodeURIComponent(q)}`);
    return;
  }
  if (form.id === "replyForm") {
    e.preventDefault();
    const body = form.elements.body.value.trim();
    const err = $(".form-error", form);
    if (!body) { err.textContent = "Напиши текст ответа"; shake(form); return; }
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const r = await api.forumReply(current.thread.id, body);
      toast("Ответ опубликован");
      go(`#/t/${current.thread.id}/${r.page}`);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }
});

root.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "rBody") $("#replyForm")?.requestSubmit();
});

root.addEventListener("click", async (e) => {
  const t = e.target;
  const newBtn = t.closest("[data-new]");
  if (newBtn) return openComposer({ section: newBtn.dataset.new, project: newBtn.dataset.project || "" });
  const rmode = t.closest("[data-rmode]");
  if (rmode) return togglePreview($("#replyForm"), rmode.dataset.rmode === "preview", $("#rBody"), $("#rPreview"), "[data-rmode]");

  const post = t.closest(".fr-post");
  if (!post) {
    const mod = t.closest("[data-mod]");
    if (mod && current) {
      const key = mod.dataset.mod;
      try {
        await api.forumModerate(current.thread.id, { [key]: !current.thread[key] });
        toast("Готово");
        render();
      } catch (ex) { toast(ex.message, "error"); }
    }
    return;
  }
  const kind = post.dataset.kind;
  const id = post.dataset.id;
  if (t.closest("[data-like]")) {
    if (!getUser()) return openAuth("login", "Войди, чтобы ставить лайки");
    const b = t.closest("[data-like]");
    try {
      const r = await api.forumLike(kind, id);
      b.classList.toggle("is-on", r.myLike);
      b.setAttribute("aria-pressed", String(r.myLike));
      $("span", b).textContent = r.likes;
    } catch (ex) { toast(ex.message, "error"); }
    return;
  }
  if (t.closest("[data-quote]")) {
    const src = current.posts.items.find((p) => p.id === id);
    const ta = $("#rBody");
    if (src && ta) {
      ta.value = `${ta.value ? ta.value + "\n\n" : ""}> **${src.author.nick}:** ${src.body.split("\n").slice(0, 6).join("\n> ")}\n\n`;
      ta.focus();
      ta.scrollIntoView({ block: "center" });
    }
    return;
  }
  if (t.closest("[data-edit]")) {
    const body = kind === "thread" ? current.thread.body : current.posts.items.find((p) => p.id === id)?.body;
    return openComposer({ edit: { kind, id, title: kind === "thread" ? current.thread.title : undefined, body } });
  }
  if (t.closest("[data-delete]")) {
    if (!confirm(kind === "thread" ? "Удалить тему вместе со всеми ответами?" : "Удалить это сообщение?")) return;
    try {
      await api.forumDelete(kind, id);
      toast("Удалено");
      overview = null;
      if (kind === "thread") go(`#/s/${current.thread.section}`);
      else render();
    } catch (ex) { toast(ex.message, "error"); }
  }
});

async function togglePreview(form, preview, textarea, box, tabSel) {
  $$(tabSel, form).forEach((b) => b.setAttribute("aria-selected", String((b.dataset.rmode || b.dataset.mode) === (preview ? "preview" : "write"))));
  textarea.closest(".field").hidden = preview;
  box.hidden = !preview;
  if (preview) {
    box.textContent = "…";
    await renderMarkdown(box, textarea.value.trim() || "_Пусто_", { images: getUser()?.role === "admin" });
  }
}

/* ---------- Окно новой темы / редактирования ---------- */
const dlg = $("#composer");
const cform = $("#cmpForm");
const composer = setupModal(dlg);
let editing = null;

$("#cProject").innerHTML = `<option value="">— без проекта —</option>${PROJECTS.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join("")}`;

function openComposer({ section = "", project = "", edit = null } = {}) {
  if (!getUser()) return openAuth("login", "Войди, чтобы создавать темы");
  editing = edit;
  cform.reset();
  $$(".field", cform).forEach((f) => f.classList.remove("invalid"));
  $$(".error-msg", cform).forEach((m) => { m.textContent = ""; });
  $(".form-error", cform).textContent = "";
  togglePreview(cform, false, $("#cBody"), $("#cPreview"), "[data-mode]");
  const allowed = overview.sections.filter((s) => s.canPost);
  $("#cSection").innerHTML = allowed.map((s) => `<option value="${esc(s.id)}">${ICONS[s.id] || ""} ${esc(s.label)}</option>`).join("");
  $("#cmpMeta").hidden = !!edit;
  $("#cTitleField").hidden = !!edit && edit.kind !== "thread";
  $("#cmpTitle").textContent = edit ? (edit.kind === "thread" ? "Редактировать тему" : "Редактировать сообщение") : "Новая тема";
  $("#cSubmitText").textContent = edit ? "Сохранить" : "Опубликовать";
  if (edit) {
    $("#cTitle").value = edit.title || "";
    $("#cBody").value = edit.body || "";
  } else {
    if (allowed.some((s) => s.id === section)) $("#cSection").value = section;
    $("#cProject").value = project;
  }
  $("#cBody").maxLength = edit?.kind === "post" ? 5000 : 10000;
  syncTemplateBtn();
  preloadMarkdown();
  composer.open();
  (edit && edit.kind === "post" ? $("#cBody") : $("#cTitle")).focus();
}

// Заготовка правил для админа — правится под конкретный проект перед публикацией
const RULES_TEMPLATE = `## Общие правила

1. **Уважай других игроков.** Без оскорблений, травли и дискриминации.
2. **Без читов и багоюза.** Нашёл баг — напиши в раздел «Вопросы и помощь».
3. **Гриферство запрещено.** Не ломай и не воруй чужие постройки.
4. **Без рекламы** других серверов и проектов.
5. **Решение модерации — финальное.** Не согласен — обсуди спокойно в личке.

## Наказания

| Нарушение | Наказание |
|---|---|
| Первое предупреждение | устное |
| Повторное | мут / кик |
| Гриф, читы | бан |

## Как зайти

- IP: \`…\`
- Версия: …
- Заявка в вайтлист — в [личном кабинете](profile.html#settings).
`;

function syncTemplateBtn() {
  $("#cTemplate").hidden = !!editing || $("#cSection").value !== "rules";
}

cform.addEventListener("change", (e) => { if (e.target.id === "cSection") syncTemplateBtn(); });

cform.addEventListener("click", (e) => {
  const m = e.target.closest("[data-mode]");
  if (m) togglePreview(cform, m.dataset.mode === "preview", $("#cBody"), $("#cPreview"), "[data-mode]");
  if (e.target.closest("#cTemplate")) {
    const ta = $("#cBody");
    if (ta.value.trim() && !confirm("Заменить текст шаблоном?")) return;
    ta.value = RULES_TEMPLATE;
    if (!$("#cTitle").value) $("#cTitle").value = `Правила ${$("#cProject").selectedOptions[0]?.value ? $("#cProject").selectedOptions[0].textContent : "проекта"}`;
    ta.focus();
  }
});

cform.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $('button[type="submit"]', cform);
  const err = $(".form-error", cform);
  const title = $("#cTitle").value.trim();
  const body = $("#cBody").value.trim();
  const errors = {};
  if ((!editing || editing.kind === "thread") && (title.length < 3 || title.length > 120)) errors.title = "Заголовок от 3 до 120 символов";
  if (!body) errors.body = "Напиши текст";
  err.textContent = "";
  for (const [name, msg] of Object.entries(errors)) {
    const f = cform.elements[name].closest(".field");
    f.classList.add("invalid");
    $(".error-msg", f).textContent = msg;
  }
  if (Object.keys(errors).length) { shake($(".modal-card", dlg)); return; }
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    if (editing) {
      await api.forumEdit(editing.kind, editing.id, { title: editing.kind === "thread" ? title : undefined, body });
      toast("Сохранено");
      composer.close();
      render();
    } else {
      const r = await api.forumCreateThread({ section: $("#cSection").value, project: $("#cProject").value, title, body });
      toast("Тема создана 🎉");
      composer.close();
      overview = null;
      go(`#/t/${r.id}`);
    }
  } catch (ex) {
    err.textContent = ex.message;
    if (ex.fields) for (const [name, msg] of Object.entries(ex.fields)) {
      const el = cform.elements[name];
      if (el) { el.closest(".field").classList.add("invalid"); $(".error-msg", el.closest(".field")).textContent = msg; }
    }
    shake($(".modal-card", dlg));
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
});

render();

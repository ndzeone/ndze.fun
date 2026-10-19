// Админка: сводка (api.stats), очереди «Работы ждут оценки» и «Новые задания»,
// быстрые ссылки и режим данных. Не-админу — экран «закрыто».
import { mountLayout, onUserChange, openAuth } from "../core/layout.js";
import { api, toApiError } from "../data/api.js";
import { SITE } from "../config.js";
import { GAMES, TASK_STATUSES, SUB_STATUSES, CATEGORIES, DIFFICULTIES, byId } from "../data/constants.js";
import { initTilt, initMagnetic } from "../core/fx.js";
import { $, $$, esc, plural, timeAgo, toast, motion, wait } from "../core/util.js";

const user = await mountLayout("admin");
const root = $("#adminRoot");
const QUEUE_LIMIT = 6;

/* ---------- Пиксельные иконки (свои, без логотипов) ---------- */
function pixelSvg(rows, pal) {
  const w = Math.max(...rows.map((r) => r.length));
  let rects = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      if (!pal[c]) { x++; continue; }
      let n = 1;
      while (row[x + n] === c) n++;
      rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${pal[c]}"/>`;
      x += n;
    }
  });
  return `<svg viewBox="0 0 ${w} ${rows.length}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`;
}
const C = { a: "currentColor" };
const ICONS = {
  lock: pixelSvg([
    "...aaaa...",
    "..a....a..",
    ".a......a.",
    ".a......a.",
    "aaaaaaaaaa",
    "aaaabbaaaa",
    "aaaabbaaaa",
    "aaaaabaaaa",
    "aaaaaaaaaa",
    "aaaaaaaaaa",
  ], { a: "#5dd62c", b: "#0f0f0f" }),
  live: pixelSvg([
    "..a...a..",
    "...a.a...",
    "aaaaaaaaa",
    "a.......a",
    "a..aa...a",
    "a..aaa..a",
    "a..aa...a",
    "a.......a",
    "aaaaaaaaa",
  ], C),
  play: pixelSvg([
    ".aaaaaaaaa.",
    "aaaa.aaaaaa",
    "aaaa..aaaaa",
    "aaaa...aaaa",
    "aaaa..aaaaa",
    "aaaa.aaaaaa",
    ".aaaaaaaaa.",
  ], C),
  code: pixelSvg([
    "..a.....a..",
    ".a...a...a.",
    "a...a.....a",
    ".a.a.....a.",
    "..a.....a..",
  ], C),
  car: pixelSvg([
    "...aaaaa...",
    "..a..a..a..",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    ".aa.....aa.",
  ], C),
  users: pixelSvg([
    "..aa....bb..",
    ".aaaa..bbbb.",
    ".aaaa..bbbb.",
    "..aa....bb..",
    ".aaaa..bbbb.",
    "aaaaaabbbbbb",
    "aaaaaabbbbbb",
  ], { a: "currentColor", b: "currentColor" }),
  img: pixelSvg([
    "aaaaaaaaaa",
    "a........a",
    "a.bb.....a",
    "a.bb..a..a",
    "a....aaa.a",
    "a..aaaaaaa",
    "a.aaaaaaaa",
    "aaaaaaaaaa",
  ], { a: "currentColor", b: "currentColor" }),
  task: pixelSvg([
    "aaaaaaaa",
    "a......a",
    "a.aaaa.a",
    "a......a",
    "a.aaa..a",
    "a......a",
    "a.aaaa.a",
    "aaaaaaaa",
  ], C),
};

/* ---------- Помощники ---------- */
const safeImg = (url) => (/^(https?:|data:image\/|blob:)/i.test(String(url || "")) ? url : "");
const gameOf = (id) => byId(GAMES, id) || { id, label: id, short: "?", color: "#f8f8f8" };

function countUp(el, to, from = 0) {
  to = Number(to) || 0;
  if (!motion || to === from) { el.textContent = String(to); return; }
  const dur = Math.min(1200, 500 + Math.abs(to - from) * 40);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- Экран «закрыто» ---------- */
function renderLocked(u) {
  const guest = !u;
  root.innerHTML = `
  <section class="locked glass" aria-labelledby="lockedTitle">
    <div class="lock-icon">${ICONS.lock}</div>
    <h2 id="lockedTitle">${guest ? "Закрыто" : "Доступ только для ndze"}</h2>
    <p class="muted">${guest
      ? "Это пульт управления сайтом. Войди в аккаунт владельца, чтобы открыть панель."
      : `Ты вошёл как <b>${esc(u.nick)}</b>. Эта страница — пульт управления стримера, у обычных аккаунтов сюда доступа нет.`}</p>
    <div class="locked-actions">
      ${guest
        ? '<button class="btn btn-primary magnetic" type="button" data-login>Войти</button>'
        : '<a class="btn btn-primary" href="tasks.html">Задания на стрим</a><a class="btn btn-ghost" href="review.html">Мои работы</a>'}
    </div>
  </section>`;
  initMagnetic(root);
}

root.addEventListener("click", (e) => {
  if (e.target.closest("[data-login]")) openAuth("login", "Админка доступна только владельцу сайта");
});

/* ---------- Дашборд ---------- */
function shell() {
  const local = api.mode !== "php";
  return `
  <section class="admin-block" aria-labelledby="statsTitle">
    <div class="section-head">
      <span class="section-index">01</span><h2 id="statsTitle">Сводка</h2><span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-refresh>↻ Обновить</button>
    </div>
    <div class="tiles" id="tiles"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
    <div class="breakdowns" id="breakdowns"></div>
  </section>

  <section class="admin-block queues" aria-label="Очереди">
    <article class="queue glass" aria-labelledby="qSubsTitle">
      <header class="queue-head">
        <span class="queue-icon tone-info">${ICONS.img}</span>
        <h2 id="qSubsTitle">Работы ждут оценки</h2>
        <span class="badge info plain" id="qSubsCount">…</span>
      </header>
      <ul class="queue-list" id="qSubs"><li class="skeleton q-skel"></li><li class="skeleton q-skel"></li></ul>
      <a class="queue-more" href="review.html">Все работы <span aria-hidden="true">→</span></a>
    </article>
    <article class="queue glass" aria-labelledby="qTasksTitle">
      <header class="queue-head">
        <span class="queue-icon tone-lime">${ICONS.task}</span>
        <h2 id="qTasksTitle">Новые задания</h2>
        <span class="badge lime plain" id="qTasksCount">…</span>
      </header>
      <ul class="queue-list" id="qTasks"><li class="skeleton q-skel"></li><li class="skeleton q-skel"></li></ul>
      <a class="queue-more" href="tasks.html?status=new">Все новые задания <span aria-hidden="true">→</span></a>
    </article>
  </section>

  <section class="admin-block" aria-labelledby="linksTitle">
    <div class="section-head"><span class="section-index">02</span><h2 id="linksTitle">Быстрые ссылки</h2></div>
    <div class="links-grid">
      <div class="quick-links">
        ${[
          { icon: ICONS.live, label: "Twitch-канал", sub: `twitch.tv/${SITE.twitch.channel}`, url: SITE.twitch.url, color: "#b48cff" },
          { icon: ICONS.play, label: "YouTube", sub: SITE.youtube.handle, url: SITE.youtube.url, color: "#ff5d5d" },
          { icon: ICONS.code, label: "GitHub", sub: `github.com/${SITE.github.user}`, url: SITE.github.url, color: "#f8f8f8" },
          { icon: ICONS.car, label: "NovaRP", sub: "novarp.ru · GTA 5 RP", url: SITE.novarp.url, color: "#4aa8ff" },
        ].map((l, i) => `
        <a class="qlink card" href="${esc(l.url)}" target="_blank" rel="noopener" style="--accent:${l.color};--i:${i}">
          <span class="qlink-icon">${l.icon}</span>
          <span class="qlink-text"><b>${esc(l.label)}</b><span>${esc(l.sub)}</span></span>
          <span class="qlink-arrow" aria-hidden="true">↗</span>
        </a>`).join("")}
      </div>
      <div class="info-cards">
        <article class="info-card glass">
          <h3>Режим данных</h3>
          <p class="mode-line">
            <span class="badge ${local ? "warn" : "lime"}">${local ? "Демо · local" : "MySQL · хостинг"}</span>
          </p>
          <p class="muted">${local
            ? "Это локальный просмотр: аккаунты, работы и задания хранятся только в IndexedDB этого браузера. На ndze.fun сайт работает с базой MySQL на хостинге."
            : "Сайт подключён к базе MySQL на хостинге Timeweb: данные общие для всех посетителей, права проверяет сервер (api/)."}</p>
        </article>
        <article class="info-card glass">
          <h3>Как обновить список репозиториев</h3>
          <ol class="steps">
            <li>Запусти <code>tools/sync-github.bat</code> (двойной клик).</li>
            <li>Скрипт заберёт репозитории <code>${esc(SITE.github.user)}</code> и сохранит снимок в <code>data/repos.json</code>.</li>
            <li>Обнови страницу «Проекты» — список подтянется сам.</li>
          </ol>
        </article>
      </div>
    </div>
  </section>`;
}

function tile({ label, value, sub, tone, icon, i }) {
  return `
  <article class="stat-tile card tone-${tone}" style="--i:${i}">
    <span class="stat-icon">${icon}</span>
    <span class="stat-label">${esc(label)}</span>
    <b class="stat-value" data-value="${Number(value) || 0}">0</b>
    <span class="stat-sub">${sub}</span>
  </article>`;
}

function renderStats(stats) {
  const s = stats.submissions;
  const t = stats.tasks;
  $("#tiles").innerHTML = [
    tile({ label: "Пользователи", value: stats.users, sub: plural(stats.users, ["аккаунт", "аккаунта", "аккаунтов"]), tone: "lime", icon: ICONS.users, i: 0 }),
    tile({ label: "Ждут оценки", value: s.pending, sub: `из ${s.total} ${plural(s.total, ["работы", "работ", "работ"])}`, tone: "info", icon: ICONS.img, i: 1 }),
    tile({ label: "Новые задания", value: t.new, sub: `из ${t.total} ${plural(t.total, ["задания", "заданий", "заданий"])}`, tone: "warn", icon: ICONS.task, i: 2 }),
    tile({ label: "На стриме", value: t.live, sub: t.live ? "прямо сейчас" : "сейчас ничего", tone: "live", icon: ICONS.live, i: 3 }),
  ].join("");

  const breakdown = (title, total, list, data, href) => `
  <article class="breakdown glass">
    <header><h3>${esc(title)}</h3><a href="${href}" class="faint">всего <b data-value="${total}">0</b></a></header>
    <div class="bar" role="img" aria-label="${esc(title)}: ${list.map((x) => `${x.label} — ${data[x.id] || 0}`).join(", ")}">
      ${total ? list.map((x) => (data[x.id] ? `<i class="seg tone-${x.tone}" style="flex-grow:${data[x.id]}"></i>` : "")).join("") : '<i class="seg empty-seg"></i>'}
    </div>
    <ul class="legend">
      ${list.map((x) => `<li><span class="dot tone-${x.tone}"></span>${esc(x.label)}<b data-value="${data[x.id] || 0}">0</b></li>`).join("")}
    </ul>
  </article>`;
  $("#breakdowns").innerHTML =
    breakdown("Работы на оценку", s.total, SUB_STATUSES, s, "review.html") +
    breakdown("Задания на стрим", t.total, TASK_STATUSES, t, "tasks.html");

  for (const el of $$("[data-value]", root)) countUp(el, el.dataset.value, Number(el.dataset.shown) || 0);
  for (const el of $$("[data-value]", root)) el.dataset.shown = el.dataset.value;
}

function renderSubs(subs) {
  const pending = subs.filter((s) => s.status === "pending");
  $("#qSubsCount").textContent = String(pending.length);
  const box = $("#qSubs");
  if (!pending.length) {
    box.innerHTML = '<li class="queue-empty"><span aria-hidden="true">✓</span> Все работы оценены — очередь пуста.</li>';
    return;
  }
  box.innerHTML = pending.slice(0, QUEUE_LIMIT).map((s) => {
    const v = s.versions?.[s.versions.length - 1];
    const img = safeImg(v?.imageUrls?.[0]);
    const href = `review.html#sub=${encodeURIComponent(s.id)}`;
    const cat = byId(CATEGORIES, s.category)?.label || "";
    return `<li class="q-item">
      <a class="q-thumb" href="${esc(href)}" tabindex="-1" aria-hidden="true">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ICONS.img}</a>
      <div class="q-body">
        <a class="q-title" href="${esc(href)}">${esc(s.title)}</a>
        <span class="q-meta"><b>${esc(s.authorNick)}</b> · <time datetime="${esc(s.updatedAt)}">${esc(timeAgo(s.updatedAt))}</time>${cat ? ` · ${esc(cat)}` : ""}${v && v.n > 1 ? ` · <span class="v-tag">v${v.n}</span>` : ""}</span>
      </div>
      <a class="btn btn-ghost btn-xs" href="${esc(href)}">Оценить</a>
    </li>`;
  }).join("") + (pending.length > QUEUE_LIMIT ? `<li class="queue-rest">и ещё ${pending.length - QUEUE_LIMIT} ${plural(pending.length - QUEUE_LIMIT, ["работа", "работы", "работ"])}</li>` : "");
}

let newTasks = [];
function renderTasks() {
  $("#qTasksCount").textContent = String(newTasks.length);
  const box = $("#qTasks");
  if (!newTasks.length) {
    box.innerHTML = '<li class="queue-empty"><span aria-hidden="true">✓</span> Новых заданий нет — всё разобрано.</li>';
    return;
  }
  box.innerHTML = newTasks.slice(0, QUEUE_LIMIT).map((t) => {
    const g = gameOf(t.game);
    const d = byId(DIFFICULTIES, Number(t.difficulty));
    const href = `tasks.html#task=${encodeURIComponent(t.id)}`;
    return `<li class="q-item" data-id="${esc(t.id)}" style="--game:${esc(g.color)}">
      <span class="q-game" title="${esc(g.label)}">${esc(g.short)}</span>
      <div class="q-body">
        <a class="q-title" href="${esc(href)}">${esc(t.title)}</a>
        <span class="q-meta"><b>${esc(t.authorNick)}</b> · ${esc(timeAgo(t.createdAt))} · ▲ ${t.votes}${d ? ` · ${esc(d.label)}` : ""}</span>
      </div>
      <div class="q-actions">
        <button class="btn btn-primary btn-xs" type="button" data-task-act="accepted" aria-label="Принять: ${esc(t.title)}">Принять</button>
        <button class="btn btn-danger btn-xs" type="button" data-task-act="rejected" aria-label="Отклонить: ${esc(t.title)}">Отклонить</button>
      </div>
    </li>`;
  }).join("") + (newTasks.length > QUEUE_LIMIT ? `<li class="queue-rest">и ещё ${newTasks.length - QUEUE_LIMIT} в очереди</li>` : "");
}

function sectionError(sel, countSel, err) {
  $(countSel).textContent = "!";
  $(sel).innerHTML = `<li class="queue-empty is-error">⚠ ${esc(toApiError(err).message)}</li>`;
}

async function refreshStats() {
  try {
    renderStats(await api.stats());
  } catch (err) {
    $("#tiles").innerHTML = `<p class="empty">⚠ ${esc(toApiError(err).message)}</p>`;
  }
}

let session = 0;
async function renderDashboard() {
  const my = ++session;
  root.innerHTML = shell();
  initTilt($(".quick-links", root), ".qlink", { maxX: 6, maxY: 8 });
  initTilt($("#tiles"), ".stat-tile", { maxX: 6, maxY: 8 });
  initMagnetic(root);
  const [stats, subs, tasks] = await Promise.allSettled([
    api.stats(),
    api.listSubmissions({ scope: "all" }),
    api.listTasks({ status: "new" }),
  ]);
  if (my !== session) return;
  if (stats.status === "fulfilled") renderStats(stats.value);
  else $("#tiles").innerHTML = `<p class="empty">⚠ ${esc(toApiError(stats.reason).message)}</p>`;
  if (subs.status === "fulfilled") renderSubs(subs.value);
  else sectionError("#qSubs", "#qSubsCount", subs.reason);
  if (tasks.status === "fulfilled") {
    newTasks = [...tasks.value].sort((a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt));
    renderTasks();
  } else sectionError("#qTasks", "#qTasksCount", tasks.reason);
}

root.addEventListener("click", async (e) => {
  if (e.target.closest("[data-refresh]")) {
    renderDashboard();
    return;
  }
  const btn = e.target.closest("[data-task-act]");
  if (!btn) return;
  const item = btn.closest(".q-item");
  const id = item.dataset.id;
  const status = btn.dataset.taskAct;
  $$("button", item).forEach((b) => { b.disabled = true; });
  try {
    await api.updateTask(id, { status });
    toast(status === "accepted" ? "Задание принято ✓" : "Задание отклонено");
    if (motion) {
      item.classList.add("is-leaving");
      await wait(320);
    }
    const next = item.nextElementSibling?.querySelector("[data-task-act]") || item.previousElementSibling?.querySelector("[data-task-act]");
    newTasks = newTasks.filter((t) => t.id !== id);
    const nextId = next?.closest(".q-item")?.dataset.id;
    renderTasks();
    const focusTarget = nextId ? $(`.q-item[data-id="${CSS.escape(nextId)}"] [data-task-act]`, root) : $("#qTasksTitle");
    if (focusTarget && !nextId) focusTarget.setAttribute("tabindex", "-1");
    focusTarget?.focus({ preventScroll: true });
    refreshStats();
  } catch (err) {
    $$("button", item).forEach((b) => { b.disabled = false; });
    toast(toApiError(err).message, "error");
  }
});

/* ---------- Старт ---------- */
function render(u) {
  session++;
  if (u?.role === "admin") renderDashboard();
  else renderLocked(u);
}
render(user);
onUserChange(render);

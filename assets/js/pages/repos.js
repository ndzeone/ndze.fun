// Страница «Проекты»: профиль GitHub, статистика, фильтры и сетка репозиториев.
// Фильтры живут в адресе (?q=&vis=&lang=&sort=), так что ссылкой можно поделиться.
import { mountLayout } from "../core/layout.js";
import { loadRepos } from "../data/github.js";
import { initTilt, initMagnetic } from "../core/fx.js";
import { repoCardHTML, langColor } from "../core/repo-card.js";
import { $, $$, esc, plural, timeAgo, formatDate, motion } from "../core/util.js";
import { SITE } from "../config.js";

await mountLayout("repos");

const grid = $("#grid");
const toolbar = $("#toolbar");
const qInput = $("#q");
const sortSel = $("#sort");
const VIS = ["all", "public", "private"];
const SORTS = ["updated", "stars", "name"];

const state = readUrl();
let data = null; // { user, repos, source, generatedAt }

/* ---------- Адрес ⇄ состояние ---------- */
function readUrl() {
  const p = new URLSearchParams(location.search);
  return {
    q: (p.get("q") || "").slice(0, 100),
    vis: VIS.includes(p.get("vis")) ? p.get("vis") : "all",
    lang: p.get("lang") || "",
    sort: SORTS.includes(p.get("sort")) ? p.get("sort") : "updated",
  };
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.vis !== "all") p.set("vis", state.vis);
  if (state.lang) p.set("lang", state.lang);
  if (state.sort !== "updated") p.set("sort", state.sort);
  const qs = p.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
}

/* ---------- Отрисовка ---------- */
const time = (r) => new Date(r.pushedAt || r.updatedAt || 0).getTime();
const SORTERS = {
  updated: (a, b) => time(b) - time(a),
  stars: (a, b) => b.stars - a.stars || time(b) - time(a),
  name: (a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base", numeric: true }),
};

function filtered() {
  const q = state.q.trim().toLowerCase();
  return data.repos
    .filter((r) => state.vis === "all" || (state.vis === "private" ? r.private : !r.private))
    .filter((r) => !state.lang || r.language === state.lang)
    .filter((r) => !q || [r.name, r.description, r.language, ...(r.topics || [])].some((s) => String(s || "").toLowerCase().includes(q)))
    .sort(SORTERS[state.sort]);
}

function renderProfile(user) {
  const box = $("#profile");
  const u = user || {};
  const url = u.htmlUrl || SITE.github.url;
  const followers = Number(u.followers) || 0;
  box.innerHTML = `
    <div class="profile__row">
      ${u.avatarUrl
        ? `<img class="profile__avatar" src="${esc(u.avatarUrl)}" alt="" width="64" height="64" loading="lazy" decoding="async">`
        : `<span class="profile__avatar profile__avatar--empty" aria-hidden="true">${esc((u.login || SITE.nick)[0].toUpperCase())}</span>`}
      <div class="profile__who">
        <div class="profile__name">${esc(u.name || u.login || SITE.github.user)}</div>
        <div class="profile__login">@${esc(u.login || SITE.github.user)}</div>
      </div>
    </div>
    ${u.bio ? `<div class="profile__bio">${esc(u.bio)}</div>` : ""}
    <div class="profile__facts">
      <span><b>${followers}</b> ${plural(followers, ["подписчик", "подписчика", "подписчиков"])}</span>
      <span><b>${data.repos.length}</b> ${plural(data.repos.length, ["репозиторий", "репозитория", "репозиториев"])}</span>
    </div>
    <a class="btn btn-primary btn-sm magnetic profile__btn" href="${esc(url)}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
      Открыть GitHub<span class="sr-only"> (в новой вкладке)</span>
    </a>`;
  box.removeAttribute("aria-busy");
  initMagnetic(box);
}

function countUp(el, to) {
  if (!motion || to === 0) { el.textContent = String(to); return; }
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const total = data.repos.length;
  const priv = data.repos.filter((r) => r.private).length;
  const langs = new Set(data.repos.map((r) => r.language).filter(Boolean)).size;
  countUp($("#statTotal"), total);
  countUp($("#statPublic"), total - priv);
  countUp($("#statPrivate"), priv);
  countUp($("#statLangs"), langs);
  $('[data-count="all"]').textContent = total;
  $('[data-count="public"]').textContent = total - priv;
  $('[data-count="private"]').textContent = priv;

  const note = $("#repoNote");
  if (data.source === "snapshot" && data.generatedAt) {
    note.innerHTML = `<span class="pulse-dot" aria-hidden="true"></span> Список обновлён <time datetime="${esc(data.generatedAt)}">${esc(formatDate(data.generatedAt))}</time> · ${esc(timeAgo(data.generatedAt))}`;
  } else if (data.source === "snapshot") {
    note.innerHTML = `<span class="pulse-dot" aria-hidden="true"></span> Список из сохранённого снимка`;
  } else {
    note.innerHTML = `<span class="pulse-dot" aria-hidden="true"></span> Данные напрямую из GitHub — только открытые репозитории`;
  }
  note.hidden = false;
  $("#privateHint").hidden = priv > 0;
}

function renderLangChips() {
  const counts = new Map();
  for (const r of data.repos) if (r.language) counts.set(r.language, (counts.get(r.language) || 0) + 1);
  const langs = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (state.lang && !counts.has(state.lang)) state.lang = "";
  $("#langGroup").hidden = langs.length === 0;
  $("#langChips").innerHTML = [
    `<button class="chip" type="button" data-lang="" aria-pressed="${!state.lang}">Все языки</button>`,
    ...langs.map(([lang, n]) => `<button class="chip" type="button" data-lang="${esc(lang)}" aria-pressed="${state.lang === lang}">
      <i class="lang-dot" style="--lang:${esc(langColor(lang))}" aria-hidden="true"></i>${esc(lang)} <span class="count">${n}</span></button>`),
  ].join("");
}

function syncControls() {
  qInput.value = state.q;
  sortSel.value = state.sort;
  $$("[data-vis]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.vis === state.vis)));
  $$("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang)));
}

function renderGrid() {
  const list = filtered();
  const total = data.repos.length;
  $("#repoCount").textContent = list.length === total
    ? `${total} ${plural(total, ["проект", "проекта", "проектов"])}`
    : `Показано ${list.length} из ${total}`;

  if (!total) {
    grid.innerHTML = `<div class="empty"><span class="empty-icon" aria-hidden="true">🕸</span>
      <p>Репозиториев пока нет — скоро здесь что-нибудь появится.</p></div>`;
    return;
  }
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><span class="empty-icon" aria-hidden="true">🔍</span>
      <p><b>Ничего не нашлось.</b> Попробуй другой запрос или сбрось фильтры.</p>
      <button class="btn btn-ghost btn-sm" type="button" data-reset>Сбросить фильтры</button></div>`;
    return;
  }
  grid.innerHTML = list.map((r, i) => repoCardHTML(r, { index: i })).join("");
}

function update() {
  syncControls();
  writeUrl();
  renderGrid();
}

/* ---------- Состояния загрузки ---------- */
function showSkeleton() {
  grid.setAttribute("aria-busy", "true");
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(6);
}

function showError(err) {
  grid.removeAttribute("aria-busy");
  toolbar.hidden = true;
  $("#repoCount").textContent = "";
  grid.innerHTML = `<div class="empty repos-error" role="alert"><span class="empty-icon" aria-hidden="true">⚠</span>
    <p><b>Не удалось загрузить репозитории.</b><br>${esc(err?.message || "Что-то пошло не так")}</p>
    <button class="btn btn-primary btn-sm" type="button" data-retry>Попробовать ещё раз</button></div>`;
  const box = $("#profile");
  box.removeAttribute("aria-busy");
  box.innerHTML = `<div class="muted">Профиль GitHub недоступен.</div>
    <a class="btn btn-ghost btn-sm profile__btn" href="${esc(SITE.github.url)}" target="_blank" rel="noopener">Открыть GitHub</a>`;
}

async function load(retry = false) {
  showSkeleton();
  toolbar.hidden = false;
  try {
    data = await loadRepos();
  } catch (err) {
    showError(err);
    if (retry) $("[data-retry]")?.focus();
    return;
  }
  grid.removeAttribute("aria-busy");
  renderProfile(data.user);
  renderStats();
  renderLangChips();
  update();
}

/* ---------- События ---------- */
qInput.addEventListener("input", () => {
  state.q = qInput.value.slice(0, 100);
  if (data) { writeUrl(); renderGrid(); }
});
sortSel.addEventListener("change", () => {
  state.sort = sortSel.value;
  if (data) update();
});
toolbar.addEventListener("click", (e) => {
  const vis = e.target.closest("[data-vis]");
  const lang = e.target.closest("[data-lang]");
  if (vis) state.vis = vis.dataset.vis;
  else if (lang) state.lang = lang.dataset.lang;
  else return;
  if (data) update();
});
grid.addEventListener("click", (e) => {
  if (e.target.closest("[data-retry]")) load(true);
  if (e.target.closest("[data-reset]")) {
    Object.assign(state, { q: "", vis: "all", lang: "" });
    update();
    qInput.focus();
  }
});
addEventListener("popstate", () => {
  Object.assign(state, readUrl());
  if (data) update();
});

initTilt(grid, ".repo-card");
syncControls();
load();

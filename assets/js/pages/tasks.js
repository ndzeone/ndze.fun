// Задания на стрим: игры-фильтры, «сейчас на стриме», список с голосованием,
// форма «Предложить задание», быстрые действия админа.
import { mountLayout, onUserChange, openAuth, getUser } from "../core/layout.js";
import { api, toApiError } from "../data/api.js";
import { GAMES, TASK_STATUSES, DIFFICULTIES, LIMITS, byId } from "../data/constants.js";
import { checkTask } from "../data/validate.js";
import { initMagnetic, initTilt } from "../core/fx.js";
import { setupModal, shake } from "../core/modal.js";
import { $, $$, esc, plural, timeAgo, formatDate, toast, initial, motion, wait } from "../core/util.js";

await mountLayout("tasks");

/* ---------- Пиксельные эмблемы (свои рисунки, не логотипы) ---------- */
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

const EMBLEMS = {
  // блок земли с травой
  minecraft: pixelSvg([
    "GGGGGGGGGG",
    "GgGGGGgGGG",
    "GGGGgGGGGg",
    "gGdGGGdgGG",
    "DdDDgDDDdD",
    "DDDDDDdDDD",
    "DdDDDDDDDD",
    "DDDDdDDDdD",
    "DDdDDDDDDD",
    "DDDDDDdDDD",
  ], { G: "#5dd62c", g: "#337418", D: "#8a5a32", d: "#5e3a1e" }),
  // прицел
  cs2: pixelSvg([
    ".....aaa.....",
    "...aa.c.aa...",
    "..a...c...a..",
    ".a....c....a.",
    ".a.........a.",
    "a...........a",
    "accc..b..ccca",
    "a...........a",
    ".a.........a.",
    ".a....c....a.",
    "..a...c...a..",
    "...aa.c.aa...",
    ".....aaa.....",
  ], { a: "#ffb02e", c: "#f8f8f8", b: "#ff5d5d" }),
  // машина
  gta5rp: pixelSvg([
    "..............",
    "....bbbbbb....",
    "...bwwbwwwb...",
    "..bwwwbwwwwb..",
    "bbbbbbbbbbbbbb",
    "ybbbbbbbbbbbbr",
    "bbbbbbbbbbbbbb",
    ".kkk......kkk.",
    ".kgk......kgk.",
    ".kkk......kkk.",
  ], { b: "#4aa8ff", w: "#cfe9ff", y: "#ffe9a8", r: "#ff5d5d", k: "#7a7a7a", g: "#f8f8f8" }),
  all: pixelSvg([
    "GGG.OOO",
    "GGG.OOO",
    "GGG.OOO",
    ".......",
    "BBB.WWW",
    "BBB.WWW",
    "BBB.WWW",
  ], { G: "#5dd62c", O: "#ffb02e", B: "#4aa8ff", W: "#f8f8f8" }),
};
const VOTE_SVG = pixelSvg(["...a...", "..aaa..", ".aaaaa.", "aaaaaaa", "..aaa..", "..aaa.."], { a: "currentColor" });

const ALL_CARD = { id: "", label: "Все игры", short: "ALL", color: "#5dd62c" };
const gameOf = (id) => byId(GAMES, id) || { id, label: id, short: "?", color: "#f8f8f8" };
const ADMIN_ACTIONS = [
  { id: "accepted", label: "Принять" },
  { id: "live", label: "На стриме" },
  { id: "done", label: "Выполнено" },
  { id: "rejected", label: "Отклонить" },
];
const tasksWord = (n) => plural(n, ["задание", "задания", "заданий"]);

/* ---------- Состояние и URL ---------- */
const params = new URLSearchParams(location.search);
const state = {
  tasks: [],
  loaded: false,
  error: null,
  game: GAMES.some((g) => g.id === params.get("game")) ? params.get("game") : "",
  status: TASK_STATUSES.some((s) => s.id === params.get("status")) ? params.get("status") : "",
  sort: params.get("sort") === "new" ? "new" : "top",
};

function syncUrl() {
  const q = new URLSearchParams();
  if (state.game) q.set("game", state.game);
  if (state.status) q.set("status", state.status);
  if (state.sort !== "top") q.set("sort", state.sort);
  const qs = q.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

const gameGrid = $("#gameGrid");
const liveStrip = $("#liveStrip");
const liveList = $("#liveList");
const chipsBox = $("#statusChips");
const list = $("#taskList");
const resultsLive = $("#resultsLive");

/* ---------- Карточки игр ---------- */
function buildGames() {
  gameGrid.innerHTML = [ALL_CARD, ...GAMES].map((g, i) => {
    const [name, sub] = g.label.split(" · ");
    return `
    <div class="game-card${g.id ? "" : " is-all"}${g.url ? " has-link" : ""}" style="--game:${esc(g.color)};--i:${i}" data-game="${esc(g.id)}">
      <button type="button" class="game-btn" data-game="${esc(g.id)}" aria-pressed="false">
        <span class="game-emblem">${EMBLEMS[g.id || "all"] || ""}</span>
        <span class="game-name">${esc(name)}${sub ? `<span class="game-sub">${esc(sub)}</span>` : ""}</span>
        <span class="game-count"><b data-count>0</b> <span data-word>заданий</span><span class="game-live" data-live hidden><span class="live-dot" aria-hidden="true"></span>в эфире</span></span>
      </button>
      ${g.url ? `<a class="game-link" href="${esc(g.url)}" target="_blank" rel="noopener">Сервер NovaRP <span aria-hidden="true">↗</span></a>` : ""}
    </div>`;
  }).join("");
  initTilt(gameGrid, ".game-card", { maxX: 6, maxY: 8 });
}

function renderGames() {
  for (const card of $$(".game-card", gameGrid)) {
    const id = card.dataset.game;
    const mine = id ? state.tasks.filter((t) => t.game === id) : state.tasks;
    const n = mine.length;
    $("[data-count]", card).textContent = String(n);
    $("[data-word]", card).textContent = tasksWord(n);
    $("[data-live]", card).hidden = !mine.some((t) => t.status === "live");
    const active = state.game === id;
    card.classList.toggle("is-active", active);
    $(".game-btn", card).setAttribute("aria-pressed", String(active));
  }
}

gameGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".game-btn");
  if (!btn) return;
  state.game = btn.dataset.game;
  syncUrl();
  renderGames();
  renderChips();
  renderList();
});

/* ---------- Сейчас на стриме ---------- */
function renderLive() {
  const live = state.tasks.filter((t) => t.status === "live");
  liveStrip.hidden = !live.length;
  liveList.innerHTML = live.map((t) => {
    const g = gameOf(t.game);
    return `<li><a class="live-item" href="#task=${esc(t.id)}" data-task="${esc(t.id)}" style="--game:${esc(g.color)}">
      <span class="game-tag"><span class="game-tag-icon">${EMBLEMS[g.id] || ""}</span>${esc(g.short)}</span>
      <span class="live-title">${esc(t.title)}</span>
      <span class="live-votes" aria-label="${t.votes} ${plural(t.votes, ["голос", "голоса", "голосов"])}">${VOTE_SVG}${t.votes}</span>
    </a></li>`;
  }).join("");
}

liveList.addEventListener("click", (e) => {
  const a = e.target.closest("[data-task]");
  if (!a) return;
  e.preventDefault();
  history.replaceState(null, "", `${location.pathname}${location.search}#task=${a.dataset.task}`);
  focusTask(a.dataset.task);
});

/* ---------- Чипы статусов и сортировка ---------- */
function buildChips() {
  chipsBox.innerHTML = [{ id: "", label: "Все" }, ...TASK_STATUSES].map((s) =>
    `<button type="button" class="chip" data-status="${esc(s.id)}" aria-pressed="false">${s.id ? `<span class="chip-dot tone-${esc(s.tone)}" aria-hidden="true"></span>` : ""}${esc(s.label)} <span class="count" data-count>0</span></button>`,
  ).join("");
}

function renderChips() {
  const inGame = state.game ? state.tasks.filter((t) => t.game === state.game) : state.tasks;
  for (const chip of $$(".chip", chipsBox)) {
    const id = chip.dataset.status;
    $("[data-count]", chip).textContent = String(id ? inGame.filter((t) => t.status === id).length : inGame.length);
    chip.setAttribute("aria-pressed", String(state.status === id));
  }
}

chipsBox.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.status = chip.dataset.status;
  syncUrl();
  renderChips();
  renderList();
});

$("#sortSeg").addEventListener("change", (e) => {
  state.sort = e.target.value === "new" ? "new" : "top";
  syncUrl();
  renderList();
});

function syncControls() {
  $(state.sort === "new" ? "#sortNew" : "#sortTop").checked = true;
  renderGames();
  renderChips();
}

/* ---------- Список заданий ---------- */
function visibleTasks() {
  let out = state.tasks;
  if (state.game) out = out.filter((t) => t.game === state.game);
  if (state.status) out = out.filter((t) => t.status === state.status);
  out = [...out];
  if (state.sort === "new") out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else out.sort((a, b) => b.votes - a.votes || b.createdAt.localeCompare(a.createdAt));
  return out;
}

function voteLabel(t) {
  return `${t.myVote ? "Убрать голос" : "Голосовать"} — ${t.votes} ${plural(t.votes, ["голос", "голоса", "голосов"])}`;
}

function adminTools(t) {
  const id = esc(t.id);
  return `
  <div class="admin-tools" role="group" aria-label="Управление заданием">
    <div class="adm-status">
      ${ADMIN_ACTIONS.map((a) => `<button type="button" class="adm-btn" data-action="status" data-status="${a.id}" aria-pressed="${t.status === a.id}">${a.label}</button>`).join("")}
    </div>
    <details class="note-edit">
      <summary>✎ ${t.adminNote ? "Изменить заметку" : "Добавить заметку"}</summary>
      <form class="note-form" data-id="${id}">
        <label class="sr-only" for="note-${id}">Заметка ndze к заданию</label>
        <textarea id="note-${id}" name="note" rows="2" maxlength="${LIMITS.note.max}" placeholder="Например: сделаю в пятницу на стриме">${esc(t.adminNote || "")}</textarea>
        <div class="note-actions">
          <button class="btn btn-primary btn-xs" type="submit">Сохранить</button>
          ${t.adminNote ? '<button class="btn btn-ghost btn-xs" type="button" data-action="clear-note">Убрать</button>' : ""}
        </div>
      </form>
    </details>
  </div>`;
}

function taskCard(t, i, me) {
  const g = gameOf(t.game);
  const st = byId(TASK_STATUSES, t.status) || { label: t.status, tone: "plain" };
  const d = byId(DIFFICULTIES, Number(t.difficulty)) || DIFFICULTIES[0];
  const isAdmin = me?.role === "admin";
  const canDelete = isAdmin || (me && me.id === t.userId && t.status === "new");
  const id = esc(t.id);
  return `
  <article class="task-card${t.status === "live" ? " is-live" : ""}" id="task-${id}" data-id="${id}" tabindex="-1"
    style="--game:${esc(g.color)};--i:${Math.min(i, 12)}" aria-labelledby="tt-${id}">
    <div class="task-top">
      <span class="game-tag" title="${esc(g.label)}"><span class="game-tag-icon">${EMBLEMS[g.id] || ""}</span>${esc(g.short)}<span class="sr-only"> — ${esc(g.label)}</span></span>
      <span class="badge ${esc(st.tone)}">${esc(st.label)}</span>
    </div>
    <h3 class="task-title" id="tt-${id}">${esc(t.title)}</h3>
    ${t.description ? `<p class="task-desc" id="td-${id}">${esc(t.description)}</p>
    <button class="more-btn" type="button" data-action="more" aria-expanded="false" aria-controls="td-${id}" hidden>ещё</button>` : ""}
    <p class="diff diff-${d.id}"><span class="diff-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Сложность: </span>${esc(d.label)}</p>
    ${t.adminNote ? `<p class="note-bubble"><b>ndze:</b> ${esc(t.adminNote)}</p>` : ""}
    ${isAdmin ? adminTools(t) : ""}
    <footer class="task-foot">
      <span class="avatar sm" aria-hidden="true">${esc(initial(t.authorNick))}</span>
      <span class="task-author"><b>${esc(t.authorNick)}</b><time datetime="${esc(t.createdAt)}" title="${esc(formatDate(t.createdAt))}">${esc(timeAgo(t.createdAt))}</time></span>
      ${canDelete ? '<button class="btn btn-danger btn-xs del-btn" type="button" data-action="delete">Удалить</button>' : ""}
      <button class="vote-btn" type="button" data-action="vote" aria-pressed="${t.myVote}" aria-label="${esc(voteLabel(t))}">${VOTE_SVG}<span class="vote-n">${t.votes}</span></button>
    </footer>
  </article>`;
}

function emptyHTML(icon, title, text, action) {
  return `<div class="empty tasks-empty"><span class="empty-icon" aria-hidden="true">${icon}</span>
    <b class="empty-title">${title}</b><p>${text}</p>${action || ""}</div>`;
}

function renderList({ animate = true } = {}) {
  if (!state.loaded) return;
  list.setAttribute("aria-busy", "false");
  const game = state.game ? gameOf(state.game) : null;
  $("#boardTitle").textContent = game ? `Задания · ${game.label.split(" · ")[0]}` : "Все задания";

  if (state.error) {
    list.innerHTML = emptyHTML("⚠", "Не удалось загрузить задания", esc(state.error.message),
      '<button class="btn btn-ghost btn-sm" type="button" data-action="retry">Попробовать ещё раз</button>');
    resultsLive.textContent = "Ошибка загрузки";
    return;
  }
  if (!state.tasks.length) {
    list.innerHTML = emptyHTML(EMBLEMS.all, "Пока ни одного задания",
      "Будь первым — предложи челлендж, а зрители проголосуют.",
      '<button class="btn btn-primary btn-sm" type="button" data-action="suggest">Предложить задание</button>');
    resultsLive.textContent = "Заданий пока нет";
    return;
  }
  const items = visibleTasks();
  if (!items.length) {
    list.innerHTML = emptyHTML("🕸", "Здесь пусто",
      "С такими фильтрами заданий нет. Попробуй другую игру или статус — или предложи своё.",
      '<div class="empty-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="reset">Сбросить фильтры</button><button class="btn btn-primary btn-sm" type="button" data-action="suggest">Предложить задание</button></div>');
    resultsLive.textContent = "Ничего не найдено";
    return;
  }
  const me = getUser();
  list.classList.toggle("animate", animate && motion);
  list.innerHTML = items.map((t, i) => taskCard(t, i, me)).join("");
  measureClamps();
  resultsLive.textContent = `Показано ${items.length} ${tasksWord(items.length)}`;
}

function measureClamps(scope = list) {
  for (const p of $$(".task-desc", scope)) {
    const btn = p.nextElementSibling;
    if (!btn || p.classList.contains("is-open")) continue;
    btn.hidden = p.scrollHeight <= p.clientHeight + 2;
  }
}
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => measureClamps(), 150);
});
document.fonts?.ready.then(() => measureClamps());

function renderAll(opts) {
  renderGames();
  renderLive();
  renderChips();
  renderList(opts);
}

/** Перерисовать, сохранив фокус на том же элементе карточки. */
function rerenderKeepFocus() {
  const a = document.activeElement;
  const card = a?.closest?.(".task-card");
  const memo = card ? { id: card.dataset.id, action: a.dataset.action, status: a.dataset.status } : null;
  renderAll({ animate: false });
  if (!memo) return;
  const next = document.getElementById(`task-${memo.id}`);
  if (!next) return;
  const sel = memo.action ? `[data-action="${memo.action}"]${memo.status ? `[data-status="${memo.status}"]` : ""}` : "";
  ((sel && $(sel, next)) || next).focus({ preventScroll: true });
}

async function load() {
  try {
    state.tasks = await api.listTasks();
    state.error = null;
  } catch (err) {
    state.error = toApiError(err);
  }
  state.loaded = true;
  renderAll();
}

/* ---------- Действия на карточках ---------- */
const findTask = (id) => state.tasks.find((t) => t.id === id);
const busy = new Set();

function paintVote(card, t, pop = false) {
  const btn = $(".vote-btn", card);
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(t.myVote));
  btn.setAttribute("aria-label", voteLabel(t));
  $(".vote-n", btn).textContent = String(t.votes);
  if (pop && motion) {
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
  }
}

async function vote(card, t) {
  if (!getUser()) return openAuth("login", "Войди, чтобы голосовать за задания");
  if (busy.has(`v${t.id}`)) return;
  busy.add(`v${t.id}`);
  const prev = { votes: t.votes, myVote: t.myVote };
  t.myVote = !prev.myVote;
  t.votes = Math.max(0, prev.votes + (t.myVote ? 1 : -1));
  paintVote(card, t, true);
  try {
    const r = await api.toggleVote(t.id);
    t.votes = r.votes;
    t.myVote = r.myVote;
  } catch (err) {
    Object.assign(t, prev);
    toast(toApiError(err).message, "error");
  } finally {
    busy.delete(`v${t.id}`);
  }
  paintVote(card, t);
  renderLive();
}

async function removeTask(card, t, btn) {
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Точно удалить?";
    clearTimeout(btn._timer);
    btn._timer = setTimeout(() => {
      btn.dataset.confirm = "";
      btn.textContent = "Удалить";
    }, 3500);
    return;
  }
  clearTimeout(btn._timer);
  btn.disabled = true;
  try {
    await api.deleteTask(t.id);
    if (motion) {
      card.classList.add("is-removing");
      await wait(320);
    }
    state.tasks = state.tasks.filter((x) => x.id !== t.id);
    toast("Задание удалено");
    renderAll({ animate: false });
  } catch (err) {
    btn.disabled = false;
    btn.dataset.confirm = "";
    btn.textContent = "Удалить";
    toast(toApiError(err).message, "error");
  }
}

async function patchTask(t, patch, okMsg) {
  const key = `p${t.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    const next = await api.updateTask(t.id, patch);
    Object.assign(t, next);
    toast(okMsg);
    rerenderKeepFocus();
  } catch (err) {
    toast(toApiError(err).message, "error");
  } finally {
    busy.delete(key);
  }
}

list.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "retry") { state.loaded = false; list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; load(); return; }
  if (action === "suggest") { openSuggest(); return; }
  if (action === "reset") {
    state.game = "";
    state.status = "";
    syncUrl();
    syncControls();
    renderList();
    return;
  }
  const card = btn.closest(".task-card");
  const t = card && findTask(card.dataset.id);
  if (!t) return;
  if (action === "vote") vote(card, t);
  else if (action === "delete") removeTask(card, t, btn);
  else if (action === "more") {
    const p = $(".task-desc", card);
    const open = !p.classList.contains("is-open");
    p.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "свернуть" : "ещё";
  } else if (action === "status") {
    if (t.status === btn.dataset.status) return;
    const label = byId(TASK_STATUSES, btn.dataset.status)?.label || btn.dataset.status;
    patchTask(t, { status: btn.dataset.status }, `Статус: «${label}»`);
  } else if (action === "clear-note") {
    patchTask(t, { adminNote: null }, "Заметка убрана");
  }
});

list.addEventListener("submit", (e) => {
  const form = e.target.closest(".note-form");
  if (!form) return;
  e.preventDefault();
  const t = findTask(form.dataset.id);
  if (!t) return;
  const text = form.elements.note.value.trim();
  if ([...text].length > LIMITS.note.max) return toast(`Заметка — не больше ${LIMITS.note.max} символов`, "error");
  patchTask(t, { adminNote: text || null }, text ? "Заметка сохранена" : "Заметка убрана");
});

/* ---------- Глубокая ссылка #task=<id> ---------- */
function taskIdFromHash() {
  const m = /^#task=(.+)$/.exec(location.hash);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return ""; }
}

function focusTask(id) {
  if (!id || !state.loaded) return;
  if (!findTask(id)) {
    toast("Задание не найдено — возможно, его уже удалили", "error");
    return;
  }
  let card = document.getElementById(`task-${id}`);
  if (!card) {
    state.game = "";
    state.status = "";
    syncUrl();
    syncControls();
    renderList({ animate: false });
    card = document.getElementById(`task-${id}`);
  }
  if (!card) return;
  card.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "center" });
  card.classList.remove("is-highlight");
  void card.offsetWidth;
  card.classList.add("is-highlight");
  card.focus({ preventScroll: true });
  clearTimeout(card._hl);
  card._hl = setTimeout(() => card.classList.remove("is-highlight"), 2800);
}
addEventListener("hashchange", () => focusTask(taskIdFromHash()));

/* ---------- Форма «Предложить задание» ---------- */
const dlg = $("#taskModal");
const modalCard = $(".modal-card", dlg);
const form = $("#taskForm");
const submitBtn = $('button[type="submit"]', form);
const formError = $(".form-error", form);
const counter = $("#tDesc-count");
let sending = false;
const modal = setupModal(dlg);

$("#tGameSeg").innerHTML = GAMES.map((g) =>
  `<input type="radio" name="game" id="tg-${esc(g.id)}" value="${esc(g.id)}"><label for="tg-${esc(g.id)}" style="--game:${esc(g.color)}"><span class="seg-icon">${EMBLEMS[g.id] || ""}</span>${esc(g.label)}</label>`,
).join("");
$("#tDiffSeg").innerHTML = DIFFICULTIES.map((d) =>
  `<input type="radio" name="difficulty" id="td-${d.id}" value="${d.id}"><label for="td-${d.id}" class="diff diff-${d.id}"><span class="diff-bars" aria-hidden="true"><i></i><i></i><i></i></span>${esc(d.label)}</label>`,
).join("");

function updateCounter() {
  const n = [...form.elements.description.value].length;
  const max = LIMITS.description.max;
  counter.textContent = `${n} / ${max}`;
  counter.classList.toggle("near", n > max * 0.9 && n <= max);
  counter.classList.toggle("over", n > max);
}

function clearErrors() {
  formError.textContent = "";
  for (const box of $$("[data-field]", form)) {
    box.classList.remove("invalid");
    $(".error-msg", box).textContent = "";
    $$("input, textarea", box).forEach((el) => el.removeAttribute("aria-invalid"));
  }
}

function showErrors(errors) {
  for (const [name, msg] of Object.entries(errors || {})) {
    const box = $(`[data-field="${name}"]`, form);
    if (!box) continue;
    box.classList.add("invalid");
    $(".error-msg", box).textContent = msg;
    $$("input, textarea", box).forEach((el) => el.setAttribute("aria-invalid", "true"));
  }
}

function focusFirstInvalid() {
  const box = $("[data-field].invalid", form);
  if (!box) return;
  ($("input:checked", box) || $("input, textarea", box))?.focus();
}

function openSuggest() {
  if (!getUser()) return openAuth("register", "Зарегистрируйся, чтобы предлагать задания");
  form.reset();
  clearErrors();
  modalCard.classList.remove("shake");
  submitBtn.disabled = false;
  submitBtn.classList.remove("is-loading");
  if (state.game) $(`#tg-${state.game}`).checked = true;
  updateCounter();
  modal.open();
  (state.game ? form.elements.title : $("#tGameSeg input"))?.focus();
}

$("#suggestBtn").addEventListener("click", openSuggest);

form.addEventListener("input", (e) => {
  if (e.target.name === "description") updateCounter();
  const box = e.target.closest("[data-field]");
  if (box?.classList.contains("invalid")) {
    box.classList.remove("invalid");
    $(".error-msg", box).textContent = "";
    $$("input, textarea", box).forEach((el) => el.removeAttribute("aria-invalid"));
  }
  formError.textContent = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending) return;
  clearErrors();
  const data = {
    game: form.elements.game.value,
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    difficulty: Number(form.elements.difficulty.value) || null,
  };
  const errors = checkTask(data);
  if (Object.keys(errors).length) {
    showErrors(errors);
    shake(modalCard);
    focusFirstInvalid();
    return;
  }
  sending = true;
  submitBtn.disabled = true;
  submitBtn.classList.add("is-loading");
  try {
    const created = await api.createTask(data);
    modal.close();
    toast("Задание отправлено! Зови друзей голосовать 🕷");
    if (state.game && state.game !== created.game) state.game = "";
    if (state.status && state.status !== created.status) state.status = "";
    syncUrl();
    syncControls();
    await load();
    focusTask(created.id);
  } catch (err) {
    const apiErr = toApiError(err);
    if (apiErr.code === "auth_required") {
      modal.close();
      openAuth("login", "Войди, чтобы предлагать задания");
    } else {
      showErrors(apiErr.fields);
      formError.textContent = apiErr.message;
      shake(modalCard);
      focusFirstInvalid();
    }
  } finally {
    sending = false;
    submitBtn.disabled = false;
    submitBtn.classList.remove("is-loading");
  }
});

/* ---------- Старт ---------- */
buildGames();
buildChips();
syncControls();
initMagnetic($(".tasks-head"));
initTilt(list, ".task-card", { maxX: 4, maxY: 5 });
await load();
if (taskIdFromHash()) requestAnimationFrame(() => focusTask(taskIdFromHash()));

onUserChange(() => load());

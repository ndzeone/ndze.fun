// Страница «Оценка работ»: отправка работ, очередь админа, галерея идеалов,
// карточка работы с версиями, сравнением «до/после», оценкой и комментариями.
// Карточка открывается по ссылке review.html#sub=<id> (на неё ссылается и админка).
import { mountLayout, onUserChange, openAuth } from "../core/layout.js";
import { api } from "../data/api.js";
import { SITE } from "../config.js";
import { CATEGORIES, SUB_STATUSES, LIMITS, byId } from "../data/constants.js";
import { checkSubmission, checkVersion, checkComment, checkFiles } from "../data/validate.js";
import { setupModal, shake } from "../core/modal.js";
import { initTilt } from "../core/fx.js";
import { $, $$, esc, plural, timeAgo, formatDate, formatBytes, toast, initial, clamp } from "../core/util.js";

let user = await mountLayout("review");

/* ───────────────────────── Помощники ───────────────────────── */
const isAdmin = () => user?.role === "admin";
const isOwner = (s) => !!user && s.userId === user.id;
/** Картинки показываем только из ответов api и только с безопасной схемой. */
const safeUrl = (u) => (typeof u === "string" && /^(https?:|data:image\/|blob:)/i.test(u) ? u : "");
const latest = (s) => s.versions[s.versions.length - 1];
const coverOf = (s) => safeUrl(latest(s)?.imageUrls?.[0]);
const statusOf = (id) => byId(SUB_STATUSES, id) || { id, label: id, tone: "plain" };
const catLabel = (id) => byId(CATEGORIES, id)?.label || "Другое";
const len = (s) => [...String(s ?? "")].length;
const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

const REASON_REGISTER = "Зарегистрируйся, чтобы отправить работу на оценку";
const STATUS_ACTIONS = [
  { id: "pending", label: "Ждёт оценки" },
  { id: "revision", label: "На доработку" },
  { id: "ideal", label: "Идеал" },
  { id: "rejected", label: "Отклонить" },
];

const ICON = {
  comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8v6M8 11h6"/></svg>',
};

function setBusy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle("is-loading", on);
}

/* ───────────────────────── Ошибки форм ───────────────────────── */
function fieldBox(form, name) {
  const marked = form.querySelector(`[data-field="${name}"]`);
  if (marked) return marked;
  const el = form.elements[name];
  return el instanceof Element ? el.closest(".field") : null;
}
function clearErrors(form) {
  $$(".invalid", form).forEach((b) => b.classList.remove("invalid"));
  $$(".error-msg", form).forEach((e) => { e.textContent = ""; });
  $$("[aria-invalid]", form).forEach((e) => e.removeAttribute("aria-invalid"));
  const fe = $(".form-error", form);
  if (fe) fe.textContent = "";
}
function clearFieldError(box) {
  if (!box?.classList.contains("invalid")) return;
  box.classList.remove("invalid");
  const err = $(".error-msg", box);
  if (err) err.textContent = "";
  $$("[aria-invalid]", box).forEach((e) => e.removeAttribute("aria-invalid"));
}
/** Показывает ошибки по полям; возвращает первый проблемный контрол (для фокуса). */
function showErrors(form, errors) {
  let first = null;
  for (const [name, msg] of Object.entries(errors || {})) {
    const box = fieldBox(form, name);
    if (!box) continue;
    box.classList.add("invalid");
    const err = $(".error-msg", box);
    if (err) err.textContent = msg;
    const controls = $$("input, textarea, select", box);
    controls.forEach((c) => c.setAttribute("aria-invalid", "true"));
    first ??= controls[0];
  }
  return first;
}
function bindCounter(textarea, counter, max) {
  const update = () => {
    const n = len(textarea.value);
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle("is-over", n > max);
    counter.classList.toggle("is-near", n > max * 0.9 && n <= max);
  };
  textarea.addEventListener("input", update);
  update();
  return update;
}
/** Ввод в поле с ошибкой — убираем ошибку этого поля. */
function liveClear(form) {
  const handler = (e) => {
    if (e.target.type === "file") return; // ошибки файлов ведёт сам picker
    clearFieldError(e.target.closest(".field, [data-field]"));
    const fe = $(".form-error", form);
    if (fe) fe.textContent = "";
  };
  form.addEventListener("input", handler);
  form.addEventListener("change", handler);
}

/* ───────────────────────── Выбор файлов (drag & drop) ───────────────────────── */
function createPicker(root, id) {
  const max = LIMITS.files.max;
  root.innerHTML = `
    <div class="drop">
      <input type="file" class="drop-input" id="${id}-input" accept="${LIMITS.files.types.join(",")}" multiple aria-describedby="${id}-hint ${id}-err">
      <label class="drop-label" for="${id}-input">
        <span class="drop-icon">${ICON.upload}</span>
        <b>Перетащи картинки сюда</b>
        <span>или <u>выбери файлы</u> на устройстве</span>
      </label>
    </div>
    <span class="hint" id="${id}-hint">До ${max} изображений · JPG, PNG, WEBP или GIF · до ${Math.round(LIMITS.files.maxBytes / 1048576)} МБ каждое · <span class="pick-count">0 / ${max}</span></span>
    <ul class="thumbs" aria-label="Выбранные изображения"></ul>
    <span class="error-msg" id="${id}-err" aria-live="polite"></span>`;

  const input = $(".drop-input", root);
  const drop = $(".drop", root);
  const list = $(".thumbs", root);
  const err = $(".error-msg", root);
  const count = $(".pick-count", root);
  let items = []; // { file, url }

  const setError = (msg) => {
    err.textContent = msg || "";
    root.classList.toggle("invalid", !!msg);
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  function render() {
    count.textContent = `${items.length} / ${max}`;
    list.hidden = !items.length;
    list.innerHTML = items.map((it, i) => `
      <li>
        <img src="${esc(it.url)}" alt="">
        <span class="thumb-meta">${esc(it.file.name)} · ${esc(formatBytes(it.file.size))}</span>
        <button class="thumb-x" type="button" data-remove="${i}" aria-label="Убрать «${esc(it.file.name)}»">✕</button>
      </li>`).join("");
  }

  function add(files) {
    let problem = "";
    for (const f of files) {
      if (items.some((it) => it.file.name === f.name && it.file.size === f.size && it.file.lastModified === f.lastModified)) continue;
      if (items.length >= max) { problem = `Не больше ${max} файлов — лишние пропущены`; break; }
      const bad = checkFiles([f], { required: false });
      if (bad) { problem = bad; continue; }
      items.push({ file: f, url: URL.createObjectURL(f) });
    }
    setError(problem);
    render();
  }

  function remove(i) {
    const [it] = items.splice(i, 1);
    if (it) URL.revokeObjectURL(it.url);
    setError("");
    render();
    ($(`[data-remove="${Math.min(i, items.length - 1)}"]`, list) || input).focus();
  }

  input.addEventListener("change", () => {
    add([...input.files]);
    input.value = "";
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) remove(Number(b.dataset.remove));
  });
  let depth = 0;
  drop.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; drop.classList.add("is-over"); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  drop.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.classList.remove("is-over"); } });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove("is-over");
    add([...(e.dataTransfer?.files || [])]);
  });

  render();
  return {
    get files() { return items.map((it) => it.file); },
    add,
    setError,
    focus: () => input.focus(),
    reset() {
      items.forEach((it) => URL.revokeObjectURL(it.url));
      items = [];
      setError("");
      render();
    },
  };
}

/* ───────────────────────── Состояние страницы ───────────────────────── */
const tabsEl = $("#tabs");
const panel = $("#panel");
const newSubBtn = $("#newSubBtn");

const state = {
  tab: null,
  filter: "all",
  lists: { mine: null, queue: null, gallery: null },
  errors: {},
  animate: true,
};
let loadToken = 0;
let pendingSub = null; // работа, которую хотели открыть до входа

function availableTabs() {
  const t = [];
  if (user) t.push({ id: "mine", label: "Мои работы" });
  if (isAdmin()) t.push({ id: "queue", label: "Очередь" });
  t.push({ id: "gallery", label: "Галерея идеалов" });
  return t;
}
const defaultTab = () => (isAdmin() ? "queue" : user ? "mine" : "gallery");

function tabCount(id) {
  const list = state.lists[id];
  if (!list) return "";
  return id === "queue" ? list.filter((s) => s.status === "pending").length : list.length;
}

function renderTabs() {
  const tabs = availableTabs();
  if (!tabs.some((t) => t.id === state.tab)) state.tab = defaultTab();
  tabsEl.innerHTML = tabs.map((t) => {
    const sel = t.id === state.tab;
    const n = tabCount(t.id);
    const hint = t.id === "queue" ? ` title="Ждут оценки: ${n}"` : "";
    return `<button type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="panel"
      aria-selected="${sel}" tabindex="${sel ? 0 : -1}"${hint}>
      <span>${esc(t.label)}</span>${n !== "" ? `<span class="tab-count">${n}</span>` : ""}
    </button>`;
  }).join("");
  panel.setAttribute("aria-labelledby", `tab-${state.tab}`);
}

function selectTab(id, { focus = false } = {}) {
  if (id === state.tab) return;
  state.tab = id;
  state.animate = true;
  renderTabs();
  renderPanel();
  if (focus) $(`#tab-${id}`)?.focus();
}

tabsEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) selectTab(b.dataset.tab);
});
tabsEl.addEventListener("keydown", (e) => {
  const ids = availableTabs().map((t) => t.id);
  const i = ids.indexOf(state.tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(ids[(next + ids.length) % ids.length], { focus: true });
});

/* ---------- Список ---------- */
function sortQueue(list) {
  const rank = { pending: 0, revision: 1 };
  return [...list].sort((a, b) => {
    const ra = rank[a.status] ?? 2;
    const rb = rank[b.status] ?? 2;
    if (ra !== rb) return ra - rb;
    // ждущие оценки — сначала самые старые, остальные — свежие сверху
    return ra === 0 ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt);
  });
}

function cardHTML(s, i) {
  const st = statusOf(s.status);
  const v = s.versions.length;
  const c = s.comments.length;
  const img = coverOf(s);
  return `<a class="card sub-card" href="#sub=${encodeURIComponent(s.id)}" data-id="${esc(s.id)}" style="--i:${Math.min(i, 12)}">
    <div class="sub-cover">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : '<span class="sub-noimg">нет превью</span>'}
      <span class="badge ${st.tone} sub-status">${esc(st.label)}</span>
      <span class="sub-ver" title="${v} ${plural(v, ["версия", "версии", "версий"])}">v${v}</span>
    </div>
    <div class="sub-body">
      <div class="sub-top">
        <h3 class="sub-title">${esc(s.title)}</h3>
        <span class="sub-rating${s.rating ? "" : " is-empty"}" title="Оценка ndze">
          <span class="sr-only">Оценка: </span>${s.rating ? `${s.rating}<small>/10</small>` : "—"}
        </span>
      </div>
      <p class="sub-meta"><span class="sub-author">@${esc(s.authorNick)}</span><span class="dot" aria-hidden="true"></span><span>${esc(catLabel(s.category))}</span></p>
      <p class="sub-foot">
        <span title="Комментарии">${ICON.comment}<span class="sr-only">Комментариев: </span>${c}</span>
        <span title="Версии">${ICON.layers}<span class="sr-only">Версий: </span>${v}</span>
        <time datetime="${esc(s.updatedAt)}" title="${esc(formatDate(s.updatedAt))}">${esc(timeAgo(s.updatedAt))}</time>
      </p>
    </div>
  </a>`;
}

function ctaHTML() {
  return `<div class="cta glass">
    <div class="cta-text">
      <p class="cta-kicker">Твоя работа может быть здесь</p>
      <h3>Хочешь разбор от ndze?</h3>
      <p class="muted">Зарегистрируйся, отправь работу и дорабатывай её по советам со стрима, пока она не станет идеалом и не попадёт в галерею.</p>
    </div>
    <div class="cta-actions">
      <button class="btn btn-primary" type="button" data-action="register">Зарегистрироваться</button>
      <button class="link-btn" type="button" data-action="login">Уже есть аккаунт? Войти</button>
    </div>
  </div>`;
}

function filtersHTML(list) {
  const all = list || [];
  const chip = (id, label, n) => `<button class="chip" type="button" data-filter="${id}" aria-pressed="${state.filter === id}">${esc(label)}<span class="count">${n}</span></button>`;
  return `<div class="chips queue-filters" role="group" aria-label="Фильтр по статусу">
    ${chip("all", "Все", all.length)}
    ${SUB_STATUSES.map((s) => chip(s.id, s.label, all.filter((x) => x.status === s.id).length)).join("")}
  </div>`;
}

function emptyHTML() {
  if (state.tab === "mine") {
    return `<div class="empty">
      <span class="empty-icon" aria-hidden="true">🎨</span>
      <p><b>Здесь пока пусто</b><br>Отправь первую работу — ndze разберёт её на ближайшем стриме.</p>
      <button class="btn btn-primary btn-sm" type="button" data-action="new">Отправить работу</button>
    </div>`;
  }
  if (state.tab === "queue") {
    const st = state.filter !== "all" && statusOf(state.filter);
    return `<div class="empty">
      <span class="empty-icon" aria-hidden="true">🕸</span>
      <p>${st ? `Нет работ со статусом «${esc(st.label)}».` : "<b>Очередь пуста</b><br>Новых работ нет — можно выдохнуть."}</p>
    </div>`;
  }
  return `<div class="empty">
    <span class="empty-icon" aria-hidden="true">🏆</span>
    <p><b>Галерея ждёт первый идеал</b><br>Доведи свою работу до совершенства — и она окажется здесь.</p>
  </div>`;
}

function renderPanel() {
  const tab = state.tab;
  const list = state.lists[tab];
  let html = "";
  if (tab === "gallery" && !user) html += ctaHTML();
  if (tab === "queue") html += filtersHTML(list);

  if (state.errors[tab]) {
    html += `<div class="empty"><span class="empty-icon" aria-hidden="true">⚠</span><p>${esc(state.errors[tab])}</p>
      <button class="btn btn-ghost btn-sm" type="button" data-action="retry">Попробовать ещё раз</button></div>`;
  } else if (!list) {
    html += `<div class="sub-grid" aria-busy="true">${'<div class="skeleton sub-skel"></div>'.repeat(6)}</div>`;
  } else {
    let items = list;
    if (tab === "queue") {
      items = sortQueue(state.filter === "all" ? list : list.filter((s) => s.status === state.filter));
    }
    html += items.length
      ? `<div class="sub-grid${state.animate ? " is-entering" : ""}">${items.map(cardHTML).join("")}</div>`
      : emptyHTML();
    state.animate = false;
  }
  panel.innerHTML = html;
}

panel.addEventListener("click", (e) => {
  const f = e.target.closest("[data-filter]");
  if (f) {
    state.filter = f.dataset.filter;
    state.animate = true;
    renderPanel();
    $(`[data-filter="${cssEsc(state.filter)}"]`, panel)?.focus();
    return;
  }
  const a = e.target.closest("[data-action]")?.dataset.action;
  if (a === "new") openSubmit();
  else if (a === "register") openAuth("register", REASON_REGISTER);
  else if (a === "login") openAuth("login", REASON_REGISTER);
  else if (a === "retry") loadLists({ skeleton: true });
});
initTilt(panel, ".sub-card");

async function loadLists({ skeleton = false } = {}) {
  const token = ++loadToken;
  if (skeleton) {
    state.lists = { mine: null, queue: null, gallery: null };
    state.errors = {};
    state.animate = true;
    renderPanel();
  }
  const jobs = [["gallery", "gallery"]];
  if (user) jobs.push(["mine", "mine"]);
  if (isAdmin()) jobs.push(["queue", "all"]);
  await Promise.all(jobs.map(async ([key, scope]) => {
    try {
      const list = await api.listSubmissions({ scope });
      if (token === loadToken) { state.lists[key] = list; state.errors[key] = null; }
    } catch (err) {
      if (token === loadToken) state.errors[key] = err.message;
    }
  }));
  if (token !== loadToken) return;
  renderTabs();
  renderPanel();
}
const refresh = () => loadLists();

/* ───────────────────────── Отправка работы ───────────────────────── */
const submitDlg = $("#submitModal");
const submitModal = setupModal(submitDlg);
const submitForm = $("#submitForm");
const submitCard = $(".modal-card", submitDlg);
const submitBtn = $('button[type="submit"]', submitForm);
const subPicker = createPicker($("#sPicker"), "sFiles");

$("#sCats").innerHTML = CATEGORIES.map((c) =>
  `<input type="radio" name="category" id="sCat-${c.id}" value="${c.id}"><label for="sCat-${c.id}">${esc(c.label)}</label>`).join("");
const updateDescCounter = bindCounter(submitForm.elements.description, $("#sDesc-count"), LIMITS.description.max);
liveClear(submitForm);
// Файл, брошенный мимо зоны, не должен открываться в браузере вместо страницы
for (const dlg of [submitDlg, $("#versionModal")]) {
  dlg.addEventListener("dragover", (e) => e.preventDefault());
  dlg.addEventListener("drop", (e) => e.preventDefault());
}

function openSubmit() {
  if (!user) return openAuth("register", REASON_REGISTER);
  submitCard.classList.remove("shake");
  submitModal.open();
  submitForm.elements.title.focus();
}
newSubBtn.addEventListener("click", openSubmit);

submitForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitBtn.disabled) return;
  clearErrors(submitForm);
  const f = submitForm.elements;
  const data = {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    category: f.category.value,
    files: subPicker.files,
    note: f.note.value.trim(),
  };
  const errors = checkSubmission(data);
  if (Object.keys(errors).length) {
    const first = showErrors(submitForm, errors);
    if (errors.files) subPicker.setError(errors.files);
    shake(submitCard);
    first?.focus();
    return;
  }
  setBusy(submitBtn, true);
  try {
    const sub = await api.createSubmission(data);
    toast("Работа отправлена! ndze посмотрит её на стриме 🕷");
    submitForm.reset();
    subPicker.reset();
    updateDescCounter();
    submitModal.close();
    if (state.tab !== "mine") { state.tab = "mine"; state.animate = true; }
    await refresh();
    openSub(sub.id);
  } catch (err) {
    if (err.fields) {
      showErrors(submitForm, err.fields);
      if (err.fields.files) subPicker.setError(err.fields.files);
    }
    $(".form-error", submitForm).textContent = err.message;
    shake(submitCard);
  } finally {
    setBusy(submitBtn, false);
  }
});

/* ───────────────────────── Карточка работы ───────────────────────── */
const detailDlg = $("#detailModal");
const detailCard = $("#detailCard");
const detail = { id: null, sub: null, v: 0, img: 0, a: 0, b: 0, pos: 50, confirmDelete: false, busy: false };
let returnFocusId = null;

const detailModal = setupModal(detailDlg, {
  onClose() {
    returnFocusId = detail.id;
    detail.id = null;
    detail.sub = null;
    if (hashSubId()) history.replaceState(null, "", location.pathname + location.search);
    requestAnimationFrame(() => {
      if (returnFocusId && (document.activeElement === document.body || !document.activeElement)) {
        $(`.sub-card[data-id="${cssEsc(returnFocusId)}"]`, panel)?.focus();
      }
    });
  },
});

function hashSubId() {
  const m = location.hash.match(/^#sub=([^&]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
function openSub(id) {
  const h = `#sub=${encodeURIComponent(id)}`;
  if (location.hash === h) showDetail(id);
  else location.hash = h; // → hashchange → showDetail
}
function syncHash() {
  const id = hashSubId();
  if (id) showDetail(id);
  else if (detailDlg.open) detailModal.close();
}
addEventListener("hashchange", syncHash);

function loadingHTML() {
  return `<button class="modal-close" type="button" data-close aria-label="Закрыть">✕</button>
    <h2 id="dTitle" class="sr-only">Загрузка работы…</h2>
    <div class="d-loading" aria-busy="true">
      <div class="skeleton" style="height:28px;width:40%"></div>
      <div class="skeleton" style="height:44px;width:70%"></div>
      <div class="skeleton" style="aspect-ratio:4/3;min-height:0"></div>
    </div>`;
}

async function showDetail(id, { quiet = false } = {}) {
  const same = detail.id === id && detailDlg.open && !detailDlg.classList.contains("is-closing");
  detail.id = id;
  if (!same) {
    detail.sub = null;
    detailCard.innerHTML = loadingHTML();
    detailModal.open();
  }
  try {
    const sub = await api.getSubmission(id);
    if (detail.id !== id) return;
    setDetail(sub, { fresh: !same });
  } catch (err) {
    if (detail.id !== id) return;
    detailModal.close();
    if (quiet) return; // например, вышли из аккаунта с открытой приватной работой
    if (err.code === "auth_required") {
      pendingSub = id;
      openAuth("login", "Эта работа видна только автору и ndze — войди, чтобы открыть её");
    } else {
      const msg = {
        not_found: "Работа не найдена — возможно, её удалили",
        forbidden: "Эта работа видна только автору и ndze",
      }[err.code] || err.message;
      toast(msg, "error");
    }
  }
}

function setDetail(sub, { fresh = false, toLatest = false } = {}) {
  const last = sub.versions.length - 1;
  if (fresh) {
    Object.assign(detail, { v: last, img: 0, a: Math.max(0, last - 1), b: last, pos: 50, confirmDelete: false });
  } else if (toLatest) {
    Object.assign(detail, { v: last, img: 0, a: Math.max(0, last - 1), b: last, pos: 50 });
  } else {
    detail.v = clamp(detail.v, 0, last);
    detail.a = clamp(detail.a, 0, last);
    detail.b = clamp(detail.b, 0, last);
  }
  detail.sub = sub;
  renderDetail({ fresh });
}

function versionLabel(v) {
  return `v${v.n}`;
}

function viewerHTML(s) {
  const ver = s.versions[detail.v];
  const urls = (ver?.imageUrls || []).map(safeUrl);
  detail.img = clamp(detail.img, 0, Math.max(0, urls.length - 1));
  const cur = urls[detail.img];
  const versions = s.versions.length > 1
    ? `<div class="d-versions" role="group" aria-label="Версии работы">
        ${s.versions.map((v, i) => `<button type="button" class="ver-btn" data-action="version" data-n="${i}" data-key="ver-${i}" aria-pressed="${i === detail.v}">${versionLabel(v)}${i === s.versions.length - 1 ? '<span class="ver-new">новая</span>' : ""}</button>`).join("")}
      </div>`
    : "";
  const thumbs = urls.length > 1
    ? `<div class="d-thumbs" role="group" aria-label="Изображения версии">
        ${urls.map((u, i) => `<button type="button" class="d-thumb" data-action="img" data-i="${i}" data-key="img-${i}" aria-pressed="${i === detail.img}" aria-label="Изображение ${i + 1} из ${urls.length}">${u ? `<img src="${esc(u)}" alt="">` : ""}</button>`).join("")}
      </div>`
    : "";
  return `<section class="d-viewer" aria-label="Изображения">
    ${versions}
    <button type="button" class="d-stage" data-action="zoom" data-key="zoom" aria-label="Открыть изображение на весь экран">
      ${cur ? `<img src="${esc(cur)}" alt="${esc(s.title)} — ${versionLabel(ver)}, изображение ${detail.img + 1} из ${urls.length}">` : '<span class="sub-noimg">нет изображения</span>'}
      <span class="d-zoom" aria-hidden="true">${ICON.zoom}</span>
      ${urls.length > 1 ? `<span class="d-counter" aria-hidden="true">${detail.img + 1} / ${urls.length}</span>` : ""}
    </button>
    ${thumbs}
    <p class="d-vnote">
      <span class="ver-tag">${versionLabel(ver)}</span>
      <time datetime="${esc(ver.createdAt)}">${esc(formatDate(ver.createdAt))}</time>
      <span class="d-vnote-text">${ver.note ? esc(ver.note) : '<span class="faint">без заметки</span>'}</span>
    </p>
  </section>`;
}

function compareHTML(s) {
  if (s.versions.length < 2) return "";
  const opts = (sel) => s.versions.map((v, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${versionLabel(v)}</option>`).join("");
  const A = s.versions[detail.a];
  const B = s.versions[detail.b];
  const ua = safeUrl(A.imageUrls[0]);
  const ub = safeUrl(B.imageUrls[0]);
  return `<section class="d-compare" aria-labelledby="dCmpTitle">
    <div class="d-sec-head">
      <h3 id="dCmpTitle">До / после</h3>
      <div class="cmp-pick">
        <label>До <select class="mini-select" data-action="cmpA" data-key="cmpA">${opts(detail.a)}</select></label>
        <label>После <select class="mini-select" data-action="cmpB" data-key="cmpB">${opts(detail.b)}</select></label>
      </div>
    </div>
    <div class="cmp" style="--pos:${detail.pos}%">
      ${ua ? `<img class="cmp-a" src="${esc(ua)}" alt="До: ${versionLabel(A)}" draggable="false">` : ""}
      ${ub ? `<img class="cmp-b" src="${esc(ub)}" alt="После: ${versionLabel(B)}" draggable="false">` : ""}
      <span class="cmp-tag cmp-tag-a" aria-hidden="true">${versionLabel(A)}</span>
      <span class="cmp-tag cmp-tag-b" aria-hidden="true">${versionLabel(B)}</span>
      <span class="cmp-handle" aria-hidden="true"><i></i></span>
      <input type="range" class="cmp-range" min="0" max="100" step="1" value="${detail.pos}" data-key="cmp"
        aria-label="Сравнение ${versionLabel(A)} и ${versionLabel(B)}: левее — больше «после», правее — больше «до»" aria-valuetext="${detail.pos}%">
    </div>
    <p class="hint">Тяни ползунок или используй стрелки ← → на клавиатуре. Сравниваются первые изображения версий.</p>
  </section>`;
}

function adminHTML(s) {
  if (!isAdmin()) return "";
  const rates = Array.from({ length: 10 }, (_, i) => i + 1);
  return `<section class="d-admin" aria-labelledby="dAdmTitle">
    <div class="d-sec-head"><h3 id="dAdmTitle">Решение ndze</h3><span class="role-badge">admin</span></div>
    <p class="d-label" id="dRateLbl">Оценка</p>
    <div class="rate-grid" role="group" aria-labelledby="dRateLbl">
      ${rates.map((r) => `<button type="button" class="px-btn" data-action="rate" data-r="${r}" data-key="rate-${r}" aria-pressed="${s.rating === r}" aria-label="Оценка ${r} из 10">${r}</button>`).join("")}
    </div>
    <button type="button" class="link-btn rate-clear" data-action="rate" data-r="" data-key="rate-null"${s.rating == null ? " disabled" : ""}>Сбросить оценку</button>
    <p class="d-label" id="dStatusLbl">Статус</p>
    <div class="status-row" role="group" aria-labelledby="dStatusLbl">
      ${STATUS_ACTIONS.map((a) => `<button type="button" class="st-btn" data-tone="${statusOf(a.id).tone}" data-action="status" data-s="${a.id}" data-key="st-${a.id}" aria-pressed="${s.status === a.id}">${esc(a.label)}</button>`).join("")}
    </div>
  </section>`;
}

function uploadHTML(s) {
  if (!isOwner(s)) return "";
  return `<div class="d-actions">
    <button type="button" class="btn btn-primary btn-sm" data-action="newVersion" data-key="newVersion">${ICON.upload}<span>Загрузить доработку</span></button>
    <span class="hint">Новая версия снова встанет в очередь на оценку</span>
  </div>`;
}

function deleteHTML(s) {
  if (!isOwner(s) && !isAdmin()) return "";
  const del = detail.confirmDelete
    ? `<div class="del-confirm" role="group" aria-label="Подтверждение удаления">
        <span>Удалить работу со всеми версиями и комментариями?</span>
        <button type="button" class="btn btn-danger btn-sm" data-action="deleteYes" data-key="deleteYes"><span>Да, удалить</span><span class="spinner light" aria-hidden="true"></span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="deleteNo" data-key="deleteNo">Отмена</button>
      </div>`
    : `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-key="delete">Удалить работу</button>`;
  return `<div class="d-danger">${del}</div>`;
}

function commentsHTML(s) {
  const canWrite = !!user && (isOwner(s) || isAdmin());
  const items = s.comments.map((c) => `
    <li class="comment${c.isAdmin ? " is-admin" : ""}">
      <span class="avatar sm${c.isAdmin ? "" : " ghost"}" aria-hidden="true">${esc(initial(c.isAdmin ? SITE.nick : c.authorNick))}</span>
      <div class="comment-body">
        <p class="comment-head">
          <b>${esc(c.isAdmin ? SITE.nick : c.authorNick)}</b>
          ${c.isAdmin ? '<span class="role-badge">admin</span>' : ""}
          <time datetime="${esc(c.createdAt)}" title="${esc(formatDate(c.createdAt))}">${esc(timeAgo(c.createdAt))}</time>
        </p>
        <p class="comment-text">${esc(c.text)}</p>
      </div>
    </li>`).join("");
  return `<section class="d-comments" aria-labelledby="dComTitle">
    <div class="d-sec-head"><h3 id="dComTitle">Комментарии</h3><span class="tab-count">${s.comments.length}</span></div>
    ${s.comments.length ? `<ol class="comments">${items}</ol>` : `<p class="d-nocom faint">${canWrite ? "Пока тихо. Задай вопрос или расскажи, что поменял в новой версии." : "Комментариев пока нет."}</p>`}
    ${canWrite ? `<form class="comment-form" id="commentForm" novalidate>
      <div class="field">
        <textarea id="dComment" name="text" placeholder=" " maxlength="${LIMITS.comment.max}" rows="3" aria-describedby="dComment-count dComment-err" data-key="comment"></textarea>
        <label for="dComment">${isAdmin() && !isOwner(s) ? "Совет автору" : "Комментарий"}</label>
        <span class="counter" id="dComment-count" aria-live="polite">0 / ${LIMITS.comment.max}</span>
        <span class="error-msg" id="dComment-err"></span>
      </div>
      <div class="comment-send">
        <span class="hint">Ctrl + Enter — отправить</span>
        <button class="btn btn-primary btn-sm" type="submit" data-key="sendComment"><span>Отправить</span><span class="spinner" aria-hidden="true"></span></button>
      </div>
    </form>` : ""}
  </section>`;
}

function detailHTML(s) {
  const st = statusOf(s.status);
  const n = s.versions.length;
  return `<span class="modal-ticks" aria-hidden="true"><i></i><i></i><i></i></span>
    <button class="modal-close" type="button" data-close data-key="close" aria-label="Закрыть">✕</button>
    <header class="d-head">
      <div class="d-head-main">
        <div class="d-badges">
          <span class="badge ${st.tone}">${esc(st.label)}</span>
          <span class="badge plain">${esc(catLabel(s.category))}</span>
          <span class="badge plain">${n} ${plural(n, ["версия", "версии", "версий"])}</span>
        </div>
        <h2 id="dTitle" tabindex="-1">${esc(s.title)}</h2>
        <p class="d-meta">
          <span class="sub-author">@${esc(s.authorNick)}</span>
          <span class="dot" aria-hidden="true"></span>
          <span>отправлено <time datetime="${esc(s.createdAt)}">${esc(formatDate(s.createdAt))}</time></span>
          <span class="dot" aria-hidden="true"></span>
          <span>обновлено <time datetime="${esc(s.updatedAt)}">${esc(timeAgo(s.updatedAt))}</time></span>
        </p>
      </div>
      <div class="d-score${s.rating ? "" : " is-empty"}">
        <span class="d-score-n">${s.rating ? `${s.rating}<small>/10</small>` : "—"}</span>
        <span class="d-score-l">${s.rating ? "оценка ndze" : "ещё не оценено"}</span>
      </div>
    </header>
    ${s.status === "revision" && isOwner(s) ? `<p class="d-callout warn">ndze ждёт доработку — посмотри советы в комментариях и загрузи новую версию.</p>` : ""}
    ${s.status === "ideal" ? `<p class="d-callout lime">🏆 Идеал! Работа в публичной галерее.</p>` : ""}
    ${viewerHTML(s)}
    ${uploadHTML(s)}
    ${compareHTML(s)}
    ${s.description ? `<section class="d-desc" aria-labelledby="dDescTitle"><h3 id="dDescTitle">Описание</h3><p>${esc(s.description)}</p></section>` : ""}
    ${adminHTML(s)}
    ${commentsHTML(s)}
    ${deleteHTML(s)}`;
}

function renderDetail({ fresh = false } = {}) {
  const s = detail.sub;
  if (!s) return;
  const active = document.activeElement;
  const key = detailCard.contains(active) ? active.closest("[data-key]")?.dataset.key : null;
  const scroll = detailCard.scrollTop;
  const draft = $("#dComment", detailCard)?.value || "";
  detailCard.innerHTML = detailHTML(s);
  const ta = $("#dComment", detailCard);
  if (ta) {
    ta.value = draft;
    bindCounter(ta, $("#dComment-count", detailCard), LIMITS.comment.max);
  }
  if (fresh) {
    detailCard.scrollTop = 0;
    $("#dTitle", detailCard).focus({ preventScroll: true });
  } else {
    detailCard.scrollTop = scroll;
    if (key) $(`[data-key="${cssEsc(key)}"]`, detailCard)?.focus({ preventScroll: true });
  }
}

/* ---------- Действия в карточке ---------- */
detailCard.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !detail.sub) return;
  const s = detail.sub;
  switch (el.dataset.action) {
    case "version":
      detail.v = Number(el.dataset.n);
      detail.img = 0;
      renderDetail();
      break;
    case "img":
      detail.img = Number(el.dataset.i);
      renderDetail();
      break;
    case "zoom":
      openLightbox(s, detail.v, detail.img);
      break;
    case "newVersion":
      openVersionForm(s);
      break;
    case "rate":
      review({ rating: el.dataset.r ? Number(el.dataset.r) : null }, el);
      break;
    case "status":
      if (el.dataset.s !== s.status) review({ status: el.dataset.s }, el);
      break;
    case "delete":
      detail.confirmDelete = true;
      renderDetail();
      $('[data-key="deleteNo"]', detailCard)?.focus();
      break;
    case "deleteNo":
      detail.confirmDelete = false;
      renderDetail();
      $('[data-key="delete"]', detailCard)?.focus();
      break;
    case "deleteYes":
      await removeSub(el);
      break;
  }
});

detailCard.addEventListener("change", (e) => {
  const a = e.target.dataset.action;
  if (a === "cmpA" || a === "cmpB") {
    detail[a === "cmpA" ? "a" : "b"] = Number(e.target.value);
    renderDetail();
  }
});

detailCard.addEventListener("input", (e) => {
  if (e.target.classList.contains("cmp-range")) {
    detail.pos = Number(e.target.value);
    e.target.closest(".cmp").style.setProperty("--pos", `${detail.pos}%`);
    e.target.setAttribute("aria-valuetext", `${detail.pos}%`);
  } else if (e.target.id === "dComment") {
    clearFieldError(e.target.closest(".field"));
  }
});

detailCard.addEventListener("keydown", (e) => {
  if (e.target.id === "dComment" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

detailCard.addEventListener("submit", async (e) => {
  if (e.target.id !== "commentForm") return;
  e.preventDefault();
  const form = e.target;
  const btn = $('button[type="submit"]', form);
  if (btn.disabled) return;
  clearErrors(form);
  const text = form.elements.text.value.trim();
  const errors = checkComment(text);
  if (Object.keys(errors).length) {
    showErrors(form, errors)?.focus();
    return;
  }
  const id = detail.id;
  setBusy(btn, true);
  try {
    await api.addComment(id, text);
    form.elements.text.value = "";
    const sub = await api.getSubmission(id);
    if (detail.id === id) {
      setDetail(sub);
      const list = $(".comments", detailCard);
      list?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      $("#dComment", detailCard)?.focus({ preventScroll: true });
    }
    toast("Комментарий отправлен");
    refresh();
  } catch (err) {
    if (err.fields) showErrors(form, err.fields);
    toast(err.message, "error");
  } finally {
    if (btn.isConnected) setBusy(btn, false);
  }
});

async function review(patch, btn) {
  if (detail.busy) return;
  const id = detail.id;
  detail.busy = true;
  const box = $(".d-admin", detailCard);
  box?.classList.add("is-busy");
  btn?.setAttribute("aria-busy", "true");
  try {
    const sub = await api.reviewSubmission(id, patch);
    if (detail.id === id) setDetail(sub);
    if ("status" in patch) toast(`Статус: ${statusOf(sub.status).label}${sub.status === "ideal" ? " — работа в галерее 🏆" : ""}`);
    else toast(sub.rating ? `Оценка ${sub.rating}/10 сохранена` : "Оценка сброшена");
    refresh();
  } catch (err) {
    toast(err.message, "error");
    box?.classList.remove("is-busy");
    btn?.removeAttribute("aria-busy");
  } finally {
    detail.busy = false;
  }
}

async function removeSub(btn) {
  const id = detail.id;
  setBusy(btn, true);
  try {
    await api.deleteSubmission(id);
    toast("Работа удалена");
    detailModal.close();
    refresh();
  } catch (err) {
    toast(err.message, "error");
    if (btn.isConnected) setBusy(btn, false);
  }
}

/* ───────────────────────── Новая версия ───────────────────────── */
const versionDlg = $("#versionModal");
const versionModal = setupModal(versionDlg);
const versionForm = $("#versionForm");
const versionCard = $(".modal-card", versionDlg);
const versionBtn = $('button[type="submit"]', versionForm);
const verPicker = createPicker($("#vPicker"), "vFiles");
const updateNoteCounter = bindCounter(versionForm.elements.note, $("#vNote-count"), LIMITS.note.max);
liveClear(versionForm);
let versionFor = null;

function openVersionForm(s) {
  if (versionFor !== s.id) {
    versionForm.reset();
    verPicker.reset();
    updateNoteCounter();
    versionFor = s.id;
  }
  clearErrors(versionForm);
  $("#vFor").textContent = `доработка · ${s.title}`;
  $("#vTitle").textContent = `Версия v${s.versions.length + 1}`;
  versionModal.open();
  verPicker.focus();
}

versionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (versionBtn.disabled || !versionFor) return;
  clearErrors(versionForm);
  const data = { files: verPicker.files, note: versionForm.elements.note.value.trim() };
  const errors = checkVersion(data);
  if (Object.keys(errors).length) {
    const first = showErrors(versionForm, errors);
    if (errors.files) verPicker.setError(errors.files);
    shake(versionCard);
    first?.focus();
    return;
  }
  const id = versionFor;
  setBusy(versionBtn, true);
  try {
    const sub = await api.addVersion(id, data);
    toast(`Версия v${sub.versions.length} загружена — работа снова в очереди`);
    versionForm.reset();
    verPicker.reset();
    updateNoteCounter();
    versionFor = null;
    versionModal.close();
    if (detail.id === id) setDetail(sub, { toLatest: true });
    refresh();
  } catch (err) {
    if (err.fields) {
      showErrors(versionForm, err.fields);
      if (err.fields.files) verPicker.setError(err.fields.files);
    }
    $(".form-error", versionForm).textContent = err.message;
    shake(versionCard);
  } finally {
    setBusy(versionBtn, false);
  }
});

/* ───────────────────────── Лайтбокс ───────────────────────── */
const lbDlg = $("#lightbox");
const lbModal = setupModal(lbDlg);
const lbImg = $("#lbImg");
const lbCap = $("#lbCap");
const lb = { urls: [], i: 0, title: "", ver: "" };

function openLightbox(s, vIndex, imgIndex) {
  const ver = s.versions[vIndex];
  lb.urls = (ver?.imageUrls || []).map(safeUrl).filter(Boolean);
  if (!lb.urls.length) return;
  lb.i = clamp(imgIndex, 0, lb.urls.length - 1);
  lb.title = s.title;
  lb.ver = versionLabel(ver);
  renderLightbox();
  lbModal.open();
  $(".lb-close", lbDlg).focus();
}
function renderLightbox() {
  const many = lb.urls.length > 1;
  lbImg.src = lb.urls[lb.i];
  lbImg.alt = `${lb.title} — ${lb.ver}, изображение ${lb.i + 1} из ${lb.urls.length}`;
  lbCap.textContent = `${lb.title} · ${lb.ver}${many ? ` · ${lb.i + 1} / ${lb.urls.length}` : ""}`;
  $$("[data-lb]", lbDlg).forEach((b) => { b.hidden = !many; });
}
function stepLightbox(d) {
  if (lb.urls.length < 2) return;
  lb.i = (lb.i + d + lb.urls.length) % lb.urls.length;
  renderLightbox();
}
lbDlg.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lb]");
  if (b) stepLightbox(Number(b.dataset.lb));
  else if (e.target.classList.contains("lb-figure")) lbModal.close();
});
lbDlg.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); stepLightbox(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); stepLightbox(1); }
});

/* ───────────────────────── Пользователь ───────────────────────── */
function renderUserBits() {
  newSubBtn.title = user ? "" : "Нужен аккаунт";
}

onUserChange((u) => {
  user = u;
  state.tab = defaultTab();
  state.filter = "all";
  renderUserBits();
  renderTabs();
  loadLists({ skeleton: true });
  if (!u) {
    submitModal.close();
    versionModal.close();
  }
  if (detail.id && detailDlg.open) showDetail(detail.id, { quiet: true });
  if (u && pendingSub) {
    const id = pendingSub;
    pendingSub = null;
    openSub(id);
  }
});

addEventListener("pagehide", () => {
  subPicker.reset();
  verPicker.reset();
});

/* ───────────────────────── Старт ───────────────────────── */
state.tab = defaultTab();
renderUserBits();
renderTabs();
renderPanel();
loadLists();
if (hashSubId()) syncHash();

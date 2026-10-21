// Пульт → «Расписание · архив · цели»: стримы в расписании, архив эфиров с таймкодами
// (и подсказками из заданий и работ того дня), цели канала и ссылки на их оверлеи для OBS.
import { apiCall, toApiError } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { $, $$, esc, toast } from "../core/util.js";
import { whenText } from "../home/schedule.js";
import { num } from "../home/channel.js";

const TABS = [
  { id: "schedule", label: "📅 Расписание" },
  { id: "archive", label: "📼 Архив" },
  { id: "goals", label: "🎯 Цели" },
  { id: "overlays", label: "🖥 Оверлеи" },
];
const KIND = { moment: ["⚡", "Момент"], task: ["🎯", "Задание"], work: ["🖼", "Работа"] };
const OVERLAYS = [
  { w: "schedule", label: "Следующий стрим", hint: "отсчёт до эфира, 760×220" },
  { w: "goals", label: "Цели канала", hint: "полосы целей, 800×360; &id=<цель> — одна, &n=2 — сколько" },
  { w: "viewer", label: "Зритель дня", hint: "аватар и очки, 620×170" },
];

/* ---------- Время по Москве ---------- */
const MSK_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Date → «YYYY-MM-DDTHH:MM» по Москве (значение datetime-local). */
function mskLocal(date) {
  const p = Object.fromEntries(MSK_PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Ближайшие 20:00 по Москве — время стрима по умолчанию. */
function defaultStart() {
  const now = new Date();
  const today = `${mskLocal(now).slice(0, 10)}T20:00`;
  return today > mskLocal(now) ? today : `${mskLocal(new Date(now.getTime() + 86_400_000)).slice(0, 10)}T20:00`;
}

/* ---------- Формы ---------- */
let uid = 0;
function fld(name, label, { type = "text", max, value = "", attrs = "", area = false } = {}) {
  const id = `stx-${name}-${++uid}`;
  const input = area
    ? `<textarea id="${id}" name="${name}" placeholder=" " rows="3"${max ? ` maxlength="${max}"` : ""}>${esc(value)}</textarea>`
    : `<input id="${id}" name="${name}" type="${type}" placeholder=" "${max ? ` maxlength="${max}"` : ""} value="${esc(value)}" ${attrs}>`;
  return `<div class="field">${input}<label for="${id}">${esc(label)}</label><span class="error-msg"></span></div>`;
}

function clearErr(form) {
  $$(".field.invalid", form).forEach((f) => {
    f.classList.remove("invalid");
    const m = $(".error-msg", f);
    if (m) m.textContent = "";
  });
}

function showErr(form, err) {
  const e = toApiError(err);
  for (const [name, msg] of Object.entries(e.fields || {})) {
    const field = form.elements[name]?.closest?.(".field");
    if (!field) continue;
    field.classList.add("invalid");
    const m = $(".error-msg", field);
    if (m) m.textContent = msg;
  }
  toast(e.message, "error");
}

async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); } }
}

const post = (route, body) => apiCall(route, { method: "POST", body });
const submitBtn = (label) => `<button class="btn btn-primary btn-sm" type="submit"><span>${esc(label)}</span><span class="spinner" aria-hidden="true"></span></button>`;

/* ================================ Модуль ================================ */
export function mount(container) {
  ensureCss("streamtools.css");
  const root = document.createElement("div");
  root.className = "stx-adm";
  root.innerHTML = `<div class="stx-subtabs" role="tablist" aria-label="Стрим-инструменты">${TABS.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-stx-tab="${t.id}">${esc(t.label)}</button>`).join("")}</div>
    <div class="stx-adm-panel" role="tabpanel"></div>`;
  container.append(root);
  const panel = $(".stx-adm-panel", root);

  let tab = "schedule";
  let events = [];
  let streams = [];
  let arPage = 0;
  let arPages = 1;
  let arPrefill = null;
  const open = new Set();          // эфиры с раскрытым редактором таймкодов
  const sugg = new Map();          // id эфира → { day, items }
  let goals = [];

  function show(next) {
    tab = next;
    $$("[data-stx-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.stxTab === tab)));
    if (tab === "schedule") renderSchedule();
    else if (tab === "archive") renderArchive();
    else if (tab === "goals") renderGoals();
    else renderOverlays();
  }

  /* ---------------- Расписание ---------------- */
  function evFormHTML() {
    return `<form class="glass stx-form" id="stxEv" novalidate>
      <h3 data-form-title>Новый стрим в расписании</h3>
      <input type="hidden" name="id">
      <div class="stx-form-grid">
        ${fld("title", "Название стрима", { max: 120 })}
        ${fld("game", "Игра (необязательно)", { max: 60 })}
        ${fld("startsAt", "Начало, МСК", { type: "datetime-local", value: defaultStart() })}
        ${fld("durationMin", "Длительность, мин", { type: "number", value: "180", attrs: 'min="15" max="1440" step="15"' })}
      </div>
      ${fld("note", "Заметка для зрителей (необязательно)", { max: 300 })}
      <div class="stx-actions">${submitBtn("Сохранить")}<button class="btn btn-ghost btn-sm" type="button" data-form-cancel hidden>Отменить правку</button></div>
    </form>
    <ul class="stx-list" id="stxEvList"><li class="skeleton"></li></ul>`;
  }

  async function renderSchedule() {
    panel.innerHTML = evFormHTML();
    await loadEvents();
  }

  function evRow(e) {
    const meta = [whenText(e.startsAt), `${e.durationMin} мин`, e.game, e.note].filter(Boolean).map(esc).join(" · ");
    return `<li class="glass stx-row${e.isPast ? " is-past" : ""}" data-ev="${esc(e.id)}">
      <div class="stx-row-main"><b>${esc(e.title)}</b><small>${meta}</small></div>
      ${e.isNow ? '<span class="badge live">Идёт сейчас</span>' : e.isPast ? '<span class="badge plain">Прошёл</span>' : '<span class="badge lime">Впереди</span>'}
      <div class="stx-actions">
        <button class="btn btn-ghost btn-xs" type="button" data-ev-edit>Править</button>
        ${e.isPast || e.isNow ? '<button class="btn btn-ghost btn-xs" type="button" data-ev-archive>→ В архив</button>' : ""}
        <button class="btn btn-danger btn-xs" type="button" data-ev-del>Удалить</button>
      </div></li>`;
  }

  async function loadEvents() {
    const list = $("#stxEvList", root);
    if (!list) return;
    try {
      events = (await apiCall("schedule/all")).items;
    } catch (e) {
      list.innerHTML = `<li class="stx-err">⚠ ${esc(toApiError(e).message)}</li>`;
      return;
    }
    const ahead = events.filter((e) => !e.isPast);
    const past = events.filter((e) => e.isPast).reverse();
    list.innerHTML = events.length
      ? [...ahead, ...past].map(evRow).join("")
      : '<li class="stx-muted">Расписание пустое. Добавь ближайший стрим — у зрителей появится отсчёт на главной.</li>';
  }

  function resetForm(form, title) {
    form.reset();
    form.elements.id.value = "";
    clearErr(form);
    $("[data-form-title]", form).textContent = title;
    $("[data-form-cancel]", form).hidden = true;
  }

  /* ---------------- Архив ---------------- */
  function arFormHTML() {
    const p = arPrefill || {};
    return `<form class="glass stx-form" id="stxAr" novalidate>
      <h3 data-form-title>${p.id ? "Правка эфира" : "Новый эфир в архиве"}</h3>
      <input type="hidden" name="id" value="${esc(p.id || "")}">
      <div class="stx-form-grid">
        ${fld("title", "Название эфира", { max: 120, value: p.title || "" })}
        ${fld("game", "Игра (необязательно)", { max: 60, value: p.game || "" })}
        ${fld("startedAt", "Начало, МСК", { type: "datetime-local", value: p.startedAt || mskLocal(new Date()) })}
        ${fld("vodUrl", "Запись: twitch.tv/videos/… или YouTube", { type: "url", max: 300, value: p.vodUrl || "", attrs: 'inputmode="url" autocomplete="off"' })}
      </div>
      ${fld("summary", "Коротко о стриме (необязательно)", { area: true, max: 3000, value: p.summary || "" })}
      <div class="stx-actions">${submitBtn("Сохранить")}<button class="btn btn-ghost btn-sm" type="button" data-form-cancel${p.id ? "" : " hidden"}>Отменить правку</button></div>
    </form>
    <ul class="stx-list" id="stxArList"><li class="skeleton"></li></ul>
    <button class="btn btn-ghost btn-sm stx-more" type="button" data-ar-more hidden>Показать ещё</button>`;
  }

  async function renderArchive() {
    panel.innerHTML = arFormHTML();
    arPrefill = null;
    streams = [];
    arPage = 0;
    await loadStreams();
  }

  async function loadStreams() {
    const list = $("#stxArList", root);
    if (!list) return;
    try {
      const d = await apiCall("archive", { query: { page: arPage + 1 } });
      arPage = d.page;
      arPages = d.pages;
      const known = new Set(streams.map((s) => s.id));
      streams.push(...d.items.filter((s) => !known.has(s.id)));
    } catch (e) {
      list.innerHTML = `<li class="stx-err">⚠ ${esc(toApiError(e).message)}</li>`;
      return;
    }
    renderStreams();
  }

  function renderStreams() {
    const list = $("#stxArList", root);
    if (!list) return;
    list.innerHTML = streams.length ? streams.map(streamRow).join("")
      : '<li class="stx-muted">Архив пуст. После стрима добавь эфир, ссылку на запись и таймкоды — зрители увидят их на странице «Стримы».</li>';
    const more = $("[data-ar-more]", root);
    if (more) more.hidden = arPage >= arPages;
  }

  function streamRow(s) {
    const isOpen = open.has(s.id);
    const meta = [whenText(s.startedAt), s.game, `${s.marks.length} тк`].filter(Boolean).map(esc).join(" · ");
    return `<li class="glass stx-adm-stream" data-st="${esc(s.id)}">
      <div class="stx-adm-stream-head">
        <div class="stx-row-main"><b>${esc(s.title)}</b><small>${meta}${s.vodUrl ? ` · <a class="py-link" href="${esc(s.vodUrl)}" target="_blank" rel="noopener">запись ↗</a>` : " · без записи"}</small></div>
        <div class="stx-actions">
          <button class="btn ${isOpen ? "btn-primary" : "btn-ghost"} btn-xs" type="button" data-st-marks aria-expanded="${isOpen}">Таймкоды</button>
          <button class="btn btn-ghost btn-xs" type="button" data-st-edit>Править</button>
          <button class="btn btn-danger btn-xs" type="button" data-st-del>Удалить</button>
        </div>
      </div>
      ${isOpen ? marksEditor(s) : ""}
    </li>`;
  }

  const kindOptions = (sel) => Object.entries(KIND).map(([k, [icon, label]]) => `<option value="${k}"${k === sel ? " selected" : ""}>${icon} ${label}</option>`).join("");

  function marksEditor(s) {
    const sg = sugg.get(s.id);
    return `<div class="stx-adm-marks">
      ${s.marks.length ? `<div>${s.marks.map((m) => `<div class="stx-mark-row" data-mark="${esc(m.id)}">
          <span class="stx-mark-at">${esc(m.atText)}</span><span title="${esc(KIND[m.kind]?.[1] || "")}">${KIND[m.kind]?.[0] || "⚡"}</span>
          <span class="stx-mark-label">${esc(m.label)}</span>
          <span class="stx-actions"><button class="btn btn-ghost btn-xs" type="button" data-mark-edit aria-label="Изменить">✎</button><button class="btn btn-danger btn-xs" type="button" data-mark-del aria-label="Удалить">✕</button></span>
        </div>`).join("")}</div>` : '<p class="stx-faint">Таймкодов пока нет.</p>'}
      <form class="stx-mark-form" data-mark-form novalidate>
        <input name="at" placeholder="1:02:03" aria-label="Таймкод от начала записи" maxlength="9" autocomplete="off">
        <select name="kind" aria-label="Тип отметки">${kindOptions("moment")}</select>
        <input name="label" placeholder="Что случилось" aria-label="Подпись" maxlength="160" autocomplete="off">
        <input type="hidden" name="id"><input type="hidden" name="refId">
        <button class="btn btn-primary btn-xs" type="submit" data-mark-submit>Добавить</button>
      </form>
      <div class="stx-actions"><button class="btn btn-ghost btn-sm" type="button" data-suggest><span>🪄 Подтянуть из этого дня</span><span class="spinner light" aria-hidden="true"></span></button></div>
      ${sg ? suggHTML(sg) : ""}
    </div>`;
  }

  function suggHTML(sg) {
    return `<div class="stx-sugg"><b>Задания и разборы работ за ${esc(sg.day.split("-").reverse().join("."))}</b>
      ${sg.items.length ? sg.items.map((it) => `<form class="stx-sugg-row${it.added ? " is-added" : ""}" data-sugg-form novalidate>
          <input name="at" value="${esc(it.atText)}" aria-label="Таймкод" maxlength="9">
          <select name="kind" aria-label="Тип">${kindOptions(it.kind)}</select>
          <input name="label" value="${esc(it.label)}" aria-label="Подпись" maxlength="160">
          <input type="hidden" name="refId" value="${esc(it.refId)}">
          <button class="btn btn-ghost btn-xs" type="submit"${it.added ? " disabled" : ""}>${it.added ? "✓ Есть" : "+ Добавить"}</button>
        </form>`).join("")
        : '<p class="stx-faint">В этот день задания не выполнялись и работы не оценивались.</p>'}
      <p class="stx-faint">Время посчитано от начала эфира по моменту смены статуса — поправь, если запись началась позже.</p></div>`;
  }

  function replaceStream(s) {
    const i = streams.findIndex((x) => x.id === s.id);
    if (i >= 0) streams[i] = s; else streams.unshift(s);
    const li = $(`[data-st="${CSS.escape(s.id)}"]`, root);
    if (li) li.outerHTML = streamRow(s);
    else renderStreams();
  }

  /* ---------------- Цели ---------------- */
  function goalFormHTML() {
    return `<form class="glass stx-form" id="stxGoal" novalidate>
      <h3 data-form-title>Новая цель канала</h3>
      <input type="hidden" name="id">
      <div class="stx-form-grid">
        ${fld("title", "Цель, например «500 фолловеров»", { max: 120 })}
        ${fld("unit", "Единица (фолл., сабов, ₽)", { max: 24 })}
        ${fld("current", "Сейчас", { type: "number", value: "0", attrs: 'step="1"' })}
        ${fld("target", "Нужно", { type: "number", value: "100", attrs: 'min="1" step="1"' })}
        ${fld("sort", "Порядок (меньше — выше)", { type: "number", value: "0", attrs: 'step="1"' })}
        <div class="field"><select name="status" id="stx-gstatus"><option value="active">Активная</option><option value="done">Выполнена (в архив)</option></select><label for="stx-gstatus">Статус</label><span class="error-msg"></span></div>
      </div>
      <div class="stx-actions">${submitBtn("Сохранить")}<button class="btn btn-ghost btn-sm" type="button" data-form-cancel hidden>Отменить правку</button></div>
    </form>
    <ul class="stx-list" id="stxGoalList"><li class="skeleton"></li></ul>`;
  }

  function goalRow(g) {
    return `<li class="glass stx-row${g.status === "done" ? " is-past" : ""}" data-goal-row="${esc(g.id)}">
      <div class="stx-row-main"><b>${esc(g.title)}</b><small>${num(g.current)} / ${num(g.target)}${g.unit ? ` ${esc(g.unit)}` : ""} · ${g.percent}% · порядок ${g.sort}${g.reached ? " · ★ достигнута" : ""}</small></div>
      <span class="badge ${g.status === "done" ? "plain" : "lime"}">${g.status === "done" ? "Выполнена" : "Активная"}</span>
      <div class="stx-actions">
        <button class="btn btn-ghost btn-xs" type="button" data-bump="-1">−1</button>
        <button class="btn btn-ghost btn-xs" type="button" data-bump="1">+1</button>
        <button class="btn btn-ghost btn-xs" type="button" data-bump="10">+10</button>
        <button class="btn btn-ghost btn-xs" type="button" data-goal-edit>Править</button>
        <button class="btn btn-danger btn-xs" type="button" data-goal-del>Удалить</button>
      </div>
      <div class="stx-bar" aria-hidden="true"><i style="--p:${Number(g.percent) || 0}%"></i></div>
    </li>`;
  }

  async function renderGoals() {
    panel.innerHTML = goalFormHTML();
    await loadGoals();
  }

  async function loadGoals() {
    const list = $("#stxGoalList", root);
    if (!list) return;
    try {
      goals = (await apiCall("goals")).items;
    } catch (e) {
      list.innerHTML = `<li class="stx-err">⚠ ${esc(toApiError(e).message)}</li>`;
      return;
    }
    list.innerHTML = goals.length ? goals.map(goalRow).join("") : '<li class="stx-muted">Целей нет. Добавь первую — она появится на главной, на странице «Стримы» и в оверлее.</li>';
  }

  /* ---------------- Оверлеи ---------------- */
  async function renderOverlays() {
    panel.innerHTML = '<div class="skeleton"></div>';
    let key;
    try { key = (await apiCall("stream")).overlayKey; } catch (e) { panel.innerHTML = `<p class="stx-err">⚠ ${esc(toApiError(e).message)}</p>`; return; }
    const url = (w) => new URL(`overlay.html?w=${w}&key=${encodeURIComponent(key)}`, location.href).href;
    panel.innerHTML = `<p class="stx-muted">Источник «Браузер» в OBS, фон прозрачный. Ключ тот же, что у остальных оверлеев (меняется кнопкой «Новый ключ» выше).</p>
      <div class="stx-ovl">${OVERLAYS.map((o) => `<div class="glass"><b>${esc(o.label)}</b><small>${esc(o.hint)}</small>
        <div class="stx-actions"><button class="btn btn-ghost btn-xs" type="button" data-copy-url="${esc(url(o.w))}">Скопировать ссылку</button>
        <a class="btn btn-ghost btn-xs" href="${esc(url(o.w))}" target="_blank" rel="noopener">Открыть ↗</a></div></div>`).join("")}</div>`;
  }

  /* ---------------- Клики ---------------- */
  root.addEventListener("click", async (e) => {
    const t = e.target;
    const tabBtn = t.closest("[data-stx-tab]");
    if (tabBtn) return show(tabBtn.dataset.stxTab);

    const cancel = t.closest("[data-form-cancel]");
    if (cancel) {
      const f = cancel.closest("form");
      resetForm(f, f.id === "stxEv" ? "Новый стрим в расписании" : f.id === "stxAr" ? "Новый эфир в архиве" : "Новая цель канала");
      if (f.id === "stxEv") f.elements.startsAt.value = defaultStart();
      return;
    }

    // расписание
    const evLi = t.closest("[data-ev]");
    if (evLi) {
      const ev = events.find((x) => x.id === evLi.dataset.ev);
      if (!ev) return;
      if (t.closest("[data-ev-edit]")) {
        const f = $("#stxEv", root);
        clearErr(f);
        f.elements.id.value = ev.id;
        f.elements.title.value = ev.title;
        f.elements.game.value = ev.game || "";
        f.elements.startsAt.value = ev.startsAtMsk;
        f.elements.durationMin.value = ev.durationMin;
        f.elements.note.value = ev.note || "";
        $("[data-form-title]", f).textContent = "Правка стрима";
        $("[data-form-cancel]", f).hidden = false;
        f.scrollIntoView({ behavior: "smooth", block: "center" });
        f.elements.title.focus({ preventScroll: true });
      } else if (t.closest("[data-ev-archive]")) {
        arPrefill = { title: ev.title, game: ev.game, startedAt: ev.startsAtMsk };
        tab = "archive";
        $$("[data-stx-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.stxTab === "archive")));
        const pre = arPrefill;
        await renderArchive();
        toast(`Заполнил форму из расписания: «${pre.title}» — добавь ссылку на запись`);
      } else if (t.closest("[data-ev-del]")) {
        if (!confirm(`Удалить «${ev.title}» из расписания?`)) return;
        try { await post("schedule/delete", { id: ev.id }); toast("Удалено из расписания"); loadEvents(); } catch (err) { toast(toApiError(err).message, "error"); }
      }
      return;
    }

    // архив
    if (t.closest("[data-ar-more]")) return busy(t.closest("button"), loadStreams);
    const stLi = t.closest("[data-st]");
    if (stLi) {
      const s = streams.find((x) => x.id === stLi.dataset.st);
      if (!s) return;
      if (t.closest("[data-st-marks]")) {
        if (open.has(s.id)) open.delete(s.id); else open.add(s.id);
        replaceStream(s);
      } else if (t.closest("[data-st-edit]")) {
        const f = $("#stxAr", root);
        clearErr(f);
        f.elements.id.value = s.id;
        f.elements.title.value = s.title;
        f.elements.game.value = s.game || "";
        f.elements.startedAt.value = s.startedAtMsk;
        f.elements.vodUrl.value = s.vodUrl || "";
        f.elements.summary.value = s.summary || "";
        $("[data-form-title]", f).textContent = "Правка эфира";
        $("[data-form-cancel]", f).hidden = false;
        f.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (t.closest("[data-st-del]")) {
        if (!confirm(`Удалить эфир «${s.title}» и все его таймкоды?`)) return;
        try {
          await post("archive/delete", { id: s.id });
          streams = streams.filter((x) => x.id !== s.id);
          open.delete(s.id);
          renderStreams();
          toast("Эфир удалён из архива");
        } catch (err) { toast(toApiError(err).message, "error"); }
      } else if (t.closest("[data-suggest]")) {
        await busy(t.closest("button"), async () => {
          try {
            sugg.set(s.id, await apiCall("archive/suggest", { query: { id: s.id } }));
            replaceStream(s);
          } catch (err) { toast(toApiError(err).message, "error"); }
        });
      } else if (t.closest("[data-mark-edit]")) {
        const m = s.marks.find((x) => x.id === t.closest("[data-mark]").dataset.mark);
        const f = $("[data-mark-form]", stLi);
        if (!m || !f) return;
        f.elements.at.value = m.atText;
        f.elements.kind.value = m.kind;
        f.elements.label.value = m.label;
        f.elements.id.value = m.id;
        f.elements.refId.value = m.refId || "";
        $("[data-mark-submit]", f).textContent = "Сохранить";
        f.elements.label.focus();
      } else if (t.closest("[data-mark-del]")) {
        const id = t.closest("[data-mark]").dataset.mark;
        try { replaceStream(await post("archive/mark/delete", { id })); } catch (err) { toast(toApiError(err).message, "error"); }
      }
      return;
    }

    // цели
    const gLi = t.closest("[data-goal-row]");
    if (gLi) {
      const g = goals.find((x) => x.id === gLi.dataset.goalRow);
      if (!g) return;
      const bump = t.closest("[data-bump]");
      if (bump) {
        try {
          const ng = await post("goals/bump", { id: g.id, delta: Number(bump.dataset.bump) });
          goals = goals.map((x) => (x.id === ng.id ? ng : x));
          gLi.outerHTML = goalRow(ng);
          if (ng.reached && !g.reached) toast(`🎉 Цель «${ng.title}» достигнута!`);
        } catch (err) { toast(toApiError(err).message, "error"); }
      } else if (t.closest("[data-goal-edit]")) {
        const f = $("#stxGoal", root);
        clearErr(f);
        f.elements.id.value = g.id;
        f.elements.title.value = g.title;
        f.elements.unit.value = g.unit || "";
        f.elements.current.value = g.current;
        f.elements.target.value = g.target;
        f.elements.sort.value = g.sort;
        f.elements.status.value = g.status;
        $("[data-form-title]", f).textContent = "Правка цели";
        $("[data-form-cancel]", f).hidden = false;
        f.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (t.closest("[data-goal-del]")) {
        if (!confirm(`Удалить цель «${g.title}»?`)) return;
        try { await post("goals/delete", { id: g.id }); toast("Цель удалена"); loadGoals(); } catch (err) { toast(toApiError(err).message, "error"); }
      }
      return;
    }

    const copy = t.closest("[data-copy-url]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copyUrl); toast("Ссылка оверлея скопирована"); } catch { prompt("Скопируй:", copy.dataset.copyUrl); }
    }
  });

  /* ---------------- Отправка форм ---------------- */
  root.addEventListener("submit", async (e) => {
    const f = e.target;
    e.preventDefault();
    const btn = $('button[type="submit"]', f);
    clearErr(f);
    const v = (name) => (f.elements[name]?.value ?? "").trim();

    if (f.id === "stxEv") {
      await busy(btn, async () => {
        try {
          await post("schedule/save", { id: v("id") || null, title: v("title"), game: v("game"), startsAt: v("startsAt"), durationMin: Number(v("durationMin")), note: v("note") });
          toast(v("id") ? "Стрим обновлён" : "Стрим добавлен в расписание");
          resetForm(f, "Новый стрим в расписании");
          f.elements.startsAt.value = defaultStart();
          await loadEvents();
        } catch (err) { showErr(f, err); }
      });
    } else if (f.id === "stxAr") {
      await busy(btn, async () => {
        try {
          const s = await post("archive/save", { id: v("id") || null, title: v("title"), game: v("game"), startedAt: v("startedAt"), vodUrl: v("vodUrl"), summary: v("summary") });
          const isNew = !v("id");
          if (isNew) open.add(s.id); // сразу к таймкодам
          resetForm(f, "Новый эфир в архиве");
          f.elements.startedAt.value = mskLocal(new Date());
          replaceStream(s);
          toast(isNew ? "Эфир добавлен — теперь таймкоды" : "Эфир обновлён");
          if (isNew) $(`[data-st="${CSS.escape(s.id)}"]`, root)?.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (err) { showErr(f, err); }
      });
    } else if (f.id === "stxGoal") {
      await busy(btn, async () => {
        try {
          await post("goals/save", { id: v("id") || null, title: v("title"), unit: v("unit"), current: Number(v("current") || 0), target: Number(v("target")), sort: Number(v("sort") || 0), status: v("status") });
          toast(v("id") ? "Цель обновлена" : "Цель добавлена");
          resetForm(f, "Новая цель канала");
          await loadGoals();
        } catch (err) { showErr(f, err); }
      });
    } else if (f.matches("[data-mark-form], [data-sugg-form]")) {
      const stLi = f.closest("[data-st]");
      if (!stLi) return;
      const streamId = stLi.dataset.st;
      const body = { streamId, at: v("at"), kind: v("kind"), label: v("label") };
      if (v("id")) body.id = v("id");
      if (v("refId")) body.refId = v("refId");
      await busy(btn, async () => {
        try {
          const s = await post("archive/mark", body);
          const sg = sugg.get(streamId);
          if (sg && body.refId) sg.items.forEach((it) => { if (it.refId === body.refId) it.added = true; });
          replaceStream(s);
          $(`[data-st="${CSS.escape(streamId)}"] [data-mark-form] input[name="at"]`, root)?.focus();
        } catch (err) { toast(toApiError(err).message, "error"); }
      });
    }
  });

  show(tab);
  return { destroy() { root.remove(); } };
}

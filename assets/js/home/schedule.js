// «Сейчас на канале» → следующий стрим: большой пиксельный отсчёт ДД:ЧЧ:ММ:СС, .ics в календарь
// и напоминание браузерным уведомлением за 10 минут (пока открыта любая вкладка сайта).
// Отсюда же берут помощники страница streams.html и оверлей расписания.
import { apiCall, api } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast } from "../core/util.js";
import { SITE } from "../config.js";

const ROOT = new URL("../../../", import.meta.url); // корень сайта (файл в assets/js/home/)
const TZ = "Europe/Moscow";
const REMIND_KEY = "ndze:stx-reminders";
const REMIND_BEFORE = 10 * 60_000;
const REMIND_EVERY = 30_000;

/* ---------- Время ---------- */
const fmtDay = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short", day: "numeric", month: "long" });
const fmtTime = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
const fmtWeekday = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short" });

/** «пт, 24 октября · 20:00 МСК» */
export const whenText = (iso) => `${fmtDay.format(new Date(iso))} · ${fmtTime.format(new Date(iso))} МСК`;
export const timeText = (iso) => fmtTime.format(new Date(iso));
export const shortDay = (iso) => fmtShort.format(new Date(iso)).replace(".", "");
export const weekday = (iso) => fmtWeekday.format(new Date(iso));

/** Сколько осталось: { d, h, m, s } (не меньше нуля). */
export function splitLeft(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}
const pad = (n) => String(n).padStart(2, "0");

/** «2д 03:04:05» / «03:04:05» — для оверлея. */
export function leftText(ms) {
  const { d, h, m, s } = splitLeft(ms);
  return `${d ? `${d}д ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Ссылка на .ics: все предстоящие эфиры или один. */
export const icsUrl = (id) => new URL(`api/index.php?r=schedule/ics${id ? `&id=${encodeURIComponent(id)}` : ""}`, ROOT).href;
export const twitchUrl = (channel) => `https://www.twitch.tv/${encodeURIComponent(channel || SITE.twitch.channel)}`;

/* ---------- Напоминания (localStorage + Notification API) ---------- */
function readReminders() {
  try {
    const list = JSON.parse(localStorage.getItem(REMIND_KEY) || "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && typeof r.startsAt === "string") : [];
  } catch {
    return [];
  }
}
function writeReminders(list) {
  try { localStorage.setItem(REMIND_KEY, JSON.stringify(list)); } catch { /* приватный режим — живём без напоминаний */ }
}
export const hasReminder = (id) => readReminders().some((r) => r.id === id);

export async function addReminder(ev) {
  if (!("Notification" in window)) { toast("Этот браузер не умеет уведомления — добавь стрим в календарь", "error"); return false; }
  if (Notification.permission === "denied") { toast("Уведомления для сайта запрещены в настройках браузера", "error"); return false; }
  if (Notification.permission !== "granted") {
    let p = "default";
    try { p = await Notification.requestPermission(); } catch { /* старый Safari */ }
    if (p !== "granted") { toast("Без разрешения на уведомления напомнить не получится", "error"); return false; }
  }
  const list = readReminders().filter((r) => r.id !== ev.id);
  list.push({ id: ev.id, title: String(ev.title || "").slice(0, 120), game: String(ev.game || "").slice(0, 60), startsAt: ev.startsAt, fired: false });
  writeReminders(list);
  startReminders();
  toast("Напомню за 10 минут до начала — если будет открыта любая вкладка сайта");
  return true;
}

export function removeReminder(id) {
  writeReminders(readReminders().filter((r) => r.id !== id));
}

function fire(r, now) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const left = Math.round((Date.parse(r.startsAt) - now) / 60_000);
  try {
    const n = new Notification(left > 0 ? `Стрим через ${left} мин` : "Стрим начинается!", {
      body: [r.title, r.game].filter(Boolean).join(" · ") || "ndze выходит в эфир",
      tag: `stx-${r.id}`, // одно уведомление, даже если сайт открыт в нескольких вкладках
      icon: new URL("assets/img/favicon.svg", ROOT).href,
    });
    n.onclick = () => { window.open(twitchUrl(), "_blank", "noopener"); n.close(); };
  } catch { /* Chrome на Android требует service worker — там остаётся календарь */ }
}

function checkReminders() {
  const run = () => {
    const now = Date.now();
    const list = readReminders();
    let changed = false;
    for (const r of list) {
      const left = Date.parse(r.startsAt) - now;
      if (!r.fired && left <= REMIND_BEFORE && left > -15 * 60_000) {
        r.fired = true;
        changed = true;
        fire(r, now);
      }
    }
    const kept = list.filter((r) => Date.parse(r.startsAt) > now - 3 * 3600_000); // старые убираем
    if (changed || kept.length !== list.length) writeReminders(kept);
  };
  // несколько вкладок: проверяет та, что первой взяла замок
  if (navigator.locks?.request) navigator.locks.request("ndze-stx-remind", { ifAvailable: true }, (lock) => { if (lock) run(); }).catch(run);
  else run();
}

/** Запустить проверку напоминаний на этой вкладке (раз в 30 с). Повторный вызов ничего не делает. */
export function startReminders() {
  if (window.__stxRemindTimer) return;
  if (!readReminders().length) {
    // нечего ждать — не держим таймер; запустимся, когда напоминание поставят здесь или в другой вкладке
    if (!window.__stxRemindWait) {
      window.__stxRemindWait = true;
      window.addEventListener("storage", (e) => { if (e.key === REMIND_KEY) startReminders(); });
    }
    return;
  }
  window.__stxRemindTimer = setInterval(checkReminders, REMIND_EVERY);
  checkReminders();
}

/* ---------- Разметка ---------- */
export function countdownHTML(ms) {
  const { d, h, m, s } = splitLeft(ms);
  const cell = (u, v, label) => `<span class="stx-cd-cell"><b data-u="${u}">${pad(v)}</b><small>${label}</small></span>`;
  return `<div class="stx-cd${ms <= 0 ? " is-zero" : ""}" role="timer" aria-label="До начала: ${d} дн ${h} ч ${m} мин">
    ${cell("d", d, "дн")}<i aria-hidden="true">:</i>${cell("h", h, "ч")}<i aria-hidden="true">:</i>${cell("m", m, "мин")}<i aria-hidden="true">:</i>${cell("s", s, "сек")}</div>`;
}

/** Обновить цифры отсчёта без перерисовки (раз в секунду). */
export function updateCountdown(box, ms) {
  const cd = box.querySelector(".stx-cd");
  if (!cd) return;
  const v = splitLeft(ms);
  for (const u of ["d", "h", "m", "s"]) {
    const el = cd.querySelector(`[data-u="${u}"]`);
    const txt = pad(v[u]);
    if (el && el.textContent !== txt) el.textContent = txt;
  }
  cd.classList.toggle("is-zero", ms <= 0);
  if (v.s === 0) cd.setAttribute("aria-label", `До начала: ${v.d} дн ${v.h} ч ${v.m} мин`);
}

function remindBtn(ev) {
  const on = hasReminder(ev.id);
  return `<button class="btn ${on ? "btn-ghost" : "btn-primary"} btn-sm stx-remind" type="button" data-remind="${esc(ev.id)}" aria-pressed="${on}">
    ${on ? "✓ Напомню за 10 мин" : "🔔 Напомнить"}</button>`;
}

function cardHTML(data, live, { more = 3 } = {}) {
  const channel = data?.channel || live?.channel || SITE.twitch.channel;
  const next = data?.next || null;
  const rest = (data?.items || []).filter((e) => e.id !== next?.id).slice(0, more);
  const restHTML = rest.length
    ? `<ul class="stx-next-list">${rest.map((e) => `<li><time datetime="${esc(e.startsAt)}">${esc(weekday(e.startsAt))} ${esc(shortDay(e.startsAt))} · ${esc(timeText(e.startsAt))}</time><span>${esc(e.title)}${e.game ? ` · ${esc(e.game)}` : ""}</span></li>`).join("")}</ul>`
    : "";

  if (live?.live) {
    const what = [live.title, live.game].filter(Boolean);
    return `<div class="stx-card-top"><span class="stx-kicker is-live"><span class="live-dot" aria-hidden="true"></span>Сейчас в эфире</span>
        ${live.uptime ? `<span class="stx-faint">идёт ${esc(live.uptime)}</span>` : ""}</div>
      <h3>${esc(what[0] || `${SITE.nick} в эфире`)}</h3>
      ${what[1] ? `<span class="stx-game">${esc(what[1])}</span>` : ""}
      <div class="stx-actions"><a class="btn stx-btn-twitch btn-sm" href="${esc(twitchUrl(channel))}" target="_blank" rel="noopener">Смотреть на Twitch ↗</a></div>
      ${next && !next.isNow ? `<p class="stx-faint">Следующий: ${esc(next.title)} — ${esc(whenText(next.startsAt))}</p>` : restHTML}`;
  }
  if (!next) {
    return `<span class="stx-kicker">📅 Следующий стрим</span>
      <h3>Скоро в расписании</h3>
      <p class="stx-muted">Ближайшие стримы ещё не запланированы. Обычно: ${esc(SITE.schedule.replace(/^Стримы:\s*/i, ""))}.</p>
      <div class="stx-actions"><a class="btn btn-ghost btn-sm" href="${esc(twitchUrl(channel))}" target="_blank" rel="noopener">Подписаться на Twitch ↗</a></div>`;
  }
  const ms = Date.parse(next.startsAt) - Date.now();
  return `<div class="stx-card-top"><span class="stx-kicker">📅 ${next.isNow ? "Стрим вот-вот начнётся" : "Следующий стрим через"}</span>
      ${next.game ? `<span class="stx-game">${esc(next.game)}</span>` : ""}</div>
    ${countdownHTML(ms)}
    <h3>${esc(next.title)}</h3>
    <p class="stx-when">${esc(whenText(next.startsAt))}${next.note ? ` · ${esc(next.note)}` : ""}</p>
    <div class="stx-actions">
      <a class="btn btn-ghost btn-sm" href="${esc(icsUrl())}" download="ndze-streams.ics">📅 В календарь</a>
      ${next.isNow ? `<a class="btn stx-btn-twitch btn-sm" href="${esc(twitchUrl(channel))}" target="_blank" rel="noopener">Открыть Twitch ↗</a>` : remindBtn(next)}
    </div>
    ${restHTML}`;
}

/* ---------- Модуль ---------- */
export function mount(container, ctx = {}) {
  ensureCss("streamtools.css");
  startReminders();
  const card = document.createElement("article");
  card.className = "card glass stx-card stx-sched";
  card.innerHTML = '<div class="skeleton" style="min-height:220px"></div>';
  container.append(card);

  let data = null;
  let live = null;
  let reloading = false;
  let dead = false;

  const render = () => {
    if (dead) return;
    card.classList.toggle("is-live", !!live?.live);
    card.innerHTML = cardHTML(data, live, { more: ctx.more ?? 3 });
  };

  async function load() {
    try {
      data = await apiCall("schedule");
    } catch (e) {
      data = null;
      if (e.code !== "validation") console.warn("[ndze] расписание:", e.message);
    }
    if (api.mode === "php" && typeof api.live === "function") live = await api.live().catch(() => live);
    render();
  }

  // каждую секунду — только цифры; когда отсчёт дошёл до нуля — перезапрашиваем (стрим начался)
  const tick = setInterval(() => {
    const next = data?.next;
    if (!next || live?.live) return;
    const ms = Date.parse(next.startsAt) - Date.now();
    updateCountdown(card, ms);
    const end = Date.parse(next.endsAt) - Date.now();
    if ((ms <= 0 && !next.isNow) || end <= 0) {
      if (reloading) return;
      reloading = true;
      load().finally(() => { setTimeout(() => { reloading = false; }, 30_000); });
    }
  }, 1000);
  const refresh = setInterval(load, 5 * 60_000);
  const onLive = (e) => { live = e.detail; render(); };
  window.addEventListener("ndze:live", onLive);

  card.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-remind]");
    if (!btn) return;
    const ev = data?.next?.id === btn.dataset.remind ? data.next : (data?.items || []).find((x) => x.id === btn.dataset.remind);
    if (!ev) return;
    if (hasReminder(ev.id)) {
      removeReminder(ev.id);
      toast("Напоминание убрано");
    } else {
      btn.disabled = true;
      await addReminder(ev);
    }
    render();
  });

  load();
  return {
    destroy() {
      dead = true;
      clearInterval(tick);
      clearInterval(refresh);
      window.removeEventListener("ndze:live", onLive);
    },
  };
}

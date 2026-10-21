// «Стримы»: следующий эфир с отсчётом (модуль home/schedule.js), расписание на две недели,
// цели канала и архив прошедших эфиров с таймкодами (клик — запись с нужной секунды).
import { mountLayout } from "../core/layout.js";
import { apiCall } from "../data/api.js";
import { $, esc, formatDate, plural } from "../core/util.js";
import { mount as mountNext, icsUrl, timeText, shortDay, weekday, startReminders } from "../home/schedule.js";
import { goalsHTML, animateBars } from "../home/channel.js";

await mountLayout("streams");
startReminders();

const KIND = { moment: ["⚡", "Момент"], task: ["🎯", "Задание"], work: ["🖼", "Разбор работы"] };
const errHTML = (e) => `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(e?.message || "Не удалось загрузить")}</p></div>`;

/** Ссылка на запись с нужного места: Twitch ?t=1h2m3s, YouTube &t=3723s. Только канонические ссылки сервера. */
function vodAt(url, sec) {
  if (typeof url !== "string") return null;
  const s = Math.max(0, Math.floor(sec));
  if (/^https:\/\/www\.twitch\.tv\/videos\/\d+$/.test(url)) {
    return `${url}?t=${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
  }
  if (/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(url)) return `${url}&t=${s}s`;
  return null;
}

/* ---------- Расписание ---------- */
mountNext($("#nextBox"), { more: 0 });
$("#icsAll").href = icsUrl();

async function renderWeek() {
  const box = $("#week");
  let data;
  try { data = await apiCall("schedule"); } catch (e) { box.innerHTML = errHTML(e); return; }
  const items = data.items || [];
  box.innerHTML = `<h3>Ближайшие две недели</h3>
    ${items.length ? `<ol>${items.map((e) => `<li class="stx-week-row${e.isNow ? " is-now" : ""}">
        <span class="stx-week-date"><b>${esc(e.isNow ? "Сейчас" : weekday(e.startsAt))}</b><small>${esc(shortDay(e.startsAt))} · ${esc(timeText(e.startsAt))}</small></span>
        <span class="stx-week-text"><b>${esc(e.title)}</b><small>${[e.game, e.note].filter(Boolean).map(esc).join(" · ") || `${Math.round(e.durationMin / 60 * 10) / 10} ч`}</small></span>
        <a class="btn btn-ghost btn-xs stx-ics-btn" href="${esc(icsUrl(e.id))}" download="ndze-stream.ics" title="Добавить в календарь" aria-label="Добавить «${esc(e.title)}» в календарь">📅</a>
      </li>`).join("")}</ol>`
      : `<p class="stx-muted">На ближайшие две недели стримов не запланировано — загляни позже или включи уведомления о начале эфира в личном кабинете.</p>`}
    <p class="stx-faint">Время московское. Файл .ics открывается в Google Календаре, Apple Календаре и Outlook.</p>`;
}

/* ---------- Цели ---------- */
async function renderGoals() {
  const box = $("#goalsBox");
  let data;
  try { data = await apiCall("goals"); } catch (e) { box.innerHTML = errHTML(e); return; }
  const items = data.items || [];
  box.innerHTML = items.length ? goalsHTML(items, { fill: false }) : '<p class="stx-muted">Целей пока нет — скоро появятся.</p>';
  animateBars(box);
}

/* ---------- Архив ---------- */
let page = 0;
let pages = 1;

function streamHTML(s) {
  const marks = s.marks || [];
  const markHTML = (m) => {
    const [icon, kindLabel] = KIND[m.kind] || KIND.moment;
    const href = s.vodUrl ? vodAt(s.vodUrl, m.at) : null;
    const inner = `<span class="stx-mark-at">${esc(m.atText)}</span><span class="stx-mark-kind" title="${esc(kindLabel)}" aria-label="${esc(kindLabel)}">${icon}</span><span class="stx-mark-label">${esc(m.label)}</span>`;
    return `<li>${href ? `<a class="stx-mark" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="stx-mark">${inner}</span>`}</li>`;
  };
  const vodLabel = s.vodKind === "youtube" ? "Запись на YouTube ↗" : "Запись на Twitch ↗";
  return `<article class="glass stx-arch" id="s-${esc(s.id)}">
    <div class="stx-arch-head">
      <div><h3>${esc(s.title)}</h3>
        <div class="stx-arch-meta"><time datetime="${esc(s.startedAt)}">${esc(formatDate(s.startedAt))}, ${esc(timeText(s.startedAt))} МСК</time>
          ${s.game ? `<span class="stx-game">${esc(s.game)}</span>` : ""}
          ${marks.length ? `<span>· ${marks.length} ${plural(marks.length, ["таймкод", "таймкода", "таймкодов"])}</span>` : ""}</div></div>
      ${s.vodUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(s.vodUrl)}" target="_blank" rel="noopener">${vodLabel}</a>` : '<span class="stx-faint">Записи нет</span>'}
    </div>
    ${s.summary ? `<p class="stx-arch-sum">${esc(s.summary)}</p>` : ""}
    ${marks.length ? `<ol class="stx-marks${marks.length > 6 ? " is-collapsed" : ""}">${marks.map(markHTML).join("")}</ol>
      ${marks.length > 6 ? `<button class="btn btn-ghost btn-xs" type="button" data-expand>Все таймкоды (${marks.length})</button>` : ""}` : ""}
  </article>`;
}

async function loadArchive() {
  const list = $("#arcList");
  const more = $("#arcMore");
  more.disabled = true;
  let data;
  try {
    data = await apiCall("archive", { query: { page: page + 1 } });
  } catch (e) {
    if (!page) list.innerHTML = errHTML(e);
    more.disabled = false;
    return;
  }
  page = data.page;
  pages = data.pages;
  if (page === 1) list.innerHTML = "";
  if (!data.total) list.innerHTML = '<div class="empty"><span class="empty-icon">📼</span><p>Архив пока пуст — первые эфиры с таймкодами появятся после ближайших стримов.</p></div>';
  else list.insertAdjacentHTML("beforeend", data.items.map(streamHTML).join(""));
  $("#arcCount").textContent = data.total ? `${data.total} ${plural(data.total, ["эфир", "эфира", "эфиров"])}` : "";
  more.hidden = page >= pages;
  more.disabled = false;
}

$("#arcMore").addEventListener("click", loadArchive);
$("#arcList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-expand]");
  if (!btn) return;
  btn.previousElementSibling?.classList.remove("is-collapsed");
  btn.remove();
});

renderWeek();
renderGoals();
loadArchive();
setInterval(renderWeek, 5 * 60_000);

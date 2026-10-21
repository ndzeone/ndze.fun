// «Сейчас на канале» → зритель дня (самый активный за московские сутки) и цели канала пиксельными полосами.
// goalsHTML / viewerHTML используют страница streams.html и оверлеи.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, avatarHTML, plural } from "../core/util.js";

const nf = new Intl.NumberFormat("ru-RU");
export const num = (n) => nf.format(n);

/* ---------- Цели ---------- */
/** Одна цель: заголовок, «12 / 50 сабов», полоса. fill=false — полоса пустая (для анимации заполнения). */
export function goalHTML(g, { fill = true, tag = "li" } = {}) {
  const p = Math.max(0, Math.min(100, Number(g.percent) || 0));
  const unit = g.unit ? ` ${esc(g.unit)}` : "";
  return `<${tag} class="stx-goal${g.reached ? " is-reached" : ""}${g.status === "done" ? " is-done" : ""}" data-goal="${esc(g.id)}">
    <div class="stx-goal-head"><b>${esc(g.title)}</b><span class="stx-goal-num">${num(g.current)} / ${num(g.target)}${unit}</span></div>
    <div class="stx-bar" role="progressbar" aria-label="${esc(g.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><i style="--p:${fill ? p : 0}%" data-p="${p}"></i></div>
    ${g.reached ? '<span class="stx-goal-done">★ Цель достигнута!</span>' : ""}
  </${tag}>`;
}

export function goalsHTML(items, { limit = 99, fill = true } = {}) {
  return `<ul class="stx-goals">${items.slice(0, limit).map((g) => goalHTML(g, { fill })).join("")}</ul>`;
}

/** Запустить заполнение полос, отрисованных с fill=false (после кадра, чтобы сработал transition). */
export function animateBars(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll(".stx-bar > i[data-p]").forEach((i) => i.style.setProperty("--p", `${Number(i.dataset.p) || 0}%`));
  }));
}

/* ---------- Зритель дня ---------- */
export const BREAKDOWN = {
  submissions: ["🖼", ["работа", "работы", "работ"]],
  tasks: ["📜", ["задание", "задания", "заданий"]],
  taskVotes: ["▲", ["голос за задания", "голоса за задания", "голосов за задания"]],
  battleVotes: ["⚔", ["голос в битве", "голоса в битве", "голосов в битве"]],
  bets: ["🔮", ["ставка", "ставки", "ставок"]],
  pixels: ["🎨", ["пиксель", "пикселя", "пикселей"]],
  forumThreads: ["💬", ["тема на форуме", "темы на форуме", "тем на форуме"]],
  forumPosts: ["💬", ["ответ на форуме", "ответа на форуме", "ответов на форуме"]],
  comments: ["🗨", ["комментарий", "комментария", "комментариев"]],
};
export const points = (n) => `${num(n)} ${plural(n, ["очко", "очка", "очков"])}`;

export function breakdownHTML(bd = {}) {
  return Object.entries(bd).filter(([k, n]) => BREAKDOWN[k] && n > 0)
    .map(([k, n]) => `<span class="stx-chip">${BREAKDOWN[k][0]} ${num(n)} ${esc(plural(n, BREAKDOWN[k][1]))}</span>`).join("");
}

export function viewerHTML(data) {
  const top = data?.top;
  if (!top) {
    return `<span class="stx-kicker">⭐ Зритель дня</span>
      <h3>Место свободно</h3>
      <p class="stx-muted">Сегодня ещё никто не отметился. Пришли работу, предложи задание или проголосуй — и корона твоя до полуночи.</p>`;
  }
  const u = top.user;
  const rest = (data.list || []).slice(1);
  return `<span class="stx-kicker">⭐ Зритель дня</span>
    <div class="stx-viewer-top">
      <span class="stx-viewer-ava">${avatarHTML(u.nick, u.avatarUrl, { size: "lg", extra: u.frame ? `frame-${u.frame}` : "" })}</span>
      <span class="stx-viewer-name"><b>${esc(u.nick)}</b><small>${points(top.score)} за сегодня</small></span>
    </div>
    <div class="stx-chips">${breakdownHTML(top.breakdown)}</div>
    ${rest.length ? `<ol class="stx-rank" start="2">${rest.map((r, i) => `<li><span class="stx-place">${i + 2}</span>${avatarHTML(r.user.nick, r.user.avatarUrl, { size: "sm" })}
      <span class="stx-rank-nick">${esc(r.user.nick)}</span><span class="stx-rank-score">${num(r.score)}</span></li>`).join("")}</ol>` : ""}
    <p class="stx-faint">Очки за сегодня с полуночи по Москве: работы, задания, голоса, ставки, холст и форум.</p>`;
}

/* ---------- Модуль ---------- */
export function mount(container, ctx = {}) {
  ensureCss("streamtools.css");
  const box = document.createElement("div");
  box.className = "stx-mod";
  box.innerHTML = `<article class="card glass stx-card stx-viewer" aria-live="polite"><div class="skeleton" style="min-height:160px"></div></article>
    <article class="card glass stx-card stx-goals-card" hidden></article>`;
  container.append(box);
  const vCard = box.querySelector(".stx-viewer");
  const gCard = box.querySelector(".stx-goals-card");
  let dead = false;
  let firstGoals = true;

  async function load() {
    const [viewer, goals] = await Promise.all([
      apiCall("viewer/today").catch(() => null),
      apiCall("goals").catch(() => null),
    ]);
    if (dead) return;
    vCard.innerHTML = viewerHTML(viewer);
    const active = (goals?.items || []).filter((g) => g.status === "active");
    gCard.hidden = !active.length;
    if (active.length) {
      gCard.innerHTML = `<div class="stx-card-top"><span class="stx-kicker">🎯 Цели канала</span><a class="cc-go" href="streams.html#goals">Все цели →</a></div>
        ${goalsHTML(active, { limit: 4, fill: !firstGoals })}`;
      if (firstGoals) animateBars(gCard);
      firstGoals = false;
    }
  }

  load();
  const timer = setInterval(load, 60_000);
  return { destroy() { dead = true; clearInterval(timer); } };
}

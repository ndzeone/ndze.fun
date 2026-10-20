// «Движ»: битва работ, ставки баллами, общий холст, лидеры и мини-игра.
// Холст (core/place.js) и игра (core/runner.js) — отдельные модули, грузятся при открытии вкладки.
import { mountLayout, onUserChange, getUser, openAuth } from "../core/layout.js";
import { api } from "../data/api.js";
import { CATEGORIES, byId } from "../data/constants.js";
import { $, $$, esc, avatarHTML, plural, timeAgo, toast, motion, wait } from "../core/util.js";
import { initMagnetic } from "../core/fx.js";

await mountLayout("play");

const TABS = [
  { id: "battle", label: "Битва работ", icon: "⚔" },
  { id: "bets", label: "Ставки", icon: "🔮" },
  { id: "canvas", label: "Холст", icon: "🎨" },
  { id: "leaders", label: "Лидеры", icon: "🏆" },
  { id: "game", label: "Игра", icon: "🕷" },
];
const panel = $("#playPanel");
let tab = TABS.some((t) => `#${t.id}` === location.hash) ? location.hash.slice(1) : "battle";
let mounted = null; // { destroy() } смонтированного модуля (холст, игра)
let seq = 0;

$("#playTabs").innerHTML = TABS.map((t) => `<button type="button" role="tab" id="ptab-${t.id}" data-tab="${t.id}" aria-controls="playPanel">
  <span aria-hidden="true">${t.icon}</span>${esc(t.label)}</button>`).join("");

const loginBtn = (reason, label = "Войти") => `<button class="btn btn-primary btn-sm" type="button" data-open-auth="login" data-reason="${esc(reason)}">${esc(label)}</button>`;
const errorHTML = (err) => `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message || "Не удалось загрузить")}</p></div>`;

async function show(next, { focus = false } = {}) {
  tab = next;
  const my = ++seq;
  history.replaceState(history.state, "", `#${tab}`);
  $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  panel.setAttribute("aria-labelledby", `ptab-${tab}`);
  mounted?.destroy?.();
  mounted = null;
  panel.innerHTML = '<div class="skeleton py-skel"></div>';
  panel.classList.remove("is-in");
  void panel.offsetWidth;
  panel.classList.add("is-in");
  try {
    if (tab === "battle") await renderBattle(my);
    else if (tab === "bets") await renderBets(my);
    else if (tab === "leaders") await renderLeaders(my);
    else await mountModule(my, tab);
  } catch (err) {
    if (my === seq) panel.innerHTML = errorHTML(err);
  }
  if (my === seq) initMagnetic();
  if (focus) $(`[data-tab="${tab}"]`)?.focus();
}

async function mountModule(my, which) {
  const box = document.createElement("div");
  const mod = which === "canvas" ? await import("../core/place.js") : await import("../core/runner.js");
  if (my !== seq) return;
  panel.replaceChildren(box);
  mounted = which === "canvas" ? mod.mountPlace(box) : mod.mountRunner(box);
}

/* ================= Битва работ ================= */
let battlePair = null;
let battleBusy = false;

function leanCardHTML(s, side) {
  const cat = byId(CATEGORIES, s.category)?.label || "";
  return `<button class="bt-card glass" type="button" data-vote="${side}" aria-label="Голос за «${esc(s.title)}»">
    <span class="bt-img">${s.imageUrl ? `<img src="${esc(s.imageUrl)}" alt="" loading="lazy" decoding="async">` : "🖼"}</span>
    <span class="bt-info">
      <strong>${esc(s.title)}</strong>
      <span class="bt-author">${avatarHTML(s.authorNick, s.authorAvatar, { size: "xs" })}@${esc(s.authorNick)}${cat ? ` · ${esc(cat)}` : ""}</span>
      <span class="bt-rating" title="Рейтинг в битве">⚡ ${s.rating} · ${s.wins}–${s.losses}</span>
    </span>
    <span class="bt-pick" aria-hidden="true">Эта лучше!</span>
  </button>`;
}

function topRowHTML(s, i) {
  return `<li class="bt-top-row"><span class="bt-place">${i + 1}</span>
    <span class="bt-thumb">${s.imageUrl ? `<img src="${esc(s.imageUrl)}" alt="" loading="lazy">` : ""}</span>
    <span class="bt-top-text"><b>${esc(s.title)}</b><small>@${esc(s.authorNick)}</small></span>
    <span class="bt-top-score">⚡ ${s.rating}</span></li>`;
}

async function renderBattle(my) {
  const [pairData, top] = await Promise.all([api.battlePair(), api.battleTop()]);
  if (my !== seq) return;
  battlePair = pairData.pair;
  const user = getUser();
  let arena;
  if (pairData.pair) {
    arena = `<div class="bt-arena">${leanCardHTML(pairData.pair[0], 0)}<span class="bt-vs" aria-hidden="true">VS</span>${leanCardHTML(pairData.pair[1], 1)}</div>
      <p class="py-hint">${user ? "Кликни по работе, которая нравится больше. Голос двигает её рейтинг вверх." : "Войди, чтобы голосовать — иначе будет слишком просто накрутить."}</p>`;
  } else if (pairData.allVoted) {
    arena = `<div class="empty"><span class="empty-icon">⚖</span><p>Ты оценил все пары! Загляни, когда в галерее появятся новые работы.</p></div>`;
  } else {
    arena = `<div class="empty"><span class="empty-icon">⚔</span><p>Для битвы нужно хотя бы две работы со статусом «Идеал» — сейчас их ${pairData.total}.</p>
      <a class="btn btn-primary btn-sm" href="review.html">Прислать работу</a></div>`;
  }
  const week = top.week;
  panel.innerHTML = `<div class="py-grid">
    <section class="py-main" aria-labelledby="btTitle">
      <h2 id="btTitle" class="py-title">Какая работа круче?</h2>
      ${arena}
    </section>
    <aside class="py-side">
      <article class="glass py-box bt-week">
        <h3>👑 Работа недели</h3>
        ${week ? `<div class="bt-week-card">${week.imageUrl ? `<img src="${esc(week.imageUrl)}" alt="" loading="lazy">` : ""}
          <b>${esc(week.title)}</b><small>@${esc(week.authorNick)} · ${week.weekWins} ${plural(week.weekWins, ["победа", "победы", "побед"])} за неделю</small></div>`
          : `<p class="muted">Пока никто не побеждал на этой неделе — голосуй!</p>`}
      </article>
      <article class="glass py-box">
        <h3>Топ по рейтингу</h3>
        ${top.top.length ? `<ol class="bt-top">${top.top.map(topRowHTML).join("")}</ol>` : `<p class="muted">Рейтинг появится после первых голосов.</p>`}
      </article>
    </aside>
  </div>`;
}

panel.addEventListener("click", async (e) => {
  const card = e.target.closest("[data-vote]");
  if (!card || battleBusy || !battlePair) return;
  if (!getUser()) return openAuth("login", "Войди, чтобы голосовать в битве работ");
  const side = Number(card.dataset.vote);
  const winner = battlePair[side];
  const loser = battlePair[1 - side];
  battleBusy = true;
  card.classList.add("is-winner");
  $(`[data-vote="${1 - side}"]`, panel)?.classList.add("is-loser");
  try {
    const r = await api.battleVote(winner.id, loser.id);
    card.insertAdjacentHTML("beforeend", `<span class="bt-delta">+${r.delta}</span>`);
    if (motion) await wait(900);
    await renderBattle(seq);
  } catch (err) {
    toast(err.message, "error");
    card.classList.remove("is-winner");
    $$(".is-loser", panel).forEach((x) => x.classList.remove("is-loser"));
  } finally {
    battleBusy = false;
  }
});

/* ================= Ставки ================= */
const STATUS = {
  open: { label: "Приём ставок", tone: "lime" },
  locked: { label: "Ставки закрыты", tone: "warn" },
  resolved: { label: "Итоги", tone: "info" },
  cancelled: { label: "Отменено", tone: "plain" },
};
let betsData = null;

function predictionHTML(p) {
  const st = STATUS[p.status] || STATUS.open;
  const canBet = p.status === "open" && !p.myBet && getUser() && betsData.balance >= 10;
  const opts = p.options.map((o, i) => {
    const pct = p.totalPool ? Math.round((o.pool / p.totalPool) * 100) : 0;
    const win = p.status === "resolved" && p.result === i;
    const mine = p.myBet?.option === i;
    const odds = o.pool ? (p.totalPool / o.pool).toFixed(2) : "—";
    return `<li class="bet-opt${win ? " is-win" : ""}${mine ? " is-mine" : ""}">
      ${canBet ? `<input type="radio" name="opt-${esc(p.id)}" id="o-${esc(p.id)}-${i}" value="${i}"${i === 0 ? " checked" : ""}>` : ""}
      <label ${canBet ? `for="o-${esc(p.id)}-${i}"` : ""}>
        <span class="bet-bar" style="width:${pct}%"></span>
        <span class="bet-text">${win ? "✓ " : ""}${esc(o.text)}${mine ? ' <em>· твоя ставка</em>' : ""}</span>
        <span class="bet-num">${pct}% · ${o.bettors} · ×${odds}</span>
      </label>
    </li>`;
  }).join("");
  let foot = "";
  if (p.myBet) {
    const res = p.myBet.payout === null ? "ждёт итогов"
      : p.myBet.payout > p.myBet.amount ? `выигрыш +${p.myBet.payout - p.myBet.amount} 🎉`
        : p.myBet.payout === p.myBet.amount ? "ставка вернулась" : "не повезло";
    foot = `<p class="bet-mine">Твоя ставка: <b>${p.myBet.amount}</b> на «${esc(p.options[p.myBet.option]?.text || "?")}» — ${res}</p>`;
  } else if (canBet) {
    foot = `<form class="bet-form" data-bet="${esc(p.id)}">
      <label class="bet-amount"><span>Ставка</span><input type="number" name="amount" min="10" max="${betsData.balance}" step="10" value="${Math.min(100, betsData.balance)}" inputmode="numeric"></label>
      <div class="bet-quick">${[50, 100, 250].filter((v) => v <= betsData.balance).map((v) => `<button class="chip" type="button" data-amount="${v}">${v}</button>`).join("")}<button class="chip" type="button" data-amount="${betsData.balance}">Всё</button></div>
      <button class="btn btn-primary btn-sm" type="submit"><span>Поставить</span><span class="spinner" aria-hidden="true"></span></button>
    </form>`;
  } else if (p.status === "open" && !getUser()) foot = `<p class="py-hint">${loginBtn("Войди, чтобы ставить баллы", "Войти и поставить")}</p>`;
  return `<article class="bet glass" data-id="${esc(p.id)}">
    <header class="bet-head"><span class="badge ${st.tone}">${esc(st.label)}</span><span class="faint">банк ${p.totalPool} · ${esc(timeAgo(p.createdAt))}</span></header>
    <h3>${esc(p.question)}</h3>
    <ul class="bet-opts">${opts}</ul>
    ${foot}
  </article>`;
}

async function renderBets(my) {
  betsData = await api.predictions();
  if (my !== seq) return;
  const user = getUser();
  panel.innerHTML = `<div class="bets-top glass">
      <div><h2 class="py-title">Ставки на стрим</h2>
      <p class="muted">Только сайтовые баллы, никаких денег. У каждого ${betsData.start} стартовых баллов; угадавшие делят весь банк пропорционально ставкам.</p></div>
      <div class="bets-balance">${user ? `<span>Твой баланс</span><b>${betsData.balance}</b><small>баллов</small>` : loginBtn("Войди, чтобы получить 1000 баллов и ставить", "Получить 1000 баллов")}</div>
    </div>
    ${betsData.items.length ? `<div class="bets-list">${betsData.items.map(predictionHTML).join("")}</div>`
      : `<div class="empty"><span class="empty-icon">🔮</span><p>Сейчас открытых ставок нет — они появляются во время стримов.</p></div>`}`;
}

panel.addEventListener("click", (e) => {
  const q = e.target.closest("[data-amount]");
  if (!q) return;
  const input = q.closest("form")?.elements.amount;
  if (input) input.value = q.dataset.amount;
});

panel.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-bet]");
  if (!form) return;
  e.preventDefault();
  const btn = $('button[type="submit"]', form);
  const option = form.closest(".bet").querySelector("input[type=radio]:checked")?.value;
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    const r = await api.placeBet(form.dataset.bet, option, form.elements.amount.value);
    betsData.balance = r.balance;
    betsData.items = betsData.items.map((p) => (p.id === r.item.id ? r.item : p));
    toast("Ставка принята 🔮");
    await renderBets(seq);
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
});

/* ================= Лидеры ================= */
async function renderLeaders(my) {
  const [list, game] = await Promise.all([api.leaderboard(), api.gameTop().catch(() => ({ all: [] }))]);
  if (my !== seq) return;
  const me = getUser();
  const row = (r, i) => `<li class="ld-row${me?.id === r.user.id ? " is-me" : ""}">
    <span class="ld-place">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</span>
    ${avatarHTML(r.user.nick, r.user.avatarUrl, { size: "sm" })}
    <span class="ld-name"><b>${esc(r.user.nick)}</b><small>${esc(r.title)} · ${r.badges} ${plural(r.badges, ["значок", "значка", "значков"])}</small></span>
    <span class="ld-level">ур. ${r.level}</span>
    <span class="ld-xp">${r.xp} XP</span>
  </li>`;
  const gameRow = (r, i) => `<li class="ld-row${me?.id === r.user.id ? " is-me" : ""}"><span class="ld-place">${i + 1}</span>
    ${avatarHTML(r.user.nick, r.user.avatarUrl, { size: "sm" })}<span class="ld-name"><b>${esc(r.user.nick)}</b></span><span class="ld-xp">${r.score}</span></li>`;
  panel.innerHTML = `<div class="py-grid">
    <section class="py-main glass py-box" aria-labelledby="ldTitle">
      <h2 id="ldTitle" class="py-title">Зал славы</h2>
      <p class="muted">Опыт за работы, «идеалы», задания, голоса, ставки, пиксели и рекорды. Подробности и значки — в <a class="py-link" href="profile.html">личном кабинете</a>.</p>
      ${list.length ? `<ol class="ld-list">${list.map(row).join("")}</ol>` : `<div class="empty"><span class="empty-icon">🏆</span><p>Пока пусто — будь первым!</p></div>`}
    </section>
    <aside class="py-side">
      <article class="glass py-box"><h3>🕷 Рекорды забега</h3>
        ${game.all?.length ? `<ol class="ld-list compact">${game.all.slice(0, 5).map(gameRow).join("")}</ol>` : `<p class="muted">Ещё никто не бегал по крышам.</p>`}
        <button class="btn btn-ghost btn-sm" type="button" data-goto="game">Играть →</button>
      </article>
    </aside>
  </div>`;
}

panel.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) show(g.dataset.goto, { focus: true });
});

/* ================= Вкладки ================= */
$("#playTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b && b.dataset.tab !== tab) show(b.dataset.tab);
});
$("#playTabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const i = TABS.findIndex((t) => t.id === tab);
  show(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id, { focus: true });
});
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (h !== tab && TABS.some((t) => t.id === h)) show(h);
});
// вход/выход меняет кнопки и балансы — перерисуем текущую вкладку (холст и игра следят за входом сами)
onUserChange(() => { if (tab === "battle" || tab === "bets" || tab === "leaders") show(tab); });

show(tab);

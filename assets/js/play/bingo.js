// Вкладка «Бинго» (play.html#bingo): личная карточка 5×5 (сервер считает её из sha256(раунд + игрок)),
// ведущий отмечает случившиеся события — клетки загораются сами (опрос каждые 5 с). Линия → «БИНГО!».
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, plural, avatarHTML } from "../core/util.js";

ensureCss("interactive.css");

const REFRESH_MS = 5000;
const LINES = (() => {
  const l = [];
  for (let i = 0; i < 5; i++) {
    l.push([0, 1, 2, 3, 4].map((k) => i * 5 + k));
    l.push([0, 1, 2, 3, 4].map((k) => i + k * 5));
  }
  l.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
  return l;
})();

export function mount(root, ctx) {
  const user = ctx.user || null;
  let round = null;
  let last = "";
  let seen = null; // отмеченные события на прошлой отрисовке (для анимации «штампа»)
  let busy = false;
  let timer = 0;
  root.classList.add("ix", "ix-bingo");

  function boardHTML(r) {
    const on = new Set(r.marked);
    const hit = (k) => r.card[k] === null || on.has(r.card[k]);
    const lineCells = new Set(LINES.filter((l) => l.every(hit)).flat());
    return `<div class="ix-board ix-px" role="grid" aria-label="Твоя карточка бинго">${r.card.map((idx, k) => {
      if (idx === null) return `<div class="ix-cell is-free${lineCells.has(k) ? " is-line" : ""}" role="gridcell" aria-label="Свободная клетка"><div><span aria-hidden="true">🕷</span>FREE</div></div>`;
      const marked = on.has(idx);
      const fresh = marked && seen && !seen.has(idx);
      const cls = `ix-cell${marked ? " is-on" : ""}${fresh ? " is-new" : ""}${lineCells.has(k) ? " is-line" : ""}`;
      return `<div class="${cls}" role="gridcell" aria-label="${esc(r.items[idx])}${marked ? " — случилось" : ""}">${esc(r.items[idx])}</div>`;
    }).join("")}</div>`;
  }

  function sideHTML(r) {
    const open = r.status === "open";
    let action = "";
    if (!user) {
      action = `<div class="ix-login"><p>Войди — и получишь свою карточку. У каждого она своя!</p>
        <button class="ix-pbtn ix-px is-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы играть в стрим-бинго">Войти</button></div>`;
    } else if (r.myPlace) {
      action = `<div class="ix-winner"><span style="font-size:1.8rem" aria-hidden="true">🎱</span><div><small>Ты собрал бинго</small><b>${r.myPlace} место</b></div></div>`;
    } else if (open) {
      action = `<button class="ix-pbtn ix-px is-red ix-bingo-btn" type="button" data-claim="${esc(r.id)}"${r.canClaim ? "" : " disabled"}>
        <span>БИНГО!</span><span class="spinner" aria-hidden="true"></span></button>
        <p class="ix-note">${r.canClaim ? "У тебя полная линия — жми, пока другие не успели!" : "Собери линию: строку, столбец или диагональ."}</p>`;
    }
    const winners = r.claims.length
      ? `<ol class="ix-winners">${r.claims.map((c) => `<li><span class="ix-place">${c.place <= 3 ? ["🥇", "🥈", "🥉"][c.place - 1] : c.place}</span>
          ${avatarHTML(c.user.nick, c.user.avatarUrl, { size: "xs" })}<b>${esc(c.user.nick)}</b><span class="ix-prize">+${c.prize}</span></li>`).join("")}</ol>`
      : `<p class="ix-note">Пока никто не собрал линию.</p>`;
    const marked = new Set(r.marked);
    return `<div class="ix-card glass">
        ${action}
        <h3 class="ix-sub">Победители</h3>${winners}
      </div>
      <div class="ix-card glass">
        <h3 class="ix-sub">События · ${r.marked.length}/${r.items.length}</h3>
        <ul class="ix-events">${r.items.map((t, i) => ({ t, i })).sort((a, b) => marked.has(b.i) - marked.has(a.i))
          .map(({ t, i }) => `<li class="${marked.has(i) ? "is-on" : ""}">${esc(t)}</li>`).join("")}</ul>
      </div>`;
  }

  function render() {
    const r = round;
    root.innerHTML = `
      <header class="ix-hero glass">
        <span class="ix-hero-icon ix-px" aria-hidden="true">🎱</span>
        <div class="ix-hero-text"><h2>${r ? esc(r.title) : "Стрим-бинго"}</h2>
          <p>${r ? `Первый, кто соберёт линию, получает <b>${r.reward}</b> ${plural(r.reward, ["балл", "балла", "баллов"])}, следующие — по ${Math.floor(r.reward / 2)}. Клетки загораются сами, когда событие случается на стриме.`
            : "Карточка с событиями стрима: «ndze упал с крыши», «донат с мемом»… Отмечаются в прямом эфире."}</p></div>
        ${r ? `<div class="ix-hero-side"><span class="badge ${r.status === "open" ? "lime" : "plain"}">${r.status === "open" ? "Раунд идёт" : "Раунд завершён"}</span></div>` : ""}
      </header>
      ${!r ? `<div class="empty"><span class="empty-icon">🎱</span><p>Раунд бинго ещё не начался — загляни во время стрима.</p></div>`
        : `<div class="ix-bingo-wrap">
            <div>${r.card ? boardHTML(r) : `<div class="empty"><span class="empty-icon">🃏</span><p>Карточка появится после входа.</p></div>`}</div>
            <div class="ix">${sideHTML(r)}</div>
          </div>`}`;
    seen = r ? new Set(r.marked) : null;
  }

  async function load() {
    try {
      const d = await apiCall("bingo");
      const sig = JSON.stringify(d.round);
      if (sig === last) return;
      const prevCan = round?.canClaim;
      last = sig;
      if (round && d.round && round.id !== d.round.id) seen = null;
      round = d.round;
      render();
      if (round?.canClaim && !prevCan) toast("У тебя линия! Жми «БИНГО!» 🎱");
    } catch (err) {
      if (!round) root.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  async function onClick(e) {
    const b = e.target.closest("[data-claim]");
    if (!b || busy) return;
    busy = true;
    b.classList.add("is-loading");
    b.disabled = true;
    try {
      const r = await apiCall("bingo/claim", { method: "POST", body: { id: b.dataset.claim } });
      toast(`БИНГО! ${r.place} место${r.prize ? `, +${r.prize} баллов` : ""} 🎉`);
      round = r.round;
      last = JSON.stringify(round);
      render();
    } catch (err) {
      toast(err.message, "error");
      b.classList.remove("is-loading");
      b.disabled = false;
    } finally {
      busy = false;
    }
  }

  root.addEventListener("click", onClick);
  root.innerHTML = '<div class="skeleton" style="min-height:420px"></div>';
  load();
  timer = setInterval(() => { if (!document.hidden && !busy) load(); }, REFRESH_MS);
  return {
    destroy() {
      clearInterval(timer);
      root.removeEventListener("click", onClick);
    },
  };
}

// Оверлей OBS «Розыгрыш» (overlay.html?w=giveaway): пока идёт приём — счётчик участников;
// после розыгрыша — рулетка из ников останавливается на победителе. Данные публичные, обновление каждые 3 с.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";

ensureCss("interactive.css");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? "участник" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "участника" : "участников");
const CELL = 200;     // ширина ячейки рулетки (как в CSS)
const SPIN_MS = 7000;
const FRESH_MS = 60000; // открыли оверлей позже минуты после розыгрыша — сразу показываем победителя

export function mount(root) {
  let timer = 0;
  let alive = true;
  let shownKey = "";
  let rolledId;      // id розыгрыша, рулетку которого уже показали
  let rolling = false;
  root.innerHTML = '<section class="ix-ov ix-ov-gw" hidden></section>';
  const box = root.querySelector(".ix-ov-gw");

  function show(html, key) {
    if (key === shownKey) return false;
    shownKey = key;
    box.hidden = false;
    box.innerHTML = html;
    box.classList.remove("is-in");
    void box.offsetWidth;
    box.classList.add("is-in");
    return true;
  }

  function winnerHTML(g) {
    return `<div class="ix-ov-win"><small>Победитель · ${esc(g.prize)}</small><b>🏆 ${esc(g.winner?.nick || "?")}</b></div>`;
  }

  async function roulette(g) {
    rolling = true;
    const win = g.winner?.nick || "?";
    const pool = g.nicks.length ? g.nicks : [win];
    const strip = [];
    for (let i = 0; i < 46; i++) strip.push(pool[Math.floor(Math.random() * pool.length)]);
    const at = 40; // победитель на 41-й позиции, после него ещё несколько ячеек
    strip[at] = win;
    show(`<span class="ov-label">Розыгрыш · ${esc(g.title)}</span>
      <div class="ix-ov-prize">🎁 ${esc(g.prize)}</div>
      <div class="ix-roulette"><div class="ix-strip">${strip.map((n, i) => `<span${i === at ? ' class="is-win" data-win' : ""}>${esc(n)}</span>`).join("")}</div></div>
      <div data-result></div>`, `roll:${g.id}`);
    const rl = box.querySelector(".ix-roulette");
    const st = box.querySelector(".ix-strip");
    st.querySelector("[data-win]").classList.remove("is-win");
    const target = at * CELL + CELL / 2 - rl.clientWidth / 2 + (Math.random() - 0.5) * CELL * 0.6;
    if (!reduced) {
      st.style.transform = "translateX(0)";
      void st.offsetWidth;
      st.style.transition = `transform ${SPIN_MS}ms cubic-bezier(.12, .8, .18, 1)`;
      st.style.transform = `translateX(${-target}px)`;
      await new Promise((r) => setTimeout(r, SPIN_MS + 200));
      st.style.transition = "transform .5s steps(5)";
    }
    st.style.transform = `translateX(${-(at * CELL + CELL / 2 - rl.clientWidth / 2)}px)`;
    st.querySelector("[data-win]")?.classList.add("is-win");
    box.querySelector("[data-result]").innerHTML = winnerHTML(g);
    rolling = false;
  }

  function render(g) {
    if (rolling) return;
    if (!g) {
      box.hidden = true;
      shownKey = "";
      return;
    }
    if (g.status === "drawn") {
      const fresh = Date.now() - Date.parse(g.drawnAt) < FRESH_MS;
      if (rolledId === undefined) rolledId = fresh ? null : g.id; // старый розыгрыш при открытии оверлея не крутим
      if (rolledId !== g.id) {
        rolledId = g.id;
        roulette(g);
        return;
      }
      if (!shownKey.startsWith("roll:")) {
        show(`<span class="ov-label">Розыгрыш · ${esc(g.title)}</span>${winnerHTML(g)}`, `win:${g.id}`);
      }
      return;
    }
    if (rolledId === undefined) rolledId = null;
    const key = `open:${g.id}:${g.status}`;
    if (!show(`<span class="ov-label">${g.status === "open" ? "Розыгрыш · участвуй!" : "Приём закрыт · скоро розыгрыш"}</span>
      <div class="ix-ov-title">${esc(g.title)}</div>
      <div class="ix-ov-prize">🎁 ${esc(g.prize)}</div>
      <div><span class="ix-ov-big" data-n>${g.entries}</span> <span class="ix-ov-sub" data-w>${word(g.entries)}</span></div>
      <div class="ix-ov-foot"><span>ndze.fun → движ → розыгрыши</span><span>честно: sha256 заранее</span></div>`, key)) {
      box.querySelector("[data-n]").textContent = String(g.entries);
      box.querySelector("[data-w]").textContent = word(g.entries);
    }
  }

  async function tick() {
    try {
      const d = await apiCall("giveaway/live");
      if (alive) render(d.giveaway);
    } catch {
      /* попробуем ещё раз */
    }
    if (alive) timer = setTimeout(tick, 3000);
  }
  tick();
  return { destroy() { alive = false; clearTimeout(timer); } };
}

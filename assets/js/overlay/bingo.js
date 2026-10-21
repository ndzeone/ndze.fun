// Оверлей OBS «Бинго» (overlay.html?w=bingo): какие события уже случились и кто собрал линию.
// Данные публичные, обновление каждые 3 с.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";

ensureCss("interactive.css");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const SHOW = 8; // последних отмеченных событий на экране

export function mount(root) {
  let timer = 0;
  let alive = true;
  let last = "";
  let seen = null;
  let order = []; // порядок, в котором события отмечали (по наблюдениям оверлея)
  root.innerHTML = '<section class="ix-ov ix-ov-bingo" hidden></section>';
  const box = root.querySelector(".ix-ov-bingo");

  function render(r) {
    // закрытый раунд висит ещё 5 минут — чтобы успели увидеть победителей
    const stale = r && r.status !== "open" && (!r.closedAt || Date.now() - Date.parse(r.closedAt) > 300000);
    if (!r || stale) {
      box.hidden = true;
      last = "";
      return;
    }
    const sig = JSON.stringify([r.id, r.status, r.marked, r.claims.map((c) => c.user.id)]);
    if (sig === last) return;
    const firstShow = box.hidden || !last.includes(r.id);
    last = sig;
    if (firstShow) {
      seen = null;
      order = [...r.marked];
    }
    const now = new Set(r.marked);
    order = order.filter((i) => now.has(i));
    for (const i of r.marked) if (!order.includes(i)) order.push(i);
    const recent = order.slice(-SHOW).reverse();
    box.hidden = false;
    box.innerHTML = `<span class="ov-label">Стрим-бинго · ${r.marked.length}/${r.items.length}</span>
      <div class="ix-ov-title">${esc(r.title)}</div>
      ${recent.length ? `<ul class="ix-ov-events">${recent.map((i) => `<li class="${seen && !seen.has(i) ? "is-new" : ""}">${esc(r.items[i])}</li>`).join("")}</ul>`
        : '<div class="ix-ov-sub">Ждём первых событий…</div>'}
      ${r.claims.length ? `<div class="ix-ov-sub">БИНГО собрали:</div><ol class="ix-ov-winners">${r.claims.slice(0, 6).map((c) => `<li>${c.place}. ${esc(c.user.nick)}</li>`).join("")}</ol>` : ""}
      <div class="ix-ov-foot"><span>${r.status === "open" ? "карточка: ndze.fun → движ → бинго" : "раунд завершён"}</span><span>${r.reward} баллов</span></div>`;
    if (firstShow) {
      box.classList.remove("is-in");
      void box.offsetWidth;
      box.classList.add("is-in");
    }
    seen = now;
  }

  async function tick() {
    try {
      const d = await apiCall("bingo");
      if (alive) render(d.round);
    } catch {
      /* попробуем ещё раз */
    }
    if (alive) timer = setTimeout(tick, 3000);
  }
  tick();
  return { destroy() { alive = false; clearTimeout(timer); } };
}

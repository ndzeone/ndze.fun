// Оверлей OBS «Опрос» (overlay.html?w=poll): последний открытый опрос (или закрытый — ещё 2 минуты),
// полосы растут ступеньками. Данные публичные — ключ не нужен. Обновление каждые 3 с.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";

ensureCss("interactive.css");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? "голос" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "голоса" : "голосов");

export function mount(root) {
  let pollId = null;
  let timer = 0;
  let alive = true;
  root.innerHTML = '<section class="ix-ov ix-ov-poll" hidden></section>';
  const box = root.querySelector(".ix-ov-poll");

  function render(p) {
    if (!p) {
      box.hidden = true;
      pollId = null;
      return;
    }
    const max = Math.max(...p.options.map((o) => o.votes));
    if (p.id !== pollId) {
      // новый опрос — строим заново; полосы стартуют с нуля и вырастут на следующем кадре
      pollId = p.id;
      box.hidden = false;
      box.classList.remove("is-in");
      void box.offsetWidth;
      box.classList.add("is-in");
      box.innerHTML = `<span class="ov-label" data-status></span>
        <div class="ix-ov-title">${esc(p.question)}</div>
        <ul class="ix-ov-opts">${p.options.map((o, i) => `<li class="ix-ov-opt" data-i="${i}"><span class="ix-bar" style="--w:0%"></span><b>${esc(o.text)}</b><span data-pct>0%</span></li>`).join("")}</ul>
        <div class="ix-ov-foot"><span data-total></span><span>голосуй: ndze.fun → движ</span></div>`;
      void box.offsetWidth;
    }
    box.querySelector("[data-status]").textContent = p.status === "open" ? "Опрос · голосуй!" : "Итоги опроса";
    box.querySelector("[data-total]").textContent = `${p.total} ${word(p.total)}`;
    p.options.forEach((o, i) => {
      const li = box.querySelector(`[data-i="${i}"]`);
      if (!li) return;
      li.querySelector(".ix-bar").style.setProperty("--w", `${o.percent}%`);
      li.querySelector("[data-pct]").textContent = `${o.percent}%`;
      li.classList.toggle("is-top", p.total > 0 && o.votes === max);
    });
  }

  async function tick() {
    try {
      const d = await apiCall("poll/live");
      if (alive) render(d.poll);
    } catch {
      /* сеть моргнула — попробуем через 3 с */
    }
    if (alive) timer = setTimeout(tick, 3000);
  }
  tick();
  return { destroy() { alive = false; clearTimeout(timer); } };
}

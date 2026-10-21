// Оверлей OBS «Зритель дня»: overlay.html?w=viewer&key=… — аватар, ник и очки самого активного зрителя за сегодня.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, initial } from "../core/util.js";
import { points, BREAKDOWN } from "../home/channel.js";

const POLL = 60_000;

export function mount(root) {
  ensureCss("streamtools.css");
  root.innerHTML = `<section class="stx-ov stx-ov-view" hidden><span class="ov-label">⭐ Зритель дня</span><div data-body></div></section>
    <p class="ov-error" hidden></p>`;
  const box = root.querySelector(".stx-ov");
  const body = box.querySelector("[data-body]");
  const errEl = root.querySelector(".ov-error");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lastId = null;
  let timer = 0;
  let dead = false;

  function render(top) {
    box.hidden = !top;
    if (!top) { lastId = null; return; }
    const u = top.user;
    // самое заметное действие — подписью под ником
    const best = Object.entries(top.breakdown || {}).filter(([k]) => BREAKDOWN[k]).sort((a, b) => b[1] - a[1])[0];
    body.innerHTML = `<div class="stx-ov-viewer">
      <span class="stx-ov-ava" aria-hidden="true">${esc(initial(u.nick))}${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : ""}</span>
      <div><b>${esc(u.nick)}</b><small>${esc(points(top.score))}${best ? ` · ${BREAKDOWN[best[0]][0]} ${best[1]}` : ""}</small></div></div>`;
    const img = body.querySelector("img");
    if (img) img.addEventListener("error", () => img.remove(), { once: true });
    if (u.id !== lastId && !reduced) {
      box.classList.remove("pop");
      void box.offsetWidth;
      box.classList.add("pop");
    }
    lastId = u.id;
  }

  async function tick() {
    try {
      const d = await apiCall("viewer/today");
      errEl.hidden = true;
      render(d.top);
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
    }
    if (!dead) timer = setTimeout(tick, POLL);
  }
  tick();
  return { destroy() { dead = true; clearTimeout(timer); } };
}

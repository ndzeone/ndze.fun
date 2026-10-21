// Оверлей OBS «Следующий стрим через …»: overlay.html?w=schedule&key=…
// Отсчёт тикает каждую секунду, расписание перечитывается раз в минуту. Нет стримов — панель скрыта.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc } from "../core/util.js";
import { leftText, whenText } from "../home/schedule.js";

const POLL = 60_000;

export function mount(root) {
  ensureCss("streamtools.css");
  root.innerHTML = `<section class="stx-ov stx-ov-sched" hidden></section><p class="ov-error" hidden></p>`;
  const box = root.querySelector(".stx-ov");
  const errEl = root.querySelector(".ov-error");
  let next = null;
  let timer = 0;
  let dead = false;

  function render() {
    box.hidden = !next;
    if (!next) return;
    const ms = Date.parse(next.startsAt) - Date.now();
    const now = next.isNow || ms <= 0;
    box.innerHTML = `<span class="ov-label">${now ? "🔴 В эфире" : "Следующий стрим через"}</span>
      ${now ? '<div class="stx-ov-cd stx-ov-live">Уже начинаем!</div>' : `<div class="stx-ov-cd" data-cd>${esc(leftText(ms))}</div>`}
      <div class="stx-ov-title">${esc(next.title)}</div>
      <div class="stx-ov-sub">${[next.game, whenText(next.startsAt)].filter(Boolean).map(esc).join(" · ")}</div>`;
  }

  const tick = setInterval(() => {
    if (!next || next.isNow) return;
    const ms = Date.parse(next.startsAt) - Date.now();
    const cd = box.querySelector("[data-cd]");
    if (ms <= 0 || !cd) return render();
    cd.textContent = leftText(ms);
  }, 1000);

  async function load() {
    try {
      next = (await apiCall("schedule")).next;
      errEl.hidden = true;
      render();
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
    }
    if (!dead) timer = setTimeout(load, POLL);
  }
  load();
  return { destroy() { dead = true; clearTimeout(timer); clearInterval(tick); } };
}

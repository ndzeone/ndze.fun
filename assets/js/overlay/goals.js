// Оверлей OBS «Цели канала»: overlay.html?w=goals&key=…[&id=<цель>][&n=3]
// Полосы плавно дозаполняются при изменении; когда цель достигнута — вспышка «Цель достигнута!».
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc } from "../core/util.js";
import { num } from "../home/channel.js";

const POLL = 10_000;

export function mount(root, ctx = {}) {
  ensureCss("streamtools.css");
  const params = ctx.params || new URLSearchParams(location.search);
  const onlyId = params.get("id") || "";
  const n = Math.max(1, Math.min(6, Number(params.get("n")) || 3));
  root.innerHTML = `<section class="stx-ov stx-ov-goals" hidden><span class="ov-label">Цели канала</span><div data-list></div></section>
    <p class="ov-error" hidden></p>`;
  const box = root.querySelector(".stx-ov");
  const list = box.querySelector("[data-list]");
  const errEl = root.querySelector(".ov-error");
  const reached = new Map(); // id → была ли цель достигнута в прошлый раз
  let first = true;
  let timer = 0;
  let dead = false;

  function rowHTML(g) {
    return `<div class="stx-ov-goal${g.reached ? " is-reached" : ""}" data-id="${esc(g.id)}">
      <div class="stx-ov-goal-head"><b data-t>${esc(g.title)}</b><span data-n></span></div>
      <div class="stx-bar"><i style="--p:0%"></i></div></div>`;
  }

  function flash(g) {
    const el = document.createElement("div");
    el.className = "stx-flash";
    el.textContent = "Цель достигнута!";
    el.title = g.title;
    root.append(el);
    setTimeout(() => el.remove(), 6200);
  }

  function render(items) {
    box.hidden = !items.length;
    // строки обновляем на месте, чтобы ширина полосы анимировалась от прежнего значения
    const ids = items.map((g) => g.id).join(",");
    if (list.dataset.ids !== ids) {
      list.innerHTML = items.map(rowHTML).join("");
      list.dataset.ids = ids;
    }
    for (const g of items) {
      const row = list.querySelector(`[data-id="${CSS.escape(g.id)}"]`);
      if (!row) continue;
      row.classList.toggle("is-reached", !!g.reached);
      row.querySelector("[data-t]").textContent = g.title;
      row.querySelector("[data-n]").textContent = `${num(g.current)} / ${num(g.target)}${g.unit ? ` ${g.unit}` : ""}`;
      const bar = row.querySelector(".stx-bar > i");
      requestAnimationFrame(() => requestAnimationFrame(() => bar.style.setProperty("--p", `${Math.max(0, Math.min(100, Number(g.percent) || 0))}%`)));
      if (!first && g.reached && reached.get(g.id) === false) flash(g);
      reached.set(g.id, !!g.reached);
    }
    first = false;
  }

  async function tick() {
    try {
      const d = await apiCall("goals");
      let items = (d.items || []).filter((g) => (onlyId ? g.id === onlyId : g.status === "active"));
      items = items.slice(0, n);
      errEl.hidden = true;
      render(items);
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
    }
    if (!dead) timer = setTimeout(tick, POLL);
  }
  tick();
  return { destroy() { dead = true; clearTimeout(timer); } };
}

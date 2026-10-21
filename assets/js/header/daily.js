// Кнопка ежедневного бонуса в шапке (только для вошедших): подарок светится, пока бонус за сегодня не забран.
// Клик — забрать бонус: вылет пиксельных монеток и тост «+35 баллов, серия 4 дня 🔥».
// События: слушает «ndze:daily» (бонус забрали из кабинета), шлёт «ndze:points» { balance } после получения.
import { ensureCss } from "../modules.js";
import { apiCall } from "../data/api.js";
import { onUserChange } from "../core/layout.js";
import { esc, toast, motion, plural } from "../core/util.js";

ensureCss("points.css");

// пиксельный подарок 16×16
const GIFT_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges">
  <rect class="pt-gift-box" x="2" y="7" width="12" height="8"/>
  <rect class="pt-gift-lid" x="1" y="4" width="14" height="3"/>
  <rect class="pt-gift-ribbon" x="7" y="4" width="2" height="11"/>
  <rect class="pt-gift-ribbon" x="4" y="1" width="3" height="2"/><rect class="pt-gift-ribbon" x="9" y="1" width="3" height="2"/>
  <rect class="pt-gift-ribbon" x="6" y="2" width="4" height="2"/>
</svg>`;

const days = (n) => `${n} ${plural(n, ["день", "дня", "дней"])}`;

/** Вылет монеток из центра элемента. */
export function coinBurst(el, amount) {
  if (!motion || !el) return;
  const r = el.getBoundingClientRect();
  const down = r.top < 120; // кнопка у верхнего края (шапка) — монетки и «+N» летят вниз
  const layer = document.createElement("div");
  layer.className = `pt-burst${down ? " is-down" : ""}`;
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  const coins = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 34 + Math.random() * 30;
    return `<i class="pt-coin" style="--dx:${Math.round(Math.cos(a) * dist)}px;--dy:${Math.round(Math.sin(a) * dist + (down ? 16 : -18))}px;--d:${Math.round(Math.random() * 90)}ms"></i>`;
  }).join("");
  layer.innerHTML = `${coins}<b class="pt-burst-text">+${Number(amount) || 0}</b>`;
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1300);
}

export function mount(container, ctx) {
  let user = ctx.user || null;
  let state = null; // ответ GET daily
  let busy = false;
  let seq = 0;

  function render() {
    if (!user) { container.innerHTML = ""; return; }
    const ready = !!state && !state.claimedToday;
    const label = !state ? "Ежедневный бонус"
      : ready ? `Забрать ежедневный бонус: +${state.nextAmount} баллов`
        : `Бонус получен. Серия ${days(state.streak)}, завтра +${state.nextAmount}`;
    container.innerHTML = `<button class="pt-daily-btn${ready ? " is-ready" : ""}${busy ? " is-busy" : ""}" type="button" aria-label="${esc(label)}" title="${esc(label)}">
      ${GIFT_SVG}${state?.streak ? `<span class="pt-daily-streak" aria-hidden="true">${state.streak}</span>` : ""}
    </button>`;
  }

  async function load() {
    const my = ++seq;
    if (!user) { state = null; render(); return; }
    try {
      const s = await apiCall("daily");
      if (my === seq) state = s;
    } catch {
      if (my === seq) state = null;
    }
    if (my === seq) render();
  }

  async function onClick(e) {
    const btn = e.target.closest(".pt-daily-btn");
    if (!btn || busy) return;
    if (!state) return load();
    if (state.claimedToday) {
      toast(`Бонус за сегодня уже получен. Серия ${days(state.streak)} 🔥 — завтра +${state.nextAmount}`);
      return;
    }
    busy = true;
    btn.classList.add("is-busy");
    try {
      const r = await apiCall("daily/claim", { method: "POST" });
      state = r;
      coinBurst(btn, r.amount);
      toast(`+${r.amount} баллов, серия ${days(r.streak)} 🔥`);
      window.dispatchEvent(new CustomEvent("ndze:points", { detail: { balance: r.balance, daily: r } }));
    } catch (err) {
      toast(err.message, "error");
      await load();
    } finally {
      busy = false;
      render();
    }
  }

  const onDaily = (e) => { if (e.detail) { state = e.detail; render(); } else load(); };
  const onVisible = () => { if (!document.hidden && user) load(); }; // вкладку открыли утром — сутки могли смениться
  container.addEventListener("click", onClick);
  window.addEventListener("ndze:daily", onDaily);
  document.addEventListener("visibilitychange", onVisible);
  const off = onUserChange((u) => { user = u; state = null; load(); });
  load();

  return {
    destroy() {
      off();
      container.removeEventListener("click", onClick);
      window.removeEventListener("ndze:daily", onDaily);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

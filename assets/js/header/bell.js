// Колокольчик уведомлений в шапке (только для вошедших): счётчик непрочитанных — лёгкий опрос
// notifications?only=unread раз в минуту, пока вкладка видна; по клику — панель с 30 последними уведомлениями.
// На телефоне панель — лист во всю ширину под шапкой (notify.css).
import { api, apiCall } from "../data/api.js";
import { onUserChange } from "../core/layout.js";
import { $, $$, esc, timeAgo, toast, motion } from "../core/util.js";
import { ensureCss } from "../modules.js";

ensureCss("notify.css");

const POLL_MS = 60_000;
const ROOT = new URL("../../../", import.meta.url); // корень сайта (файл в assets/js/header/)
const SAFE_LINK = /^[a-z0-9_-]{1,40}\.html(?:[?#][^\s<>"'\\]*)?$/i;
const ICONS = {
  task: "🎯", review: "⭐", comment: "💬", forum: "🗨", bet: "🔮", whitelist: "⛏",
  shop: "🛒", giveaway: "🎁", daily: "🎁", season: "⚔", badge: "🏅", quiz: "🧠", poll: "📊", build: "🗺", clip: "🎬",
};
// пиксельный колокольчик 12×12
const BELL_SVG = `<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M5 0h2v1H5zM4 1h4v1H4zM3 2h6v5H3zM2 7h8v1H2zM1 8h10v1H1zM5 9.5h2V11H5z"/></svg>`;

let uid = 0;

export function mount(container, ctx) {
  if (api.mode !== "php") return null; // в локальном демо уведомлений нет
  const panelId = `nt-panel-${++uid}`;
  const root = document.createElement("div");
  root.className = "nt-bell";
  container.append(root);

  let user = ctx.user;
  let unread = 0;
  let items = null;      // null — ещё не загружали
  let open = false;
  let timer = 0;
  let loadSeq = 0;
  let destroyed = false;

  /* ---------- Разметка ---------- */
  function render() {
    if (!user) {
      root.replaceChildren();
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.innerHTML = `
      <button class="nt-bell-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="${panelId}" title="Уведомления">
        ${BELL_SVG}<span class="nt-count" hidden aria-hidden="true"></span><span class="sr-only nt-sr"></span>
      </button>
      <div class="nt-panel glass" id="${panelId}" role="region" aria-label="Уведомления" tabindex="-1" hidden>
        <div class="nt-head">
          <h2 class="nt-title">Уведомления</h2>
          <button class="nt-readall" type="button" data-readall>Прочитать все</button>
          <button class="nt-close" type="button" data-close aria-label="Закрыть">✕</button>
        </div>
        <ul class="nt-list" aria-live="polite"></ul>
      </div>`;
    renderCount();
  }

  function renderCount(ring = false) {
    const btn = $(".nt-bell-btn", root);
    if (!btn) return;
    const badge = $(".nt-count", btn);
    badge.hidden = unread <= 0;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    btn.classList.toggle("has-unread", unread > 0);
    $(".nt-sr", btn).textContent = unread > 0 ? `Уведомления: ${unread} непрочитанных` : "Уведомления";
    const all = $("[data-readall]", root);
    if (all) all.disabled = unread <= 0;
    if (ring && motion) {
      btn.classList.remove("is-ringing");
      void btn.offsetWidth;
      btn.classList.add("is-ringing");
    }
  }

  function itemHTML(n) {
    const link = n.link && SAFE_LINK.test(n.link) ? new URL(n.link, ROOT).href : "";
    const icon = ICONS[n.kind] || "🔔";
    const inner = `<span class="nt-ico" aria-hidden="true">${icon}</span>
      <span class="nt-body"><span class="nt-text">${esc(n.text)}</span>
      <time class="nt-time" datetime="${esc(n.createdAt)}">${esc(timeAgo(n.createdAt))}${n.read ? "" : " · новое"}</time></span>`;
    const cls = `nt-item${n.read ? "" : " is-unread"}`;
    return `<li>${link
      ? `<a class="${cls}" href="${esc(link)}" data-id="${n.id}">${inner}</a>`
      : `<button class="${cls}" type="button" data-id="${n.id}">${inner}</button>`}</li>`;
  }

  function renderList(error = "") {
    const list = $(".nt-list", root);
    if (!list) return;
    if (error) list.innerHTML = `<li class="nt-empty"><b aria-hidden="true">🕸</b>${esc(error)}</li>`;
    else if (items === null) list.innerHTML = '<li class="skeleton nt-skel"></li><li class="skeleton nt-skel"></li><li class="skeleton nt-skel"></li>';
    else if (!items.length) list.innerHTML = `<li class="nt-empty"><b aria-hidden="true">🕷</b>Пока тихо. Здесь появятся ответы на форуме, оценки работ, итоги ставок и заданий.</li>`;
    else list.innerHTML = items.map(itemHTML).join("");
  }

  /* ---------- Данные ---------- */
  async function poll() {
    if (!user || document.hidden) return;
    try {
      const r = await apiCall("notifications", { query: { only: "unread" } });
      if (destroyed || !user) return;
      const grew = r.unread > unread;
      unread = r.unread;
      renderCount(grew);
      if (grew && open) loadList();
    } catch { /* сеть пропала — попробуем через минуту */ }
  }

  async function loadList() {
    const my = ++loadSeq;
    if (items === null) renderList();
    try {
      const r = await apiCall("notifications");
      if (my !== loadSeq || destroyed) return;
      items = r.items;
      unread = r.unread;
      renderCount();
      renderList();
    } catch (err) {
      if (my === loadSeq) renderList(err.message || "Не удалось загрузить уведомления");
    }
  }

  function startPolling() {
    clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    poll();
  }

  /* ---------- Открытие / закрытие ---------- */
  function setOpen(next, { focusButton = false } = {}) {
    open = next;
    const btn = $(".nt-bell-btn", root);
    const panel = $(".nt-panel", root);
    if (!btn || !panel) return;
    btn.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    if (open) {
      loadList();
      requestAnimationFrame(() => panel.focus({ preventScroll: true })); // дальше Tab / стрелки — по пунктам
    } else if (focusButton) btn.focus();
  }

  async function markRead(ids) {
    try {
      const r = await apiCall("notifications/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
      unread = r.unread;
      renderCount();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* ---------- События ---------- */
  root.addEventListener("click", async (e) => {
    if (e.target.closest(".nt-bell-btn")) return setOpen(!open);
    if (e.target.closest("[data-close]")) return setOpen(false, { focusButton: true });
    if (e.target.closest("[data-readall]")) {
      items?.forEach((n) => { n.read = true; });
      unread = 0;
      renderCount();
      renderList();
      await markRead("all");
      return;
    }
    const item = e.target.closest("[data-id]");
    if (!item) return;
    const id = Number(item.dataset.id);
    const n = items?.find((x) => x.id === id);
    const href = item.tagName === "A" ? item.href : "";
    if (href && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) { // в новой вкладке — просто отметим
      if (n && !n.read) { n.read = true; unread = Math.max(0, unread - 1); renderList(); markRead([id]); }
      return;
    }
    e.preventDefault();
    if (n && !n.read) {
      n.read = true;
      unread = Math.max(0, unread - 1);
      renderCount();
      renderList();
      // ждём отметку недолго: переход не должен тормозить
      await Promise.race([markRead([id]), new Promise((r) => setTimeout(r, 700))]);
    }
    setOpen(false);
    if (href) location.href = href;
  });

  const onDocPointer = (e) => { if (open && !root.contains(e.target)) setOpen(false); };
  const onKey = (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false, { focusButton: true }); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { // стрелки — по пунктам списка
      const list = $$(".nt-list [data-id]", root);
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
    }
  };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener("pointerdown", onDocPointer);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisible);

  const offUser = onUserChange((u) => {
    const changed = (u?.id ?? null) !== (user?.id ?? null);
    user = u;
    if (!changed) return;
    open = false;
    items = null;
    unread = 0;
    loadSeq++;
    render();
    if (user) startPolling();
    else clearInterval(timer);
  });

  render();
  if (user) startPolling();

  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      offUser();
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      root.remove();
    },
  };
}

// Вкладка «Тир-листы» (play.html#tierlists): перетащи предметы по тирам S–D (мышь и тач — pointer events)
// или нажми на предмет и выбери тир в меню (клавиатура). Рядом — общий тир-лист сообщества (средний балл S=5…D=1).
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, plural } from "../core/util.js";

ensureCss("interactive.css");

const TIERS = ["S", "A", "B", "C", "D"];
const DRAG_PX = 6;

export function mount(root, ctx) {
  const user = ctx.user || null;
  let lists = null;
  let selId = null;
  const drafts = new Map(); // listId → расстановка (несохранённая)
  let drag = null;          // { id, item, el, x, y, ghost, zone }
  let suppressClick = false;
  let menu = null;
  let busy = false;
  root.classList.add("ix", "ix-tl");
  root.style.position = "relative";

  const sel = () => lists.find((l) => l.id === selId) || null;
  const editable = (l) => !!(user && l && l.status === "open");
  function placementOf(l) {
    if (!drafts.has(l.id)) drafts.set(l.id, l.mine ? [...l.mine] : l.items.map(() => null));
    return drafts.get(l.id);
  }

  function tokenHTML(l, i, { live = false, extra = "" } = {}) {
    const it = l.items[i];
    const inner = `${it.emoji ? `<span aria-hidden="true">${esc(it.emoji)}</span>` : ""}<span>${esc(it.text)}</span>${extra}`;
    return live
      ? `<button class="ix-token" type="button" data-item="${i}" aria-haspopup="menu" aria-label="${esc(it.text)}: выбрать тир">${inner}</button>`
      : `<span class="ix-token is-static">${inner}</span>`;
  }

  function myBoardHTML(l) {
    const live = editable(l);
    const pl = live ? placementOf(l) : l.mine || l.items.map(() => null);
    const rows = TIERS.map((t) => `<div class="ix-tier" data-tier="${t}">
      <span class="ix-tier-label" aria-hidden="true">${t}</span>
      <div class="ix-zone" data-zone="${t}" aria-label="Тир ${t}">${pl.map((p, i) => (p === t ? tokenHTML(l, i, { live }) : "")).join("")}</div>
    </div>`).join("");
    const left = pl.filter((p) => !p).length;
    let foot = "";
    if (!user) {
      foot = `<div class="ix-login"><p>Войди, чтобы собрать свой тир-лист и повлиять на общий.</p>
        <button class="ix-pbtn ix-px is-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы голосовать в тир-листах">Войти</button></div>`;
    } else if (live) {
      const saved = JSON.stringify(pl) === JSON.stringify(l.mine);
      foot = `<div class="ix-tl-save">
        <button class="ix-pbtn ix-px" type="button" data-save${left || saved ? " disabled" : ""}><span>${l.mine ? "Обновить" : "Сохранить"}</span><span class="spinner" aria-hidden="true"></span></button>
        <span class="ix-note">${left ? `Осталось расставить: ${left}` : saved ? "Сохранено ✔" : "Готово — сохраняй!"}</span></div>`;
    } else if (!l.mine) {
      foot = `<p class="ix-note">Голосование закрыто — ты не успел поучаствовать.</p>`;
    }
    return `<div class="ix-card glass">
      <h3>Мой тир-лист</h3>
      ${live ? '<p class="ix-note">Перетаскивай предметы или нажми на предмет и выбери тир.</p>' : ""}
      <div class="ix-tiers">${rows}</div>
      ${live || !user ? `<div class="ix-zone ix-pool" data-zone="" aria-label="Не расставлено">${pl.map((p, i) => (!p ? tokenHTML(l, i, { live }) : "")).join("")}</div>` : ""}
      ${foot}
    </div>`;
  }

  function communityHTML(l) {
    if (!l.votes) {
      return `<div class="ix-card glass"><h3>Сообщество</h3><div class="empty"><span class="empty-icon">🏅</span><p>Пока никто не голосовал — будь первым!</p></div></div>`;
    }
    const idx = l.items.map((_, i) => i).filter((i) => l.community[i]).sort((a, b) => l.community[b].avg - l.community[a].avg);
    const rows = TIERS.map((t) => `<div class="ix-tier" data-tier="${t}">
      <span class="ix-tier-label" aria-hidden="true">${t}</span>
      <div class="ix-zone" aria-label="Тир ${t}">${idx.filter((i) => l.community[i].tier === t)
        .map((i) => tokenHTML(l, i, { extra: `<small>${l.community[i].avg.toFixed(1)}</small>` })).join("")}</div>
    </div>`).join("");
    return `<div class="ix-card glass"><h3>Сообщество</h3>
      <p class="ix-note">${l.votes} ${plural(l.votes, ["голос", "голоса", "голосов"])} · средний балл S=5 … D=1</p>
      <div class="ix-tiers">${rows}</div></div>`;
  }

  function render() {
    closeMenu(false);
    const l = sel();
    root.innerHTML = `
      <header class="ix-hero glass">
        <span class="ix-hero-icon ix-px" aria-hidden="true">🏅</span>
        <div class="ix-hero-text"><h2>${l ? esc(l.title) : "Тир-листы"}</h2>
          <p>Расставь всё по полочкам: S — топ, D — дно. Из всех голосов собирается общий тир-лист сообщества.</p></div>
        ${l ? `<div class="ix-hero-side"><span class="badge ${l.status === "open" ? "lime" : "plain"}">${l.status === "open" ? "Голосование открыто" : "Голосование закрыто"}</span></div>` : ""}
      </header>
      ${lists.length > 1 ? `<div class="ix-tabs" role="group" aria-label="Тир-листы">${lists.map((x) => `<button class="chip" type="button" data-list="${esc(x.id)}" aria-pressed="${x.id === selId}">${x.status === "open" ? "🟢 " : ""}${esc(x.title)}</button>`).join("")}</div>` : ""}
      ${l ? `<div class="ix-tl-wrap">${myBoardHTML(l)}${communityHTML(l)}</div>`
        : `<div class="empty"><span class="empty-icon">🏅</span><p>Тир-листов пока нет — ndze скоро что-нибудь придумает.</p></div>`}`;
  }

  function rerenderMine(focusItem = null) {
    const l = sel();
    const card = root.querySelector(".ix-tl-wrap > .ix-card");
    if (!l || !card) return render();
    card.outerHTML = myBoardHTML(l);
    if (focusItem !== null) root.querySelector(`.ix-tl-wrap [data-item="${focusItem}"]`)?.focus();
  }

  function place(item, tier) {
    const l = sel();
    if (!editable(l)) return;
    placementOf(l)[item] = tier || null;
    rerenderMine(item);
  }

  /* ---------- Меню выбора тира (клик / клавиатура / тач без перетаскивания) ---------- */
  function openMenu(btn) {
    closeMenu(false);
    const item = Number(btn.dataset.item);
    const cur = placementOf(sel())[item] || "";
    menu = document.createElement("div");
    menu.className = "ix-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Выбери тир");
    menu.dataset.for = String(item);
    menu.innerHTML = [...TIERS, ""].map((t) => `<button type="button" role="menuitem" data-tier="${t}" data-pick="${t}"${t === cur ? ' aria-current="true"' : ""}>${t || "Убрать"}</button>`).join("");
    root.append(menu);
    const rb = root.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const left = Math.min(r.left - rb.left, rb.width - menu.offsetWidth - 4);
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${r.bottom - rb.top + 6}px`;
    menu.querySelector("button")?.focus();
  }
  function closeMenu(refocus = true) {
    if (!menu) return;
    const item = menu.dataset.for;
    menu.remove();
    menu = null;
    if (refocus) root.querySelector(`.ix-tl-wrap [data-item="${item}"]`)?.focus();
  }

  /* ---------- Перетаскивание ---------- */
  function zoneAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest("[data-zone]");
    return el && root.contains(el) ? el : null;
  }
  function onDown(e) {
    const t = e.target.closest("button.ix-token[data-item]");
    if (!t || e.button > 0 || !editable(sel())) return;
    drag = { item: Number(t.dataset.item), el: t, x: e.clientX, y: e.clientY, ghost: null, zone: null, id: e.pointerId };
    try { t.setPointerCapture(e.pointerId); } catch { /* не страшно */ }
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      closeMenu(false);
      drag.ghost = drag.el.cloneNode(true);
      drag.ghost.classList.add("ix-ghost");
      drag.ghost.removeAttribute("data-item");
      document.body.append(drag.ghost);
      drag.el.classList.add("is-dragging");
    }
    e.preventDefault();
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
    const z = zoneAt(e.clientX, e.clientY);
    if (z !== drag.zone) {
      drag.zone?.classList.remove("is-over");
      z?.classList.add("is-over");
      drag.zone = z;
    }
  }
  function endDrag(drop) {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.zone?.classList.remove("is-over");
    d.ghost?.remove();
    d.el.classList.remove("is-dragging");
    if (d.ghost) {
      suppressClick = true; // click после перетаскивания не должен открывать меню
      setTimeout(() => { suppressClick = false; }, 0);
      if (drop && d.zone) place(d.item, d.zone.dataset.zone);
    }
  }
  const onUp = (e) => { if (drag && e.pointerId === drag.id) endDrag(true); };
  const onCancel = (e) => { if (drag && e.pointerId === drag.id) endDrag(false); };

  /* ---------- Клики ---------- */
  async function onClick(e) {
    const pick = e.target.closest("[data-pick]");
    if (pick && menu) {
      const item = Number(menu.dataset.for);
      closeMenu(false);
      place(item, pick.dataset.pick);
      return;
    }
    const tok = e.target.closest("button.ix-token[data-item]");
    if (tok) {
      if (suppressClick) return;
      if (menu && menu.dataset.for === tok.dataset.item) return closeMenu();
      return openMenu(tok);
    }
    if (menu && !e.target.closest(".ix-menu")) closeMenu(false);
    const tab = e.target.closest("[data-list]");
    if (tab) {
      selId = tab.dataset.list;
      render();
      root.querySelector(`[data-list="${CSS.escape(selId)}"]`)?.focus();
      return;
    }
    const save = e.target.closest("[data-save]");
    if (save && !busy) {
      const l = sel();
      const pl = placementOf(l);
      busy = true;
      save.classList.add("is-loading");
      save.disabled = true;
      try {
        const body = { listId: l.id, placement: Object.fromEntries(pl.map((t, i) => [String(i), t])) };
        const upd = await apiCall("tierlist/vote", { method: "POST", body });
        lists = lists.map((x) => (x.id === upd.id ? upd : x));
        drafts.set(upd.id, [...upd.mine]);
        toast("Тир-лист сохранён 🏅");
        render();
      } catch (err) {
        toast(err.message, "error");
        save.classList.remove("is-loading");
        save.disabled = false;
      } finally {
        busy = false;
      }
    }
  }
  function onKey(e) {
    if (e.key === "Escape" && menu) {
      e.preventDefault();
      closeMenu();
    }
  }
  function onDocClick(e) {
    if (menu && !root.contains(e.target)) closeMenu(false);
  }

  async function load() {
    try {
      const d = await apiCall("tierlists");
      lists = d.items;
      selId = lists.find((l) => l.status === "open")?.id || lists[0]?.id || null;
      render();
    } catch (err) {
      root.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onCancel);
  root.addEventListener("lostpointercapture", onCancel);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocClick);
  root.innerHTML = '<div class="skeleton" style="min-height:420px"></div>';
  load();
  return {
    destroy() {
      endDrag(false);
      document.removeEventListener("click", onDocClick);
    },
  };
}

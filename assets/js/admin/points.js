// «Пульт» → «Магазин · бонусы · сезоны»: очередь заказов (выполнить / вернуть баллы), награды магазина (CRUD),
// статистика сезона, команд и ежедневных бонусов, история наград сезонов.
import { ensureCss } from "../modules.js";
import { apiCall } from "../data/api.js";
import { esc, toast, timeAgo, avatarHTML, plural } from "../core/util.js";
import { ORDER_STATUS, pts } from "../play/shop.js";
import { tugHTML } from "../play/season.js";

ensureCss("points.css");

const VIEWS = [
  { id: "orders", label: "Заказы" },
  { id: "items", label: "Награды" },
  { id: "season", label: "Сезон" },
];
const FILTERS = [
  { id: "pending", label: "Ждут" },
  { id: "", label: "Все" },
  { id: "done", label: "Выполнены" },
  { id: "refunded", label: "Возвраты" },
];
const NOTE_MAX = 300;
const userAv = (u) => avatarHTML(u.nick, u.avatarUrl, { size: "sm", extra: u.frame ? `frame-${u.frame}` : "" });

export function mount(container) {
  let view = "orders";
  let filter = "pending";
  let overview = null; // GET shop/admin
  let orders = null; // GET shop/orders
  let editing = null; // награда в форме (null — новая)
  let armedRefund = null;
  let alive = true;
  let seq = 0;

  /* ---------- Каркас ---------- */
  function shellHTML() {
    const s = overview?.season;
    const tile = (n, label, tone = "") => `<div class="pt-stat${tone ? ` is-${tone}` : ""}"><b>${n}</b><span>${esc(label)}</span></div>`;
    return `<div class="pt-admin">
      ${s ? `<div class="pt-stats">
        ${tile(overview.pendingCount, plural(overview.pendingCount, ["заказ ждёт", "заказа ждут", "заказов ждут"]), overview.pendingCount ? "warn" : "")}
        ${tile(s.participants, "участников сезона")}
        ${tile(s.dailyToday, "бонусов сегодня")}
        ${tile(s.shopSpent, "баллов потрачено за сезон")}
      </div>` : ""}
      <div class="chips pt-views" role="tablist">${VIEWS.map((v) => `<button class="chip" type="button" role="tab" data-view="${v.id}" aria-pressed="${view === v.id}">${esc(v.label)}${v.id === "orders" && overview?.pendingCount ? ` <span class="pt-dot-count">${overview.pendingCount}</span>` : ""}</button>`).join("")}</div>
      <div class="pt-admin-panel" data-panel></div>
    </div>`;
  }

  function renderPanel() {
    const panel = container.querySelector("[data-panel]");
    if (!panel) return;
    if (view === "orders") panel.innerHTML = ordersHTML();
    else if (view === "items") panel.innerHTML = itemsHTML();
    else panel.innerHTML = seasonHTML();
  }

  function render() {
    if (!alive) return;
    container.innerHTML = shellHTML();
    renderPanel();
  }

  /* ---------- Заказы ---------- */
  function orderRow(o) {
    const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
    const actions = o.status === "refunded" ? "" : `<div class="pt-ord-actions">
        <div class="field pt-ord-note"><input id="ptAn-${esc(o.id)}" name="adminNote" placeholder=" " maxlength="${NOTE_MAX}" value="${esc(o.adminNote || "")}"><label for="ptAn-${esc(o.id)}">Ответ зрителю (необязательно)</label></div>
        ${o.status === "pending" ? `<button class="btn btn-primary btn-sm" type="button" data-order="${esc(o.id)}" data-status="done"><span>Выполнено ✓</span><span class="spinner" aria-hidden="true"></span></button>` : ""}
        <button class="btn btn-danger btn-sm" type="button" data-order="${esc(o.id)}" data-status="refunded"><span>${armedRefund === o.id ? `Точно вернуть ${o.cost}?` : "Вернуть баллы"}</span><span class="spinner" aria-hidden="true"></span></button>
      </div>`;
    return `<li class="pt-ord glass${o.status === "pending" ? " is-pending" : ""}" data-id="${esc(o.id)}">
      <div class="pt-ord-head">
        <span class="pt-ord-item"><span aria-hidden="true">${esc(o.item.icon || "🎁")}</span><b>${esc(o.item.title)}</b></span>
        <span class="badge ${st.tone}">${esc(st.label)}</span>
      </div>
      <div class="pt-ord-who">${userAv(o.user)}<b>${esc(o.user.nick)}</b><span class="faint">· ${pts(o.cost)} · ${esc(timeAgo(o.createdAt))}</span></div>
      ${o.note ? `<p class="pt-ord-text">${esc(o.note)}</p>` : `<p class="faint pt-ord-text">Без комментария</p>`}
      ${o.status === "refunded" && o.adminNote ? `<p class="faint">Ответ: ${esc(o.adminNote)}</p>` : ""}
      ${actions}
    </li>`;
  }

  function ordersHTML() {
    const chips = `<div class="chips pt-filters">${FILTERS.map((f) => `<button class="chip" type="button" data-filter="${f.id}" aria-pressed="${filter === f.id}">${esc(f.label)}</button>`).join("")}</div>`;
    if (!orders) return chips + '<div class="skeleton" style="min-height:160px"></div>';
    const list = orders.items;
    return chips + (list.length ? `<ul class="pt-ords">${list.map(orderRow).join("")}</ul>`
      : `<div class="empty"><span class="empty-icon">📭</span><p>${filter === "pending" ? "Очередь пуста — все заказы выполнены." : "Заказов нет."}</p></div>`);
  }

  async function loadOrders() {
    const my = ++seq;
    try {
      const r = await apiCall("shop/orders", { query: { status: filter } });
      if (my !== seq || !alive) return;
      orders = r;
      if (overview) overview.pendingCount = r.pendingCount;
    } catch (err) {
      toast(err.message, "error");
      orders = { items: [], pendingCount: overview?.pendingCount || 0 };
    }
    render();
  }

  /* ---------- Награды магазина ---------- */
  function formHTML() {
    const it = editing || {};
    const f = (name, label, attrs = "", value = "") => `<div class="field" data-f="${name}">
      <input id="ptF-${name}" name="${name}" placeholder=" " ${attrs} value="${esc(value)}"><label for="ptF-${name}">${label}</label><span class="error-msg"></span></div>`;
    return `<form class="pt-item-form glass" data-item-form>
      <h4>${editing ? "Изменить награду" : "Новая награда"}</h4>
      <div class="pt-form-row">
        ${f("icon", "Эмодзи", 'maxlength="8" class="pt-icon-input"', it.icon || "🎁")}
        ${f("title", "Название", 'maxlength="80" required', it.title || "")}
      </div>
      <div class="field" data-f="description"><textarea id="ptF-description" name="description" placeholder=" " maxlength="${NOTE_MAX}" rows="2">${esc(it.description || "")}</textarea><label for="ptF-description">Описание (что получит зритель)</label><span class="error-msg"></span></div>
      <div class="pt-form-row is-3">
        ${f("cost", "Цена", 'type="number" min="1" step="1" inputmode="numeric" required', it.cost ?? 300)}
        ${f("stock", "Остаток", 'type="number" min="0" step="1" inputmode="numeric"', it.stock ?? "")}
        ${f("sort", "Порядок", 'type="number" step="1" inputmode="numeric"', it.sort ?? 0)}
      </div>
      <p class="pt-small pt-form-hint">Цена — в баллах. Пустой остаток — без ограничений. Меньший порядок — выше на витрине.</p>
      <div class="field check"><input type="checkbox" id="ptF-active" name="active"${it.active === false ? "" : " checked"}><label for="ptF-active"><span class="box"></span>В продаже</label></div>
      <div class="pt-form-actions">
        <button class="btn btn-primary btn-sm" type="submit"><span>${editing ? "Сохранить" : "Добавить"}</span><span class="spinner" aria-hidden="true"></span></button>
        ${editing ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel-edit>Отмена</button>` : ""}
      </div>
    </form>`;
  }

  function itemsHTML() {
    const items = overview?.items || [];
    const row = (it) => `<li class="pt-adm-item${it.active ? "" : " is-off"}">
      <span class="pt-adm-icon" aria-hidden="true">${esc(it.icon || "🎁")}</span>
      <span class="pt-adm-main"><b>${esc(it.title)}</b>
        <small>${pts(it.cost)} · ${it.stock === null ? "без ограничений" : `осталось ${it.stock}`} · ${it.orders} ${plural(it.orders, ["заказ", "заказа", "заказов"])}${it.pending ? ` (ждут ${it.pending})` : ""}${it.active ? "" : " · снята с продажи"}</small></span>
      <span class="pt-adm-btns">
        <button class="btn btn-ghost btn-xs" type="button" data-edit="${esc(it.id)}">Изменить</button>
        ${it.orders ? "" : `<button class="btn btn-danger btn-xs" type="button" data-del="${esc(it.id)}">Удалить</button>`}
      </span>
    </li>`;
    return `<div class="pt-items-admin">
      ${formHTML()}
      <div>
        ${items.length ? `<ul class="pt-adm-list">${items.map(row).join("")}</ul>
          <p class="faint pt-small">Награду с заказами нельзя удалить — сними её с продажи, чтобы история осталась.</p>`
          : `<div class="empty"><span class="empty-icon">🛒</span><p>Магазин пуст.</p>
            <button class="btn btn-primary btn-sm" type="button" data-seed><span>Добавить примеры</span><span class="spinner" aria-hidden="true"></span></button>
            <p class="faint pt-small">Заказать трек — 300, ник в титрах — 500, задание вне очереди — 800, выбрать игру — 1500.</p></div>`}
      </div>
    </div>`;
  }

  /* ---------- Сезон ---------- */
  function seasonHTML() {
    const s = overview?.season;
    if (!s) return '<div class="skeleton" style="min-height:160px"></div>';
    const end = new Date(s.endsAt);
    const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    const awards = overview.awards || [];
    return `<div class="pt-adm-season">
      <article class="glass pt-box">
        <h3>${esc(s.label)}</h3>
        <p class="muted">До конца сезона ${daysLeft} ${plural(daysLeft, ["день", "дня", "дней"])} (${esc(end.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }))} МСК). Награды топ-3 выдаются автоматически в первый запрос нового месяца.</p>
        <dl class="pt-dl">
          <div><dt>Участников с опытом</dt><dd>${s.participants}</dd></div>
          <div><dt>Бонусов за сезон</dt><dd>${s.dailySeason} · ${pts(s.dailyPaid)}</dd></div>
          <div><dt>Заказов за сезон</dt><dd>${s.shopOrders} · ${pts(s.shopSpent)}</dd></div>
        </dl>
        <h4 class="pt-h4">Сейчас лидируют</h4>
        ${s.top.length ? `<ol class="pt-mini">${s.top.map((r) => `<li>${["🥇", "🥈", "🥉"][r.place - 1]} ${userAv(r.user)}<b>${esc(r.user.nick)}</b><span>${r.xp} XP</span></li>`).join("")}</ol>` : `<p class="faint">Пока никого.</p>`}
      </article>
      <article class="glass pt-box">
        <h3>Команды</h3>
        ${tugHTML({ lime: s.teams.lime, red: s.teams.red })}
        <p class="faint pt-small">Лаймовые: ${s.teams.lime.members} · Красные: ${s.teams.red.members}. Оверлей для OBS: <code>overlay.html?w=teams&amp;key=…</code></p>
      </article>
      <article class="glass pt-box">
        <h3>Награды прошлых сезонов</h3>
        ${awards.length ? `<ol class="pt-mini">${awards.map((a) => `<li><span class="faint">${esc(a.label)}</span> ${["🥇", "🥈", "🥉"][a.place - 1] || a.place} ${userAv(a.user)}<b>${esc(a.user.nick)}</b><span>+${a.prize}</span></li>`).join("")}</ol>`
          : `<p class="faint">Ещё ни одного завершённого сезона с наградами.</p>`}
      </article>
    </div>`;
  }

  /* ---------- Загрузка ---------- */
  async function loadOverview() {
    try {
      overview = await apiCall("shop/admin");
    } catch (err) {
      if (alive) container.innerHTML = `<div class="empty"><span class="empty-icon">🛒</span><p>${esc(err.message)}</p></div>`;
      return false;
    }
    return true;
  }

  function fieldErrors(form, fields) {
    form.querySelectorAll(".field").forEach((f) => { f.classList.remove("invalid"); const m = f.querySelector(".error-msg"); if (m) m.textContent = ""; });
    for (const [k, msg] of Object.entries(fields || {})) {
      const f = form.querySelector(`[data-f="${k}"]`);
      if (!f) continue;
      f.classList.add("invalid");
      f.querySelector(".error-msg").textContent = msg;
    }
  }

  /* ---------- События ---------- */
  container.addEventListener("click", async (e) => {
    const t = e.target;
    const v = t.closest("[data-view]");
    if (v) { view = v.dataset.view; editing = null; render(); if (view === "orders" && !orders) loadOrders(); return; }
    const fl = t.closest("[data-filter]");
    if (fl) { filter = fl.dataset.filter; orders = null; renderPanel(); loadOrders(); return; }

    const ob = t.closest("[data-order]");
    if (ob) {
      const id = ob.dataset.order;
      const status = ob.dataset.status;
      if (status === "refunded" && armedRefund !== id) { // возврат — со второго клика
        armedRefund = id;
        renderPanel();
        setTimeout(() => { if (armedRefund === id) { armedRefund = null; if (view === "orders") renderPanel(); } }, 5000);
        return;
      }
      const note = container.querySelector(`[data-id="${CSS.escape(id)}"] input[name="adminNote"]`)?.value.trim() || "";
      ob.disabled = true;
      ob.classList.add("is-loading");
      try {
        const o = await apiCall("shop/order", { method: "POST", body: { id, status, adminNote: note } });
        armedRefund = null;
        toast(status === "done" ? `Заказ «${o.item.title}» выполнен — зритель получил уведомление` : `Баллы вернулись: +${o.cost} для ${o.user.nick}`);
        await loadOverview();
        await loadOrders();
      } catch (err) {
        toast(err.message, "error");
        ob.disabled = false;
        ob.classList.remove("is-loading");
      }
      return;
    }

    const ed = t.closest("[data-edit]");
    if (ed) {
      editing = overview.items.find((i) => i.id === ed.dataset.edit) || null;
      renderPanel();
      container.querySelector("#ptF-title")?.focus();
      return;
    }
    if (t.closest("[data-cancel-edit]")) { editing = null; renderPanel(); return; }

    const del = t.closest("[data-del]");
    if (del) {
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "Точно удалить?"; return; }
      try {
        await apiCall("shop/item/delete", { method: "POST", body: { id: del.dataset.del } });
        toast("Награда удалена");
        if (editing?.id === del.dataset.del) editing = null;
        await loadOverview();
        render();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const seed = t.closest("[data-seed]");
    if (seed) {
      seed.disabled = true;
      seed.classList.add("is-loading");
      try {
        await apiCall("shop/seed", { method: "POST" });
        toast("Добавлено 4 примера — поправь цены и описания под себя");
        await loadOverview();
        render();
      } catch (err) {
        toast(err.message, "error");
        seed.disabled = false;
        seed.classList.remove("is-loading");
      }
    }
  });

  container.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-item-form]");
    if (!form) return;
    e.preventDefault();
    const el = form.elements;
    const body = {
      title: el.title.value.trim(),
      description: el.description.value.trim(),
      icon: el.icon.value.trim(),
      cost: el.cost.value === "" ? null : Number(el.cost.value),
      stock: el.stock.value === "" ? null : Number(el.stock.value),
      sort: el.sort.value === "" ? 0 : Number(el.sort.value),
      active: el.active.checked,
    };
    if (editing) body.id = editing.id;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const it = await apiCall("shop/item", { method: "POST", body });
      toast(editing ? `«${it.title}» сохранена` : `«${it.title}» в магазине`);
      editing = null;
      await loadOverview();
      render();
    } catch (err) {
      fieldErrors(form, err.fields);
      toast(err.message, "error");
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  });

  container.innerHTML = '<div class="skeleton" style="min-height:220px"></div>';
  loadOverview().then((ok) => { if (ok) { render(); loadOrders(); } });
  return { destroy() { alive = false; } };
}

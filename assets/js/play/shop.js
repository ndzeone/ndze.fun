// «Движ» → «Магазин»: награды за баллы (заказать трек, ник в титрах…), покупка с комментарием, мои заказы.
// Покупка списывает баллы сразу; ndze выполняет заказ из «Пульта» или возвращает баллы.
import { ensureCss } from "../modules.js";
import { apiCall } from "../data/api.js";
import { esc, toast, timeAgo, plural } from "../core/util.js";

ensureCss("points.css");

export const ORDER_STATUS = {
  pending: { label: "Ждёт", tone: "warn" },
  done: { label: "Выполнен", tone: "lime" },
  refunded: { label: "Возврат", tone: "plain" },
};
const NOTE_MAX = 300;
export const pts = (n) => `${n} ${plural(n, ["балл", "балла", "баллов"])}`;

/** Строка заказа (кабинет, магазин). */
export function orderHTML(o) {
  const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
  return `<li class="pt-order">
    <span class="pt-order-icon" aria-hidden="true">${esc(o.item.icon || "🎁")}</span>
    <span class="pt-order-main">
      <b>${esc(o.item.title)}</b>
      <small>${pts(o.cost)} · ${esc(timeAgo(o.createdAt))}</small>
      ${o.note ? `<span class="pt-order-note">«${esc(o.note)}»</span>` : ""}
      ${o.adminNote ? `<span class="pt-order-reply">ndze: ${esc(o.adminNote)}</span>` : ""}
    </span>
    <span class="badge ${st.tone}">${esc(st.label)}</span>
  </li>`;
}

export function mount(container, ctx) {
  let data = null; // { items, balance, orders }
  let buying = null; // id награды, для которой открыта форма покупки
  let alive = true;
  const user = ctx.user || null;

  const loginBtn = (reason, label) => `<button class="btn btn-primary btn-sm" type="button" data-open-auth="login" data-reason="${esc(reason)}">${esc(label)}</button>`;

  function itemHTML(it) {
    const lack = user && data.balance !== null ? it.cost - data.balance : 0;
    let action;
    if (it.soldOut) action = `<button class="btn btn-ghost btn-sm" type="button" disabled>Закончилось</button>`;
    else if (!user) action = loginBtn("Войди, чтобы тратить баллы в магазине", "Войти и купить");
    else if (lack > 0) action = `<button class="btn btn-ghost btn-sm" type="button" disabled>Не хватает ${pts(lack)}</button>`;
    else action = `<button class="btn btn-primary btn-sm" type="button" data-buy="${esc(it.id)}">Купить</button>`;
    const form = buying === it.id ? `<form class="pt-buy-form" data-confirm="${esc(it.id)}">
        <div class="field">
          <textarea id="ptNote-${esc(it.id)}" name="note" placeholder=" " maxlength="${NOTE_MAX}" rows="3"></textarea>
          <label for="ptNote-${esc(it.id)}">Комментарий для ndze (необязательно)</label>
          <span class="error-msg"></span>
        </div>
        <p class="pt-buy-hint">Например, название трека или ник для титров. <span class="pt-count" data-count>0/${NOTE_MAX}</span></p>
        <div class="pt-buy-actions">
          <button class="btn btn-primary btn-sm" type="submit"><span>Подтвердить −${it.cost}</span><span class="spinner" aria-hidden="true"></span></button>
          <button class="btn btn-ghost btn-sm" type="button" data-cancel>Отмена</button>
        </div>
      </form>` : "";
    return `<article class="pt-item glass${buying === it.id ? " is-buying" : ""}${it.soldOut ? " is-out" : ""}" data-id="${esc(it.id)}">
      <span class="pt-item-icon" aria-hidden="true">${esc(it.icon || "🎁")}</span>
      <h3 class="pt-item-title">${esc(it.title)}</h3>
      ${it.description ? `<p class="pt-item-desc">${esc(it.description)}</p>` : ""}
      <div class="pt-item-foot">
        <span class="pt-cost"><i class="pt-coin-ico" aria-hidden="true"></i>${it.cost}</span>
        ${it.stock !== null ? `<span class="pt-stock${it.stock <= 3 ? " is-low" : ""}">${it.soldOut ? "нет в наличии" : `осталось ${it.stock}`}</span>` : ""}
        ${buying === it.id ? "" : action}
      </div>
      ${form}
    </article>`;
  }

  function render() {
    if (!alive) return;
    const orders = data.orders || [];
    container.innerHTML = `<div class="pt-shop">
      <div class="pt-head glass">
        <div>
          <h2 class="py-title">Магазин наград</h2>
          <p class="muted">Трать сайтовые баллы на плюшки на стриме. Баллы — за ежедневный бонус 🎁, угаданные ставки и топ сезона. Никаких денег.</p>
        </div>
        <div class="pt-balance">${user ? `<span>Твой баланс</span><b data-balance>${data.balance}</b><small>баллов</small>`
          : loginBtn("Войди, чтобы получить 1000 баллов", "Получить 1000 баллов")}</div>
      </div>
      <div class="pt-shop-grid">
        <div class="pt-items">
          ${data.items.length ? data.items.map(itemHTML).join("")
            : `<div class="empty"><span class="empty-icon">🛒</span><p>Витрина пока пустая — ndze скоро добавит награды.</p></div>`}
        </div>
        <aside class="py-side">
          ${user ? `<article class="glass py-box"><h3>Мои заказы</h3>
            ${orders.length ? `<ul class="pt-orders">${orders.slice(0, 8).map(orderHTML).join("")}</ul>`
              : `<p class="muted">Пока ничего не заказано.</p>`}
          </article>` : ""}
          <article class="glass py-box pt-howto"><h3>Где взять баллы</h3>
            <ul>
              <li><span aria-hidden="true">🎁</span><span>Ежедневный бонус в шапке сайта: от 20 до 70 баллов, растёт с серией.</span></li>
              <li><span aria-hidden="true">🔮</span><span><a class="py-link" href="#bets">Ставки на стрим</a> — угадавшие делят банк.</span></li>
              <li><span aria-hidden="true">🏆</span><span><a class="py-link" href="#season">Топ-3 сезона</a> получают 1000 / 500 / 250 баллов.</span></li>
            </ul>
          </article>
        </aside>
      </div>
    </div>`;
    if (buying) container.querySelector(`[data-confirm="${CSS.escape(buying)}"] textarea`)?.focus();
  }

  async function load() {
    try {
      data = await apiCall("shop");
      render();
    } catch (err) {
      if (alive) container.innerHTML = `<div class="empty"><span class="empty-icon">🛒</span><p>${esc(err.message)}</p></div>`;
    }
  }

  container.addEventListener("click", (e) => {
    const buy = e.target.closest("[data-buy]");
    if (buy) { buying = buy.dataset.buy; render(); return; }
    if (e.target.closest("[data-cancel]")) { buying = null; render(); }
  });
  container.addEventListener("input", (e) => {
    if (e.target.name !== "note") return;
    const c = e.target.closest("form")?.querySelector("[data-count]");
    if (c) c.textContent = `${[...e.target.value].length}/${NOTE_MAX}`;
  });
  container.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-confirm]");
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const note = form.elements.note.value.trim();
    const field = form.querySelector(".field");
    if ([...note].length > NOTE_MAX) {
      field.classList.add("invalid");
      field.querySelector(".error-msg").textContent = `Не больше ${NOTE_MAX} символов`;
      return;
    }
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const r = await apiCall("shop/buy", { method: "POST", body: { itemId: form.dataset.confirm, note, expectedCost: (data.items || []).find((i) => i.id === form.dataset.confirm)?.cost } });
      buying = null;
      data.balance = r.balance;
      data.orders = [r.order, ...(data.orders || [])];
      if (r.item) data.items = data.items.map((it) => (it.id === r.item.id ? r.item : it));
      toast(`Заказ «${r.order.item.title}» оформлен! ndze увидит его в пульте`);
      window.dispatchEvent(new CustomEvent("ndze:points", { detail: { balance: r.balance } }));
      render();
    } catch (err) {
      toast(err.message, "error", 6000);
      if (err.fields?.note) {
        field.classList.add("invalid");
        field.querySelector(".error-msg").textContent = err.fields.note;
      }
      btn.disabled = false;
      btn.classList.remove("is-loading");
      if (err.code !== "validation" || /закончил|нет в магазине/i.test(err.message)) { buying = null; load(); }
    }
  });

  // бонус забрали в шапке — обновим баланс и доступность кнопок
  const onPoints = (e) => {
    if (!data || typeof e.detail?.balance !== "number") return;
    data.balance = e.detail.balance;
    if (!buying) render();
    else { const b = container.querySelector("[data-balance]"); if (b) b.textContent = data.balance; }
  };
  window.addEventListener("ndze:points", onPoints);

  container.innerHTML = '<div class="skeleton py-skel"></div>';
  load();
  return { destroy() { alive = false; window.removeEventListener("ndze:points", onPoints); } };
}

// Пульт → «Push · Discord-вебхук»: подписчики push и тестовая рассылка, настройка Discord-вебхука
// (ссылка хранится на сервере и сюда приходит только замаскированной), события, тест и последний статус.
import { apiCall } from "../data/api.js";
import { $, $$, esc, plural, timeAgo, toast } from "../core/util.js";
import { DISCORD_SVG } from "../core/layout.js";
import { ensureCss } from "../modules.js";

ensureCss("notify.css");

const TOPIC_LABEL = { live: "эфир", news: "новости" };

export function mount(container) {
  const root = document.createElement("div");
  root.className = "nt-admin";
  root.innerHTML = '<div class="skeleton nt-box-skel"></div><div class="skeleton nt-box-skel"></div>';
  container.append(root);
  let data = null;
  let destroyed = false;

  const btn = (attrs, label, cls = "btn-ghost", type = "button") =>
    `<button class="btn ${cls} btn-sm" type="${type}" ${attrs}><span>${esc(label)}</span><span class="spinner${cls === "btn-primary" ? "" : " light"}" aria-hidden="true"></span></button>`;

  function pushHTML(p) {
    const st = p.status;
    let statusLine = '<p class="nt-note">Рассылок ещё не было.</p>';
    if (st) {
      statusLine = `<div class="nt-line"><span class="badge ${st.error ? "warn" : "lime"}">${esc(timeAgo(st.at))}</span>
        <span>«${esc(st.title)}»${st.topic ? ` · ${esc(TOPIC_LABEL[st.topic] || st.topic)}` : " · всем"}</span></div>
        <div class="nt-line"><span>отправлено <b>${st.sent}</b> · доставлено <b>${st.ok}</b> · удалено устаревших <b>${st.removed}</b> · ошибок <b>${st.failed}</b></span></div>
        ${st.error ? `<p class="nt-err">Первая ошибка: ${esc(st.error)}</p>` : ""}`;
    }
    return `<section class="nt-box glass" aria-labelledby="ntPushTitle">
      <h3 id="ntPushTitle"><span aria-hidden="true">🔔</span>Push-уведомления</h3>
      <div class="nt-stats">
        <div class="nt-stat"><b>${p.total}</b><span>${plural(p.total, ["подписчик", "подписчика", "подписчиков"])}</span></div>
        <div class="nt-stat"><b>${p.live}</b><span>на эфиры</span></div>
        <div class="nt-stat"><b>${p.news}</b><span>на новости</span></div>
        <div class="nt-stat"><b>${p.users}</b><span>с аккаунтом</span></div>
      </div>
      ${p.failing ? `<p class="nt-note">${p.failing} ${plural(p.failing, ["подписка", "подписки", "подписок"])} с ошибками доставки — после 5 ошибок подряд удаляется сама.</p>` : ""}
      <div><p class="nt-note nt-sub">Последняя рассылка</p>${statusLine}</div>
      <div class="nt-actions">${btn(`data-push-test${p.total ? "" : " disabled"}`, "Отправить тестовый push", "btn-primary")}</div>
      <p class="nt-note">Автоматически: «ndze в эфире» — при старте стрима, «Новость» — при новой теме в разделе «Новости» форума.
        Push уходит пустым, текст браузер берёт с сайта; до 500 подписчиков на событие. ${p.keyReady ? "" : "Ключи VAPID создадутся при первой подписке."}</p>
    </section>`;
  }

  function hookHTML(w) {
    const st = w.status;
    const evName = (k) => (k === "test" ? "тест" : w.labels[k] || k);
    const statusHTML = st
      ? `<div class="nt-line"><span class="badge ${st.ok ? "lime" : "danger"}">${st.ok ? "Доставлено" : "Ошибка"}</span>
          <span>${esc(evName(st.event))} · ${esc(timeAgo(st.at))}${st.status ? ` · HTTP ${st.status}` : ""} · ${st.ms} мс</span></div>
        ${st.error ? `<p class="nt-err">${esc(st.error)}</p>` : ""}`
      : '<p class="nt-note">Ещё ничего не отправлялось.</p>';
    return `<section class="nt-box glass" aria-labelledby="ntHookTitle">
      <h3 id="ntHookTitle">${DISCORD_SVG}Discord-вебхук</h3>
      <div class="nt-line">${w.configured
        ? `<span class="badge lime">Подключён</span><span class="nt-mono">${esc(w.masked)}</span>`
        : '<span class="badge plain">Не настроен</span>'}</div>
      <form class="nt-hook-form" data-hook-form novalidate>
        <div class="field">
          <input id="ntHookUrl" name="url" type="url" placeholder=" " autocomplete="off" spellcheck="false" inputmode="url" aria-describedby="ntHookUrl-err">
          <label for="ntHookUrl">${w.configured ? "Новая ссылка вебхука" : "Ссылка вебхука"}</label>
          <span class="error-msg" id="ntHookUrl-err"></span>
        </div>
        <p class="nt-note">Discord: настройки канала → Интеграции → Вебхуки → «Копировать URL вебхука». Ссылка хранится только на сервере.</p>
        <div class="nt-actions">
          ${btn("data-hook-save", "Сохранить ссылку", "btn-primary", "submit")}
          ${w.configured ? btn("data-hook-test", "Отправить тест") + btn("data-hook-del", "Удалить", "btn-danger") : ""}
        </div>
      </form>
      <fieldset class="nt-events"><legend>Что отправлять в канал</legend>
        ${Object.entries(w.labels).map(([k, label]) => `<label class="nt-switch">
          <input type="checkbox" data-event="${esc(k)}"${w.events[k] ? " checked" : ""}>
          <span class="nt-switch-ui" aria-hidden="true"></span><span class="nt-switch-text">${esc(label)}</span>
        </label>`).join("")}
      </fieldset>
      <div><p class="nt-note nt-sub">Последняя отправка</p>${statusHTML}</div>
      <p class="nt-note">Хостинг в России: discord.com может быть недоступен с сервера — тогда здесь будет «Нет связи». Сайт от этого не тормозит: отправка идёт уже после ответа посетителю.</p>
    </section>`;
  }

  function render() {
    if (destroyed || !data) return;
    root.innerHTML = pushHTML(data.push) + hookHTML(data.webhook);
  }

  async function load() {
    try {
      data = await apiCall("notify/admin");
      render();
    } catch (err) {
      if (!destroyed) root.innerHTML = `<div class="empty nt-wide"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  async function withBusy(button, fn) {
    if (!button || button.disabled) return;
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      await fn();
    } catch (err) {
      toast(err.message, "error");
      if (err.fields?.url) {
        const f = $("#ntHookUrl", root)?.closest(".field");
        if (f) { f.classList.add("invalid"); $(".error-msg", f).textContent = err.fields.url; }
      }
    } finally {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }

  root.addEventListener("click", (e) => {
    const test = e.target.closest("[data-push-test]");
    if (test) {
      const n = data.push.total;
      if (!confirm(`Отправить тестовый push всем (${n} ${plural(n, ["подписчик", "подписчика", "подписчиков"])})?`)) return;
      withBusy(test, async () => {
        const r = await apiCall("push/test", { method: "POST" });
        toast(r.error ? `Отправлено ${r.sent}, доставлено ${r.ok}. Ошибка: ${r.error}` : `Отправлено ${r.sent}, доставлено ${r.ok} 🔔`, r.ok || !r.sent ? "ok" : "error", 6000);
        await load();
      });
    }
    const hookTest = e.target.closest("[data-hook-test]");
    if (hookTest) {
      withBusy(hookTest, async () => {
        const st = await apiCall("notify/webhook/test", { method: "POST" });
        toast(st.ok ? "Тест ушёл в Discord ✔" : st.error, st.ok ? "ok" : "error", 7000);
        await load();
      });
    }
    const del = e.target.closest("[data-hook-del]");
    if (del && confirm("Удалить вебхук? Сообщения в Discord перестанут приходить.")) {
      withBusy(del, async () => {
        data.webhook = await apiCall("notify/webhook", { method: "POST", body: { url: "" } });
        toast("Вебхук удалён");
        render();
      });
    }
  });

  root.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-hook-form]");
    if (!form) return;
    e.preventDefault();
    const url = form.elements.url.value.trim();
    const field = form.elements.url.closest(".field");
    field.classList.remove("invalid");
    $(".error-msg", field).textContent = "";
    if (!url) {
      field.classList.add("invalid");
      $(".error-msg", field).textContent = "Вставь ссылку вебхука";
      return;
    }
    withBusy($("[data-hook-save]", form), async () => {
      data.webhook = await apiCall("notify/webhook", { method: "POST", body: { url } });
      toast("Вебхук сохранён — отправь тест, чтобы проверить связь");
      render();
    });
  });

  root.addEventListener("change", async (e) => {
    const box = e.target.closest("[data-event]");
    if (!box) return;
    box.disabled = true;
    try {
      data.webhook = await apiCall("notify/webhook", { method: "POST", body: { events: { [box.dataset.event]: box.checked } } });
      toast(`${box.checked ? "Включено" : "Выключено"}: ${data.webhook.labels[box.dataset.event]}`);
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message, "error");
    } finally {
      box.disabled = false;
    }
  });

  load();
  return { destroy() { destroyed = true; root.remove(); } };
}

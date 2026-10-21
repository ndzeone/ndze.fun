// Карточка «Уведомления в браузере» в настройках кабинета: Web Push «ndze в эфире» и новости.
// Регистрирует /sw.js (корень сайта), подписывается с applicationServerKey из push/key и сообщает серверу
// адрес подписки (push/subscribe). Сам push приходит пустым — текст service worker берёт из push/latest.
import { apiCall } from "../data/api.js";
import { $, $$, esc, toast } from "../core/util.js";
import { ensureCss } from "../modules.js";

ensureCss("notify.css");

const SITE_ROOT = new URL("../../../", import.meta.url); // файл в assets/js/profile/
const SW_URL = new URL("sw.js", SITE_ROOT);
const TOPICS = [
  { id: "live", label: "Эфир", hint: "когда ndze запускает стрим на Twitch" },
  { id: "news", label: "Новости", hint: "новые посты в разделе «Новости» на форуме" },
];
const STORE = "ndze:push-topics";

const supported = () => window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !("PushManager" in window);

function b64uToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const sameKey = (buf, key) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === key.length && a.every((v, i) => v === key[i]);
};

function savedTopics() {
  try {
    const t = JSON.parse(localStorage.getItem(STORE) || "null");
    if (Array.isArray(t) && t.length && t.every((x) => TOPICS.some((tp) => tp.id === x))) return t;
  } catch { /* приватный режим */ }
  return TOPICS.map((t) => t.id);
}
function storeTopics(t) {
  try { localStorage.setItem(STORE, JSON.stringify(t)); } catch { /* ничего */ }
}

const STATES = {
  unsupported: { badge: "plain", label: "Не поддерживается" },
  denied: { badge: "danger", label: "Запрещены в браузере" },
  on: { badge: "lime", label: "Включены" },
  off: { badge: "plain", label: "Выключены" },
  loading: { badge: "plain", label: "Проверяю…" },
};

export function mount(container) {
  const card = document.createElement("div");
  card.className = "pf-card glass nt-push";
  container.append(card);

  let state = "loading";
  let topics = savedTopics();
  let busy = false;
  let destroyed = false;

  function render() {
    const st = STATES[state];
    let note = "";
    if (state === "unsupported") {
      note = isIOS()
        ? "На iPhone и iPad уведомления работают, только если добавить сайт на экран «Домой» (Поделиться → На экран «Домой») и открыть его оттуда."
        : "Этот браузер не умеет push-уведомления (или сайт открыт не по HTTPS). Попробуй Chrome, Edge, Firefox или Safari.";
    } else if (state === "denied") {
      note = "Ты запретил уведомления для сайта. Разреши их в настройках браузера (значок замка слева от адреса → Уведомления), затем обнови страницу.";
    } else if (state === "on") {
      note = "Уведомления приходят, даже когда сайт закрыт. Выключить можно здесь или в настройках браузера.";
    } else {
      note = "Браузер спросит разрешение — нажми «Разрешить». Спама не будет: только эфиры и новости.";
    }
    const canUse = state === "on" || state === "off";
    card.innerHTML = `
      <h3><span aria-hidden="true">🔔</span>Уведомления в браузере</h3>
      <p class="muted">Узнавай первым, когда <b>ndze выходит в эфир</b> или публикует новость, — браузер покажет уведомление, даже если вкладка закрыта.</p>
      <div class="nt-push-state" role="status"><span class="badge ${st.badge}">${esc(st.label)}</span></div>
      ${canUse ? `<fieldset class="nt-topics"><legend>О чём уведомлять</legend>
        ${TOPICS.map((t) => `<label class="nt-switch">
          <input type="checkbox" data-topic="${t.id}"${topics.includes(t.id) ? " checked" : ""}${busy ? " disabled" : ""}>
          <span class="nt-switch-ui" aria-hidden="true"></span>
          <span class="nt-switch-text">${esc(t.label)}<small>${esc(t.hint)}</small></span>
        </label>`).join("")}
      </fieldset>` : ""}
      ${canUse ? `<div class="nt-push-actions">${state === "on"
        ? `<button class="btn btn-ghost btn-sm" type="button" data-push-off${busy ? " disabled" : ""}><span>Отключить</span><span class="spinner light" aria-hidden="true"></span></button>`
        : `<button class="btn btn-primary btn-sm" type="button" data-push-on${busy ? " disabled" : ""}><span>Включить уведомления</span><span class="spinner" aria-hidden="true"></span></button>`}
      </div>` : ""}
      <p class="nt-push-note">${esc(note)}</p>`;
    if (busy) $(".nt-push-actions .btn", card)?.classList.add("is-loading");
  }

  const registration = () => navigator.serviceWorker.getRegistration(SITE_ROOT.href);

  async function detect() {
    if (!supported()) { state = "unsupported"; return render(); }
    if (Notification.permission === "denied") { state = "denied"; return render(); }
    try {
      const reg = await registration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub && Notification.permission === "granted") {
        const r = await apiCall("push/state", { method: "POST", body: { endpoint: sub.endpoint } });
        if (r.subscribed) {
          topics = r.topics.length ? r.topics : topics;
          storeTopics(topics);
          state = "on";
        } else state = "off"; // браузер подписан, а сервер подписку забыл — «Включить» пришлёт её снова
      } else state = "off";
    } catch {
      state = "off";
    }
    if (!destroyed) render();
  }

  async function subscribe() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      state = perm === "denied" ? "denied" : "off";
      if (perm !== "denied") toast("Без разрешения браузера уведомления не придут", "error");
      return;
    }
    const reg = await navigator.serviceWorker.register(SW_URL.href, { scope: SITE_ROOT.pathname });
    await navigator.serviceWorker.ready;
    const { key } = await apiCall("push/key");
    const appKey = b64uToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, appKey)) { // ключ сервера сменился — подписываемся заново
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const json = sub.toJSON();
    const r = await apiCall("push/subscribe", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys, topics } });
    topics = r.topics;
    storeTopics(topics);
    state = "on";
  }

  async function unsubscribe() {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await apiCall("push/unsubscribe", { method: "POST", body: { endpoint } }).catch(() => {});
    }
    state = "off";
  }

  async function run(fn, okMsg) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
      if (okMsg && state === "on") toast(okMsg);
    } catch (err) {
      const msg = err?.name === "NotAllowedError" ? "Браузер не разрешил уведомления"
        : err?.name === "AbortError" ? "Push-сервис браузера не ответил — попробуй ещё раз позже"
          : err?.message || "Не получилось включить уведомления";
      toast(msg, "error");
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-push-on]")) run(subscribe, "Готово! Уведомления включены 🔔");
    else if (e.target.closest("[data-push-off]")) run(async () => { await unsubscribe(); toast("Уведомления выключены"); });
  });

  card.addEventListener("change", (e) => {
    const box = e.target.closest("[data-topic]");
    if (!box) return;
    const next = $$("[data-topic]", card).filter((b) => b.checked).map((b) => b.dataset.topic);
    if (!next.length) {
      box.checked = true;
      toast("Оставь хотя бы одну тему — или отключи уведомления совсем", "error");
      return;
    }
    topics = next;
    storeTopics(topics);
    if (state === "on") run(subscribe, "Настройки уведомлений сохранены");
  });

  render();
  detect();
  return { destroy() { destroyed = true; card.remove(); } };
}

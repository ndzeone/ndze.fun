// Общий каркас каждой страницы: шапка с навигацией, вход/регистрация, подвал,
// фон-паутина и курсор. Страница вызывает:
//
//   import { mountLayout, onUserChange, openAuth, getUser } from "../core/layout.js";
//   const user = await mountLayout("review");   // id страницы из NAV ниже
//
// onUserChange(cb)       — cb(User|null) при входе/выходе (сразу не вызывается)
// openAuth("login"|"register", reason?) — открыть окно входа; reason — подсказка сверху окна
// getUser()              — текущий пользователь (синхронно, после mountLayout)
import { SITE } from "../config.js";
import { api } from "../data/api.js";
import { checkSignIn, checkSignUp } from "../data/validate.js";
import { $, $$, esc, avatarHTML, wait, motion, toast } from "./util.js";
import { initFx } from "./fx.js";
import { initWebShooter, initKonami } from "./webshoot.js";
import { setupModal, shake } from "./modal.js";

export const NAV = [
  { id: "home", href: "index.html", label: "Главная" },
  { id: "projects", href: "projects.html", label: "Проекты" },
  { id: "repos", href: "repos.html", label: "GitHub" },
  { id: "review", href: "review.html", label: "Оценка работ" },
  { id: "tasks", href: "tasks.html", label: "Задания" },
  { id: "play", href: "play.html", label: "Движ" },
  { id: "stream", href: "stream.html", label: "Пульт", adminOnly: true },
  { id: "admin", href: "admin.html", label: "Админка", adminOnly: true },
];

const LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v26M3 16h26M6.8 6.8l18.4 18.4M25.2 6.8L6.8 25.2" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="16" r="4.5" fill="currentColor"/><circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/></svg>`;
export const DISCORD_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18.2 18.2 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.7 19.7 0 0 0 6 3l1.3-2.1a12.8 12.8 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.6 19.6 0 0 0 6-3c.5-5.1-.8-9.6-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>`;
const EYE_SVG =`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;

let user = null;
let pageId = "home";
const userListeners = new Set();
let auth; // { open(tab, reason) }

export const getUser = () => user;
export function onUserChange(cb) {
  userListeners.add(cb);
  return () => userListeners.delete(cb);
}
export const openAuth = (tab = "login", reason = "") => auth?.open(tab, reason);

/* ---------- Шапка ---------- */
function headerHTML() {
  return `
  <a href="index.html" class="logo" aria-label="${esc(SITE.nick)} — на главную">${LOGO_SVG}<span>${esc(SITE.nick)}</span></a>
  <nav class="nav-links" id="navLinks" aria-label="Разделы сайта"></nav>
  <div class="header-right">
    <div class="user-slot" id="userSlot"></div>
    <button class="burger" type="button" aria-label="Меню" aria-expanded="false" aria-controls="navLinks"><span></span></button>
  </div>`;
}

function renderNav() {
  $("#navLinks").innerHTML = NAV
    .filter((n) => !n.adminOnly || user?.role === "admin")
    .map((n) => `<a href="${n.href}" class="${n.adminOnly ? "admin-link" : ""}"${n.id === pageId ? ' aria-current="page"' : ""}>${esc(n.label)}</a>`)
    .join("");
}

function renderUserSlot() {
  const slot = $("#userSlot");
  if (user) {
    slot.innerHTML = `<div class="user-chip">
      <a class="user-chip-link" href="profile.html" title="Личный кабинет"${pageId === "profile" ? ' aria-current="page"' : ""}>
        ${avatarHTML(user.nick, user.avatarUrl)}
        <span class="user-name">${esc(user.nick)}</span>
        ${user.role === "admin" ? '<span class="role-badge">admin</span>' : ""}
        <span class="sr-only">— личный кабинет</span>
      </a>
      <button class="link-btn" type="button" data-logout>Выйти</button>
    </div>`;
  } else {
    slot.innerHTML = `<button class="btn btn-primary btn-sm" type="button" data-open-auth="login">Войти</button>`;
  }
}

function setUser(next) {
  const changed = (next?.id ?? null) !== (user?.id ?? null) || next?.role !== user?.role
    || next?.nick !== user?.nick || next?.avatarUrl !== user?.avatarUrl;
  user = next;
  renderNav();
  renderUserSlot();
  if (changed) userListeners.forEach((cb) => cb(user));
}

/* ---------- Окно входа / регистрации ---------- */
function authHTML() {
  return `
  <div class="modal-frame"><div class="modal-card">
    <span class="modal-ticks" aria-hidden="true"><i></i><i></i><i></i></span>
    <button class="modal-close" type="button" data-close aria-label="Закрыть">✕</button>
    <p class="modal-logo">${esc(SITE.nick)}</p>
    <h2 id="authTitle">Вход</h2>
    <p class="modal-sub" id="authReason">Войди, чтобы присылать работы на оценку и задания на стрим.</p>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" id="tabLogin" aria-selected="true" data-tab="login">Вход</button>
      <button type="button" role="tab" id="tabRegister" aria-selected="false" data-tab="register">Регистрация</button>
    </div>
    <button class="btn btn-discord btn-block" type="button" data-oauth="discord">${DISCORD_SVG}<span>Войти через Discord</span><span class="spinner light" aria-hidden="true"></span></button>
    <p class="or-line"><span>или по email</span></p>
    <form id="authForm" novalidate>
      <div class="field" data-for="nick" hidden>
        <input id="aNick" name="nick" type="text" placeholder=" " autocomplete="username" maxlength="20" aria-describedby="aNick-err">
        <label for="aNick">Ник</label><span class="error-msg" id="aNick-err"></span>
      </div>
      <div class="field">
        <input id="aEmail" name="email" type="email" placeholder=" " autocomplete="email" inputmode="email" aria-describedby="aEmail-err">
        <label for="aEmail">Email</label><span class="error-msg" id="aEmail-err"></span>
      </div>
      <div class="field">
        <input id="aPass" name="password" class="has-icon" type="password" placeholder=" " autocomplete="current-password" aria-describedby="aPass-err">
        <label for="aPass">Пароль</label>
        <button class="eye" type="button" aria-label="Показать пароль" aria-pressed="false">${EYE_SVG}</button>
        <div class="strength" data-level="0" hidden><i></i><i></i><i></i><i></i><span></span></div>
        <span class="error-msg" id="aPass-err"></span>
      </div>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit"><span class="submit-text">Войти</span><span class="spinner" aria-hidden="true"></span></button>
    </form>
    <div class="success-view">
      <svg class="check-icon" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="34"/><path d="M25 41l10 10 20-22"/></svg>
      <h2 id="authHello" tabindex="-1">Готово!</h2>
      <p class="muted" id="authHelloSub"></p>
    </div>
  </div></div>`;
}

const STRENGTH = ["", "Слабый", "Средний", "Хороший", "Отличный"];
function passwordScore(v) {
  if (!v) return 0;
  if (v.length < 8) return 1;
  let s = 1;
  if (v.length >= 12) s++;
  if (/\p{Ll}/u.test(v) && /\p{Lu}/u.test(v)) s++;
  if (/\d/.test(v) && /[^\p{L}\d]/u.test(v)) s++;
  return Math.min(s, 4);
}

function mountAuth() {
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.id = "authModal";
  dlg.setAttribute("aria-labelledby", "authTitle");
  dlg.innerHTML = authHTML();
  document.body.append(dlg);

  const card = $(".modal-card", dlg);
  const form = $("#authForm", dlg);
  const submit = $('button[type="submit"]', form);
  const meter = $(".strength", form);
  const eye = $(".eye", form);
  const formError = $(".form-error", form);
  let tab = "login";
  let session = 0;
  let closeTimer;

  const modal = setupModal(dlg, {
    onClose: () => { session++; clearTimeout(closeTimer); },
  });

  function setTab(next) {
    tab = next;
    const reg = tab === "register";
    $("#authTitle", dlg).textContent = reg ? "Регистрация" : "Вход";
    $(".submit-text", submit).textContent = reg ? "Создать аккаунт" : "Войти";
    $$("[data-tab]", dlg).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $('[data-for="nick"]', form).hidden = !reg;
    meter.hidden = !reg;
    form.elements.password.autocomplete = reg ? "new-password" : "current-password";
    clearErrors();
  }

  function clearErrors() {
    formError.textContent = "";
    for (const f of $$(".field", form)) {
      f.classList.remove("valid", "invalid");
      $(".error-msg", f).textContent = "";
    }
    for (const el of form.elements) el.removeAttribute?.("aria-invalid");
  }

  function showErrors(errors) {
    for (const [name, msg] of Object.entries(errors)) {
      const el = form.elements[name];
      if (!el) continue;
      const field = el.closest(".field");
      field.classList.add("invalid");
      el.setAttribute("aria-invalid", "true");
      $(".error-msg", field).textContent = msg;
    }
  }

  function reset() {
    session++;
    clearTimeout(closeTimer);
    form.reset();
    card.classList.remove("is-success", "shake");
    form.elements.password.type = "password";
    eye.setAttribute("aria-pressed", "false");
    meter.dataset.level = "0";
    $("span", meter).textContent = "";
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }

  dlg.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) setTab(t.dataset.tab);
    const oauth = e.target.closest("[data-oauth]");
    if (oauth && !oauth.disabled) {
      oauth.disabled = true;
      oauth.classList.add("is-loading");
      try {
        await api.signInWithOAuth(oauth.dataset.oauth); // при успехе браузер уходит на discord.com
      } catch (err) {
        formError.textContent = err.message;
        shake(card);
        oauth.disabled = false;
        oauth.classList.remove("is-loading");
      }
    }
  });

  eye.addEventListener("click", () => {
    const input = form.elements.password;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
  });

  form.addEventListener("input", (e) => {
    if (e.target.name === "password") {
      const lvl = passwordScore(e.target.value);
      meter.dataset.level = String(lvl);
      $("span", meter).textContent = STRENGTH[lvl];
    }
    const field = e.target.closest(".field");
    if (field?.classList.contains("invalid")) {
      field.classList.remove("invalid");
      $(".error-msg", field).textContent = "";
      e.target.removeAttribute("aria-invalid");
    }
    formError.textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    clearErrors();
    const data = {
      nick: form.elements.nick.value.trim(),
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
    };
    const errors = tab === "register" ? checkSignUp(data) : checkSignIn(data);
    if (Object.keys(errors).length) {
      showErrors(errors);
      shake(card);
      form.querySelector(".invalid input")?.focus();
      return;
    }

    const mySession = session;
    submit.disabled = true;
    submit.classList.add("is-loading");
    try {
      const u = tab === "register" ? await api.signUp(data) : await api.signIn(data);
      if (motion) await wait(400);
      if (mySession !== session || !dlg.open) return;
      $("#authHello", dlg).textContent = tab === "register" ? `Добро пожаловать, ${u.nick}!` : `С возвращением, ${u.nick}!`;
      $("#authHelloSub", dlg).textContent = u.role === "admin" ? "Ты вошёл как админ 🕷" : "Увидимся на стриме 🕷";
      card.classList.add("is-success");
      $("#authHello", dlg).focus();
      closeTimer = setTimeout(modal.close, 1800);
    } catch (err) {
      if (mySession !== session) return;
      if (err.fields) showErrors(err.fields);
      formError.textContent = err.message;
      shake(card);
    } finally {
      submit.disabled = false;
      submit.classList.remove("is-loading");
    }
  });

  return {
    open(nextTab = "login", reason = "") {
      reset();
      setTab(nextTab);
      $("#authReason", dlg).textContent = reason || "Войди, чтобы присылать работы на оценку и задания на стрим.";
      modal.open();
      form.elements[nextTab === "register" ? "nick" : "email"].focus();
    },
  };
}

/* ---------- Подвал ---------- */
function footerHTML() {
  const links = [...SITE.socials, ...(SITE.links || [])].map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join("");
  return `<span>© ${new Date().getFullYear()} ${esc(SITE.nick)} · сделано с паутиной 🕸</span><nav class="footer-links" aria-label="Соцсети">${links}</nav>`;
}

/* ---------- Возврат с Discord: показать итог и убрать ?code=… из адреса ---------- */
// api/discord-callback.php возвращает на страницу с ?auth=discord или ?auth=discord_error&reason=…
const DISCORD_ERRORS = {
  unreachable: "Сервер сайта не может связаться с Discord (в России он заблокирован). Войди по email.",
  access_denied: "Вход через Discord отменён.",
  not_configured: "Вход через Discord ещё не настроен.",
  state: "Ссылка входа устарела — попробуй ещё раз.",
  discord_taken: "Этот Discord уже привязан к другому аккаунту на сайте.",
  already_linked: "К твоему аккаунту уже привязан другой Discord — сначала отвяжи его.",
  unlinked: "Этот Discord отвязан от аккаунта. Войди по email и паролю — привязать снова можно в личном кабинете.",
};
function handleOAuthReturn() {
  const url = new URL(location.href);
  const auth = url.searchParams.get("auth");
  if (!auth || !auth.startsWith("discord")) return;
  if (auth === "discord_linked") toast("Discord привязан к аккаунту 🎉");
  else if (auth === "discord" && user) toast(`Привет, ${user.nick}! Ты вошёл через Discord`);
  else toast(DISCORD_ERRORS[url.searchParams.get("reason")] || "Не получилось войти через Discord — попробуй ещё раз.", "error", 7000);
  url.searchParams.delete("auth");
  url.searchParams.delete("reason");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

/* ---------- «Паучье чутьё»: идёт ли стрим ---------- */
// Сервер спрашивает Twitch не чаще раза в минуту (api/lib/settings.php), мы — раз в 90 с, пока вкладка видна.
// Событие window "ndze:live" (detail — статус) слушают страницы: например, у паука на главной загораются глаза.
const LIVE_EVERY = 90_000;
let liveStatus = null;
export const getLive = () => liveStatus;

function liveBannerHTML(s) {
  const what = [s.title, s.game].filter(Boolean).join(" · ");
  return `<a class="live-banner-link" href="https://www.twitch.tv/${esc(s.channel || SITE.twitch.channel)}" target="_blank" rel="noopener">
      <span class="live-dot" aria-hidden="true"></span><b>${esc(SITE.nick)} в эфире</b>
      ${what ? `<span class="live-what">${esc(what)}</span>` : ""}
      <span class="live-go">Смотреть <span aria-hidden="true">↗</span></span>
    </a>
    <button class="live-close" type="button" aria-label="Скрыть плашку">✕</button>`;
}

function startLiveWatch(header) {
  if (api.mode !== "php" || typeof api.live !== "function") return;
  const banner = document.createElement("div");
  banner.className = "live-banner";
  banner.hidden = true;
  banner.setAttribute("role", "status");
  header.after(banner);
  let dismissed = "";
  try { dismissed = sessionStorage.getItem("ndze:live-hide") || ""; } catch { /* приватный режим */ }

  banner.addEventListener("click", (e) => {
    if (!e.target.closest(".live-close")) return;
    banner.hidden = true;
    dismissed = String(liveStatus?.title ?? "live"); // скрыли этот эфир; новый стрим (другое название) покажем снова
    try { sessionStorage.setItem("ndze:live-hide", dismissed); } catch { /* ничего */ }
  });

  const check = async () => {
    if (document.hidden) return;
    let s;
    try { s = await api.live(); } catch { return; }
    const was = liveStatus?.live;
    liveStatus = s;
    document.documentElement.classList.toggle("is-live", !!s.live);
    if (s.live) {
      banner.innerHTML = liveBannerHTML(s);
      banner.hidden = dismissed === String(s.title ?? "live");
    } else banner.hidden = true;
    if (was !== s.live) window.dispatchEvent(new CustomEvent("ndze:live", { detail: s }));
  };
  check();
  setInterval(check, LIVE_EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

/* ---------- Монтирование ---------- */
export async function mountLayout(page) {
  pageId = page;
  const body = document.body;

  const fxLayer = document.createElement("div");
  fxLayer.innerHTML = `<a class="skip" href="#main">К содержимому</a>
    <canvas id="web" aria-hidden="true"></canvas>
    <div class="cursor-dot" aria-hidden="true"></div><div class="cursor-ring" aria-hidden="true"></div>`;
  body.prepend(...fxLayer.children);

  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = headerHTML();
  $(".skip").after(header);

  if (api.mode === "local") {
    const banner = document.createElement("div");
    banner.className = "demo-banner";
    banner.innerHTML = `<span>⚠ Демо-режим: аккаунты и работы хранятся только в этом браузере.</span><span>Это локальный просмотр — на ndze.fun работает настоящая база.</span>`;
    header.before(banner);
  }

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = footerHTML();
  body.append(footer);

  auth = mountAuth();

  // Бургер-меню
  const burger = $(".burger", header);
  const nav = $("#navLinks", header);
  burger.addEventListener("click", () => {
    const open = burger.getAttribute("aria-expanded") !== "true";
    burger.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  });
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      burger.setAttribute("aria-expanded", "false");
      nav.classList.remove("is-open");
    }
  });

  document.addEventListener("click", async (e) => {
    const openBtn = e.target.closest("[data-open-auth]");
    if (openBtn) openAuth(openBtn.dataset.openAuth || "login", openBtn.dataset.reason || "");
    if (e.target.closest("[data-logout]")) {
      await api.signOut();
      toast("Ты вышел из аккаунта");
    }
  });

  api.onAuthChange((u) => setUser(u));
  try {
    user = await api.getUser();
  } catch {
    user = null;
  }
  handleOAuthReturn();
  renderNav();
  renderUserSlot();
  initFx();
  initWebShooter(); // зажми мышь — выстрел паутиной
  initKonami();     // ↑↑↓↓←→←→BA — Питер пролетает через экран
  startLiveWatch(header);
  return user;
}

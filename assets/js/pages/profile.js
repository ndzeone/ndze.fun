// Личный кабинет: аватарка, ник, пароль, Discord, мои работы и задания.
import { mountLayout, onUserChange, getUser, DISCORD_SVG } from "../core/layout.js";
import { api } from "../data/api.js";
import { SUB_STATUSES, TASK_STATUSES, GAMES, CATEGORIES, DIFFICULTIES, LIMITS, byId } from "../data/constants.js";
import { checkNick, checkPasswordChange, checkAvatar } from "../data/validate.js";
import { initMagnetic } from "../core/fx.js";
import { $, $$, esc, avatarHTML, plural, timeAgo, formatDate, toast, motion } from "../core/util.js";

const root = $("#profileRoot");
const fileInput = $("#avatarInput");

const TABS = [
  { id: "works", label: "Мои работы" },
  { id: "tasks", label: "Мои задания" },
  { id: "settings", label: "Настройки" },
];
let profile = null; // Profile из api.getProfile()
let works = [];
let tasks = [];
let tab = TABS.some((t) => `#${t.id}` === location.hash) ? location.hash.slice(1) : "works";
let loadSeq = 0;
let avatarBusy = false;

await mountLayout("profile");

/* ---------- Загрузка ---------- */
async function load() {
  const seq = ++loadSeq;
  if (!getUser()) {
    profile = null;
    renderGuest();
    return;
  }
  try {
    const [p, subs, allTasks] = await Promise.all([api.getProfile(), api.listSubmissions({ scope: "mine" }), api.listTasks()]);
    if (seq !== loadSeq) return;
    profile = p;
    works = subs;
    tasks = allTasks.filter((t) => t.userId === p.user.id);
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    if (err.code === "auth_required") renderGuest();
    else root.innerHTML = `<div class="empty pf-error"><span class="empty-icon">🕸</span><p>Не удалось открыть кабинет: ${esc(err.message)}</p>
      <button class="btn btn-ghost btn-sm" type="button" data-act="retry">Попробовать ещё раз</button></div>`;
  }
}

onUserChange((u) => {
  if (!u || u.id !== profile?.user.id) return load();
  profile.user = u; // сменился ник или аватарка — перерисуем шапку кабинета
  renderHero();
});

/* ---------- Гость ---------- */
function renderGuest() {
  root.innerHTML = `<section class="pf-guest glass" aria-labelledby="pfGuestTitle">
    ${avatarHTML("?", null, { size: "xl", extra: "ghost" })}
    <h1 id="pfGuestTitle">Личный кабинет</h1>
    <p class="muted">Войди, чтобы поставить аватарку, сменить ник и следить за своими работами и заданиями на стрим.</p>
    <div class="pf-guest-cta">
      <button class="btn btn-primary magnetic" type="button" data-open-auth="login" data-reason="Войди, чтобы открыть личный кабинет.">Войти</button>
      <button class="btn btn-ghost magnetic" type="button" data-open-auth="register">Регистрация</button>
    </div>
  </section>`;
  initMagnetic();
}

/* ---------- Кабинет ---------- */
function render() {
  root.innerHTML = `${heroHTML()}${statsHTML()}
    <div class="pf-tabs" role="tablist" aria-label="Разделы кабинета">
      ${TABS.map((t) => `<button type="button" role="tab" id="tab-${t.id}" aria-controls="pfPanel" aria-selected="${t.id === tab}" data-tab="${t.id}">${esc(t.label)}${tabCount(t.id)}</button>`).join("")}
    </div>
    <section class="pf-panel" id="pfPanel" role="tabpanel" aria-labelledby="tab-${tab}">${panelHTML()}</section>`;
  if (motion) $$(".pf-stat-n[data-n]", root).forEach(countUp);
}

function tabCount(id) {
  const n = id === "works" ? works.length : id === "tasks" ? tasks.length : null;
  return n === null ? "" : `<span class="tab-n">${n}</span>`;
}

function heroHTML() {
  const u = profile.user;
  return `<section class="pf-hero glass" id="pfHero" aria-labelledby="pfNick">
    <div class="pf-avatar-zone" id="avatarZone">
      <button class="pf-avatar-btn${avatarBusy ? " is-loading" : ""}" type="button" data-act="avatar-pick" aria-label="Сменить аватарку">
        ${avatarHTML(u.nick, u.avatarUrl, { size: "xl" })}
        <span class="pf-avatar-overlay" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Сменить</span>
        <span class="spinner light" aria-hidden="true"></span>
      </button>
      <div class="pf-avatar-actions">
        <button class="btn btn-ghost btn-xs" type="button" data-act="avatar-pick"${avatarBusy ? " disabled" : ""}>Загрузить</button>
        ${u.avatarUrl ? `<button class="btn btn-ghost btn-xs" type="button" data-act="avatar-remove"${avatarBusy ? " disabled" : ""}>Удалить</button>` : ""}
      </div>
      <p class="pf-avatar-hint">JPG, PNG, WEBP или GIF до 10 МБ.<br>Можно перетащить сюда.</p>
    </div>
    <div class="pf-info">
      <p class="pf-eyebrow"><span class="pulse-dot" aria-hidden="true"></span>Личный кабинет</p>
      <h1 class="pf-nick" id="pfNick">${esc(u.nick)}</h1>
      <div class="pf-badges">
        ${u.role === "admin" ? '<span class="badge lime">админ сайта</span>' : '<span class="badge plain">зритель</span>'}
        <span class="badge plain">на сайте с ${esc(formatDate(u.createdAt))}</span>
        ${profile.discordLinked ? `<span class="badge pf-discord-badge">${DISCORD_SVG}Discord</span>` : ""}
      </div>
      <p class="pf-email">${u.email ? esc(u.email) : "email не указан — входишь через Discord"}</p>
      <div class="pf-quick">
        <a class="btn btn-primary btn-sm magnetic" href="review.html">Прислать работу ↗</a>
        <a class="btn btn-ghost btn-sm magnetic" href="tasks.html">Предложить задание</a>
      </div>
    </div>
  </section>`;
}

function renderHero() {
  const hero = $("#pfHero", root);
  if (!hero || !profile) return;
  hero.outerHTML = heroHTML();
  initMagnetic();
}

function statsHTML() {
  const s = profile.stats;
  const items = [
    { n: s.submissions, label: plural(s.submissions, ["работа отправлена", "работы отправлено", "работ отправлено"]) },
    { n: s.ideal, label: "доведено до идеала", lime: true },
    { n: s.avgRating, label: "средняя оценка", suffix: s.avgRating === null ? "" : "/10" },
    { n: s.tasks, label: plural(s.tasks, ["задание предложено", "задания предложено", "заданий предложено"]) },
    { n: s.tasksDone, label: "выполнено на стриме", lime: true },
    { n: s.votesReceived, label: plural(s.votesReceived, ["голос за задания", "голоса за задания", "голосов за задания"]) },
  ];
  return `<div class="pf-stats">${items.map((it) => {
    const int = Number.isInteger(it.n);
    const shown = it.n === null ? "—" : motion && int ? 0 : it.n;
    return `<div class="pf-stat glass${it.lime ? " is-lime" : ""}">
      <span class="pf-stat-n"${int ? ` data-n="${it.n}"` : ""}>${shown}</span>${it.suffix ? `<small>${it.suffix}</small>` : ""}
      <span class="pf-stat-l">${esc(it.label)}</span>
    </div>`;
  }).join("")}</div>`;
}

function countUp(el) {
  const target = Number(el.dataset.n);
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 900);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- Вкладки ---------- */
function panelHTML() {
  if (tab === "tasks") return tasksHTML();
  if (tab === "settings") return settingsHTML();
  return worksHTML();
}

function setTab(next) {
  tab = next;
  history.replaceState(history.state, "", `#${tab}`);
  $$("[data-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const panel = $("#pfPanel", root);
  panel.setAttribute("aria-labelledby", `tab-${tab}`);
  panel.innerHTML = panelHTML();
  panel.classList.remove("is-in");
  void panel.offsetWidth; // перезапуск анимации появления
  panel.classList.add("is-in");
  initMagnetic();
}

function worksHTML() {
  if (!works.length) {
    return `<div class="empty"><span class="empty-icon">🎨</span><p>Ты ещё не присылал работ на оценку.</p>
      <a class="btn btn-primary btn-sm magnetic" href="review.html">Прислать первую работу</a></div>`;
  }
  return `<div class="pf-works">${works.map((s) => {
    const st = byId(SUB_STATUSES, s.status) || { label: s.status, tone: "plain" };
    const last = s.versions[s.versions.length - 1];
    const img = last?.imageUrls?.[0];
    const cat = byId(CATEGORIES, s.category)?.label || "";
    return `<a class="pf-work glass" href="review.html#sub=${encodeURIComponent(s.id)}">
      <span class="pf-work-thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : "🖼"}</span>
      <span class="pf-work-body">
        <span class="pf-work-top"><span class="badge ${st.tone}">${esc(st.label)}</span>${s.rating ? `<span class="pf-rating">${s.rating}<small>/10</small></span>` : ""}</span>
        <strong>${esc(s.title)}</strong>
        <span class="faint">${esc(cat)} · v${s.versions.length} · ${esc(timeAgo(s.updatedAt))}${s.comments.length ? ` · 💬 ${s.comments.length}` : ""}</span>
      </span>
    </a>`;
  }).join("")}</div>`;
}

function tasksHTML() {
  if (!tasks.length) {
    return `<div class="empty"><span class="empty-icon">🎮</span><p>Ты ещё не предлагал заданий на стрим.</p>
      <a class="btn btn-primary btn-sm magnetic" href="tasks.html">Предложить задание</a></div>`;
  }
  return `<ul class="pf-tasks">${tasks.map((t) => {
    const g = byId(GAMES, t.game);
    const st = byId(TASK_STATUSES, t.status) || { label: t.status, tone: "plain" };
    const d = byId(DIFFICULTIES, t.difficulty);
    return `<li class="pf-task glass" style="--game:${esc(g?.color || "#5dd62c")}">
      <span class="pf-task-game">${esc(g?.short || t.game)}</span>
      <span class="pf-task-body">
        <strong>${esc(t.title)}</strong>
        <span class="faint">${esc(g?.label || "")}${d ? ` · ${esc(d.label)}` : ""} · ${esc(timeAgo(t.createdAt))}</span>
        ${t.adminNote ? `<span class="pf-task-note"><b>ndze:</b> ${esc(t.adminNote)}</span>` : ""}
      </span>
      <span class="pf-task-side"><span class="badge ${st.tone}">${esc(st.label)}</span><span class="pf-votes" title="Голоса">▲ ${t.votes}</span></span>
    </li>`;
  }).join("")}</ul><p class="pf-more"><a class="btn btn-ghost btn-sm magnetic" href="tasks.html">Все задания →</a></p>`;
}

function passField(id, name, label, autocomplete) {
  return `<div class="field">
    <input id="${id}" name="${name}" type="password" placeholder=" " autocomplete="${autocomplete}" aria-describedby="${id}-err">
    <label for="${id}">${label}</label><span class="error-msg" id="${id}-err"></span>
  </div>`;
}

function settingsHTML() {
  const u = profile.user;
  const canSetPassword = profile.hasPassword || !!u.email;
  const canUnlink = profile.hasPassword && !!u.email;
  return `<div class="pf-settings">
    <form class="pf-card glass" id="nickForm" novalidate>
      <h3>Ник</h3>
      <p class="muted">Виден в заданиях, работах и комментариях. 3–20 символов: буквы, цифры и&nbsp;«_».</p>
      <div class="field">
        <input id="sNick" name="nick" type="text" placeholder=" " maxlength="${LIMITS.nick.max}" autocomplete="nickname" value="${esc(u.nick)}" aria-describedby="sNick-err">
        <label for="sNick">Ник</label><span class="error-msg" id="sNick-err"></span>
      </div>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-sm" type="submit"><span>Сохранить ник</span><span class="spinner" aria-hidden="true"></span></button>
    </form>

    <form class="pf-card glass" id="passForm" novalidate>
      <h3>${profile.hasPassword ? "Пароль" : "Задать пароль"}</h3>
      <p class="muted">${profile.hasPassword
        ? "Этот браузер останется в аккаунте, а все остальные устройства выйдут."
        : u.email
          ? `Сейчас ты входишь через Discord. С паролем сможешь входить и по email <b>${esc(u.email)}</b>.`
          : "У аккаунта нет email — входить можно только через Discord."}</p>
      ${canSetPassword ? `
        <input type="text" name="username" autocomplete="username" value="${esc(u.email || u.nick)}" hidden>
        ${profile.hasPassword ? passField("sCur", "currentPassword", "Текущий пароль", "current-password") : ""}
        ${passField("sNew", "newPassword", "Новый пароль", "new-password")}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-sm" type="submit"><span>${profile.hasPassword ? "Сменить пароль" : "Задать пароль"}</span><span class="spinner" aria-hidden="true"></span></button>` : ""}
    </form>

    <div class="pf-card glass pf-discord-card">
      <h3>${DISCORD_SVG}Discord</h3>
      ${profile.discordLinked
        ? `<p class="muted">Discord привязан — можно входить в один клик. Аватарка из Discord подтягивается сама, если ты не загрузил свою.</p>
           ${canUnlink
             ? `<button class="btn btn-ghost btn-sm" type="button" data-act="discord-unlink"><span>Отвязать Discord</span><span class="spinner light" aria-hidden="true"></span></button>`
             : `<p class="hint">Чтобы отвязать Discord, сначала задай пароль — иначе не сможешь войти.</p>`}`
        : `<p class="muted">Привяжи Discord, чтобы входить в один клик и взять аватарку оттуда.</p>
           <button class="btn btn-discord btn-sm" type="button" data-act="discord-link">${DISCORD_SVG}<span>Привязать Discord</span><span class="spinner light" aria-hidden="true"></span></button>`}
    </div>

    <div class="pf-card glass pf-exit">
      <h3>Выход</h3>
      <p class="muted">Выйти из аккаунта в этом браузере.</p>
      <button class="btn btn-danger btn-sm" type="button" data-logout>Выйти из аккаунта</button>
    </div>
  </div>`;
}

/* ---------- Формы настроек ---------- */
function clearErrors(form) {
  $(".form-error", form).textContent = "";
  for (const f of $$(".field", form)) {
    f.classList.remove("invalid");
    $(".error-msg", f).textContent = "";
    $("input", f)?.removeAttribute("aria-invalid");
  }
}

function showErrors(form, errors, message) {
  let shown = false;
  for (const [name, msg] of Object.entries(errors || {})) {
    const el = form.elements[name];
    const field = el?.closest?.(".field");
    if (!field) continue;
    field.classList.add("invalid");
    el.setAttribute("aria-invalid", "true");
    $(".error-msg", field).textContent = msg;
    shown = true;
  }
  if (!shown && message) $(".form-error", form).textContent = message;
  form.querySelector(".invalid input")?.focus();
  form.classList.remove("shake");
  void form.offsetWidth;
  form.classList.add("shake");
}

async function submitForm(form, run) {
  const btn = $('button[type="submit"]', form);
  if (btn.disabled) return;
  clearErrors(form);
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    await run();
  } catch (err) {
    showErrors(form, err.fields, err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

root.addEventListener("submit", (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.id === "nickForm") {
    const nick = form.elements.nick.value.trim();
    const errs = checkNick(nick);
    if (Object.keys(errs).length) return showErrors(form, errs);
    if (nick === profile.user.nick) return toast("Это и так твой ник 🙂");
    submitForm(form, async () => {
      await api.updateProfile({ nick });
      toast(`Теперь ты — ${nick}`);
    });
  }
  if (form.id === "passForm") {
    const data = {
      currentPassword: form.elements.currentPassword?.value ?? "",
      newPassword: form.elements.newPassword.value,
      hasPassword: profile.hasPassword,
    };
    const errs = checkPasswordChange(data);
    if (Object.keys(errs).length) return showErrors(form, errs);
    submitForm(form, async () => {
      await api.changePassword(data);
      const first = !profile.hasPassword;
      profile.hasPassword = true;
      toast(first ? "Пароль задан — теперь можно входить и по email" : "Пароль изменён");
      if (first) setTab("settings");
      else form.reset();
    });
  }
});

root.addEventListener("input", (e) => {
  const field = e.target.closest(".field");
  if (field?.classList.contains("invalid")) {
    field.classList.remove("invalid");
    $(".error-msg", field).textContent = "";
    e.target.removeAttribute("aria-invalid");
  }
});

/* ---------- Кнопки ---------- */
root.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn && tabBtn.dataset.tab !== tab) return setTab(tabBtn.dataset.tab);

  const act = e.target.closest("[data-act]");
  if (!act || act.disabled) return;
  switch (act.dataset.act) {
    case "retry":
      return load();
    case "avatar-pick":
      if (!avatarBusy) fileInput.click();
      return;
    case "avatar-remove":
      return removeAvatar();
    case "discord-link":
      act.disabled = true;
      act.classList.add("is-loading");
      try {
        await api.linkDiscord(); // уходим на Discord
      } catch (err) {
        toast(err.message, "error", 6000);
        act.disabled = false;
        act.classList.remove("is-loading");
      }
      return;
    case "discord-unlink":
      if (!confirm("Отвязать Discord? Входить можно будет только по email и паролю, другие устройства выйдут из аккаунта.")) return;
      act.disabled = true;
      act.classList.add("is-loading");
      try {
        profile = await api.unlinkDiscord();
        toast("Discord отвязан");
        render();
      } catch (err) {
        toast(err.message, "error", 6000);
        act.disabled = false;
        act.classList.remove("is-loading");
      }
  }
});

// Стрелки ← → по вкладкам (как у role="tablist")
root.addEventListener("keydown", (e) => {
  const cur = e.target.closest("[data-tab]");
  if (!cur || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
  const i = TABS.findIndex((t) => t.id === cur.dataset.tab);
  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  setTab(next.id);
  $(`[data-tab="${next.id}"]`, root).focus();
});

/* ---------- Аватарка ---------- */
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) uploadAvatar(file);
});

root.addEventListener("dragover", (e) => {
  const zone = e.target.closest("#avatarZone");
  if (!zone || avatarBusy || !e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  zone.classList.add("is-drag");
});
root.addEventListener("dragleave", (e) => {
  const zone = e.target.closest("#avatarZone");
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("is-drag");
});
root.addEventListener("drop", (e) => {
  const zone = e.target.closest("#avatarZone");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("is-drag");
  const file = e.dataTransfer?.files?.[0];
  if (file && !avatarBusy) uploadAvatar(file);
});

async function uploadAvatar(file) {
  const errs = checkAvatar(file);
  if (errs.files) return toast(errs.files, "error", 6000);
  avatarBusy = true;
  renderHero();
  // мгновенный предпросмотр, пока файл грузится на сервер
  const preview = URL.createObjectURL(file);
  const av = $("#avatarZone .avatar", root);
  av?.classList.add("has-img");
  av?.querySelector("img")?.remove();
  av?.insertAdjacentHTML("beforeend", `<img src="${esc(preview)}" alt="">`);
  try {
    await api.uploadAvatar(file); // onUserChange перерисует шапку кабинета
    toast("Аватарка обновлена");
  } catch (err) {
    toast(err.message, "error", 6000);
  } finally {
    avatarBusy = false;
    renderHero();
    URL.revokeObjectURL(preview);
  }
}

async function removeAvatar() {
  if (avatarBusy) return;
  avatarBusy = true;
  renderHero();
  try {
    await api.removeAvatar();
    toast("Аватарка удалена");
  } catch (err) {
    toast(err.message, "error", 6000);
  } finally {
    avatarBusy = false;
    renderHero();
  }
}

await load();

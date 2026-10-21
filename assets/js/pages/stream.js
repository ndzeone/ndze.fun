// Пульт стрима (только админ): колесо заданий, оверлеи OBS, ставки, вайтлист, холст.
import { mountLayout, onUserChange, openAuth } from "../core/layout.js";
import { api, toApiError } from "../data/api.js";
import { GAMES, byId } from "../data/constants.js";
import { $, esc, avatarHTML, timeAgo, toast, motion } from "../core/util.js";
import { drawWheel, spinWheel } from "../core/wheel.js";
import { MODULES, loadModule } from "../modules.js";

const root = $("#streamRoot");
const user = await mountLayout("stream");
let state = null; // ответ api.stream()
let spinning = false;

const WIDGETS = [
  { w: "all", label: "Всё вместе", hint: "задание, топ, колесо и QR — 1920×1080" },
  { w: "task", label: "Текущее задание", hint: "плашка 800×200" },
  { w: "top", label: "Топ-3 заданий", hint: "колонка 480×420" },
  { w: "work", label: "Последняя работа", hint: "карточка 520×480" },
  { w: "wheel", label: "Колесо", hint: "появляется при прокрутке, 700×700" },
  { w: "qr", label: "QR на сайт", hint: "квадрат 300×300" },
  { w: "schedule", label: "Следующий стрим", hint: "760×220" },
  { w: "goals", label: "Цели канала", hint: "800×360" },
  { w: "viewer", label: "Зритель дня", hint: "620×170" },
  { w: "poll", label: "Опрос", hint: "720×420" },
  { w: "giveaway", label: "Розыгрыш", hint: "720×420" },
  { w: "bingo", label: "Бинго", hint: "520×600" },
  { w: "teams", label: "Война команд", hint: "900×200" },
];
const overlayUrl = (w) => new URL(`overlay.html?w=${w}&key=${state.overlayKey}`, location.href).href;
const errText = (e) => esc(toApiError(e).message);

function locked(u) {
  root.innerHTML = `<section class="empty"><span class="empty-icon">🔒</span><p>Пульт доступен только владельцу сайта.</p>
    ${u ? "" : '<button class="btn btn-primary btn-sm" type="button" data-login>Войти</button>'}</section>`;
}
root.addEventListener("click", (e) => { if (e.target.closest("[data-login]")) openAuth("login", "Пульт доступен только владельцу сайта"); });

function shell() {
  return `
  <section class="st-block st-wheel-block glass" aria-labelledby="wTitle">
    <div class="st-wheel-wrap"><canvas class="st-wheel" id="wheel" width="420" height="420" role="img" aria-label="Колесо заданий"></canvas></div>
    <div class="st-wheel-side">
      <h2 id="wTitle">Колесо заданий</h2>
      <p class="muted">Крутятся принятые задания; чем больше голосов, тем больше сектор. Выпавшее задание получает статус «На стриме» и попадает в оверлей.</p>
      <button class="btn btn-primary st-spin" type="button" data-spin><span>🎡 Крутить!</span><span class="spinner" aria-hidden="true"></span></button>
      <div class="st-result" id="wheelResult" aria-live="polite"></div>
      <ul class="st-cands" id="cands"></ul>
    </div>
  </section>

  <section class="st-block" aria-labelledby="curTitle">
    <div class="section-head"><span class="section-index">01</span><h2 id="curTitle">Текущее задание</h2></div>
    <div class="glass st-box" id="current"></div>
  </section>

  <section class="st-block" aria-labelledby="ovTitle">
    <div class="section-head"><span class="section-index">02</span><h2 id="ovTitle">Оверлеи для OBS</h2><span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-regen>Новый ключ</button></div>
    <p class="muted st-note">В OBS: «Источники» → «+» → «Браузер», вставь ссылку и размер. Фон прозрачный. Ссылки секретные — не показывай их в эфире; если ключ утёк, нажми «Новый ключ».</p>
    <div class="st-overlays" id="overlays"></div>
  </section>

  <section class="st-block" aria-labelledby="betTitle">
    <div class="section-head"><span class="section-index">03</span><h2 id="betTitle">Ставки зрителей</h2></div>
    <form class="glass st-box st-bet-form" id="betForm" novalidate>
      <div class="field"><input id="bQ" name="question" type="text" placeholder=" " maxlength="160"><label for="bQ">Вопрос, например «Пройдёт ли ndze данж за 30 минут?»</label></div>
      <div class="st-bet-opts">
        ${[0, 1, 2, 3].map((i) => `<div class="field"><input name="opt${i}" type="text" placeholder=" " maxlength="40" value="${i === 0 ? "Да" : i === 1 ? "Нет" : ""}"><label>Вариант ${i + 1}${i > 1 ? " (необязательно)" : ""}</label></div>`).join("")}
      </div>
      <button class="btn btn-primary btn-sm" type="submit"><span>Открыть ставки</span><span class="spinner" aria-hidden="true"></span></button>
    </form>
    <div class="st-bets" id="bets"></div>
  </section>

  <section class="st-block" aria-labelledby="wlTitle">
    <div class="section-head"><span class="section-index">04</span><h2 id="wlTitle">Вайтлист Penta SMP</h2></div>
    <p class="muted st-note">После «Одобрить» добавь игрока на сервере командой — она копируется кнопкой.</p>
    <ul class="st-wl" id="wl"></ul>
  </section>

  <section class="st-block" aria-labelledby="cvTitle">
    <div class="section-head"><span class="section-index">05</span><h2 id="cvTitle">Холст</h2></div>
    <div class="glass st-box st-canvas">
      <p class="muted">Если на холсте нарисовали что-то не то — очисти его. Таймлапс начнётся заново, значки художников сохранятся.</p>
      <a class="btn btn-ghost btn-sm" href="play.html#canvas">Открыть холст</a>
      <button class="btn btn-danger btn-sm" type="button" data-clear-canvas>Очистить холст</button>
    </div>
  </section>

  <section class="st-block" aria-labelledby="modTitle">
    <div class="section-head"><span class="section-index">06</span><h2 id="modTitle">Ещё инструменты</h2></div>
    <div class="st-mod-tabs" role="tablist" id="modTabs">${MODULES.stream.map((m, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-mod-tab="${m.id}"><span aria-hidden="true">${m.icon}</span>${esc(m.label)}</button>`).join("")}</div>
    <div class="st-mod-panel" id="modPanel"></div>
  </section>`;
}

/* ---------- Модули пульта (assets/js/admin/*.js) ---------- */
let modMounted = null;
async function showModuleTab(id) {
  const entry = MODULES.stream.find((m) => m.id === id);
  if (!entry) return;
  document.querySelectorAll("[data-mod-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.modTab === id)));
  modMounted?.destroy?.();
  modMounted = null;
  const panel = $("#modPanel");
  panel.innerHTML = '<div class="skeleton st-skel"></div>';
  const mod = await loadModule(entry);
  if (!mod?.mount) { panel.innerHTML = `<p class="muted">Модуль «${esc(entry.label)}» скоро появится.</p>`; return; }
  panel.replaceChildren();
  modMounted = mod.mount(panel, { isAdmin: true }) || null;
}

/* ---------- Колесо и текущее задание ---------- */
function renderWheelArea({ redraw = true } = {}) {
  const canvas = $("#wheel");
  if (redraw && state.candidates.length) drawWheel(canvas, state.candidates, 0);
  else if (redraw) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("[data-spin]").disabled = !state.candidates.length;
  $("#cands").innerHTML = state.candidates.length
    ? state.candidates.map((c) => `<li><span class="st-game">${esc(byId(GAMES, c.game)?.short || c.game)}</span><b>${esc(c.title)}</b><small>▲ ${c.votes}</small></li>`).join("")
    : `<li class="muted">Нет принятых заданий. Прими задания в <a class="py-link" href="admin.html">админке</a> или на странице <a class="py-link" href="tasks.html?status=new">заданий</a>.</li>`;
}

function renderCurrent() {
  const t = state.currentTask;
  $("#current").innerHTML = t
    ? `<div class="st-cur"><span class="st-game big">${esc(byId(GAMES, t.game)?.short || t.game)}</span>
        <div><b>${esc(t.title)}</b><small>от @${esc(t.authorNick)} · ▲ ${t.votes}</small></div>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" data-task-done="${esc(t.id)}">✓ Выполнено</button>
        <button class="btn btn-ghost btn-sm" type="button" data-cur-clear>Убрать из оверлея</button></div>`
    : `<p class="muted">Сейчас нет задания на стриме — крутани колесо.</p>`;
}

function renderOverlays() {
  $("#overlays").innerHTML = WIDGETS.map((o) => `<div class="glass st-ov">
    <b>${esc(o.label)}</b><small>${esc(o.hint)}</small>
    <div class="st-ov-actions">
      <button class="btn btn-ghost btn-xs" type="button" data-copy-ov="${o.w}">Скопировать ссылку</button>
      <a class="btn btn-ghost btn-xs" href="${esc(overlayUrl(o.w))}" target="_blank" rel="noopener">Открыть ↗</a>
    </div></div>`).join("");
}

/* ---------- Ставки ---------- */
const BET_STATUS = { open: "Приём ставок", locked: "Ставки закрыты", resolved: "Итоги подведены", cancelled: "Отменено" };
async function renderBets() {
  let data;
  try { data = await api.predictions(); } catch (e) { $("#bets").innerHTML = `<p class="muted">⚠ ${errText(e)}</p>`; return; }
  const active = data.items.filter((p) => p.status === "open" || p.status === "locked");
  const done = data.items.filter((p) => p.status !== "open" && p.status !== "locked").slice(0, 4);
  const card = (p) => `<article class="glass st-bet" data-pred="${esc(p.id)}">
    <header><span class="badge ${p.status === "open" ? "lime" : p.status === "locked" ? "warn" : "plain"}">${BET_STATUS[p.status]}</span><small class="faint">банк ${p.totalPool}</small></header>
    <h3>${esc(p.question)}</h3>
    <ul>${p.options.map((o, i) => `<li${p.result === i ? ' class="is-win"' : ""}><span>${esc(o.text)}</span><small>${o.pool} · ${o.bettors} чел.</small>
      ${p.status === "open" || p.status === "locked" ? `<button class="btn btn-ghost btn-xs" type="button" data-resolve="${i}">Сбылось</button>` : ""}</li>`).join("")}</ul>
    ${p.status === "open" || p.status === "locked" ? `<div class="st-bet-actions">
      ${p.status === "open" ? '<button class="btn btn-ghost btn-xs" type="button" data-pred-act="lock">Закрыть приём</button>' : '<button class="btn btn-ghost btn-xs" type="button" data-pred-act="open">Открыть снова</button>'}
      <button class="btn btn-danger btn-xs" type="button" data-pred-act="cancel">Отменить и вернуть баллы</button></div>` : ""}
  </article>`;
  $("#bets").innerHTML = active.length || done.length
    ? `${active.map(card).join("")}${done.length ? `<h3 class="st-sub">Последние завершённые</h3>${done.map(card).join("")}` : ""}`
    : `<p class="muted">Ставок ещё не было.</p>`;
}

/* ---------- Вайтлист ---------- */
const WL_STATUS = { pending: ["Ждёт", "info"], approved: ["Одобрено", "lime"], rejected: ["Отклонено", "danger"] };
async function renderWhitelist() {
  let list;
  try { list = await api.whitelist(); } catch (e) { $("#wl").innerHTML = `<li class="muted">⚠ ${errText(e)}</li>`; return; }
  $("#wl").innerHTML = list.length ? list.map((r) => {
    const [label, tone] = WL_STATUS[r.status] || [r.status, "plain"];
    return `<li class="glass st-wl-row" data-wl="${esc(r.id)}">
      <img class="st-head-img" src="https://mc-heads.net/avatar/${encodeURIComponent(r.nick)}/40" alt="" width="40" height="40" loading="lazy">
      <div class="st-wl-text"><b>${esc(r.nick)}</b><small>${avatarHTML(r.user.nick, r.user.avatarUrl, { size: "xs" })}@${esc(r.user.nick)} · ${esc(timeAgo(r.createdAt))}</small></div>
      <span class="badge ${tone}">${label}</span>
      <div class="st-wl-actions">
        ${r.status !== "approved" ? '<button class="btn btn-primary btn-xs" type="button" data-wl-act="approved">Одобрить</button>' : ""}
        ${r.status !== "rejected" ? '<button class="btn btn-ghost btn-xs" type="button" data-wl-act="rejected">Отклонить</button>' : ""}
        <button class="btn btn-ghost btn-xs st-mono" type="button" data-copy="whitelist add ${esc(r.nick)}">whitelist add ${esc(r.nick)}</button>
      </div></li>`;
  }).join("") : `<li class="muted">Заявок пока нет. Зрители подают их в личном кабинете, указав ник Minecraft.</li>`;
}

/* ---------- Загрузка ---------- */
async function load() {
  root.innerHTML = shell();
  try {
    state = await api.stream();
  } catch (e) {
    root.innerHTML = `<div class="empty"><span class="empty-icon">⚠</span><p>${errText(e)}</p></div>`;
    return;
  }
  renderWheelArea();
  renderCurrent();
  renderOverlays();
  if (state.wheel) showResult(state.wheel, false);
  renderBets();
  renderWhitelist();
  if (MODULES.stream[0]) showModuleTab(MODULES.stream[0].id);
}

function showResult(spin, fresh) {
  const w = spin.candidates[spin.winnerIndex];
  if (!w) return;
  $("#wheelResult").innerHTML = `<span class="faint">${fresh ? "Выпало:" : `Последний спин ${esc(timeAgo(spin.at))}:`}</span> <b>${esc(w.title)}</b>`;
  $("#wheelResult").classList.toggle("is-fresh", fresh);
}

async function copy(text, what = "Скопировано") {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { prompt("Скопируй:", text); }
}

root.addEventListener("click", async (e) => {
  const t = e.target;
  const modTab = t.closest("[data-mod-tab]");
  if (modTab) return showModuleTab(modTab.dataset.modTab);
  if (t.closest("[data-spin]")) {
    if (spinning) return;
    const btn = t.closest("[data-spin]");
    spinning = true;
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const spin = await api.spinWheel();
      btn.classList.remove("is-loading");
      state.wheel = spin;
      $("#wheelResult").innerHTML = '<span class="faint">Крутится…</span>';
      await spinWheel($("#wheel"), spin, { reduced: !motion });
      showResult(spin, true);
      toast(`🎡 Выпало: ${spin.candidates[spin.winnerIndex].title}`);
      state = await api.stream();
      renderCurrent();
      renderWheelArea({ redraw: false }); // колесо остаётся на выпавшем секторе до следующего спина
    } catch (err) {
      toast(toApiError(err).message, "error");
    } finally {
      spinning = false;
      btn.classList.remove("is-loading");
      btn.disabled = !state.candidates.length;
    }
    return;
  }
  const done = t.closest("[data-task-done]");
  if (done) {
    try {
      await api.updateTask(done.dataset.taskDone, { status: "done" });
      state = await api.updateStream({ currentTaskId: null });
      toast("Задание выполнено ✓");
      renderCurrent();
      renderWheelArea();
    } catch (err) { toast(toApiError(err).message, "error"); }
    return;
  }
  if (t.closest("[data-cur-clear]")) {
    try { state = await api.updateStream({ currentTaskId: null }); renderCurrent(); } catch (err) { toast(toApiError(err).message, "error"); }
    return;
  }
  const ov = t.closest("[data-copy-ov]");
  if (ov) return copy(overlayUrl(ov.dataset.copyOv), "Ссылка оверлея скопирована");
  if (t.closest("[data-regen]")) {
    if (!confirm("Сделать новый ключ? Старые ссылки в OBS перестанут работать — их нужно будет вставить заново.")) return;
    try { state = await api.updateStream({ regenerateKey: true }); renderOverlays(); toast("Новый ключ готов — обнови ссылки в OBS"); } catch (err) { toast(toApiError(err).message, "error"); }
    return;
  }
  const cp = t.closest("[data-copy]");
  if (cp) return copy(cp.dataset.copy, "Команда скопирована");
  const pred = t.closest("[data-pred]");
  const act = t.closest("[data-pred-act]");
  const res = t.closest("[data-resolve]");
  if (pred && (act || res)) {
    const action = act ? act.dataset.predAct : "resolve";
    if (action === "cancel" && !confirm("Отменить ставку и вернуть всем баллы?")) return;
    if (action === "resolve" && !confirm(`Подвести итог: сбылся вариант «${res.closest("li").querySelector("span").textContent}»?`)) return;
    try {
      await api.updatePrediction(pred.dataset.pred, action, res ? Number(res.dataset.resolve) : undefined);
      toast(action === "resolve" ? "Итоги подведены, баллы начислены" : "Готово");
      renderBets();
    } catch (err) { toast(toApiError(err).message, "error"); }
    return;
  }
  const wl = t.closest("[data-wl-act]");
  if (wl) {
    try {
      await api.updateWhitelist(wl.closest("[data-wl]").dataset.wl, wl.dataset.wlAct);
      toast(wl.dataset.wlAct === "approved" ? "Одобрено — не забудь добавить на сервере" : "Заявка отклонена");
      renderWhitelist();
    } catch (err) { toast(toApiError(err).message, "error"); }
    return;
  }
  if (t.closest("[data-clear-canvas]")) {
    if (!confirm("Очистить весь холст? Это нельзя отменить.")) return;
    try { await api.clearCanvas(); toast("Холст очищен"); } catch (err) { toast(toApiError(err).message, "error"); }
  }
});

root.addEventListener("submit", async (e) => {
  if (e.target.id !== "betForm") return;
  e.preventDefault();
  const f = e.target;
  const btn = $('button[type="submit"]', f);
  const options = [0, 1, 2, 3].map((i) => f.elements[`opt${i}`].value.trim()).filter(Boolean);
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    await api.createPrediction({ question: f.elements.question.value.trim(), options });
    toast("Ставки открыты — зрители видят их на странице «Движ»");
    f.elements.question.value = "";
    renderBets();
  } catch (err) {
    toast(toApiError(err).message, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
});

window.addEventListener("resize", () => { if (state && !spinning) renderWheelArea(); });

function render(u) {
  if (u?.role === "admin") load();
  else locked(u);
}
render(user);
onUserChange(render);

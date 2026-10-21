// Вкладка «Розыгрыши» (play.html#giveaways): участие и проверка честности прямо в браузере.
// Схема: при создании сервер загадывает seed и сразу публикует sha256(seed). После розыгрыша seed раскрывается,
// победитель = участники (id по возрастанию через запятую) → HMAC-SHA256(ключ = seed) → первые 13 hex → число mod N.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, timeAgo, plural, avatarHTML } from "../core/util.js";

ensureCss("interactive.css");

const REFRESH_MS = 10000;
const STATUS = {
  open: { label: "Приём участников", tone: "lime" },
  closed: { label: "Ждём розыгрыша", tone: "warn" },
  drawn: { label: "Разыграно", tone: "info" },
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Пересчитать розыгрыш в браузере. g — ответ GET giveaway (с participants и seed). */
export async function verifyGiveaway(g) {
  if (!globalThis.crypto?.subtle) throw new Error("Браузер не умеет считать SHA-256 (нужен HTTPS)");
  const enc = new TextEncoder();
  const seedHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(g.seed)));
  const ids = g.participants.map((p) => p.id);
  const sorted = [...ids].sort();
  const key = await crypto.subtle.importKey("raw", enc.encode(g.seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = hex(await crypto.subtle.sign("HMAC", key, enc.encode(sorted.join(","))));
  const num = parseInt(h.slice(0, 13), 16);
  const index = num % sorted.length;
  return {
    hashOk: seedHash === g.seedHash,
    orderOk: ids.every((id, i) => id === sorted[i]),
    hmac: h, num, index, n: sorted.length,
    winnerOk: sorted[index] === g.winner?.id,
  };
}

export function mount(root, ctx) {
  const user = ctx.user || null;
  let items = null;
  let last = "";
  let busy = false;
  let timer = 0;
  const checks = new Map(); // id → html результата проверки (переживает перерисовку)
  root.classList.add("ix", "ix-gw");

  function cardHTML(g) {
    const st = STATUS[g.status] || STATUS.open;
    let action = "";
    if (g.status === "open") {
      action = user
        ? `<div class="ix-gw-actions">
            <button class="ix-pbtn ix-px ${g.joined ? "is-ghost" : "is-gold"}" type="button" data-join="${esc(g.id)}" data-on="${g.joined ? "0" : "1"}">
              <span>${g.joined ? "Выйти из розыгрыша" : "🎟 Участвую!"}</span><span class="spinner" aria-hidden="true"></span></button>
            ${g.joined ? '<span class="badge lime">Ты в игре</span>' : ""}
          </div>`
        : `<div class="ix-login"><p>Войди, чтобы получить билет. Победителя выберет проверяемая формула.</p>
            <button class="ix-pbtn ix-px is-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы участвовать в розыгрышах">Войти</button></div>`;
    } else if (g.status === "closed") {
      action = `<p class="ix-note">Приём закрыт${g.joined ? " — ты в списке участников" : ""}. Розыгрыш вот-вот начнётся!</p>`;
    }
    const winner = g.winner
      ? `<div class="ix-winner">${avatarHTML(g.winner.nick, g.winner.avatarUrl, { size: "sm" })}
          <div><small>Победитель</small><b>${esc(g.winner.nick)}</b></div><span aria-hidden="true" style="margin-left:auto;font-size:1.6rem">🏆</span></div>`
      : "";
    return `<article class="ix-card glass" data-id="${esc(g.id)}">
      <div class="ix-meta"><span class="badge ${st.tone}">${esc(st.label)}</span><span>${esc(timeAgo(g.drawnAt || g.createdAt))}</span></div>
      <h3>${esc(g.title)}</h3>
      <div class="ix-gw-prize ix-px" style="--ix-c:rgba(255,209,102,.35)"><span aria-hidden="true">🎁</span><b>${esc(g.prize)}</b></div>
      <div class="ix-gw-count"><b>${g.entries}</b><span class="muted">${plural(g.entries, ["участник", "участника", "участников"])}</span></div>
      ${winner}
      ${action}
      <div class="ix-hash"><span>Отпечаток секрета (sha256), опубликован при создании</span><code class="ix-mono">${esc(g.seedHash)}</code></div>
      ${g.seed ? `<div class="ix-hash"><span>Секрет (seed), раскрыт после розыгрыша</span><code class="ix-mono">${esc(g.seed)}</code></div>
        <button class="ix-pbtn ix-px is-sm" type="button" data-verify="${esc(g.id)}"><span>🔍 Проверить честность</span><span class="spinner" aria-hidden="true"></span></button>
        <div data-check="${esc(g.id)}">${checks.get(g.id) || ""}</div>` : ""}
    </article>`;
  }

  function render() {
    const active = items.filter((g) => g.status !== "drawn");
    const done = items.filter((g) => g.status === "drawn");
    root.innerHTML = `
      <header class="ix-hero glass">
        <span class="ix-hero-icon ix-px" aria-hidden="true">🎁</span>
        <div class="ix-hero-text"><h2>Честные розыгрыши</h2>
          <p>Секрет розыгрыша загадывается заранее — мы сразу показываем его отпечаток. После розыгрыша секрет раскрывается, и любой может пересчитать победителя прямо в браузере.</p></div>
      </header>
      ${active.length ? `<div class="ix-grid">${active.map(cardHTML).join("")}</div>`
        : `<div class="empty"><span class="empty-icon">🎟</span><p>Сейчас розыгрышей нет. Следи за стримами — они появляются внезапно!</p></div>`}
      ${done.length ? `<h3 class="ix-sub">Итоги прошлых розыгрышей</h3><div class="ix-grid">${done.map(cardHTML).join("")}</div>` : ""}`;
  }

  async function load() {
    try {
      const d = await apiCall("giveaways");
      const sig = JSON.stringify(d.items);
      if (sig === last) return;
      last = sig;
      items = d.items;
      render();
    } catch (err) {
      if (!items) root.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  async function verify(id, btn) {
    btn.classList.add("is-loading");
    btn.disabled = true;
    let html;
    try {
      const g = await apiCall("giveaway", { query: { id } });
      const r = await verifyGiveaway(g);
      const ok = r.hashOk && r.orderOk && r.winnerOk;
      const row = (good, text) => `<li class="${good ? "ok" : "bad"}"><span>${good ? "✔" : "✖"}</span><span>${text}</span></li>`;
      html = `<div class="ix-verify">
        <b class="${ok ? "" : "bad"}" style="color:${ok ? "var(--lime)" : "#ff3b4a"}">${ok ? "Всё честно ✔" : "Проверка не сошлась ✖"}</b>
        <ol class="ix-steps">
          ${row(r.hashOk, "sha256(seed) совпадает с отпечатком, опубликованным до розыгрыша")}
          ${row(r.orderOk, `Участники отсортированы по id: ${r.n} ${plural(r.n, ["человек", "человека", "человек"])}`)}
          <li class="ok"><span>#</span><span>HMAC-SHA256: <code class="ix-mono">${esc(r.hmac)}</code></span></li>
          <li class="ok"><span>#</span><span>0x${esc(r.hmac.slice(0, 13))} = ${r.num} mod ${r.n} = <b>${r.index}</b> → участник №${r.index + 1}</span></li>
          ${row(r.winnerOk, `Победитель по формуле: <b>${esc(g.participants[r.index]?.nick || "?")}</b>`)}
        </ol>
        <ol class="ix-people" aria-label="Участники в порядке розыгрыша">${g.participants.map((p, i) => `<li${i === r.index ? ' class="is-win"' : ""}>${esc(p.nick)}</li>`).join("")}</ol>
      </div>`;
    } catch (err) {
      html = `<p class="ix-note" style="color:#ff8a94">${esc(err.message)}</p>`;
    }
    checks.set(id, html);
    const box = root.querySelector(`[data-check="${CSS.escape(id)}"]`);
    if (box) box.innerHTML = html;
    btn.classList.remove("is-loading");
    btn.disabled = false;
  }

  async function onClick(e) {
    const v = e.target.closest("[data-verify]");
    if (v) return verify(v.dataset.verify, v);
    const b = e.target.closest("[data-join]");
    if (!b || busy) return;
    busy = true;
    b.classList.add("is-loading");
    b.disabled = true;
    try {
      const g = await apiCall("giveaway/join", { method: "POST", body: { id: b.dataset.join, join: b.dataset.on === "1" } });
      items = items.map((x) => (x.id === g.id ? g : x));
      last = JSON.stringify(items);
      toast(g.joined ? "Билет получен — удачи! 🍀" : "Ты вышел из розыгрыша");
      render();
      root.querySelector(`[data-join="${CSS.escape(g.id)}"]`)?.focus();
    } catch (err) {
      toast(err.message, "error");
      b.classList.remove("is-loading");
      b.disabled = false;
    } finally {
      busy = false;
    }
  }

  root.addEventListener("click", onClick);
  root.innerHTML = '<div class="skeleton" style="min-height:320px"></div>';
  load();
  timer = setInterval(() => { if (!document.hidden && !busy) load(); }, REFRESH_MS);
  return {
    destroy() {
      clearInterval(timer);
      root.removeEventListener("click", onClick);
    },
  };
}

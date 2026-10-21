// Вкладка «Опросы» (play.html#polls): «во что играть дальше» — голос можно менять, пока опрос открыт.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, timeAgo, plural } from "../core/util.js";

ensureCss("interactive.css");

const REFRESH_MS = 8000;

export function mount(root, ctx) {
  const user = ctx.user || null;
  let items = null;
  let last = "";
  let first = true;
  let busy = false;
  let timer = 0;
  root.classList.add("ix", "ix-polls");

  function pollHTML(p) {
    const open = p.status === "open";
    const canVote = open && user && !busy;
    const max = Math.max(...p.options.map((o) => o.votes));
    const opts = p.options.map((o, i) => {
      const top = !open && p.total > 0 && o.votes === max;
      const mine = p.myVote === i;
      const inner = `<span class="ix-bar" style="--w:${o.percent}%"></span>
        <span class="ix-opt-text">${mine ? '<span class="ix-check" aria-hidden="true">✔</span>' : ""}${top ? "👑 " : ""}${esc(o.text)}</span>
        <span class="ix-opt-num">${o.percent}%<small>${o.votes}</small></span>`;
      const cls = `ix-opt${mine ? " is-mine" : ""}${top ? " is-top" : ""}`;
      return `<li>${canVote
        ? `<button class="${cls}" type="button" data-vote="${esc(p.id)}" data-opt="${i}" aria-pressed="${mine}">${inner}</button>`
        : `<div class="${cls}">${inner}</div>`}</li>`;
    }).join("");
    let foot = "";
    if (open && !user) {
      foot = `<div class="ix-login"><p>Войди, чтобы проголосовать — один аккаунт, один голос.</p>
        <button class="ix-pbtn ix-px is-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы голосовать в опросах">Войти</button></div>`;
    } else if (open) {
      foot = `<p class="ix-note">${p.myVote === null ? "Жми на вариант — голос засчитается сразу." : "Передумал? Нажми другой вариант, пока опрос открыт."}</p>`;
    }
    return `<article class="ix-card glass ix-poll" data-id="${esc(p.id)}">
      <div class="ix-meta">
        <span class="badge ${open ? "lime" : "plain"}">${open ? "Идёт голосование" : "Итоги"}</span>
        <span>${p.total} ${plural(p.total, ["голос", "голоса", "голосов"])}</span>
        <span>· ${esc(timeAgo(open ? p.createdAt : p.closedAt || p.createdAt))}</span>
      </div>
      <h3>${esc(p.question)}</h3>
      <ul class="ix-opts">${opts}</ul>
      ${foot}
    </article>`;
  }

  function render() {
    const open = items.filter((p) => p.status === "open");
    const closed = items.filter((p) => p.status !== "open");
    root.classList.toggle("ix-anim", first);
    first = false;
    root.innerHTML = `
      <header class="ix-hero glass">
        <span class="ix-hero-icon ix-px" aria-hidden="true">📊</span>
        <div class="ix-hero-text"><h2>Во что играть дальше?</h2>
          <p>Решай вместе с чатом: какие игры, челленджи и форматы будут на стриме. Результаты в прямом эфире — прямо на экране.</p></div>
      </header>
      ${open.length ? `<div class="ix-grid">${open.map(pollHTML).join("")}</div>`
        : `<div class="empty"><span class="empty-icon">🗳</span><p>Сейчас открытых опросов нет — они появляются во время стримов.</p></div>`}
      ${closed.length ? `<h3 class="ix-sub">Прошлые опросы</h3><div class="ix-grid">${closed.map(pollHTML).join("")}</div>` : ""}`;
  }

  async function load() {
    try {
      const d = await apiCall("polls");
      const sig = JSON.stringify(d.items);
      if (sig === last) return; // ничего не изменилось — не перерисовываем (не сбиваем фокус)
      last = sig;
      items = d.items;
      render();
    } catch (err) {
      if (!items) root.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  async function onClick(e) {
    const b = e.target.closest("[data-vote]");
    if (!b || busy) return;
    if (b.getAttribute("aria-pressed") === "true") return;
    busy = true;
    b.disabled = true;
    try {
      const p = await apiCall("poll/vote", { method: "POST", body: { id: b.dataset.vote, option: Number(b.dataset.opt) } });
      items = items.map((x) => (x.id === p.id ? p : x));
      last = JSON.stringify(items);
      busy = false;
      render();
      toast("Голос засчитан 🗳");
      root.querySelector(`[data-vote="${CSS.escape(p.id)}"][data-opt="${p.myVote}"]`)?.focus();
    } catch (err) {
      busy = false;
      b.disabled = false;
      toast(err.message, "error");
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

// «Движ» → «Сезон и команды»: сезон = календарный месяц по Москве. Отсчёт до конца, топ по опыту за сезон,
// война команд «Лаймовые» против «Красных» (перетягивание каната), подиум прошлого сезона.
import { ensureCss } from "../modules.js";
import { apiCall } from "../data/api.js";
import { esc, toast, avatarHTML, plural } from "../core/util.js";

ensureCss("points.css");

export const TEAM_META = {
  lime: { name: "Лаймовые", icon: "🕷" },
  red: { name: "Красные", icon: "🕸" },
};
const PLACE = ["🥇", "🥈", "🥉"];
const FRAME_NAME = { 1: "Золото", 2: "Серебро", 3: "Бронза" };
const members = (n) => `${n} ${plural(n, ["участник", "участника", "участников"])}`;
export const userAvatar = (u, size) => avatarHTML(u.nick, u.avatarUrl, { size, extra: u.frame ? `frame-${u.frame}` : "" });

/** Канат: доля лаймовых по очкам (поровну, пока у обеих 0). */
export function tugHTML(t, { big = false } = {}) {
  const sum = t.lime.score + t.red.score;
  const share = sum ? Math.round((t.lime.score / sum) * 1000) / 10 : 50;
  const lead = t.lime.score === t.red.score ? "Ничья" : t.lime.score > t.red.score ? "Ведут Лаймовые" : "Ведут Красные";
  return `<div class="pt-tug${big ? " is-big" : ""}" role="img" aria-label="${esc(`Лаймовые ${t.lime.score} XP против Красных ${t.red.score} XP — ${lead}`)}" style="--share:${share}%">
    <div class="pt-tug-scores">
      <span class="pt-tug-side is-lime"><b>${t.lime.score}</b><small>Лаймовые</small></span>
      <span class="pt-tug-lead">${esc(lead)}</span>
      <span class="pt-tug-side is-red"><b>${t.red.score}</b><small>Красные</small></span>
    </div>
    <div class="pt-tug-bar"><span class="pt-tug-lime"></span><span class="pt-tug-red"></span><span class="pt-tug-knot" aria-hidden="true"></span></div>
  </div>`;
}

/** Сколько осталось до конца сезона: { d, h, m, s, left } */
function remaining(endsAt) {
  const left = Math.max(0, Date.parse(endsAt) - Date.now());
  const s = Math.floor(left / 1000);
  return { left, d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
}
const pad = (n) => String(n).padStart(2, "0");

export function mount(container, ctx) {
  const user = ctx.user || null;
  let data = null;
  let alive = true;
  let timer = 0;
  let armed = null; // команда, для которой нажали «Вступить» первый раз (второй клик — подтверждение)
  let armTimer = 0;
  let busy = false;

  function countdownHTML() {
    const r = remaining(data.endsAt);
    return [["d", "дн"], ["h", "ч"], ["m", "мин"], ["s", "с"]]
      .map(([k, l]) => `<span><b>${k === "d" ? r[k] : pad(r[k])}</b><small>${l}</small></span>`).join("");
  }

  function teamHTML(id) {
    const t = data.teams[id];
    const mine = data.teams.mine;
    let action = "";
    if (!user) action = `<button class="btn btn-ghost btn-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы выбрать команду">Войти и вступить</button>`;
    else if (mine === id) action = `<span class="badge lime">Ты в этой команде</span>`;
    else if (!mine) {
      action = armed === id
        ? `<button class="btn btn-primary btn-sm pt-join is-armed" type="button" data-join="${id}"><span>Точно? До конца сезона</span><span class="spinner" aria-hidden="true"></span></button>`
        : `<button class="btn btn-primary btn-sm pt-join" type="button" data-join="${id}"><span>Вступить</span><span class="spinner" aria-hidden="true"></span></button>`;
    }
    const top = t.top3.length
      ? `<ol class="pt-team-top">${t.top3.map((m, i) => `<li>${userAvatar(m.user, "sm")}<span>${esc(m.user.nick)}</span><b>${m.xp} XP</b><i aria-hidden="true">${PLACE[i]}</i></li>`).join("")}</ol>`
      : `<p class="muted pt-team-empty">Пока никого — стань первым!</p>`;
    return `<article class="pt-team is-${id}${mine === id ? " is-mine" : ""}">
      <header><span class="pt-team-icon" aria-hidden="true">${TEAM_META[id].icon}</span>
        <div><h4>${esc(t.name)}</h4><small>${members(t.members)}</small></div>
        <b class="pt-team-score">${t.score}<small>XP</small></b></header>
      ${top}
      <div class="pt-team-action">${action}</div>
    </article>`;
  }

  function warHTML() {
    return `<section class="pt-war glass" aria-labelledby="ptWarTitle">
      <h3 id="ptWarTitle">⚔ Война команд</h3>
      ${tugHTML(data.teams, { big: true })}
      <div class="pt-teams">${teamHTML("lime")}<span class="pt-vs" aria-hidden="true">VS</span>${teamHTML("red")}</div>
      <p class="pt-note">Очки команды — сумма опыта её участников за сезон. Команду выбирают один раз на сезон, перейти в другую нельзя.</p>
    </section>`;
  }

  function boardHTML() {
    const me = data.me;
    const row = (r) => `<li class="ld-row${user?.id === r.user.id ? " is-me" : ""}">
      <span class="ld-place">${r.place <= 3 ? PLACE[r.place - 1] : r.place}</span>
      ${userAvatar(r.user, "sm")}
      <span class="ld-name"><b>${esc(r.user.nick)}</b>${r.place <= 3 ? `<small>приз ${data.prizes[r.place]} баллов</small>` : ""}</span>
      <span class="ld-xp">${r.xp} XP</span>
    </li>`;
    const inTop = me && data.top.some((r) => r.user.id === user?.id);
    const meRow = user && me && !inTop
      ? `<p class="pt-me-line">${me.place ? `Ты на <b>${me.place}</b> месте · ${me.xp} XP` : "У тебя пока нет опыта в этом сезоне — пришли работу, предложи задание или забери бонус 🎁"}</p>` : "";
    return `<section class="glass py-box pt-board" aria-labelledby="ptBoardTitle">
      <h3 id="ptBoardTitle">Топ сезона</h3>
      ${data.top.length ? `<ol class="ld-list">${data.top.map(row).join("")}</ol>` : `<div class="empty"><span class="empty-icon">🏆</span><p>Сезон только начался — опыт ещё никто не набрал.</p></div>`}
      ${meRow}
    </section>`;
  }

  function podiumHTML() {
    const a = data.lastAwards;
    if (!a || !a.podium.length) return `<p class="muted">Первый сезон ещё идёт — победители появятся здесь в начале следующего месяца.</p>`;
    const by = Object.fromEntries(a.podium.map((p) => [p.place, p]));
    const step = (place) => {
      const p = by[place];
      if (!p) return `<div class="pt-step is-p${place} is-empty"><span class="pt-step-block">${place}</span></div>`;
      return `<div class="pt-step is-p${place}">
        ${userAvatar(p.user, place === 1 ? "lg" : "")}
        <b>${esc(p.user.nick)}</b><small>${p.xp} XP</small>
        <span class="pt-step-block">${PLACE[place - 1]}</span>
      </div>`;
    };
    return `<p class="faint pt-podium-label">${esc(a.label)}</p><div class="pt-podium">${step(2)}${step(1)}${step(3)}</div>`;
  }

  function render() {
    if (!alive) return;
    container.innerHTML = `<div class="pt-season">
      <header class="pt-season-head glass">
        <div>
          <span class="pt-kicker"><span class="pulse-dot" aria-hidden="true"></span>Сезон · ${data.participants} ${plural(data.participants, ["участник", "участника", "участников"])}</span>
          <h2 class="py-title">${esc(data.label)}</h2>
          <p class="muted">Опыт за месяц: работы, задания, голоса, ставки, бонусы. В конце месяца топ-3 получают ${data.prizes[1]} / ${data.prizes[2]} / ${data.prizes[3]} баллов и рамку аватарки.</p>
        </div>
        <div class="pt-countdown" role="timer" aria-label="До конца сезона" data-countdown>${countdownHTML()}</div>
      </header>
      <div data-war>${warHTML()}</div>
      <div class="py-grid">
        ${boardHTML()}
        <aside class="py-side">
          <article class="glass py-box"><h3>Прошлый сезон</h3>${podiumHTML()}</article>
          <article class="glass py-box pt-prizes"><h3>Награды</h3>
            <ul>${[1, 2, 3].map((p) => `<li><span aria-hidden="true">${PLACE[p - 1]}</span><span><b>${data.prizes[p]} баллов</b> и рамка «${FRAME_NAME[p]}»</span></li>`).join("")}</ul>
            <p class="faint">Рамку надевают в <a class="py-link" href="profile.html#settings">личном кабинете</a>.</p>
          </article>
        </aside>
      </div>
    </div>`;
  }

  async function load() {
    try {
      data = await apiCall("season");
      render();
    } catch (err) {
      if (alive) container.innerHTML = `<div class="empty"><span class="empty-icon">⚔</span><p>${esc(err.message)}</p></div>`;
    }
  }

  function tick() {
    if (!data || !alive) return;
    const box = container.querySelector("[data-countdown]");
    if (box) box.innerHTML = countdownHTML();
    if (remaining(data.endsAt).left <= 0) { data.endsAt = new Date(Date.now() + 60_000).toISOString(); setTimeout(load, 3000); } // новый сезон
  }

  container.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-join]");
    if (!btn || busy) return;
    const team = btn.dataset.join;
    if (armed !== team) { // первый клик — переспрашиваем: выбор на весь сезон
      armed = team;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; if (data) container.querySelector("[data-war]").innerHTML = warHTML(); }, 5000);
      container.querySelector("[data-war]").innerHTML = warHTML();
      container.querySelector(`[data-join="${team}"]`)?.focus();
      return;
    }
    busy = true;
    clearTimeout(armTimer);
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      data.teams = await apiCall("team/join", { method: "POST", body: { team } });
      toast(`Добро пожаловать в команду «${TEAM_META[team].name}»! ${TEAM_META[team].icon}`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      busy = false;
      armed = null;
      if (alive && data) container.querySelector("[data-war]").innerHTML = warHTML();
    }
  });

  container.innerHTML = '<div class="skeleton py-skel"></div>';
  load();
  timer = setInterval(tick, 1000);
  return { destroy() { alive = false; clearInterval(timer); clearTimeout(armTimer); } };
}

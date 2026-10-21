// «Движ» → «Клипы»: клипы с Twitch от зрителей. Предлагай, голосуй — лучший за 7 дней становится «Клипом недели».
// Плеер Twitch тяжёлый: вместо него сначала постер, iframe грузится только по клику.
import { apiCall } from "../data/api.js";
import { getUser, openAuth } from "../core/layout.js";
import { $, $$, esc, avatarHTML, plural, timeAgo, toast } from "../core/util.js";
import { ensureCss } from "../modules.js";

ensureCss("community.css");

const SLUG_RE = /^[A-Za-z0-9_-]{3,100}$/;

/** Ссылка на клип → slug или null (те же правила, что на сервере). */
export function clipSlug(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const path = u.pathname.replace(/\/+$/, "");
  let m = null;
  if (u.hostname === "clips.twitch.tv") m = path.match(/^\/([A-Za-z0-9_-]+)$/);
  else if (u.hostname === "www.twitch.tv" || u.hostname === "twitch.tv") m = path.match(/^\/[A-Za-z0-9_]{3,25}\/clip\/([A-Za-z0-9_-]+)$/);
  const slug = m?.[1];
  return slug && slug.toLowerCase() !== "embed" && SLUG_RE.test(slug) ? slug : null;
}

/** Адрес встраиваемого плеера (parent — наш домен, иначе Twitch не покажет клип). Грузится только по клику. */
export const clipEmbedUrl = (slug) =>
  `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true`;

export const userUrl = (nick) => `user.html?u=${encodeURIComponent(nick)}`;

const PLAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

/** Постер клипа: кнопка, по клику превращается в iframe (см. playClip). */
export function posterHTML(c, { big = false } = {}) {
  return `<div class="cm-player${big ? " is-big" : ""}" data-player>
    <button class="cm-poster" type="button" data-play="${esc(c.slug)}" aria-label="Смотреть клип «${esc(c.title)}»">
      <span class="cm-poster-grid" aria-hidden="true"></span>
      <span class="cm-poster-play" aria-hidden="true">${PLAY_SVG}</span>
      <span class="cm-poster-title">${esc(c.title)}</span>
      <span class="cm-poster-tw" aria-hidden="true">twitch clip</span>
    </button>
  </div>`;
}

/** Заменить постер на плеер Twitch; остальные плееры в box снова становятся постерами (экономим трафик). */
export function playClip(btn, box) {
  const player = btn.closest("[data-player]");
  if (!player) return;
  $$("iframe[data-clip]", box).forEach((f) => {
    const host = f.closest("[data-player]");
    if (host && host !== player && host._poster) host.innerHTML = host._poster;
  });
  player._poster = player.innerHTML;
  const slug = btn.dataset.play;
  player.innerHTML = `<iframe data-clip="${esc(slug)}" src="${esc(clipEmbedUrl(slug))}" title="${esc(btn.getAttribute("aria-label") || "Клип Twitch")}"
    allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

export const votesLabel = (n) => plural(n, ["голос", "голоса", "голосов"]);

export function mount(container, ctx = {}) {
  const me = getUser() || ctx.user || null;
  let period = "week";
  let sort = "top";
  let data = null;
  let seq = 0;
  let alive = true;

  container.innerHTML = '<div class="skeleton cm-skel"></div>';

  const clipCardHTML = (c, i) => `<article class="cm-clip glass" data-id="${esc(c.id)}" style="--i:${Math.min(i, 10)}">
    ${posterHTML(c)}
    <div class="cm-clip-body">
      <h3 class="cm-clip-title">${esc(c.title)}</h3>
      <p class="cm-clip-meta"><a class="cm-user" href="${esc(userUrl(c.author.nick))}">${avatarHTML(c.author.nick, c.author.avatarUrl, { size: "xs" })}${esc(c.author.nick)}</a>
        <span class="faint">· ${esc(timeAgo(c.createdAt))}</span></p>
      <div class="cm-clip-actions">
        ${voteBtnHTML(c)}
        <a class="btn btn-ghost btn-xs" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Twitch ↗</a>
        ${c.canDelete ? `<button class="btn btn-danger btn-xs" type="button" data-del="${esc(c.id)}">Удалить</button>` : ""}
      </div>
    </div>
  </article>`;

  const voteBtnHTML = (c) => {
    const own = me && c.author.id === me.id;
    return `<button class="cm-vote${c.myVote ? " is-on" : ""}" type="button" data-vote="${esc(c.id)}" aria-pressed="${c.myVote}"
      ${own ? 'disabled title="Свой клип оценивают другие"' : ""} aria-label="Голос за клип, сейчас ${c.votes}">
      <span aria-hidden="true">▲</span><b>${c.votes}</b></button>`;
  };

  function heroHTML(top) {
    if (!top) {
      return `<section class="cm-week glass cm-week-empty">
        <div><p class="cm-kicker">🎬 Клип недели</p><h2 class="py-title">Пока пусто</h2>
        <p class="muted">За последние 7 дней клипов ещё не предлагали. Нарежь момент со стрима на Twitch и кидай ссылку — лучший клип недели попадёт на главную.</p></div>
      </section>`;
    }
    return `<section class="cm-week glass" aria-labelledby="cmWeekTitle">
      ${posterHTML(top, { big: true })}
      <div class="cm-week-info">
        <p class="cm-kicker">👑 Клип недели</p>
        <h2 class="cm-week-title" id="cmWeekTitle">${esc(top.title)}</h2>
        <p class="cm-clip-meta">прислал <a class="cm-user" href="${esc(userUrl(top.author.nick))}">${avatarHTML(top.author.nick, top.author.avatarUrl, { size: "xs" })}${esc(top.author.nick)}</a></p>
        <p class="cm-week-votes"><b>${top.votes}</b> ${votesLabel(top.votes)} за неделю</p>
        <div class="cm-clip-actions">${voteBtnHTML(top)}<a class="btn btn-ghost btn-xs" href="${esc(top.url)}" target="_blank" rel="noopener noreferrer">Открыть на Twitch ↗</a></div>
      </div>
    </section>`;
  }

  function formHTML() {
    if (!me) {
      return `<article class="glass py-box"><h3>Предложить клип</h3>
        <p class="muted">Войди, чтобы прислать клип и голосовать.</p>
        <button class="btn btn-primary btn-sm" type="button" data-login>Войти</button></article>`;
    }
    return `<form class="glass py-box cm-form" id="cmClipForm" novalidate>
      <h3>Предложить клип</h3>
      <div class="field">
        <input id="cmClipUrl" name="url" type="url" placeholder=" " inputmode="url" autocomplete="off" maxlength="300" aria-describedby="cmClipUrl-err">
        <label for="cmClipUrl">Ссылка на клип Twitch</label><span class="error-msg" id="cmClipUrl-err"></span>
      </div>
      <div class="field">
        <input id="cmClipTitle" name="title" type="text" placeholder=" " maxlength="120" autocomplete="off" aria-describedby="cmClipTitle-err">
        <label for="cmClipTitle">Как назовём момент?</label><span class="error-msg" id="cmClipTitle-err"></span>
      </div>
      <p class="hint">clips.twitch.tv/… или twitch.tv/канал/clip/… · до 5 клипов в сутки</p>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-sm btn-block" type="submit"><span>Отправить</span><span class="spinner" aria-hidden="true"></span></button>
    </form>`;
  }

  function render() {
    const items = data.items;
    container.innerHTML = `<div class="cm-clips">
      ${heroHTML(data.top)}
      <div class="py-grid">
        <section class="py-main" aria-labelledby="cmClipsTitle">
          <div class="cm-head">
            <h2 class="py-title" id="cmClipsTitle">Клипы</h2>
            <div class="chips" role="group" aria-label="Период">
              <button class="chip" type="button" data-period="week" aria-pressed="${period === "week"}">Неделя</button>
              <button class="chip" type="button" data-period="all" aria-pressed="${period === "all"}">Всё время</button>
            </div>
            <div class="chips" role="group" aria-label="Сортировка">
              <button class="chip" type="button" data-sort="top" aria-pressed="${sort === "top"}">Топ</button>
              <button class="chip" type="button" data-sort="new" aria-pressed="${sort === "new"}">Новые</button>
            </div>
          </div>
          ${items.length ? `<div class="cm-clip-grid">${items.map(clipCardHTML).join("")}</div>`
            : `<div class="empty"><span class="empty-icon">🎬</span><p>${period === "week" ? "За неделю клипов нет — стань первым!" : "Клипов пока нет."}</p></div>`}
        </section>
        <aside class="py-side">
          ${formHTML()}
          <article class="glass py-box"><h3>Как это работает</h3>
            <ul class="cm-rules">
              <li>Нарежь клип на Twitch и пришли ссылку.</li>
              <li>Голосуй за чужие клипы — один голос на клип.</li>
              <li>Клип с наибольшим числом голосов за 7 дней — на главной.</li>
            </ul>
          </article>
        </aside>
      </div>
    </div>`;
  }

  async function load() {
    const my = ++seq;
    try {
      const d = await apiCall("clips", { query: { period, sort } });
      if (!alive || my !== seq) return;
      data = d;
      render();
    } catch (err) {
      if (!alive || my !== seq) return;
      container.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message || "Не удалось загрузить клипы")}</p></div>`;
    }
  }

  function updateVotes(id, votes, myVote) {
    for (const list of [data.items, data.top ? [data.top] : []]) {
      for (const c of list) if (c.id === id) Object.assign(c, { votes, myVote });
    }
    $$(`[data-vote="${CSS.escape(id)}"]`, container).forEach((b) => {
      b.classList.toggle("is-on", myVote);
      b.setAttribute("aria-pressed", String(myVote));
      b.setAttribute("aria-label", `Голос за клип, сейчас ${votes}`);
      $("b", b).textContent = votes;
    });
  }

  async function onClick(e) {
    const t = e.target;
    const play = t.closest("[data-play]");
    if (play) return playClip(play, container);
    if (t.closest("[data-login]")) return openAuth("login", "Войди, чтобы предлагать клипы и голосовать");
    const p = t.closest("[data-period]");
    if (p && p.dataset.period !== period) { period = p.dataset.period; return load(); }
    const s = t.closest("[data-sort]");
    if (s && s.dataset.sort !== sort) { sort = s.dataset.sort; return load(); }
    const v = t.closest("[data-vote]");
    if (v && !v.disabled) {
      if (!me) return openAuth("login", "Войди, чтобы голосовать за клипы");
      v.disabled = true;
      try {
        const r = await apiCall("clip/vote", { method: "POST", body: { id: v.dataset.vote } });
        updateVotes(v.dataset.vote, r.votes, r.myVote);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        v.disabled = false;
      }
      return;
    }
    const d = t.closest("[data-del]");
    if (d && confirm("Удалить клип? Голоса за него тоже пропадут.")) {
      d.disabled = true;
      try {
        await apiCall("clip/delete", { method: "POST", body: { id: d.dataset.del } });
        toast("Клип удалён");
        load();
      } catch (err) {
        toast(err.message, "error");
        d.disabled = false;
      }
    }
  }

  function showErrors(form, fields) {
    for (const [name, msg] of Object.entries(fields || {})) {
      const el = form.elements[name];
      const field = el?.closest(".field");
      if (!field) continue;
      field.classList.add("invalid");
      el.setAttribute("aria-invalid", "true");
      $(".error-msg", field).textContent = msg;
    }
  }

  async function onSubmit(e) {
    const form = e.target.closest("#cmClipForm");
    if (!form) return;
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    if (btn.disabled) return;
    $$(".field", form).forEach((f) => { f.classList.remove("invalid"); $(".error-msg", f).textContent = ""; });
    $(".form-error", form).textContent = "";
    const url = form.elements.url.value.trim();
    const title = form.elements.title.value.trim();
    const errors = {};
    if (!clipSlug(url)) errors.url = "Нужна ссылка вида https://clips.twitch.tv/… или https://www.twitch.tv/канал/clip/…";
    const len = [...title].length;
    if (len < 3 || len > 120) errors.title = "Название от 3 до 120 символов";
    if (Object.keys(errors).length) return showErrors(form, errors);
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      await apiCall("clip", { method: "POST", body: { url, title } });
      toast("Клип добавлен 🎬 Зови друзей голосовать!");
      period = "week";
      sort = "new";
      await load();
    } catch (err) {
      showErrors(form, err.fields);
      $(".form-error", form).textContent = err.message;
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  function onInput(e) {
    const field = e.target.closest(".field.invalid");
    if (!field) return;
    field.classList.remove("invalid");
    $(".error-msg", field).textContent = "";
    e.target.removeAttribute("aria-invalid");
  }

  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  container.addEventListener("input", onInput);
  load();

  return {
    destroy() {
      alive = false;
      container.removeEventListener("click", onClick);
      container.removeEventListener("submit", onSubmit);
      container.removeEventListener("input", onInput);
      container.innerHTML = "";
    },
  };
}

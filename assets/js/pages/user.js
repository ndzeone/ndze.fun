// Публичный профиль зрителя: user.html?u=<ник>. Только открытые данные (без email и Discord):
// уровень, полученные значки, «идеальные» работы, последние темы форума, команда сезона и ник Minecraft.
import { mountLayout, getUser, onUserChange } from "../core/layout.js";
import { api, apiCall } from "../data/api.js";
import { $, esc, avatarHTML, plural, formatDate, timeAgo, toast, motion } from "../core/util.js";

const root = $("#userRoot");
const me = await mountLayout("user");

const params = new URLSearchParams(location.search);
let nick = (params.get("u") || "").trim();
// без ника — показываем свой профиль (если вошёл)
if (!nick && me) {
  nick = me.nick;
  history.replaceState(history.state, "", `?u=${encodeURIComponent(nick)}`);
}

const shareUrl = () => new URL(`user.html?u=${encodeURIComponent(nick)}`, location.href).href;
const TEAM_ICON = { lime: "🟩", red: "🟥" };

function notFoundHTML(text) {
  return `<section class="cm-user-404 glass">
    <p class="cm-user-404-code" aria-hidden="true">404</p>
    <h1>Такого паука в сети нет</h1>
    <p class="muted">${esc(text)}</p>
    <div class="cm-user-404-actions">
      <a class="btn btn-primary btn-sm" href="index.html">На главную</a>
      <a class="btn btn-ghost btn-sm" href="play.html#leaders">Зал славы</a>
    </div>
  </section>`;
}

function levelHTML(p) {
  const span = Math.max(1, p.nextLevelXp - p.levelXp);
  const pct = Math.max(0, Math.min(100, Math.round(((p.xp - p.levelXp) / span) * 100)));
  return `<div class="cm-level">
    <span class="cm-lv">ур. ${p.level}</span>
    <div class="cm-xp">
      <div class="cm-xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Опыт до следующего уровня"><i style="--w:${pct}%"></i></div>
      <small>${esc(p.title)} · ${p.xp} / ${p.nextLevelXp} XP</small>
    </div>
  </div>`;
}

function heroHTML(d) {
  const u = d.user;
  const chips = [
    u.role === "admin" ? '<span class="badge lime">автор сайта</span>' : '<span class="badge plain">зритель</span>',
    `<span class="badge plain">на сайте с ${esc(formatDate(u.createdAt))}</span>`,
    d.team ? `<span class="badge plain cm-team cm-team-${esc(d.team.id)}">${TEAM_ICON[d.team.id] || "⚔"} ${esc(d.team.label)} · сезон ${esc(d.team.season)}</span>` : "",
    d.minecraft ? `<span class="badge plain cm-mc"><img src="${esc(d.minecraft.headUrl)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer">${esc(d.minecraft.nick)}</span>` : "",
  ].join("");
  return `<section class="cm-hero glass" aria-labelledby="cmNick">
    <div class="cm-hero-avatar">${avatarHTML(u.nick, u.avatarUrl, { size: "xl", extra: u.frame ? `frame-${u.frame}` : "" })}</div>
    <div class="cm-hero-info">
      <p class="cm-eyebrow"><span class="pulse-dot" aria-hidden="true"></span>Профиль${d.isMe ? " · это ты" : ""}</p>
      <h1 class="cm-nick" id="cmNick">${esc(u.nick)}</h1>
      <div class="cm-chips">${chips}</div>
      ${levelHTML(d.progress)}
      <div class="cm-hero-actions">
        <button class="btn btn-primary btn-sm" type="button" data-share>Поделиться</button>
        ${d.isMe ? `<a class="btn btn-ghost btn-sm" href="profile.html">Редактировать в кабинете</a>` : ""}
        ${d.quest.found ? `<span class="cm-spiders" title="Пойманные пауки-пасхалки">🕷 ${d.quest.found}/${d.quest.total}</span>` : ""}
      </div>
    </div>
  </section>`;
}

function statsHTML(s) {
  const items = [
    [s.submissions, plural(s.submissions, ["работа на оценке", "работы на оценке", "работ на оценке"])],
    [s.ideal, "доведено до идеала", true],
    [s.tasks, plural(s.tasks, ["задание на стрим", "задания на стрим", "заданий на стрим"])],
    [s.tasksDone, "выполнено в эфире", true],
    [s.forumPosts, plural(s.forumPosts, ["сообщение на форуме", "сообщения на форуме", "сообщений на форуме"])],
    [s.builds, plural(s.builds, ["постройка на Penta", "постройки на Penta", "построек на Penta"])],
    [s.clips, plural(s.clips, ["клип", "клипа", "клипов"])],
  ];
  return `<div class="cm-stats">${items.map(([n, label, lime]) => `<div class="cm-stat glass${lime ? " is-lime" : ""}">
    <span class="cm-stat-n" data-n="${n}">${motion ? 0 : n}</span><span class="cm-stat-l">${esc(label)}</span></div>`).join("")}</div>`;
}

function badgesHTML(p) {
  if (!p.badges.length) return `<div class="empty"><span class="empty-icon">🏅</span><p>Значков пока нет — всё впереди.</p></div>`;
  return `<ul class="cm-badge-grid">${p.badges.map((b, i) => `<li class="cm-badge glass" style="--i:${Math.min(i, 14)}" title="${esc(b.description)}">
    <span class="cm-badge-icon" aria-hidden="true">${esc(b.icon)}</span><b>${esc(b.title)}</b><small>${esc(b.description)}</small></li>`).join("")}</ul>`;
}

function galleryHTML(g, d) {
  if (!g.length) {
    return `<div class="empty"><span class="empty-icon">💎</span><p>${d.isMe ? "Доведи работу до «Идеала» — она появится здесь." : "Работ со статусом «Идеал» пока нет."}</p>
      ${d.isMe ? '<a class="btn btn-primary btn-sm" href="review.html">Прислать работу</a>' : ""}</div>`;
  }
  return `<div class="cm-gallery">${g.map((s, i) => `<a class="cm-gal-item glass" href="review.html#sub=${encodeURIComponent(s.id)}" style="--i:${Math.min(i, 12)}">
    <span class="cm-gal-img">${s.imageUrl ? `<img src="${esc(s.imageUrl)}" alt="" loading="lazy" decoding="async">` : "🖼"}</span>
    <span class="cm-gal-title">${esc(s.title)}</span></a>`).join("")}</div>`;
}

function threadsHTML(t) {
  if (!t.length) return `<p class="muted">На форуме тем пока нет.</p>`;
  return `<ul class="cm-threads">${t.map((x) => `<li><a class="cm-thread" href="forum.html#/t/${encodeURIComponent(x.id)}">
    <b>${esc(x.title)}</b>
    <small class="faint">${esc(x.sectionLabel)} · ${esc(timeAgo(x.createdAt))} · ${x.replies} ${plural(x.replies, ["ответ", "ответа", "ответов"])}</small></a></li>`).join("")}</ul>`;
}

function render(d) {
  document.title = `${d.user.nick} — профиль ndze`;
  const p = d.progress;
  root.innerHTML = `${heroHTML(d)}
    ${statsHTML(d.stats)}
    <section class="cm-sec" aria-labelledby="cmBadges">
      <div class="section-head"><span class="section-index">01</span><h2 id="cmBadges">Значки</h2><span class="spacer"></span>
        <span class="faint">${p.badges.length} из ${p.badgesTotal}</span></div>
      ${badgesHTML(p)}
    </section>
    <section class="cm-sec" aria-labelledby="cmGallery">
      <div class="section-head"><span class="section-index">02</span><h2 id="cmGallery">Галерея</h2></div>
      ${galleryHTML(d.gallery, d)}
    </section>
    <section class="cm-sec" aria-labelledby="cmThreads">
      <div class="section-head"><span class="section-index">03</span><h2 id="cmThreads">Темы на форуме</h2></div>
      ${threadsHTML(d.threads)}
    </section>`;
  if (motion) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        countUp(e.target);
        io.unobserve(e.target);
      }
    });
    root.querySelectorAll(".cm-stat-n").forEach((el) => io.observe(el));
  }
}

function countUp(el) {
  const target = Number(el.dataset.n);
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 900);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

root.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-share]")) return;
  const url = shareUrl();
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: `${nick} — профиль ndze`, url }); return; } catch { /* отменили — копируем */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Ссылка на профиль скопирована 🕸");
  } catch {
    toast(url);
  }
});

async function load() {
  if (!nick) {
    root.innerHTML = notFoundHTML("В ссылке нет ника. Профили открываются по адресу user.html?u=ник.");
    return;
  }
  if (api.mode !== "php") {
    root.innerHTML = notFoundHTML("Публичные профили работают на сайте ndze.fun.");
    return;
  }
  try {
    render(await apiCall("user", { query: { nick } }));
  } catch (err) {
    document.title = "Профиль не найден — ndze";
    root.innerHTML = err.code === "not_found"
      ? notFoundHTML(`Пользователя «${nick}» на сайте нет — возможно, он сменил ник.`)
      : `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message || "Не удалось загрузить профиль")}</p></div>`;
  }
}

load();
// вошёл/вышел — «это ты» и кнопка кабинета могут поменяться
let lastUser = getUser()?.id ?? null;
onUserChange((u) => {
  if ((u?.id ?? null) !== lastUser) { lastUser = u?.id ?? null; load(); }
});

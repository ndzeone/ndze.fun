import { SITE } from "../config.js";
import { mountLayout, DISCORD_SVG } from "../core/layout.js";
import { $, $$, esc, lerp, motion, finePointer, toast, initial, avatarHTML, plural } from "../core/util.js";
import { api } from "../data/api.js";
import { ROOT, people, loadDiscord, iconUrl, liveInvite, minecraftStatus, showMinecraft, setCount } from "../core/community.js";
import { mouse, onFrame, initReveal, initMagnetic, initTilt } from "../core/fx.js";
import { loadRepos } from "../data/github.js";
import { repoCardHTML } from "../core/repo-card.js";
import { mountSpidey } from "./spidey.js";

await mountLayout("home");

/* ---------- Тексты из конфига ---------- */
$("#heroRole").textContent = SITE.role;
$("#heroName").textContent = SITE.nick;
$("#heroTagline").textContent = SITE.tagline;
$("#about-text").textContent = SITE.about;
$("#schedule").textContent = SITE.schedule;
$("#twitchOpen").href = SITE.twitch.url;
$("#ytOpen").href = SITE.youtube.url;
$("#fcTwitch strong").textContent = SITE.twitch.url.replace(/^https?:\/\/(www\.)?/, "");
$("#socials").innerHTML = SITE.socials
  .map((s) => `<a class="pill magnetic" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}<span aria-hidden="true">↗</span></a>`)
  .join("");

/* ---------- Человек-паук ---------- */
const spidey = mountSpidey($("#spidey"), { caption: $("#spideyCaption") });
// секретный код (assets/js/core/webshoot.js) снимает маску полностью
window.addEventListener("ndze:konami", () => spidey.toggle(true));

/* ---------- «Расшифровка» ника ---------- */
function scramble(el) {
  const final = el.textContent;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=?";
  const start = performance.now();
  el.closest("h1").setAttribute("aria-label", final);
  const step = (now) => {
    const p = Math.min(1, (now - start) / 1100);
    const shown = Math.floor(p * final.length);
    el.textContent = [...final].map((ch, i) => (i < shown ? ch : chars[(Math.random() * chars.length) | 0])).join("");
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
if (motion) scramble($("#heroName"));

/* ---------- Плавающие карточки вокруг героя (параллакс за мышью) ---------- */
if (motion && finePointer) {
  const cards = $$(".float-card").map((el) => ({ el, depth: Number(el.dataset.depth) || 10, x: 0, y: 0 }));
  onFrame(() => {
    const nx = mouse.x / innerWidth - 0.5;
    const ny = mouse.y / innerHeight - 0.5;
    for (const c of cards) {
      c.x = lerp(c.x, nx * c.depth, 0.08);
      c.y = lerp(c.y, ny * c.depth, 0.08);
      c.el.style.translate = `${c.x.toFixed(2)}px ${c.y.toFixed(2)}px`;
    }
  });
}

/* ---------- Статистика ---------- */
function renderStats(repos) {
  const langs = new Set(repos.map((r) => r.language).filter(Boolean));
  const stats = [
    { value: repos.length, label: "репозиториев" },
    { value: langs.size, label: "языков программирования" },
    { value: 3, label: "игры для заданий" },
    { value: 99, suffix: "%", label: "кофе в крови" },
  ];
  $("#stats").innerHTML = stats
    .map((s) => `<div class="stat"><span class="stat-value" data-value="${s.value}" data-suffix="${esc(s.suffix || "")}">${motion ? 0 : s.value}${esc(s.suffix || "")}</span><span class="stat-label">${esc(s.label)}</span></div>`)
    .join("");
}

function countUp(el) {
  const target = Number(el.dataset.value);
  const suffix = el.dataset.suffix;
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 1400);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- Проекты с GitHub ---------- */
async function renderProjects() {
  const grid = $("#repoGrid");
  try {
    const { repos } = await loadRepos();
    $("#fcRepos").textContent = repos.length;
    renderStats(repos);
    const top = [...repos].sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || "")).slice(0, 6);
    grid.innerHTML = top.map((r, i) => repoCardHTML(r, { index: i })).join("");
    initTilt(grid, ".repo-card");
  } catch (err) {
    renderStats([]);
    grid.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>Не удалось загрузить проекты: ${esc(err.message)}</p>
      <a class="btn btn-ghost btn-sm" href="${esc(SITE.github.url)}" target="_blank" rel="noopener">Открыть GitHub ↗</a></div>`;
  }
}

/* ---------- Twitch ---------- */
function renderTwitch() {
  const channel = encodeURIComponent(SITE.twitch.channel);
  const host = location.hostname;
  if (/^https?:$/.test(location.protocol) && host) {
    const parent = `parent=${encodeURIComponent(host)}`;
    $("#player").innerHTML = `<iframe title="Twitch-плеер ${esc(SITE.twitch.channel)}" src="https://player.twitch.tv/?channel=${channel}&${parent}&muted=true" allowfullscreen loading="lazy"></iframe>`;
    $("#chat").innerHTML = `<iframe title="Twitch-чат" src="https://www.twitch.tv/embed/${channel}/chat?${parent}&darkpopout" loading="lazy"></iframe>`;
  } else {
    $("#chat").remove();
    $("#streamWrap").classList.add("solo");
    $("#player").innerHTML = `<div class="fallback"><p>Плеер Twitch работает, когда сайт открыт через <code>start.bat</code> или опубликован.</p>
      <a class="btn btn-primary" href="${esc(SITE.twitch.url)}" target="_blank" rel="noopener">Открыть канал ↗</a></div>`;
  }
}

/* ---------- YouTube: плейлист всех загрузок канала ---------- */
function renderYouTube() {
  const id = SITE.youtube.channelId || "";
  const wrap = $("#ytWrap");
  if (/^UC[\w-]{22}$/.test(id)) {
    const uploads = `UU${id.slice(2)}`;
    wrap.innerHTML = `<div class="frame yt-player"><iframe title="Видео канала ${esc(SITE.youtube.handle)}" src="https://www.youtube-nocookie.com/embed/videoseries?list=${uploads}" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>
      <a class="yt-side glass" href="${esc(SITE.youtube.url)}" target="_blank" rel="noopener">
        <span class="yt-logo" aria-hidden="true">▶</span>
        <strong>${esc(SITE.youtube.handle)}</strong>
        <span class="muted">Записи стримов, разборы работ и лучшие моменты. Подписывайся, чтобы не пропустить.</span>
        <span class="cc-go">Перейти на канал →</span>
      </a>`;
  } else {
    wrap.innerHTML = `<a class="yt-side glass" href="${esc(SITE.youtube.url)}" target="_blank" rel="noopener"><span class="yt-logo" aria-hidden="true">▶</span><strong>${esc(SITE.youtube.handle)}</strong><span class="cc-go">Перейти на канал →</span></a>`;
  }
}

/* ---------- Discord-серверы ---------- */
const COPY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>`;

function discordCardHTML(cfg, info) {
  const name = cfg.title || info?.name || cfg.kind;
  const icon = iconUrl(info);
  const link = `https://discord.gg/${cfg.invite}`;
  // описание из Discord показываем цитатой, если это не просто «Название | жанр»
  const desc = info?.description && !info.description.toLowerCase().includes(name.toLowerCase()) ? info.description : "";
  const cover = cfg.banner
    ? `<div class="dc-cover has-banner" aria-hidden="true"><img src="${esc(new URL(cfg.banner, ROOT).href)}" alt="" loading="lazy" decoding="async"></div>`
    : `<div class="dc-cover" aria-hidden="true">${icon ? `<img src="${esc(icon)}" alt="" loading="lazy" decoding="async">` : ""}</div>`;
  return `<article class="dc-card glass" style="--accent:${esc(cfg.accent || "#5865f2")}" data-invite="${esc(cfg.invite)}">
    ${cover}
    <div class="dc-head">
      <span class="dc-icon">${icon ? `<img src="${esc(icon)}" alt="" width="84" height="84" loading="lazy" decoding="async">` : esc(initial(name))}</span>
      <div class="dc-title">
        <span class="cc-kicker dc-kicker">${esc(cfg.kind)}</span>
        <h3>${esc(name)}</h3>
      </div>
    </div>
    <p class="dc-tagline">${esc(cfg.tagline)}</p>
    ${desc ? `<p class="dc-desc">«${esc(desc)}»</p>` : ""}
    ${cfg.perks?.length ? `<ul class="dc-perks">${cfg.perks.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    <div class="dc-stats"${info ? "" : " hidden"}>
      <span class="dc-stat dc-on"><i aria-hidden="true"></i><b data-online>${info?.online ?? 0}</b> в сети</span>
      <span class="dc-stat"><i aria-hidden="true"></i><b data-members>${info?.members ?? 0}</b> <span data-members-label>${people(info?.members ?? 0)}</span></span>
    </div>
    ${cfg.ip ? `<div class="dc-mc" data-ip="${esc(cfg.ip)}">
      <span class="mc-state" data-mc-state><i aria-hidden="true"></i><span>Minecraft-сервер: проверяем…</span></span>
      <button class="btn btn-ghost btn-xs dc-copy" type="button" data-copy="${esc(cfg.ip)}" data-copy-what="IP сервера" aria-label="Скопировать IP ${esc(cfg.ip)}"><span>IP: ${esc(cfg.ip)}</span>${COPY_SVG}</button>
    </div>` : ""}
    <div class="dc-actions">
      <a class="btn btn-discord magnetic" href="${esc(link)}" target="_blank" rel="noopener">${DISCORD_SVG}<span>Присоединиться</span></a>
      <button class="btn btn-ghost btn-sm dc-copy" type="button" data-copy="${esc(link)}" aria-label="Скопировать ссылку-приглашение ${esc(link)}">
        <span>discord.gg/${esc(cfg.invite)}</span>${COPY_SVG}
      </button>
    </div>
  </article>`;
}

async function renderDiscord(data) {
  const grid = $("#dcGrid");
  const list = SITE.discord || [];
  if (!list.length) return $("#discord").remove();
  grid.innerHTML = list.map((cfg) => discordCardHTML(cfg, data[cfg.invite])).join("");
  initTilt(grid, ".dc-card", { maxX: 4, maxY: 5 });
  // живые цифры догружаются в фоне, страницу не ждём
  Promise.all(list.map(async (cfg) => {
    const card = $(`[data-invite="${cfg.invite}"]`, grid);
    const live = await liveInvite(cfg.invite);
    if (!live) return false; // Discord недоступен — остаются цифры из data/discord.json
    $(".dc-stats", card).hidden = false;
    setCount($("[data-online]", card), live.online);
    setCount($("[data-members]", card), live.members);
    $("[data-members-label]", card).textContent = people(live.members);
    return true;
  })).then((live) => {
    if (!live.some(Boolean)) return;
    $("#dcLive").classList.add("is-live");
    $("#dcLiveText").textContent = "онлайн вживую";
  });
  for (const box of $$("[data-ip]", grid)) minecraftStatus(box.dataset.ip).then((st) => showMinecraft(box, st));
}

/* ---------- Зал славы: лидеры по опыту + работа недели из битвы ---------- */
async function renderFame() {
  const grid = $("#fame-grid");
  const [list, battle] = await Promise.all([api.leaderboard().catch(() => []), api.battleTop().catch(() => ({ week: null }))]);
  const week = battle.week;
  const row = (r, i) => `<li class="fame-row"><span class="fame-place">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</span>
    ${avatarHTML(r.user.nick, r.user.avatarUrl, { size: "sm" })}
    <span class="fame-name"><b>${esc(r.user.nick)}</b><small>ур. ${r.level} · ${esc(r.title)}</small></span>
    <span class="fame-xp">${r.xp} XP</span></li>`;
  grid.innerHTML = `
    <article class="card glass fame-card">
      <span class="cc-kicker">Лидеры зрителей</span>
      ${list.length ? `<ol class="fame-list">${list.slice(0, 5).map(row).join("")}</ol>`
        : `<p class="muted">Таблица пуста — присылай работы, предлагай задания и голосуй, чтобы попасть сюда первым.</p>`}
      <a class="cc-go" href="play.html#leaders">Вся таблица →</a>
    </article>
    <article class="card glass fame-card fame-week">
      <span class="cc-kicker">👑 Работа недели</span>
      ${week ? `${week.imageUrl ? `<img src="${esc(week.imageUrl)}" alt="" loading="lazy" decoding="async">` : ""}
        <h3>${esc(week.title)}</h3><p class="muted">@${esc(week.authorNick)} · ${week.weekWins} ${plural(week.weekWins, ["победа", "победы", "побед"])} в битве за неделю</p>`
        : `<h3>Кто победит?</h3><p class="muted">Две работы из галереи — выбирай лучшую. Самая побеждающая за неделю попадает сюда.</p>`}
      <a class="cc-go" href="play.html#battle">В битву работ →</a>
    </article>`;
}

/* ---------- Большие кнопки в контактах ---------- */
function renderContactLinks(data) {
  $("#contactLinks").innerHTML = (SITE.links || []).map((l) => {
    const icon = l.icon || iconUrl(data[l.invite]);
    const url = l.url || `https://discord.gg/${l.invite}`;
    return `<a class="link-card glass magnetic" style="--accent:${esc(l.accent || "#5865f2")}" href="${esc(url)}" target="_blank" rel="noopener">
      <span class="lc-icon">${icon ? `<img src="${esc(icon)}" alt="" width="56" height="56" loading="lazy" decoding="async">` : esc(initial(l.label))}</span>
      <span class="lc-text"><small>${esc(l.kind)}</small><b>${esc(l.label)}</b></span>
      <span class="lc-go">${DISCORD_SVG}<span>Зайти</span><span aria-hidden="true">↗</span></span>
    </a>`;
  }).join("");
}

$("#dcGrid").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    toast(`${btn.dataset.copyWhat || "Ссылка-приглашение"} скопирована`);
  } catch {
    toast(btn.dataset.copy);
  }
});

renderTwitch();
renderYouTube();
renderFame();
const discordData = await loadDiscord();
await renderDiscord(discordData);
renderContactLinks(discordData);
initTilt($("#community"), ".community-card", { maxX: 5, maxY: 6 });
initMagnetic();
await renderProjects();
initReveal();

// Счётчики запускаются, когда блок статистики попадает в экран
if (motion) {
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    $$(".stat-value", e.target).forEach(countUp);
    io.disconnect();
  }, { threshold: 0.4 });
  io.observe($("#stats"));
}

import { SITE } from "../config.js";
import { mountLayout, DISCORD_SVG } from "../core/layout.js";
import { $, $$, esc, lerp, motion, finePointer, plural, toast, initial } from "../core/util.js";
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
mountSpidey($("#spidey"), { caption: $("#spideyCaption") });

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
// data/discord.json собирает tools/sync-discord.ps1 при деплое (Discord и его CDN в РФ доступны не всем);
// онлайн дополнительно спрашиваем у Discord из браузера — получится, если он открывается.
const DATA_ROOT = new URL("../../../", import.meta.url);
const people = (n) => plural(n, ["участник", "участника", "участников"]);

function discordCardHTML(cfg, info) {
  const name = info?.name || cfg.kind;
  const icon = info?.icon ? new URL(info.icon, DATA_ROOT).href : "";
  const link = `https://discord.gg/${cfg.invite}`;
  // описание из Discord показываем цитатой, если это не просто «Название | жанр»
  const desc = info?.description && !info.description.toLowerCase().includes(name.toLowerCase()) ? info.description : "";
  return `<article class="dc-card glass" style="--accent:${esc(cfg.accent || "#5865f2")}" data-invite="${esc(cfg.invite)}">
    ${icon ? `<div class="dc-cover" aria-hidden="true"><img src="${esc(icon)}" alt="" loading="lazy" decoding="async"></div>` : '<div class="dc-cover" aria-hidden="true"></div>'}
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
    <div class="dc-actions">
      <a class="btn btn-discord magnetic" href="${esc(link)}" target="_blank" rel="noopener">${DISCORD_SVG}<span>Присоединиться</span></a>
      <button class="btn btn-ghost btn-sm dc-copy" type="button" data-copy="${esc(link)}" aria-label="Скопировать ссылку-приглашение ${esc(link)}">
        <span>discord.gg/${esc(cfg.invite)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>
      </button>
    </div>
  </article>`;
}

function setCount(card, attr, n) {
  const el = $(`[${attr}]`, card);
  if (!el || el.textContent === String(n)) return;
  el.textContent = n;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

async function liveDiscord(card, code) {
  try {
    const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`, {
      signal: AbortSignal.timeout?.(5000), credentials: "omit", referrerPolicy: "no-referrer",
    });
    if (!res.ok) return false;
    const j = await res.json();
    if (!Number.isFinite(j.approximate_member_count)) return false;
    $(".dc-stats", card).hidden = false;
    setCount(card, "data-online", j.approximate_presence_count);
    setCount(card, "data-members", j.approximate_member_count);
    $("[data-members-label]", card).textContent = people(j.approximate_member_count);
    return true;
  } catch {
    return false; // Discord недоступен — остаются цифры из data/discord.json
  }
}

async function renderDiscord() {
  const grid = $("#dcGrid");
  const list = SITE.discord || [];
  if (!list.length) return $("#discord").remove();
  let data = {};
  try {
    const res = await fetch(new URL("data/discord.json", DATA_ROOT), { cache: "no-cache" });
    if (res.ok) data = (await res.json()).servers || {};
  } catch { /* нет снимка — карточки без цифр */ }
  grid.innerHTML = list.map((cfg) => discordCardHTML(cfg, data[cfg.invite])).join("");
  initTilt(grid, ".dc-card", { maxX: 4, maxY: 5 });
  // живые цифры догружаются в фоне, страницу не ждём
  Promise.all(list.map((cfg) => liveDiscord($(`[data-invite="${cfg.invite}"]`, grid), cfg.invite))).then((live) => {
    if (!live.some(Boolean)) return;
    $("#dcLive").classList.add("is-live");
    $("#dcLiveText").textContent = "онлайн вживую";
  });
}

$("#dcGrid").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    toast("Ссылка-приглашение скопирована");
  } catch {
    toast(btn.dataset.copy);
  }
});

renderTwitch();
renderYouTube();
await renderDiscord();
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

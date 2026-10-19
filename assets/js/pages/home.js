import { SITE } from "../config.js";
import { mountLayout } from "../core/layout.js";
import { $, $$, esc, lerp, motion, finePointer } from "../core/util.js";
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

renderTwitch();
renderYouTube();
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

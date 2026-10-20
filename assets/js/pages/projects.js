// Страница «Проекты»: мои и совместные (список — SITE.projects в config.js).
// Данные GitHub — из data/repos.json, Discord — из data/discord.json + вживую, Minecraft — mcstatus.io.
import { SITE } from "../config.js";
import { mountLayout, DISCORD_SVG } from "../core/layout.js";
import { $, $$, esc, plural, timeAgo, formatDate, toast, initial } from "../core/util.js";
import { initReveal, initMagnetic, initTilt } from "../core/fx.js";
import { loadRepos, LANG_COLORS } from "../data/github.js";
import { ROOT, people, loadDiscord, iconUrl, liveInvite, minecraftStatus, showMinecraft, setCount } from "../core/community.js";

await mountLayout("projects");

const FILTERS = [
  { id: "all", label: "Все" },
  { id: "mine", label: "Мои" },
  { id: "team", label: "Совместные" },
];
const COPY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>`;
const GH_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z"/></svg>`;

let filter = FILTERS.some((f) => `#${f.id}` === location.hash) ? location.hash.slice(1) : "all";
const projects = SITE.projects || [];

const [discord, repoData] = await Promise.all([
  loadDiscord(),
  loadRepos().catch(() => ({ repos: [] })),
]);
const repos = new Map((repoData.repos || []).map((r) => [r.name.toLowerCase(), r]));
const repoOf = (p) => (p.repo ? repos.get(p.repo.toLowerCase()) : null);

/* ---------- Статус проекта ---------- */
function statusOf(p, repo) {
  if (p.status) return { label: p.status, tone: /разработ|работе/i.test(p.status) ? "lime" : "info" };
  const pushed = repo?.pushedAt ? Date.parse(repo.pushedAt) : NaN;
  if (Number.isNaN(pushed)) return null;
  const days = (Date.now() - pushed) / 86400000;
  if (days <= 30) return { label: "В работе", tone: "lime" };
  if (days <= 150) return { label: "Обновляется", tone: "info" };
  return { label: "На паузе", tone: "plain" };
}

function ownerBadge(p) {
  return p.owner === "team"
    ? `<span class="badge pj-team-badge">Совместный${p.with ? ` · ${esc(p.with)}` : ""}</span>`
    : `<span class="badge lime">Мой проект</span>`;
}

/* ---------- Большая карточка (серверы и сообщества) ---------- */
function featureHTML(p) {
  const info = p.discord ? discord[p.discord] : null;
  const icon = iconUrl(info);
  const st = statusOf(p, null);
  const link = p.discord ? `https://discord.gg/${p.discord}` : p.url;
  return `<article class="pj-feature glass reveal" data-owner="${esc(p.owner)}" style="--accent:${esc(p.accent || "#5dd62c")}" data-invite="${esc(p.discord || "")}">
    <div class="pj-banner" aria-hidden="true">${p.banner ? `<img src="${esc(new URL(p.banner, ROOT).href)}" alt="" loading="lazy" decoding="async">` : ""}</div>
    <div class="pj-feature-body">
      <div class="pj-feature-head">
        <span class="pj-icon">${icon ? `<img src="${esc(icon)}" alt="" width="96" height="96" loading="lazy" decoding="async">` : `<b>${esc(p.mono || initial(p.title))}</b>`}</span>
        <div class="pj-titles">
          <div class="pj-badges">${ownerBadge(p)}${st ? `<span class="badge ${st.tone}">${esc(st.label)}</span>` : ""}</div>
          <h3>${esc(p.title)}</h3>
          <span class="pj-kind">${esc(p.kind || "")}</span>
        </div>
      </div>
      <p class="pj-desc">${esc(p.description || info?.description || "")}</p>
      ${p.tags?.length ? `<ul class="pj-tags">${p.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <div class="pj-live">
        ${info ? `<span class="pj-stat pj-on"><i aria-hidden="true"></i><b data-online>${info.online ?? 0}</b> в сети</span>
          <span class="pj-stat"><i aria-hidden="true"></i><b data-members>${info.members ?? 0}</b> <span data-members-label>${people(info.members ?? 0)}</span> в Discord</span>` : ""}
        ${p.ip ? `<span class="mc-state" data-mc-state><i aria-hidden="true"></i><span>Minecraft-сервер: проверяем…</span></span>` : ""}
      </div>
      <div class="pj-actions">
        ${link ? `<a class="btn btn-discord magnetic" href="${esc(link)}" target="_blank" rel="noopener">${DISCORD_SVG}<span>${p.discord ? "Discord-сервер" : "Открыть"}</span></a>` : ""}
        ${p.ip ? `<button class="btn btn-ghost btn-sm pj-copy" type="button" data-copy="${esc(p.ip)}" data-copy-what="IP сервера"><span>IP: ${esc(p.ip)}</span>${COPY_SVG}</button>` : ""}
        ${p.discord ? `<button class="btn btn-ghost btn-sm pj-copy" type="button" data-copy="${esc(link)}" data-copy-what="Ссылка-приглашение"><span>discord.gg/${esc(p.discord)}</span>${COPY_SVG}</button>` : ""}
      </div>
    </div>
  </article>`;
}

/* ---------- Карточка приложения / репозитория ---------- */
function cardHTML(p) {
  const repo = repoOf(p);
  const st = statusOf(p, repo);
  const lang = repo?.language;
  const desc = p.description || repo?.description || "";
  const gh = p.url || (p.repo ? `https://github.com/${SITE.github.user}/${p.repo}` : "");
  const canBrowse = p.repo && repo && !repo.private;
  return `<article class="pj-card glass reveal" data-owner="${esc(p.owner)}" style="--accent:${esc(p.accent || "#5dd62c")}">
    <div class="pj-cover" aria-hidden="true"><span class="pj-mono">${esc(p.mono || initial(p.title))}</span></div>
    <div class="pj-card-body">
      <div class="pj-badges">${ownerBadge(p)}${st ? `<span class="badge ${st.tone}">${esc(st.label)}</span>` : ""}${repo?.private ? '<span class="badge plain">🔒 закрытый</span>' : ""}</div>
      <h3>${esc(p.title)}</h3>
      <span class="pj-kind">${esc(p.kind || "")}</span>
      ${desc ? `<p class="pj-desc">${esc(desc)}</p>` : ""}
      ${p.tags?.length ? `<ul class="pj-tags">${p.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <div class="pj-meta">
        ${lang ? `<span><i class="pj-lang" style="background:${esc(LANG_COLORS[lang] || "#8b8b8b")}"></i>${esc(lang)}</span>` : ""}
        ${repo ? `<span title="Звёзды на GitHub">★ ${repo.stars}</span>` : ""}
        ${repo?.pushedAt ? `<span title="${esc(formatDate(repo.pushedAt))}">обновлён ${esc(timeAgo(repo.pushedAt))}</span>` : ""}
      </div>
      <div class="pj-actions">
        ${canBrowse ? `<a class="btn btn-primary btn-sm magnetic" href="repo.html?name=${encodeURIComponent(p.repo)}">Смотреть код</a>` : ""}
        ${gh ? `<a class="btn btn-ghost btn-sm magnetic" href="${esc(gh)}" target="_blank" rel="noopener">${GH_SVG}<span>GitHub</span><span aria-hidden="true">↗</span></a>` : ""}
      </div>
    </div>
  </article>`;
}

function sectionHTML(id, index, title, sub, list, extra = "") {
  const features = list.filter((p) => p.featured);
  const cards = list.filter((p) => !p.featured);
  return `<section class="pj-section" id="${id}" data-owner="${id === "pjTeam" ? "team" : "mine"}" aria-labelledby="${id}Title">
    <div class="section-head"><span class="section-index">${index}</span><h2 id="${id}Title">${esc(title)}</h2><span class="pj-count">${list.length}</span></div>
    <p class="pj-sub muted">${esc(sub)}</p>
    ${features.map(featureHTML).join("")}
    ${cards.length || extra ? `<div class="pj-grid">${cards.map(cardHTML).join("")}${extra}</div>` : ""}
  </section>`;
}

const collabCTA = () => {
  const own = projects.find((p) => p.owner === "mine" && p.discord);
  const link = own ? `https://discord.gg/${own.discord}` : SITE.socials?.[0]?.url;
  return `<a class="pj-card pj-cta glass reveal" data-owner="team" href="${esc(link)}" target="_blank" rel="noopener">
    <span class="pj-cta-plus" aria-hidden="true">+</span>
    <h3>Сделаем проект вместе?</h3>
    <p class="pj-desc">Есть идея для сервера, мода, бота или приложения — пиши мне в Discord, обсудим на стриме.</p>
    <span class="pj-cta-go">${DISCORD_SVG}Написать в Discord ↗</span>
  </a>`;
};

/* ---------- Отрисовка ---------- */
const mine = projects.filter((p) => p.owner !== "team");
const team = projects.filter((p) => p.owner === "team");

function renderCounters() {
  const members = projects.reduce((n, p) => n + (p.discord ? discord[p.discord]?.members || 0 : 0), 0);
  const stars = mine.concat(team).reduce((n, p) => n + (repoOf(p)?.stars || 0), 0);
  const items = [
    [mine.length, plural(mine.length, ["мой проект", "моих проекта", "моих проектов"])],
    [team.length, plural(team.length, ["совместный", "совместных", "совместных"])],
    [members, `${people(members)} в Discord`],
    [stars, plural(stars, ["звезда", "звезды", "звёзд"]) + " на GitHub"],
  ];
  $("#pjCounters").innerHTML = items.map(([n, l]) => `<span class="pj-counter"><b>${n}</b>${esc(l)}</span>`).join("");
}

function render() {
  $("#pjFilter").innerHTML = FILTERS.map((f) => {
    const n = f.id === "all" ? projects.length : f.id === "team" ? team.length : mine.length;
    return `<button class="chip" type="button" data-filter="${f.id}" aria-pressed="${f.id === filter}">${esc(f.label)} <span class="count">${n}</span></button>`;
  }).join("");
  $("#pjRoot").innerHTML =
    sectionHTML("pjMine", "01", "Мои проекты", "То, что делаю сам: серверы, VPN-клиенты, лаунчеры и приложения.", mine)
    + sectionHTML("pjTeam", "02", "Совместные проекты", "Проекты, которые веду вместе с друзьями.", team, collabCTA());
  applyFilter();
}

function applyFilter() {
  $$("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  $$(".pj-section").forEach((s) => { s.hidden = filter !== "all" && s.dataset.owner !== filter; });
}

$("#pjFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b || b.dataset.filter === filter) return;
  filter = b.dataset.filter;
  history.replaceState(history.state, "", filter === "all" ? location.pathname : `#${filter}`);
  applyFilter();
});

$("#pjRoot").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    toast(`${btn.dataset.copyWhat || "Ссылка"} скопирован${btn.dataset.copyWhat === "IP сервера" ? "" : "а"}`);
  } catch {
    toast(btn.dataset.copy);
  }
});

renderCounters();
render();
initTilt($("#pjRoot"), ".pj-card", { maxX: 4, maxY: 5 });
initMagnetic();
initReveal();

// живые цифры: Discord и Minecraft
for (const card of $$(".pj-feature")) {
  const code = card.dataset.invite;
  if (code) liveInvite(code).then((live) => {
    if (!live) return;
    setCount($("[data-online]", card), live.online);
    setCount($("[data-members]", card), live.members);
    const label = $("[data-members-label]", card);
    if (label) label.textContent = people(live.members);
  });
  const p = projects.find((x) => x.discord && x.discord === code);
  if (p?.ip) minecraftStatus(p.ip).then((st) => showMinecraft(card, st));
}

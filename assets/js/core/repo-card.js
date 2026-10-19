// Карточка одного репозитория. Используют страница «Проекты» (repos.js) и главная.
//
//   import { repoCardHTML } from "../core/repo-card.js";
//   grid.innerHTML = repos.map((r, i) => repoCardHTML(r, { index: i })).join("");
//   initTilt(grid, ".repo-card");
//
// Стили — assets/css/repo-card.css (подключить на странице).
// Открытый репозиторий → ссылка <a> на repo.html?name=…, закрытый → <article> без ссылки
// с замком «Код закрыт» при наведении/фокусе.
import { esc, timeAgo, formatDate } from "./util.js";
import { LANG_COLORS } from "../data/github.js";

const svg = (body, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const REPO_ICONS = {
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  fork: svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>'),
  repo: svg('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6"/>'),
  arrow: svg('<path d="M7 17 17 7M9 7h8v8"/>'),
};

const FALLBACK_LANG = "#8a8a8a";
export const langColor = (lang) => LANG_COLORS[lang] || FALLBACK_LANG;

const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n ?? 0));

/** HTML одной карточки репозитория. index — для задержки появления (лесенка). */
export function repoCardHTML(repo, { index = 0 } = {}) {
  const r = repo || {};
  const delay = Math.min(index, 14) * 45;
  const updated = r.pushedAt || r.updatedAt;
  const badges = [
    r.private ? `<span class="badge warn plain">${REPO_ICONS.lock}Закрытый</span>` : "",
    r.fork ? `<span class="badge info">Форк</span>` : "",
    r.archived ? `<span class="badge">Архив</span>` : "",
  ].join("");
  const topics = (r.topics || []).slice(0, 3)
    .map((t) => `<li>#${esc(t)}</li>`).join("");

  const body = `
    <div class="repo-card__top">
      <span class="repo-card__icon">${r.private ? REPO_ICONS.lock : REPO_ICONS.repo}</span>
      <div class="repo-card__badges">${badges}</div>
      ${r.private ? "" : `<span class="repo-card__go">${REPO_ICONS.arrow}</span>`}
    </div>
    <h3 class="repo-card__name">${esc(r.name)}</h3>
    <p class="repo-card__desc${r.description ? "" : " is-empty"}">${esc(r.description || "Без описания")}</p>
    ${topics ? `<ul class="repo-card__topics" aria-label="Темы">${topics}</ul>` : ""}
    <div class="repo-card__meta">
      ${r.language ? `<span class="repo-card__lang"><i style="--lang:${esc(langColor(r.language))}"></i>${esc(r.language)}</span>` : ""}
      <span title="Звёзды">${REPO_ICONS.star}<span class="sr-only">Звёзд:</span>${esc(fmtNum(r.stars))}</span>
      <span title="Форки">${REPO_ICONS.fork}<span class="sr-only">Форков:</span>${esc(fmtNum(r.forks))}</span>
      ${updated ? `<span class="repo-card__time" title="Обновлён ${esc(formatDate(updated))}">${REPO_ICONS.clock}<span class="sr-only">Обновлён</span>${esc(timeAgo(updated))}</span>` : ""}
    </div>`;

  if (r.private) {
    return `<article class="card repo-card is-private" tabindex="0" style="--d:${delay}ms">${body}
      <div class="repo-card__lock">${REPO_ICONS.lock}<span>Код закрыт</span></div>
    </article>`;
  }
  return `<a class="card repo-card" href="repo.html?name=${encodeURIComponent(r.name || "")}" style="--d:${delay}ms">${body}</a>`;
}

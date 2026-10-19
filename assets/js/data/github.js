// Данные GitHub.
//   • Список репозиториев (включая закрытые) берётся из снимка data/repos.json,
//     который делает tools/sync-github.ps1 с твоим токеном. Токен на сайт не попадает.
//   • Если снимка нет — берём только открытые репозитории из публичного API.
//   • Код открытых репозиториев грузится прямо из GitHub (API деревьев + raw.githubusercontent.com).
//     У закрытых — только описание, код недоступен.
//
// Контракт:
//   loadRepos()                    → { user: GhUser, repos: Repo[], source: "snapshot"|"live", generatedAt: string|null }
//   getRepo(name)                  → Repo
//   getTree(name, branch)          → TreeItem[]      // { path, type: "blob"|"tree", size } — только для открытых
//   getFileText(name, branch, path)→ string
//   rawUrl(name, branch, path)     → string          // прямая ссылка на файл (картинки и т.п.)
//   getReadme(name, branch)        → { path, text } | null
//   repoZipUrl(name, branch)       → string
//   LANG_COLORS                    → { [language]: "#hex" }
//
//   GhUser = { login, name, avatarUrl, htmlUrl, bio, publicRepos, followers }
//   Repo   = { name, fullName, description, private, fork, archived, language, stars, forks, topics: string[],
//              defaultBranch, size, updatedAt, pushedAt, createdAt, htmlUrl, homepage }
//
// Ошибки: ApiError("not_found" | "forbidden" (закрытый) | "rate_limited" | "network").
import { SITE } from "../config.js";
import { ApiError } from "./errors.js";

const USER = SITE.github.user;
const API = "https://api.github.com";
const CACHE_PREFIX = "gh:";
const CACHE_MS = 10 * 60 * 1000;

export const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", HTML: "#e34c26", CSS: "#563d7c", Python: "#3572A5",
  Java: "#b07219", "C#": "#178600", "C++": "#f34b7d", C: "#555555", Swift: "#F05138", Kotlin: "#A97BFF",
  Go: "#00ADD8", Rust: "#dea584", PHP: "#4F5D95", Ruby: "#701516", Shell: "#89e051", PowerShell: "#012456",
  Lua: "#000080", Dart: "#00B4AB", Vue: "#41b883", SCSS: "#c6538c", Dockerfile: "#384d54",
};

/* ---------- Кэш в sessionStorage, чтобы не упираться в лимит API (60 запросов/час) ---------- */
function cacheGet(key) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + key));
    return hit && Date.now() - hit.t < CACHE_MS ? hit.v : undefined;
  } catch { return undefined; }
}
function cacheSet(key, v) {
  try { sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v })); } catch { /* переполнение — не страшно */ }
}

async function gh(path) {
  const cached = cacheGet(path);
  if (cached !== undefined) return cached;
  let res;
  try {
    res = await fetch(API + path, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new ApiError("network");
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0") throw new ApiError("rate_limited", "Лимит GitHub API исчерпан, попробуй через несколько минут");
    throw new ApiError("forbidden");
  }
  if (res.status === 404) throw new ApiError("not_found", "Не найдено на GitHub");
  if (!res.ok) throw new ApiError("unknown", `GitHub ответил ${res.status}`);
  const data = await res.json();
  cacheSet(path, data);
  return data;
}

const mapUser = (u) => ({
  login: u.login, name: u.name || u.login, avatarUrl: u.avatar_url, htmlUrl: u.html_url,
  bio: u.bio || "", publicRepos: u.public_repos ?? 0, followers: u.followers ?? 0,
});

const mapRepo = (r) => ({
  name: r.name, fullName: r.full_name, description: r.description || "", private: !!r.private,
  fork: !!r.fork, archived: !!r.archived, language: r.language || null,
  stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, topics: r.topics || [],
  defaultBranch: r.default_branch || "main", size: r.size ?? 0,
  updatedAt: r.updated_at, pushedAt: r.pushed_at, createdAt: r.created_at,
  htmlUrl: r.html_url, homepage: r.homepage || "",
});

let reposPromise;
export function loadRepos() {
  reposPromise ??= (async () => {
    try {
      const res = await fetch("data/repos.json", { cache: "no-cache" });
      if (res.ok) {
        const snap = await res.json();
        if (Array.isArray(snap.repos)) return { user: snap.user, repos: snap.repos, source: "snapshot", generatedAt: snap.generatedAt || null };
      }
    } catch { /* снимка нет — идём в публичный API */ }
    const [user, repos] = await Promise.all([
      gh(`/users/${USER}`),
      gh(`/users/${USER}/repos?per_page=100&sort=pushed`),
    ]);
    return { user: mapUser(user), repos: repos.map(mapRepo), source: "live", generatedAt: null };
  })();
  reposPromise.catch(() => { reposPromise = undefined; });
  return reposPromise;
}

export async function getRepo(name) {
  const { repos } = await loadRepos();
  const found = repos.find((r) => r.name.toLowerCase() === String(name).toLowerCase());
  if (found) return found;
  return mapRepo(await gh(`/repos/${USER}/${encodeURIComponent(name)}`));
}

export async function getTree(name, branch) {
  const repo = await getRepo(name);
  if (repo.private) throw new ApiError("forbidden", "Это закрытый репозиторий — код недоступен");
  const data = await gh(`/repos/${USER}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(branch || repo.defaultBranch)}?recursive=1`);
  return (data.tree || []).map((t) => ({ path: t.path, type: t.type === "tree" ? "tree" : "blob", size: t.size ?? 0 }))
    .filter((t) => t.type === "tree" || t.type === "blob");
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

export const rawUrl = (name, branch, path) =>
  `https://raw.githubusercontent.com/${USER}/${encodeURIComponent(name)}/${encodeURIComponent(branch)}/${encodePath(path)}`;

export async function getFileText(name, branch, path) {
  const key = `raw:${name}:${branch}:${path}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  let res;
  try {
    res = await fetch(rawUrl(name, branch, path));
  } catch {
    throw new ApiError("network");
  }
  if (res.status === 404) throw new ApiError("not_found", "Файл не найден");
  if (!res.ok) throw new ApiError("unknown", `GitHub ответил ${res.status}`);
  const text = await res.text();
  if (text.length < 200_000) cacheSet(key, text);
  return text;
}

export async function getReadme(name, branch) {
  const tree = await getTree(name, branch);
  const readme = tree.find((t) => t.type === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(t.path));
  if (!readme) return null;
  return { path: readme.path, text: await getFileText(name, branch, readme.path) };
}

export const repoZipUrl = (name, branch) =>
  `https://github.com/${USER}/${encodeURIComponent(name)}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;

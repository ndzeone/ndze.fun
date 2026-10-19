// Просмотр кода открытого репозитория: repo.html?name=<repo>&path=<файл или папка>.
// Дерево файлов слева, справа — папка (список + README) или файл (подсветка, номера строк,
// Markdown, картинки, карточка для бинарников). Навигация через history.pushState — у каждого
// файла своя ссылка, кнопки «назад/вперёд» работают.
//
// Безопасность: содержимое репозитория попадает в HTML только так —
//   • код: через hljs.highlight (экранирует) или esc();
//   • Markdown: marked → DOMPurify.sanitize, ссылки и картинки переписываются уже после очистки.
import { mountLayout } from "../core/layout.js";
import { initMagnetic } from "../core/fx.js";
import { $, $$, esc, plural, timeAgo, formatDate, formatBytes, motion } from "../core/util.js";
import { getRepo, getTree, getFileText, getReadme, rawUrl, repoZipUrl, LANG_COLORS } from "../data/github.js";
import { SITE } from "../config.js";

await mountLayout("repos");

/* ---------- Внешние библиотеки (точные версии + SRI) ---------- */
const LIBS = {
  hljs: {
    global: "hljs",
    src: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
    integrity: "sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp",
  },
  marked: {
    global: "marked",
    src: "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
    integrity: "sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi",
  },
  purify: {
    global: "DOMPurify",
    src: "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js",
    integrity: "sha384-+VfUPEb0PdtChMwmBcBmykRMDd+v6D/oFmB3rZM/puCMDYcIvF968OimRh4KQY9a",
  },
};
const libPromises = new Map();
function loadLib(key) {
  if (!libPromises.has(key)) {
    const lib = LIBS[key];
    const p = new Promise((resolve, reject) => {
      if (window[lib.global]) return resolve(window[lib.global]);
      const s = document.createElement("script");
      s.src = lib.src;
      s.integrity = lib.integrity;
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.async = true;
      s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error(`${key} не загрузился`)));
      s.onerror = () => { s.remove(); reject(new Error(`${key} не загрузился`)); };
      document.head.append(s);
    });
    p.catch(() => libPromises.delete(key)); // при повторе попробуем ещё раз
    libPromises.set(key, p);
  }
  return libPromises.get(key);
}

/* ---------- Константы ---------- */
const MAX_VIEW_BYTES = 500 * 1024;
const MAX_HIGHLIGHT_CHARS = 200_000;
const README_RE = /^readme(\.(md|markdown|txt))?$/i;
const ROOT = { path: "", type: "tree", size: 0 };
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const BINARY_EXT = new Set([
  "zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz", "jar", "war", "apk", "aab", "ipa", "exe", "dll", "so", "dylib",
  "bin", "msi", "dmg", "iso", "img", "class", "pyc", "pdb", "o", "obj", "a", "lib", "wasm", "node", "dat", "db",
  "sqlite", "sqlite3", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "wav", "ogg", "flac", "mp4",
  "webm", "mov", "avi", "mkv", "ttf", "otf", "woff", "woff2", "eot", "psd", "ai", "blend", "fbx", "unitypackage",
  "keystore", "jks", "p12", "pfx", "nupkg", "suo", "cache", "res",
]);
// расширение → язык hljs (если у hljs нет такого псевдонима)
const EXT_LANG = {
  csproj: "xml", vbproj: "xml", xaml: "xml", resx: "xml", props: "xml", targets: "xml", config: "xml",
  plist: "xml", svg: "xml", vue: "xml", manifest: "xml", fxml: "xml",
  toml: "ini", properties: "ini", cfg: "ini", conf: "ini", editorconfig: "ini", env: "bash",
  h: "c", hpp: "cpp", hh: "cpp", mdx: "markdown", gradle: "kotlin", jsonc: "json", babelrc: "json", eslintrc: "json",
};
const NAME_LANG = { dockerfile: "bash", makefile: "makefile", "cmakelists.txt": "cmake", ".gitignore": "bash", ".npmrc": "ini", ".env": "bash" };

// расширение → [цвет, значок]
const C = LANG_COLORS;
const EXT_STYLE = {};
const style = (exts, color, glyph = "code") => exts.split(" ").forEach((e) => { EXT_STYLE[e] = [color, glyph]; });
style("js mjs cjs jsx", C.JavaScript);
style("ts tsx mts cts", C.TypeScript);
style("json jsonc lock", "var(--warn)");
style("html htm xml xaml csproj vbproj resx props targets config plist manifest fxml", C.HTML);
style("css", "#8a63d2");
style("scss sass less", C.SCSS);
style("java", C.Java);
style("kt kts", C.Kotlin);
style("cs", "#3fbf3f");
style("py", "#4b8bd4");
style("go", C.Go);
style("rs", C.Rust);
style("c h", "#a8b9cc");
style("cpp hpp cc hh", C["C++"]);
style("swift", C.Swift);
style("php", "#8892bf");
style("rb", "#cc342d");
style("lua", "#6c78d8");
style("dart", C.Dart);
style("vue", C.Vue);
style("sh bash zsh", C.Shell);
style("ps1 psm1 bat cmd", "var(--info)");
style("sql", "var(--warn)");
style("gradle", "#4aa8ff");
style("md markdown mdx", "var(--white)", "text");
style("txt rst log csv", "var(--faint)", "text");
style("yml yaml toml ini cfg conf env properties editorconfig gitignore gitattributes npmrc", "var(--faint)", "conf");
style("png jpg jpeg gif webp svg ico bmp avif", "var(--info)", "image");
style("zip rar 7z gz tgz tar bz2 xz jar war apk aab nupkg", "var(--warn)", "archive");
style("exe dll so dylib bin msi dmg iso class pyc pdb o obj a lib wasm node dat db sqlite sqlite3 mp3 wav ogg mp4 webm mov ttf otf woff woff2 eot psd", "var(--danger)", "bin");
style("pdf doc docx xls xlsx ppt pptx", "var(--danger)", "text");

/* ---------- Иконки ---------- */
const svg = (inner, cls = "ficon", vb = "0 0 24 24") => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true">${inner}</svg>`;
const DOC = `<path class="i-fill" d="M6 2.5h8.5l5 5V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z"/><path d="M14.5 2.5v5h5"/>`;
const GLYPH = {
  code: `<path d="M10 12.2 7.8 14.5l2.2 2.3M14 12.2l2.2 2.3-2.2 2.3"/>`,
  text: `<path d="M8 12h8M8 15h8M8 18h5"/>`,
  conf: `<circle cx="12" cy="15" r="2.4"/><path d="M12 10.8v1.2M12 18v1.2M7.8 15H9M15 15h1.2"/>`,
  image: `<circle cx="9.5" cy="12" r="1.3"/><path d="m6.5 19 4-4 2.4 2.4 1.8-1.8 2.8 3.4"/>`,
  archive: `<path d="M12 3v1.6M12 6.4V8M12 9.8v1.6"/><rect x="10.3" y="13" width="3.4" height="3.6" rx=".8"/>`,
  bin: `<path d="M8.5 12.5v5M12.5 12.5h2.5v5h-2.5z"/>`,
};
const FOLDER = svg(`<path class="i-fill" d="M2.5 6A1.5 1.5 0 0 1 4 4.5h4.6l1.9 2H20A1.5 1.5 0 0 1 21.5 8v9.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5z"/>`, "ficon dir");
const FOLDER_OPEN = svg(`<path d="M2.5 17.5V6A1.5 1.5 0 0 1 4 4.5h4.6l1.9 2H19A1.5 1.5 0 0 1 20.5 8v1.5"/><path class="i-fill" d="M2.5 17.5 5.2 10h17.3l-2.7 7.9a1.5 1.5 0 0 1-1.4 1.1H4a1.5 1.5 0 0 1-1.5-1.5z"/>`, "ficon dir");
const CHEV = svg(`<path d="m6 4 4 4-4 4"/>`, "chev", "0 0 16 16");
const I = {
  star: svg(`<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>`, "ico"),
  fork: svg(`<circle cx="6.5" cy="5" r="2"/><circle cx="17.5" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6.5 7v1.5a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V7M12 11.5V17"/>`, "ico"),
  branch: svg(`<circle cx="6.5" cy="5" r="2"/><circle cx="6.5" cy="19" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7v10M17.5 9.5c0 4-5 3.5-9.5 7.5"/>`, "ico"),
  clock: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`, "ico"),
  zip: svg(`<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>`, "ico"),
  github: svg(`<path stroke="none" fill="currentColor" d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.2-1.2-3.2-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1.1-4.4-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.3 4.5-4.4 4.7.3.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z"/>`, "ico"),
  link: svg(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`, "ico"),
  copy: svg(`<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`, "ico"),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`, "ico"),
  raw: svg(`<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5h4"/>`, "ico"),
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>`, "ico"),
  files: svg(`<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>`, "ico"),
  book: svg(`<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h4a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5h-6zM19.5 5.5A1.5 1.5 0 0 0 18 4h-4a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h6z"/>`, "ico"),
  up: svg(`<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>`, "ico"),
  lock: svg(`<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor"/>`, "lock-svg"),
};

function fileStyle(name) {
  const lower = name.toLowerCase();
  if (README_RE.test(lower)) return ["var(--lime)", "text"];
  if (/^(license|licence|copying)(\.|$)/.test(lower)) return ["var(--warn)", "text"];
  if (lower === "dockerfile") return ["#2496ed", "conf"];
  if (lower.startsWith(".")) return EXT_STYLE[lower.slice(1)] || ["var(--faint)", "conf"];
  return EXT_STYLE[extOf(lower)] || ["var(--faint)", "text"];
}
function iconFor(it, open = false) {
  if (it.type === "tree") return open ? FOLDER_OPEN : FOLDER;
  const [color, glyph] = fileStyle(basename(it.path));
  return `<svg class="ficon" viewBox="0 0 24 24" aria-hidden="true" style="--c:${color}">${DOC}${GLYPH[glyph]}</svg>`;
}

/* ---------- Пути ---------- */
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};
const normPath = (p) => String(p || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== ".").join("/");
const isMarkdown = (name) => /\.(md|markdown|mdx)$/i.test(name);
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/** Относительная ссылка из Markdown → путь от корня репозитория. */
function resolvePath(baseDir, rel) {
  const parts = rel.startsWith("/") ? [] : baseDir ? baseDir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else {
      try { parts.push(decodeURIComponent(seg)); } catch { parts.push(seg); }
    }
  }
  return parts.join("/");
}
const isRelativeUrl = (u) => !!u && !/^[a-z][a-z\d+.-]*:/i.test(u) && !u.startsWith("//") && !u.startsWith("#");

/* ---------- Состояние ---------- */
const app = $("#repoApp");
const repoParam = (new URLSearchParams(location.search).get("name") || "").trim();
let repo = null;
let branch = "main";
let byPath = new Map();
let kids = new Map();
let fileCount = 0;
const expanded = new Set();
let current = "";
let filterQ = "";
let focusPath = null;
let viewToken = 0;
const els = {};
const drawerMQ = matchMedia("(max-width: 900px)");

const hrefFor = (path) => `repo.html?name=${encodeURIComponent(repo?.name || repoParam)}${path ? `&path=${encPath(path)}` : ""}`;
const pathFromUrl = () => normPath(new URLSearchParams(location.search).get("path"));

boot();

async function boot() {
  app.setAttribute("aria-busy", "true");
  if (!app.querySelector(".is-loading")) app.innerHTML = skeletonHTML();
  if (!repoParam) {
    return showError({
      title: "Репозиторий не выбран",
      message: "В ссылке нет имени репозитория. Выбери проект из списка.",
      retry: false,
    });
  }
  try {
    repo = await getRepo(repoParam);
  } catch (err) {
    return showError(errorInfo(err));
  }
  branch = repo.defaultBranch || "main";
  document.title = `${repo.name} — ${SITE.nick}`;
  if (repo.private) return showLocked();

  // библиотеки понадобятся почти наверняка — грузим параллельно с деревом
  for (const k of Object.keys(LIBS)) loadLib(k).catch(() => {});

  let tree;
  try {
    tree = await getTree(repo.name, branch);
  } catch (err) {
    if (err.code === "forbidden" && repo.private) return showLocked();
    if (/\b409\b/.test(err.message) || repo.size === 0 && err.code === "not_found") return showEmptyRepo();
    return showError(errorInfo(err));
  }
  indexTree(tree);
  renderShell();
  go(pathFromUrl(), { push: false });
  app.setAttribute("aria-busy", "false");
}

function indexTree(items) {
  byPath = new Map();
  kids = new Map([["", []]]);
  fileCount = 0;
  const add = (it) => {
    if (byPath.has(it.path)) return;
    byPath.set(it.path, it);
    if (it.type === "tree" && !kids.has(it.path)) kids.set(it.path, []);
  };
  for (const it of items) add(it);
  for (const it of items) {
    // родительские папки, которых вдруг нет в списке
    for (let p = dirname(it.path); p && !byPath.has(p); p = dirname(p)) add({ path: p, type: "tree", size: 0 });
  }
  for (const it of byPath.values()) {
    const parent = dirname(it.path);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(it);
    if (it.type === "blob") fileCount++;
  }
  const cmp = (a, b) => (a.type === b.type ? 0 : a.type === "tree" ? -1 : 1) || collator.compare(basename(a.path), basename(b.path));
  for (const list of kids.values()) list.sort(cmp);
}

/* ---------- Ошибки и особые состояния ---------- */
function errorInfo(err) {
  switch (err?.code) {
    case "not_found":
      return { title: "Репозиторий не найден", message: `Проекта «${repoParam}» нет у ${SITE.github.user} на GitHub — возможно, его переименовали или удалили.` };
    case "rate_limited":
      return { title: "GitHub просит подождать", message: err.message };
    case "network":
      return { title: "Нет связи с GitHub", message: "Проверь интернет и попробуй ещё раз." };
    default:
      return { title: "Не удалось загрузить репозиторий", message: err?.message || "Что-то пошло не так" };
  }
}

function showError({ title, message, retry = true }) {
  app.setAttribute("aria-busy", "false");
  app.innerHTML = `
    <div class="state-panel glass" role="alert">
      <div class="state-icon" aria-hidden="true">!</div>
      <h1 class="state-title">${esc(title)}</h1>
      <p class="muted">${esc(message)}</p>
      <div class="state-actions">
        ${retry ? `<button class="btn btn-primary btn-sm" type="button" data-retry>Повторить</button>` : ""}
        <a class="btn btn-ghost btn-sm" href="repos.html">← Все проекты</a>
      </div>
    </div>`;
  $("[data-retry]", app)?.addEventListener("click", () => {
    app.innerHTML = skeletonHTML();
    boot();
  });
}

function showLocked() {
  app.setAttribute("aria-busy", "false");
  const r = repo;
  app.innerHTML = `
    <div class="lock-screen glass">
      <div class="lock-art" aria-hidden="true">${I.lock}</div>
      <p class="lock-kicker">private</p>
      <h1 class="repo-name">${nameHTML(r.name)}</h1>
      ${r.description ? `<p class="repo-desc">${esc(r.description)}</p>` : ""}
      <div class="repo-badges">${langBadge(r)}<span class="badge warn">Закрытый</span></div>
      ${r.updatedAt ? `<p class="lock-meta">${I.clock}Обновлён ${updatedHTML(r)}</p>` : ""}
      <div class="lock-msg">
        <strong>Закрытый репозиторий — код недоступен</strong>
        <span>Проект приватный: описание видно всем, а исходники — только автору.</span>
      </div>
      <a class="btn btn-primary btn-sm magnetic" href="repos.html">← Все проекты</a>
    </div>`;
  initMagnetic(app);
}

function showEmptyRepo() {
  app.setAttribute("aria-busy", "false");
  app.innerHTML = `${headHTML(repo, false)}
    <div class="empty"><span class="empty-icon" aria-hidden="true">📭</span><p>В репозитории пока нет ни одного файла.</p></div>`;
  initMagnetic(app);
}

function skeletonHTML() {
  return `
    <div class="repo-head glass is-loading" aria-hidden="true">
      <div class="skeleton sk-title"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div>
    </div>
    <div class="browser" aria-hidden="true">
      <div class="tree-panel glass"><div class="skeleton sk-tree"></div></div>
      <div class="content-panel glass"><div class="skeleton sk-code"></div></div>
    </div>
    <p class="sr-only" role="status">Загружаю репозиторий…</p>`;
}

/* ---------- Шапка репозитория ---------- */
function langBadge(r) {
  if (!r.language) return "";
  const color = LANG_COLORS[r.language] || "var(--faint)";
  return `<span class="badge plain lang-badge"><i class="lang-dot" style="--c:${color}" aria-hidden="true"></i>${esc(r.language)}</span>`;
}
function updatedHTML(r) {
  const d = r.pushedAt || r.updatedAt;
  return `<time datetime="${esc(d)}" title="${esc(formatDate(d))}">${esc(timeAgo(d))}</time>`;
}
/** Имя с мягкими переносами после _ - . — чтобы длинные имена красиво ломались на телефоне. */
const nameHTML = (name) => esc(name).replace(/([_.-])/g, "$1<wbr>");
const safeHttp = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

function headHTML(r, withZip = true) {
  const ghUrl = /^https:\/\/github\.com\//i.test(r.htmlUrl || "") ? r.htmlUrl : `${SITE.github.url}/${encodeURIComponent(r.name)}`;
  const home = safeHttp(r.homepage);
  const topics = (r.topics || []).slice(0, 8);
  return `
  <header class="repo-head glass">
    <div class="repo-head-main">
      <p class="repo-owner">${esc(SITE.github.user)} /</p>
      <h1 class="repo-name">${nameHTML(r.name)}</h1>
      ${r.description ? `<p class="repo-desc">${esc(r.description)}</p>` : `<p class="repo-desc faint">Без описания</p>`}
      <div class="repo-badges">
        ${langBadge(r)}
        ${r.private ? `<span class="badge warn">Закрытый</span>` : `<span class="badge lime">Открытый</span>`}
        ${r.fork ? `<span class="badge info">Форк</span>` : ""}
        ${r.archived ? `<span class="badge warn">Архив</span>` : ""}
      </div>
      ${topics.length ? `<ul class="repo-topics" aria-label="Темы">${topics.map((t) => `<li>#${esc(t)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="repo-head-side">
      <ul class="repo-stats">
        <li title="Звёзды">${I.star}<b>${esc(r.stars)}</b> <span>${plural(r.stars, ["звезда", "звезды", "звёзд"])}</span></li>
        <li title="Форки">${I.fork}<b>${esc(r.forks)}</b> <span>${plural(r.forks, ["форк", "форка", "форков"])}</span></li>
        <li title="Основная ветка">${I.branch}<code>${esc(r.defaultBranch)}</code></li>
        <li>${I.clock}<span>обновлён ${updatedHTML(r)}</span></li>
      </ul>
      <div class="repo-actions">
        ${withZip ? `<a class="btn btn-primary btn-sm magnetic" href="${esc(repoZipUrl(r.name, branch))}" rel="noopener">${I.zip}<span>Скачать ZIP</span></a>` : ""}
        <a class="btn btn-ghost btn-sm magnetic" href="${esc(ghUrl)}" target="_blank" rel="noopener">${I.github}<span>Открыть на GitHub</span></a>
        ${home ? `<a class="btn btn-ghost btn-sm" href="${esc(home)}" target="_blank" rel="noopener">${I.link}<span>Сайт</span></a>` : ""}
      </div>
    </div>
  </header>`;
}

/* ---------- Каркас браузера ---------- */
function renderShell() {
  app.innerHTML = `${headHTML(repo)}
  <div class="browser" id="browser">
    <div class="drawer-backdrop" data-close-drawer hidden></div>
    <aside class="tree-panel glass" id="treePanel" aria-label="Файлы репозитория">
      <div class="tree-top">
        <div class="tree-title">
          <span class="tree-label">Файлы</span>
          <span class="tree-count">${fileCount} ${plural(fileCount, ["файл", "файла", "файлов"])}</span>
          <button class="drawer-close" type="button" data-close-drawer aria-label="Закрыть список файлов">✕</button>
        </div>
        <label class="tree-filter">
          ${I.search}
          <span class="sr-only">Фильтр файлов по пути</span>
          <input id="treeFilter" type="search" placeholder="Фильтр по пути…" autocomplete="off" spellcheck="false" aria-controls="tree">
        </label>
      </div>
      <div class="tree" id="tree" role="tree" aria-label="Дерево файлов ${esc(repo.name)}"></div>
      <p class="tree-empty" hidden>Ничего не найдено</p>
    </aside>
    <div class="content-panel glass" id="contentPanel">
      <div class="content-top">
        <button class="btn btn-ghost btn-xs tree-toggle" type="button" aria-controls="treePanel" aria-expanded="false">${I.files}<span>Файлы</span></button>
        <nav class="crumbs" aria-label="Путь к файлу"><ol id="crumbs"></ol></nav>
      </div>
      <div class="view" id="view" aria-live="polite"></div>
    </div>
  </div>`;

  Object.assign(els, {
    browser: $("#browser"),
    tree: $("#tree"),
    treePanel: $("#treePanel"),
    treeEmpty: $(".tree-empty"),
    filter: $("#treeFilter"),
    content: $("#contentPanel"),
    crumbs: $("#crumbs"),
    view: $("#view"),
    toggle: $(".tree-toggle"),
    backdrop: $(".drawer-backdrop"),
  });
  bindTree();
  bindContent();
  bindDrawer();
  initMagnetic(app);
}

/* ---------- Дерево ---------- */
function visibleRows() {
  const q = filterQ.toLowerCase();
  let allowed = null;
  if (q) {
    allowed = new Set();
    for (const it of byPath.values()) {
      if (!it.path.toLowerCase().includes(q)) continue;
      for (let p = it.path; p && !allowed.has(p); p = dirname(p)) allowed.add(p);
    }
  }
  const rows = [];
  const walk = (dir, level) => {
    for (const it of kids.get(dir) || []) {
      if (allowed && !allowed.has(it.path)) continue;
      const open = it.type === "tree" && (allowed ? true : expanded.has(it.path));
      rows.push({ it, level, open });
      if (open) walk(it.path, level + 1);
    }
  };
  walk("", 1);
  return rows;
}

function markMatch(text) {
  if (!filterQ) return esc(text);
  const i = text.toLowerCase().indexOf(filterQ.toLowerCase());
  if (i < 0) return esc(text);
  const j = i + filterQ.length;
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, j))}</mark>${esc(text.slice(j))}`;
}

function rowHTML({ it, level, open }) {
  const isDir = it.type === "tree";
  const cur = it.path === current;
  return `<a class="tree-row${cur ? " is-current" : ""}" role="treeitem" href="${esc(hrefFor(it.path))}" data-path="${esc(it.path)}"`
    + ` aria-level="${level}"${isDir ? ` aria-expanded="${open}"` : ""} aria-selected="${cur}"${cur ? ' aria-current="page"' : ""}`
    + ` tabindex="${it.path === focusPath ? 0 : -1}" style="--lvl:${level - 1}" title="${esc(it.path)}">`
    + `<span class="tw-chev" data-chev aria-hidden="true">${isDir ? CHEV : ""}</span>${iconFor(it, open)}`
    + `<span class="tw-name">${markMatch(basename(it.path))}</span></a>`;
}

function renderTree() {
  const rows = visibleRows();
  const hadFocus = els.tree.contains(document.activeElement);
  if (!rows.some((r) => r.it.path === focusPath)) {
    focusPath = (rows.find((r) => r.it.path === current) || rows[0])?.it.path ?? null;
  }
  els.tree.innerHTML = rows.map(rowHTML).join("");
  els.treeEmpty.hidden = rows.length > 0;
  if (hadFocus) focusRow(focusPath);
}

const rowEl = (path) => $$(".tree-row", els.tree).find((r) => r.dataset.path === path);

function focusRow(path, scroll = true) {
  const row = path != null && rowEl(path);
  if (!row) return;
  for (const r of $$('.tree-row[tabindex="0"]', els.tree)) r.tabIndex = -1;
  row.tabIndex = 0;
  focusPath = path;
  row.focus({ preventScroll: true });
  if (scroll) scrollRowIntoView(row);
}

function scrollRowIntoView(row) {
  if (!row) return;
  const c = els.tree;
  const rr = row.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  if (rr.top < cr.top) c.scrollTop -= cr.top - rr.top + 8;
  else if (rr.bottom > cr.bottom) c.scrollTop += rr.bottom - cr.bottom + 8;
}

function toggleDir(path, open) {
  if (filterQ) return; // в режиме фильтра все папки раскрыты
  if (open) expanded.add(path);
  else expanded.delete(path);
  focusPath = path;
  renderTree();
  focusRow(path);
}

const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function bindTree() {
  els.tree.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row || !plainClick(e)) return;
    e.preventDefault();
    const path = row.dataset.path;
    const isDir = row.hasAttribute("aria-expanded");
    const open = row.getAttribute("aria-expanded") === "true";
    focusPath = path;
    if (isDir && (e.target.closest("[data-chev]") || (open && current === path))) {
      toggleDir(path, !open);
      return;
    }
    go(path, { from: "tree" });
  });

  els.tree.addEventListener("keydown", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    const rows = $$(".tree-row", els.tree);
    const i = rows.indexOf(row);
    const path = row.dataset.path;
    const isDir = row.hasAttribute("aria-expanded");
    const open = row.getAttribute("aria-expanded") === "true";
    const level = Number(row.getAttribute("aria-level"));
    let next = null;
    switch (e.key) {
      case "ArrowDown": next = rows[i + 1]; break;
      case "ArrowUp": next = rows[i - 1]; break;
      case "Home": next = rows[0]; break;
      case "End": next = rows.at(-1); break;
      case "ArrowRight":
        if (isDir && !open) toggleDir(path, true);
        else if (isDir && Number(rows[i + 1]?.getAttribute("aria-level")) > level) next = rows[i + 1];
        break;
      case "ArrowLeft":
        if (isDir && open && !filterQ) toggleDir(path, false);
        else next = rowEl(dirname(path)) || null;
        break;
      case " ":
        if (isDir) toggleDir(path, !open);
        else go(path, { from: "tree" });
        break;
      case "Escape":
        if (filterQ) { els.filter.focus(); return; }
        return;
      case "Enter": // ссылка сама вызовет click
      default:
        return;
    }
    e.preventDefault();
    if (next) focusRow(next.dataset.path);
  });

  els.tree.addEventListener("focusin", (e) => {
    const row = e.target.closest(".tree-row");
    if (row) focusPath = row.dataset.path;
  });

  let t;
  els.filter.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      filterQ = els.filter.value.trim();
      focusPath = null;
      renderTree();
      els.tree.scrollTop = 0;
    }, 90);
  });
  els.filter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = $(".tree-row", els.tree);
      if (first) focusRow(first.dataset.path);
    } else if (e.key === "Escape" && els.filter.value) {
      e.preventDefault();
      e.stopPropagation();
      els.filter.value = "";
      filterQ = "";
      renderTree();
      scrollRowIntoView(rowEl(current));
    }
  });
}

/* ---------- Навигация ---------- */
function go(path, { push = true, from = "" } = {}) {
  path = normPath(path);
  const item = path ? byPath.get(path) : ROOT;
  current = path;
  for (let p = dirname(path); p; p = dirname(p)) expanded.add(p);
  if (item?.type === "tree" && path) expanded.add(path);
  if (path) focusPath = path;

  const url = hrefFor(path);
  if (push) history.pushState({ path }, "", url);
  else history.replaceState({ path }, "", url);
  document.title = `${path ? `${basename(path)} · ` : ""}${repo.name} — ${SITE.nick}`;

  renderTree();
  scrollRowIntoView(rowEl(path));
  renderCrumbs();
  renderView(item, path);

  if (from === "tree" && isDrawer() && item?.type !== "tree") closeDrawer(false);
  if (from) {
    const top = els.content.getBoundingClientRect().top;
    if (top < 0) window.scrollTo({ top: scrollY + top - 84, behavior: motion ? "smooth" : "auto" });
  }
  if (from === "content" || (from === "tree" && isDrawer() && item?.type !== "tree")) {
    $(".view-title", els.view)?.focus({ preventScroll: true });
  }
}

addEventListener("popstate", () => {
  if (!repo || !els.view) return;
  const name = new URLSearchParams(location.search).get("name") || "";
  if (name.toLowerCase() !== repo.name.toLowerCase()) { location.reload(); return; }
  go(pathFromUrl(), { push: false });
});

function renderCrumbs() {
  const parts = current ? current.split("/") : [];
  const items = [
    parts.length
      ? `<li><a href="${esc(hrefFor(""))}" data-nav="">${esc(repo.name)}</a></li>`
      : `<li><span aria-current="page">${esc(repo.name)}</span></li>`,
  ];
  let acc = "";
  parts.forEach((p, i) => {
    acc = acc ? `${acc}/${p}` : p;
    items.push(i === parts.length - 1
      ? `<li><span aria-current="page">${esc(p)}</span></li>`
      : `<li><a href="${esc(hrefFor(acc))}" data-nav="${esc(acc)}">${esc(p)}</a></li>`);
  });
  els.crumbs.innerHTML = items.join("");
}

function bindContent() {
  els.content.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-nav]");
    if (!a || !plainClick(e)) return;
    e.preventDefault();
    go(a.dataset.nav, { from: "content" });
  });
}

/* ---------- Выдвижная панель на телефонах ---------- */
const isDrawer = () => drawerMQ.matches;
function openDrawer() {
  els.browser.classList.add("drawer-open");
  document.documentElement.classList.add("repo-drawer-lock");
  els.toggle.setAttribute("aria-expanded", "true");
  els.backdrop.hidden = false;
  requestAnimationFrame(() => {
    const row = rowEl(current);
    if (row) focusRow(current);
    else els.filter.focus();
  });
}
function closeDrawer(returnFocus = true) {
  if (!els.browser.classList.contains("drawer-open")) return;
  els.browser.classList.remove("drawer-open");
  document.documentElement.classList.remove("repo-drawer-lock");
  els.toggle.setAttribute("aria-expanded", "false");
  els.backdrop.hidden = true;
  if (returnFocus) els.toggle.focus();
}
function bindDrawer() {
  els.toggle.addEventListener("click", () => (els.browser.classList.contains("drawer-open") ? closeDrawer() : openDrawer()));
  for (const b of $$("[data-close-drawer]", els.browser)) b.addEventListener("click", () => closeDrawer());
  els.treePanel.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDrawer() && !e.defaultPrevented) closeDrawer();
  });
  drawerMQ.addEventListener("change", () => { if (!isDrawer()) closeDrawer(false); });
}

/* ---------- Правая панель ---------- */
function renderView(item, path) {
  const token = ++viewToken;
  const alive = () => token === viewToken;
  if (!item) {
    els.view.innerHTML = `
      <div class="state-inline">
        <h2 class="view-title" tabindex="-1">Такого пути нет</h2>
        <p class="muted">В репозитории нет файла или папки <code>${esc(path)}</code>.</p>
        <a class="btn btn-ghost btn-sm" href="${esc(hrefFor(""))}" data-nav="">К корню репозитория</a>
      </div>`;
    return;
  }
  if (item.type === "tree") renderDir(path, alive);
  else renderFile(item, alive);
}

function inlineErrorHTML(err, what = "файл") {
  const msg = err?.code === "rate_limited" ? err.message
    : err?.code === "network" ? "Нет связи с GitHub."
    : err?.code === "not_found" ? "GitHub не нашёл этот файл."
    : err?.message || "Что-то пошло не так.";
  return `<div class="state-inline error" role="alert">
    <p><strong>Не удалось загрузить ${esc(what)}.</strong> <span class="muted">${esc(msg)}</span></p>
    <button class="btn btn-ghost btn-xs" type="button" data-retry-view>Повторить</button>
  </div>`;
}
function bindRetry(scope) {
  $("[data-retry-view]", scope)?.addEventListener("click", () => renderView(current ? byPath.get(current) : ROOT, current));
}

/* ----- Папка ----- */
async function renderDir(path, alive) {
  const list = kids.get(path) || [];
  const nDirs = list.filter((it) => it.type === "tree").length;
  const nFiles = list.length - nDirs;
  const counts = [
    nDirs ? `${nDirs} ${plural(nDirs, ["папка", "папки", "папок"])}` : "",
    nFiles ? `${nFiles} ${plural(nFiles, ["файл", "файла", "файлов"])}` : "",
  ].filter(Boolean).join(" · ") || "пусто";
  const up = path
    ? `<tr class="row-up"><td colspan="2"><a href="${esc(hrefFor(dirname(path)))}" data-nav="${esc(dirname(path))}" aria-label="На уровень выше">${I.up}<span>..</span></a></td></tr>`
    : "";
  const rows = list.map((it) => `<tr>
      <td><a href="${esc(hrefFor(it.path))}" data-nav="${esc(it.path)}">${iconFor(it)}<span class="name">${esc(basename(it.path))}</span></a></td>
      <td class="num">${it.type === "blob" ? esc(formatBytes(it.size)) : '<span class="faint">—</span>'}</td>
    </tr>`).join("");
  els.view.innerHTML = `
    <div class="view-head">
      <h2 class="view-title" tabindex="-1">${FOLDER_OPEN}<span>${esc(path ? basename(path) : repo.name)}</span></h2>
      <span class="view-meta">${esc(counts)}</span>
    </div>
    ${list.length || path ? `<div class="listing-wrap"><table class="listing">
      <thead><tr><th scope="col">Имя</th><th scope="col" class="num">Размер</th></tr></thead>
      <tbody>${up}${rows}</tbody>
    </table></div>` : `<div class="empty">Папка пуста</div>`}
    <div class="readme-slot"></div>`;

  const readmeItem = list.find((it) => it.type === "blob" && README_RE.test(basename(it.path)));
  if (!readmeItem) return;
  const slot = $(".readme-slot", els.view);
  slot.innerHTML = `<article class="readme" aria-label="README">
      <header class="readme-head">${I.book}<span>${esc(basename(readmeItem.path))}</span></header>
      <div class="readme-body"><div class="skeleton sk-readme"></div></div>
    </article>`;
  const body = $(".readme-body", slot);
  if (readmeItem.size > MAX_VIEW_BYTES) {
    body.innerHTML = `<p class="muted">README слишком большой для просмотра (${esc(formatBytes(readmeItem.size))}).</p>`;
    return;
  }
  try {
    let text;
    let rpath = readmeItem.path;
    if (!path) {
      const r = await getReadme(repo.name, branch);
      if (!r) { slot.innerHTML = ""; return; }
      ({ text } = r);
      rpath = r.path;
    } else {
      text = await getFileText(repo.name, branch, rpath);
    }
    if (!alive()) return;
    if (/\.txt$/i.test(rpath)) {
      const pre = document.createElement("pre");
      pre.className = "plain-text";
      pre.textContent = text;
      body.replaceChildren(pre);
    } else {
      await renderMarkdownInto(body, text, dirname(rpath), alive);
    }
  } catch (err) {
    if (!alive()) return;
    body.innerHTML = inlineErrorHTML(err, "README");
    bindRetry(body);
  }
}

/* ----- Файл ----- */
function fileKind(item) {
  const name = basename(item.path);
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return item.size > 15 * 1024 * 1024 ? "big" : "image";
  if (BINARY_EXT.has(ext)) return "binary";
  if (item.size > MAX_VIEW_BYTES) return "big";
  return isMarkdown(name) ? "markdown" : "text";
}

function binCardHTML(item, kind) {
  const name = basename(item.path);
  const title = kind === "big" ? "Файл слишком большой для просмотра" : "Бинарный файл — показать нельзя";
  const note = kind === "big" ? `Просмотр доступен для файлов до ${formatBytes(MAX_VIEW_BYTES)}.` : "Это не текст, его можно только скачать.";
  return `<div class="bin-card">
    <div class="bin-icon">${iconFor(item)}</div>
    <p class="bin-title">${esc(title)}</p>
    <p class="muted"><code>${esc(name)}</code> · ${esc(formatBytes(item.size))}</p>
    <p class="faint">${esc(note)}</p>
    <a class="btn btn-primary btn-sm" href="${esc(rawUrl(repo.name, branch, item.path))}" target="_blank" rel="noopener" download="${esc(name)}">${I.zip}<span>Скачать raw</span></a>
  </div>`;
}

const looksBinary = (text) => text.slice(0, 8000).includes("\u0000");

async function renderFile(item, alive) {
  const name = basename(item.path);
  const kind = fileKind(item);
  const raw = rawUrl(repo.name, branch, item.path);
  const textual = kind === "text" || kind === "markdown";
  els.view.innerHTML = `
    <div class="file-head">
      <div class="file-id">
        <h2 class="view-title" tabindex="-1">${iconFor(item)}<span>${esc(name)}</span></h2>
        <span class="view-meta" data-meta>${esc(formatBytes(item.size))}</span>
      </div>
      <div class="file-actions">
        ${kind === "markdown" ? `<div class="seg" role="group" aria-label="Режим просмотра">
          <button type="button" data-mode="preview" aria-pressed="true">Превью</button>
          <button type="button" data-mode="code" aria-pressed="false">Код</button>
        </div>` : ""}
        ${textual ? `<button class="btn btn-ghost btn-xs" type="button" data-copy disabled>${I.copy}<span>Копировать</span></button>` : ""}
        <a class="btn btn-ghost btn-xs" href="${esc(raw)}" target="_blank" rel="noopener">${I.raw}<span>Raw</span></a>
      </div>
    </div>
    <div class="file-body" data-body>${textual ? '<div class="skeleton sk-code"></div>' : ""}</div>`;
  const body = $("[data-body]", els.view);

  if (kind === "image") {
    body.innerHTML = `<figure class="img-preview"><img src="${esc(raw)}" alt="${esc(name)}" decoding="async"><figcaption class="faint"></figcaption></figure>`;
    const img = $("img", body);
    img.addEventListener("load", () => {
      if (img.naturalWidth) $("figcaption", body).textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    });
    img.addEventListener("error", () => { if (alive()) body.innerHTML = binCardHTML(item, "binary"); });
    return;
  }
  if (!textual) {
    body.innerHTML = binCardHTML(item, kind);
    return;
  }

  let text;
  try {
    text = await getFileText(repo.name, branch, item.path);
  } catch (err) {
    if (!alive()) return;
    body.innerHTML = inlineErrorHTML(err);
    bindRetry(body);
    return;
  }
  if (!alive()) return;
  if (looksBinary(text)) {
    body.innerHTML = binCardHTML(item, "binary");
    $("[data-copy]", els.view)?.remove();
    return;
  }

  const display = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const lines = display ? display.split("\n").length : 0;
  $("[data-meta]", els.view).textContent = `${formatBytes(item.size)} · ${lines} ${plural(lines, ["строка", "строки", "строк"])}`;
  setupCopy($("[data-copy]", els.view), text);

  if (kind === "markdown") {
    const preview = document.createElement("div");
    const code = document.createElement("div");
    code.hidden = true;
    body.replaceChildren(preview, code);
    preview.innerHTML = '<div class="skeleton sk-readme"></div>';
    let codeDone = false;
    for (const b of $$("[data-mode]", els.view)) {
      b.addEventListener("click", async () => {
        const mode = b.dataset.mode;
        for (const x of $$("[data-mode]", els.view)) x.setAttribute("aria-pressed", String(x === b));
        preview.hidden = mode !== "preview";
        code.hidden = mode !== "code";
        if (mode === "code" && !codeDone) {
          codeDone = true;
          await renderCodeInto(code, display, name, alive);
        }
      });
    }
    await renderMarkdownInto(preview, text, dirname(item.path), alive);
    return;
  }
  await renderCodeInto(body, display, name, alive);
}

function setupCopy(btn, text) {
  if (!btn) return;
  btn.disabled = false;
  let timer;
  btn.addEventListener("click", async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    const label = $("span", btn);
    btn.classList.toggle("is-copied", ok);
    btn.classList.toggle("is-failed", !ok);
    btn.querySelector("svg").outerHTML = ok ? I.check : I.copy;
    label.textContent = ok ? "Скопировано" : "Не вышло";
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove("is-copied", "is-failed");
      btn.querySelector("svg").outerHTML = I.copy;
      label.textContent = "Копировать";
    }, 1800);
  });
}

function langFor(name, hljs) {
  if (!hljs) return null;
  const lower = name.toLowerCase();
  const byName = NAME_LANG[lower];
  if (byName) return hljs.getLanguage(byName) ? byName : null;
  const ext = lower.startsWith(".") && !lower.slice(1).includes(".") ? lower.slice(1) : extOf(lower);
  if (!ext) return null;
  const lang = EXT_LANG[ext] || ext;
  return hljs.getLanguage(lang) ? lang : null;
}

async function renderCodeInto(container, display, name, alive) {
  if (!display) {
    container.innerHTML = `<div class="empty">Пустой файл</div>`;
    return;
  }
  const hljs = await loadLib("hljs").catch(() => null);
  if (!alive()) return;
  const lang = display.length <= MAX_HIGHLIGHT_CHARS ? langFor(name, hljs) : null;
  let html = null;
  if (lang) {
    try { html = hljs.highlight(display, { language: lang, ignoreIllegals: true }).value; } catch { html = null; }
  }
  html ??= esc(display);
  const n = display.split("\n").length;
  let gutter = "";
  for (let i = 1; i <= n; i++) gutter += i === n ? i : `${i}\n`;
  container.innerHTML = `<div class="code-view" style="--gw:${String(n).length}ch">
      <pre class="gutter" aria-hidden="true">${gutter}</pre>
      <pre class="code" tabindex="0" aria-label="Код файла ${esc(name)}"><code class="hljs">${html}</code></pre>
    </div>
    ${lang ? "" : `<p class="code-note faint">${display.length > MAX_HIGHLIGHT_CHARS ? "Файл большой — показан без подсветки." : "Подсветка для этого типа файлов не поддерживается."}</p>`}`;
}

/* ----- Markdown ----- */
async function renderMarkdownInto(target, text, baseDir, alive) {
  let marked;
  let purify;
  try {
    [marked, purify] = await Promise.all([loadLib("marked"), loadLib("purify")]);
  } catch {
    if (!alive()) return;
    target.innerHTML = `<p class="faint md-fallback">Не удалось загрузить отрисовку Markdown — показываю текст как есть.</p><pre class="plain-text"></pre>`;
    $("pre", target).textContent = text;
    return;
  }
  if (!alive()) return;
  const html = marked.parse(text, { gfm: true, async: false });
  const frag = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
  fixMarkdownUrls(frag, baseDir);
  const wrap = document.createElement("div");
  wrap.className = "md-body";
  wrap.append(frag);
  target.replaceChildren(wrap);

  const blocks = $$("pre > code", wrap);
  if (!blocks.length) return;
  const hljs = await loadLib("hljs").catch(() => null);
  if (!hljs || !alive()) return;
  for (const code of blocks) {
    const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1];
    if (!lang || !hljs.getLanguage(lang)) continue;
    try {
      code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value; // hljs экранирует
      code.classList.add("hljs");
    } catch { /* оставляем как есть */ }
  }
}

/** Ссылки на файлы этого же репозитория на GitHub → путь внутри репозитория. */
function sameRepoPath(url) {
  const prefix = `https://github.com/${SITE.github.user}/${repo.name}/`.toLowerCase();
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const m = /^(blob|tree|raw)\/[^/]+\/?(.*)$/.exec(url.slice(prefix.length).split(/[?#]/)[0]);
  return m ? resolvePath("", m[2]) : null;
}

function fixMarkdownUrls(frag, baseDir) {
  const toRaw = (u) => {
    if (isRelativeUrl(u)) {
      const p = resolvePath(baseDir, u.split(/[?#]/)[0]);
      return p ? rawUrl(repo.name, branch, p) : null;
    }
    const p = sameRepoPath(u);
    return p ? rawUrl(repo.name, branch, p) : u;
  };
  for (const img of frag.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src) {
      const next = toRaw(src);
      if (next) img.setAttribute("src", next);
      else img.removeAttribute("src");
    }
    img.removeAttribute("srcset");
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
  }
  for (const source of frag.querySelectorAll("source[srcset]")) {
    const set = source.getAttribute("srcset").split(",").map((part) => {
      const [u, ...rest] = part.trim().split(/\s+/);
      const next = toRaw(u);
      return next ? [next, ...rest].join(" ") : "";
    }).filter(Boolean).join(", ");
    source.setAttribute("srcset", set);
  }
  for (const a of frag.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) continue;
    const inRepo = isRelativeUrl(href) ? resolvePath(baseDir, href.split(/[?#]/)[0]) : sameRepoPath(href);
    if (inRepo !== null && (inRepo === "" || byPath.has(inRepo))) {
      a.setAttribute("href", hrefFor(inRepo));
      a.dataset.nav = inRepo;
      a.removeAttribute("target");
      continue;
    }
    if (isRelativeUrl(href)) {
      a.setAttribute("href", `${repo.htmlUrl || `${SITE.github.url}/${repo.name}`}/blob/${encodeURIComponent(branch)}/${encPath(inRepo || "")}`);
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
}

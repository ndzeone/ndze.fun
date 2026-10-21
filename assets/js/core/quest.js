// Пасхалка «Найди 5 пауков»: на пяти страницах прячется крошечный пиксельный паук (только для вошедших).
// Поймал всех пятерых — +300 баллов и значок «Паучье чутьё» (считает сервер, api/lib/features/community.php).
//
//   import("./quest.js").then((m) => m.initQuest(pageId));   // из mountLayout, на каждой странице
import { api, apiCall } from "../data/api.js";
import { getUser, onUserChange } from "./layout.js";
import { toast } from "./util.js";
import { ensureCss } from "../modules.js";

export const QUEST_EGGS = ["home", "projects", "forum", "review", "404"];
export const QUEST_HINTS = {
  home: "Один паук греется на главной — там, где всё начинается.",
  projects: "Ещё один разглядывает проекты ndze.",
  forum: "Кто-то подслушивает разговоры на форуме.",
  review: "Самый строгий паук сидит там, где оценивают работы.",
  404: "Один паук прячется там, где нет страницы.",
};
const TTL = 60_000;
const cacheKey = (uid) => `ndze:quest:${uid}`;

// пиксельный паук 12×12: тело, «песочные часы» на спине, глаза-огоньки, по 4 лапки с каждой стороны
const LEGS = [[3, 4], [2, 3], [1, 2], [1, 1], [3, 6], [2, 5], [1, 5], [0, 6], [3, 7], [2, 7], [1, 8], [1, 9], [3, 8], [2, 9], [2, 10], [2, 11]];
const SPIDER_SVG = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  <g fill="#0b0b0b" stroke="none">
    ${LEGS.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/><rect x="${11 - x}" y="${y}" width="1" height="1"/>`).join("")}
    <rect x="5" y="2" width="2" height="3"/><rect x="4" y="5" width="4" height="5"/><rect x="5" y="10" width="2" height="1"/>
  </g>
  <rect x="5" y="6" width="2" height="1" fill="#ff3b4a"/><rect x="5" y="8" width="2" height="1" fill="#ff3b4a"/><rect x="5" y="7" width="2" height="1" fill="#9e1d29"/>
  <rect x="5" y="3" width="1" height="1" fill="#5dd62c"/><rect x="6" y="3" width="1" height="1" fill="#5dd62c"/>
</svg>`;

let spider = null;
let started = false;

function readCache(uid) {
  try {
    const c = JSON.parse(sessionStorage.getItem(cacheKey(uid)) || "null");
    return c && Date.now() - c.at < TTL && Array.isArray(c.found) ? c.found : null;
  } catch {
    return null;
  }
}
function writeCache(uid, found) {
  try { sessionStorage.setItem(cacheKey(uid), JSON.stringify({ at: Date.now(), found })); } catch { /* приватный режим */ }
}

/** Найденные пауки пользователя (из кэша на 60 с или с сервера); null — не удалось узнать. */
export async function questFound(uid) {
  const cached = readCache(uid);
  if (cached) return cached;
  try {
    const r = await apiCall("quest");
    writeCache(uid, r.found);
    return r.found;
  } catch {
    return null;
  }
}

function remove() {
  spider?.remove();
  spider = null;
}

function place(pageId, uid) {
  remove();
  ensureCss("community.css");
  const el = document.createElement("button");
  el.type = "button";
  el.className = `cm-spider cm-spider--${pageId}`;
  el.setAttribute("aria-label", "Паук! Поймай его");
  el.title = "Кажется, тут кто-то есть…";
  el.innerHTML = `<span class="cm-spider-thread" aria-hidden="true"></span><span class="cm-spider-body">${SPIDER_SVG}</span>`;
  el.addEventListener("click", () => catchSpider(el, pageId, uid));
  document.body.append(el);
  spider = el;
}

async function catchSpider(el, egg, uid) {
  if (el.classList.contains("is-caught")) return;
  el.classList.add("is-caught"); // паук убегает вверх по паутине
  el.disabled = true;
  try {
    const r = await apiCall("quest/find", { method: "POST", body: { egg } });
    writeCache(uid, r.found);
    if (r.reward) toast(`Все ${r.total} пауков пойманы! +${r.reward} баллов и значок «Паучье чутьё» 🕷`, "ok", 7000);
    else if (r.done) toast(`Паук пойман! ${r.count}/${r.total} — ты нашёл всех 🕷`);
    else toast(`Паук пойман! ${r.count}/${r.total} 🕷`);
    setTimeout(() => { if (spider === el) remove(); }, 900);
  } catch (err) {
    toast(err.message || "Паук вырвался — попробуй ещё раз", "error");
    el.classList.remove("is-caught");
    el.disabled = false;
  }
}

/** Спрятать паука на странице pageId (если он ещё не пойман). Вызывать один раз после mountLayout. */
export function initQuest(pageId) {
  if (started || !QUEST_EGGS.includes(pageId) || api.mode !== "php") return;
  started = true;
  let run = 0;
  const show = async (user) => {
    const my = ++run;
    remove();
    if (!user) return;
    const found = await questFound(user.id);
    if (my !== run || !found || found.includes(pageId) || getUser()?.id !== user.id) return;
    place(pageId, user.id);
  };
  show(getUser());
  onUserChange(show);
}

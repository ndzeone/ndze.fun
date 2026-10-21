// Реестр модулей фич: страницы-хосты (play, stream, profile, home, header, overlay) подгружают их лениво.
// Модуль — ES-модуль с функцией:
//   export function mount(container, ctx) { …; return { destroy() {} } }
//   ctx: { user (User|null), isAdmin, key (ключ оверлея — только для overlay), params (URLSearchParams оверлея) }
// Путь — относительно assets/js/. Нет файла — хост просто пропускает модуль (или показывает «скоро»).
export const MODULES = {
  // вкладки страницы «Движ» (play.html)
  play: [
    { id: "polls", label: "Опросы", icon: "📊", src: "play/polls.js" },
    { id: "giveaways", label: "Розыгрыши", icon: "🎁", src: "play/giveaways.js" },
    { id: "bingo", label: "Бинго", icon: "🎱", src: "play/bingo.js" },
    { id: "quiz", label: "Квиз", icon: "🧠", src: "play/quiz.js" },
    { id: "tierlists", label: "Тир-листы", icon: "🏅", src: "play/tierlists.js" },
    { id: "shop", label: "Магазин", icon: "🛒", src: "play/shop.js" },
    { id: "season", label: "Сезон и команды", icon: "⚔", src: "play/season.js" },
    { id: "clips", label: "Клипы", icon: "🎬", src: "play/clips.js" },
    { id: "builds", label: "Penta: карта", icon: "🗺", src: "play/builds.js" },
  ],
  // вкладки «Пульта» (stream.html, только админ)
  stream: [
    { id: "streamtools", label: "Расписание · архив · цели", icon: "📅", src: "admin/streamtools.js" },
    { id: "interactive", label: "Опросы · розыгрыши · бинго · квизы · тир-листы", icon: "🎛", src: "admin/interactive.js" },
    { id: "points", label: "Магазин · бонусы · сезоны", icon: "🛒", src: "admin/points.js" },
    { id: "community", label: "Клипы · постройки · пасхалки", icon: "🧩", src: "admin/community.js" },
    { id: "notify", label: "Push · Discord-вебхук", icon: "🔔", src: "admin/notify.js" },
  ],
  // карточки во вкладке «Настройки» личного кабинета
  profile: [
    { id: "push", src: "profile/push.js" },
    { id: "points", src: "profile/points.js" },
    { id: "community", src: "profile/community.js" },
  ],
  // блоки секции «Сейчас на канале» на главной
  home: [
    { id: "schedule", src: "home/schedule.js" },
    { id: "channel", src: "home/channel.js" },
    { id: "clips", src: "home/clips.js" },
  ],
  // кнопки в шапке рядом с аккаунтом
  header: [
    { id: "daily", src: "header/daily.js" },
    { id: "bell", src: "header/bell.js" },
  ],
  // виджеты оверлеев OBS: overlay.html?w=<id>&key=…
  overlay: [
    { id: "goals", src: "overlay/goals.js" },
    { id: "viewer", src: "overlay/viewer.js" },
    { id: "schedule", src: "overlay/schedule.js" },
    { id: "poll", src: "overlay/poll.js" },
    { id: "giveaway", src: "overlay/giveaway.js" },
    { id: "bingo", src: "overlay/bingo.js" },
    { id: "teams", src: "overlay/teams.js" },
  ],
};

// версия сборки (?v=… из адреса этого файла) — модули грузятся той же версией, что и страница
const V = new URL(import.meta.url).search;

/** Подключить CSS модуля один раз: ensureCss("interactive.css") → assets/css/interactive.css той же версии. */
export function ensureCss(file) {
  const href = new URL(`../css/${file}${V}`, import.meta.url).href;
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/** Загрузить модуль; null, если файла нет или он сломан (хост это переживёт). */
export async function loadModule(entry) {
  try {
    return await import(`./${entry.src}${V}`);
  } catch (err) {
    console.warn(`[ndze] модуль ${entry.src} не загрузился`, err);
    return null;
  }
}

/** Смонтировать все модули слота в контейнер (каждый в свой div). Возвращает функцию destroy. */
export async function mountSlot(slot, container, ctx = {}) {
  const mounted = [];
  for (const entry of MODULES[slot] || []) {
    const mod = await loadModule(entry);
    if (!mod?.mount) continue;
    const box = document.createElement("div");
    box.className = `mod mod-${slot}-${entry.id}`;
    container.append(box);
    try {
      mounted.push(mod.mount(box, ctx) || null);
    } catch (err) {
      console.warn(`[ndze] модуль ${entry.src} упал при монтировании`, err);
      box.remove();
    }
  }
  return () => mounted.forEach((m) => m?.destroy?.());
}

// Всё, что нужно поменять под себя — здесь.
export const SITE = {
  nick: "ndze",
  role: "Разработчик · Стример",
  tagline: "Пишу код, стримлю игры и разбираю ваши работы в прямом эфире. С большой силой приходит большая ответственность.",
  about:
    "Привет! Я ndze — делаю проекты от VPN-клиентов до лаунчеров Minecraft и показываю процесс вживую на Twitch. Присылай свои работы на оценку или кидай задание на стрим в Minecraft, CS2 или GTA 5 RP.",

  twitch: { channel: "ndze_one", url: "https://www.twitch.tv/ndze_one" },
  youtube: {
    url: "https://www.youtube.com/@ndzeone",
    handle: "@ndzeone",
    channelId: "UCA_b9K70TCJsWVmW8-d7c3A", // если видео не грузятся — проверь ID в «Настройки канала → Дополнительно»
  },
  github: { user: "ndzeone", url: "https://github.com/ndzeone" },
  novarp: { url: "https://novarp.ru/" },

  schedule: "Стримы: Пн · Ср · Пт — 20:00 МСК",
  socials: [
    { label: "Twitch", url: "https://www.twitch.tv/ndze_one" },
    { label: "YouTube", url: "https://www.youtube.com/@ndzeone" },
    { label: "GitHub", url: "https://github.com/ndzeone" },
    { label: "NovaRP", url: "https://novarp.ru/" },
  ],
  // Большие кнопки «Мой Discord» и «Мои проекты» в контактах (иконки — из data/discord/, их кладёт sync-discord.ps1)
  links: [
    { kind: "Мой Discord-сервер", label: "RO-OM", url: "https://discord.gg/fARfeAYWmb", icon: "data/discord/1341029477471359077-icon.webp", accent: "#8b6cff" },
    { kind: "Мой проект с другом", label: "MythosMC", url: "https://discord.gg/9UgDQJJFyb", icon: "data/discord/1524885681053110392-icon.webp", accent: "#2fd673" },
  ],

  // Discord-серверы на главной. Название, иконку и число участников tools/sync-discord.ps1
  // при каждом деплое кладёт в data/discord.json; онлайн браузер уточняет у Discord вживую.
  // accent — цвет неоновой подсветки карточки, banner — свой баннер (рисует tools/make-banners.php).
  discord: [
    {
      invite: "fARfeAYWmb",
      kind: "Сервер для общения",
      accent: "#8b6cff",
      banner: "assets/img/banners/ro-om.svg",
      tagline: "Мой сервер: общаемся, сидим в войсах, обсуждаем стримы и ловим анонсы первыми.",
      perks: ["Анонсы стримов", "Войсы и чат", "Ивенты"],
    },
    {
      invite: "9UgDQJJFyb",
      kind: "Проект с другом",
      accent: "#2fd673",
      banner: "assets/img/banners/mythosmc.svg",
      tagline: "MythosMC — наш с другом Minecraft-сервер: выживание и RPG. Заходи следить за разработкой и играть первым.",
      perks: ["Minecraft", "Survival", "RPG"],
    },
  ],

  // Где хранятся аккаунты, работы и задания:
  //   "php"   — база MySQL на хостинге Timeweb через api/ (боевой режим, см. API.md);
  //   "local" — демо: только в этом браузере (первый аккаунт — админ).
  // Локальный сервер start.bat не умеет PHP, поэтому на localhost:8000 включается демо.
  backend: location.hostname === "localhost" && location.port === "8000" ? "local" : "php",
};

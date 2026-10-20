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
  // Большие кнопки в контактах. Иконка берётся из data/discord.json по invite (её кладёт sync-discord.ps1).
  links: [
    { kind: "Мой сервер · Discord", label: "Penta SMP", invite: "fARfeAYWmb", accent: "#ff3b4a" },
    { kind: "Мой проект с другом", label: "MythosMC", invite: "9UgDQJJFyb", accent: "#2fd673" },
  ],

  // Discord-серверы на главной. Название, иконку и число участников tools/sync-discord.ps1
  // при каждом деплое кладёт в data/discord.json; онлайн браузер уточняет у Discord вживую.
  // title — своё название (иначе — из Discord), accent — цвет подсветки, banner — свой баннер
  // (рисует tools/make-banners.php), ip — адрес Minecraft-сервера (статус проверяется вживую).
  discord: [
    {
      invite: "fARfeAYWmb",
      title: "Penta SMP",
      kind: "Мой сервер · Minecraft SMP",
      accent: "#ff3b4a",
      banner: "assets/img/banners/penta.svg",
      ip: "mc.penta.org",
      tagline: "Pentagrove — мир приключений и дружбы. Мой Minecraft SMP и Discord: играем вместе, сидим в войсах и ловим анонсы стримов первыми.",
      perks: ["Minecraft SMP", "Войсы и чат", "Анонсы стримов"],
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

  // Страница «Проекты» (projects.html). owner: "mine" — мой проект, "team" — веду вместе с кем-то (with — с кем).
  // Для проектов с GitHub достаточно repo: описание, язык, звёзды и дата берутся из data/repos.json.
  // discord — invite-код (участники и онлайн), ip — Minecraft-сервер (живой статус), status — свой статус.
  // mono — 2–4 символа на плитке-иконке, accent — цвет карточки, featured — большая карточка с баннером.
  projects: [
    {
      id: "penta", owner: "mine", featured: true, title: "Penta SMP", kind: "Minecraft SMP + Discord-сообщество",
      discord: "fARfeAYWmb", ip: "mc.penta.org", banner: "assets/img/banners/penta.svg", accent: "#ff3b4a", mono: "P",
      description: "Pentagrove — мир приключений и дружбы. Мой Minecraft SMP и Discord-сообщество: общаемся, сидим в войсах и ловим анонсы стримов.",
      tags: ["Minecraft", "SMP", "Discord"], status: "Сообщество",
    },
    {
      id: "mythosmc", owner: "team", with: "с другом", featured: true, title: "MythosMC", kind: "Minecraft Survival & RPG",
      discord: "9UgDQJJFyb", banner: "assets/img/banners/mythosmc.svg", accent: "#2fd673", mono: "M",
      description: "Делаем вдвоём с другом: Minecraft-сервер с выживанием и RPG. Заходи в Discord следить за разработкой и играть первым.",
      tags: ["Minecraft", "Survival", "RPG"], status: "В разработке",
    },
    { id: "ndze-vpn", owner: "mine", repo: "ndze-vpn", title: "ndze VPN", kind: "VPN-клиент для Windows", accent: "#4aa8ff", mono: "VPN", tags: ["C#", "VLESS / Reality", "Windows"] },
    { id: "aurovless", owner: "mine", repo: "AuroVless-2.0", title: "AuroVless 2.0", kind: "Умный VLESS-клиент на sing-box", accent: "#8b6cff", mono: "AV", tags: ["C#", "sing-box", "Автовыбор сервера"] },
    { id: "launcher", owner: "mine", repo: "ndze_laucher_minecraft", title: "ndze Launcher", kind: "Лаунчер Minecraft", accent: "#5dd62c", mono: "MC", tags: ["JavaScript", "Бесплатный", "Open source"] },
    { id: "cratelegacy", owner: "mine", repo: "CrateLegacy", title: "CrateLegacy", kind: "Лаунчер Minecraft для Windows", accent: "#ffb02e", mono: "CL", tags: ["Java", "Fabric / Forge / OptiFine", "Modrinth"] },
    { id: "gramm", owner: "mine", repo: "ndze.gramm.tg", title: "ndze.gramm", kind: "Форк Telegram со своими функциями", accent: "#2aa3e0", mono: "TG", tags: ["TypeScript", "Telegram"] },
    { id: "musical", owner: "mine", repo: "musical_offline_programm", title: "Musical Offline", kind: "Музыка без интернета", accent: "#ff6b9a", mono: "♪", tags: ["Swift", "iOS"] },
    { id: "messenger", owner: "mine", repo: "my_custom_messenger", title: "Мой мессенджер", kind: "Чат с демонстрацией экрана", accent: "#36d6c3", mono: "MSG", tags: ["Мессенджер", "Демонстрация экрана"] },
    { id: "kessu", owner: "mine", repo: "Kessu", title: "Kessu", kind: "Браузер, который уважает тебя", accent: "#c46bff", mono: "K", tags: ["Браузер", "Приватность"] },
    { id: "uooworld", owner: "mine", repo: "uooworld.site", title: "UooWorld", kind: "Анархия-сервер Minecraft", accent: "#7a8f6a", mono: "UW", tags: ["Minecraft", "Анархия", "Сайт"] },
    { id: "site", owner: "mine", url: "https://github.com/ndzeone/ndze.fun", title: "ndze.fun", kind: "Этот сайт", accent: "#5dd62c", mono: "🕸",
      description: "Личный сайт: Человек-паук на главной, GitHub, стримы, оценка работ, задания на стрим и личный кабинет. PHP + MySQL, деплой через GitHub Actions.",
      tags: ["JavaScript", "PHP", "MySQL"], status: "В работе" },
  ],

  // Где хранятся аккаунты, работы и задания:
  //   "php"   — база MySQL на хостинге Timeweb через api/ (боевой режим, см. API.md);
  //   "local" — демо: только в этом браузере (первый аккаунт — админ).
  // Локальный сервер start.bat не умеет PHP, поэтому на localhost:8000 включается демо.
  backend: location.hostname === "localhost" && location.port === "8000" ? "local" : "php",
};

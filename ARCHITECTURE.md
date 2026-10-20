# Архитектура сайта ndze

Статический сайт без сборки: чистые HTML + CSS + ES-модули. Открывать через `start.bat`
(локальный сервер на http://localhost:8000). Двойной клик по .html не подойдёт — модули не работают по `file://`.

## Страницы

| Файл | id для mountLayout | Что делает | JS / CSS |
|---|---|---|---|
| `index.html` | `home` | Главная: герой с Человеком-пауком, проекты, Twitch, YouTube, Discord-серверы | `pages/home.js`, `home.css` |
| `projects.html` | `projects` | Мои и совместные проекты (список — `SITE.projects` в config.js) | `pages/projects.js`, `projects.css` |
| `play.html` | `play` | «Движ»: битва работ, ставки баллами, общий холст, лидеры, мини-игра | `pages/play.js`, `play.css` (+ `core/place.js`, `core/runner.js`) |
| `stream.html` | `stream` | Пульт стрима (админ): колесо заданий, оверлеи OBS, ставки, вайтлист, холст | `pages/stream.js`, `stream.css`, `core/wheel.js` |
| `overlay.html?w=…&key=…` | — | Оверлеи для OBS (прозрачный фон, без шапки) | `pages/overlay.js`, `overlay.css` |
| `404.html` | `404` | Страница 404 с мини-игрой «бег по крышам» | `core/runner.js`, `runner.css` |
| `profile.html` | `profile` | Личный кабинет: аватарка, ник, пароль, Discord, мои работы и задания | `pages/profile.js`, `profile.css` |
| `repos.html` | `repos` | Все репозитории GitHub (открытые + закрытые) | `pages/repos.js`, `repos.css` |
| `repo.html?name=X&path=Y` | `repos` | Просмотр кода открытого репозитория | `pages/repo.js`, `repo.css` |
| `review.html` | `review` | Работы на оценку: отправка, оценка, доработка, галерея | `pages/review.js`, `review.css` |
| `tasks.html` | `tasks` | Задания на стрим: Minecraft, CS2, GTA 5 RP (NovaRP) | `pages/tasks.js`, `tasks.css` |
| `admin.html` | `admin` | Панель админа: статистика и очереди | `pages/admin.js`, `admin.css` |

## Структура

```
assets/css/base.css          общий дизайн: токены, шапка, кнопки, формы, .modal, .badge, .chip, тосты, .empty, .skeleton
assets/css/<page>.css        стили одной страницы
assets/js/config.js          ник, Twitch, YouTube, GitHub, выбор бэкенда (php / local)
assets/js/core/util.js       $, $$, esc, plural, timeAgo, formatDate, toast, initial, motion, fancyCursor
assets/js/core/fx.js         курсор, паутина на фоне, initMagnetic, initReveal, initTilt, onFrame, mouse
assets/js/core/modal.js      setupModal(dialog) → { open, close }, shake(card)
assets/js/core/layout.js     mountLayout(page), getUser(), onUserChange(cb), openAuth(tab, reason)
assets/js/data/api.js        api — контракт всех методов данных (см. комментарий в файле)
assets/js/data/local.js      демо-бэкенд (IndexedDB) — эталонная реализация контракта
assets/js/data/php.js        боевой бэкенд: запросы к api/ (PHP + MySQL на хостинге), та же семантика
assets/js/data/constants.js  CATEGORIES, SUB_STATUSES, GAMES, TASK_STATUSES, DIFFICULTIES, LIMITS
assets/js/data/validate.js   check*() — проверка полей (используют и формы, и бэкенды)
assets/js/data/errors.js     ApiError { code, message, fields }
assets/js/data/github.js     loadRepos, getRepo, getTree, getFileText, getReadme, rawUrl, LANG_COLORS
assets/js/pages/<page>.js    логика страницы
data/repos.json              снимок репозиториев (делает tools/sync-github.ps1)
data/discord.json, discord/  снимок Discord-серверов и их иконки (делает tools/sync-discord.ps1 при деплое)
api/                         PHP-сервер: index.php (маршруты), discord-*.php, lib/, schema.sql — протокол в API.md
tests/api-test.php           автотесты API на настоящей MySQL (запускаются в GitHub Actions перед деплоем)
```

## Шаблон страницы

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Название — ndze</title>
  <meta name="theme-color" content="#0f0f0f">
  <link rel="icon" href="assets/img/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;700;800&family=Pixelify+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="assets/css/base.css">
  <link rel="stylesheet" href="assets/css/PAGE.css">
  <script>document.documentElement.classList.add("js");</script>
</head>
<body>
  <main id="main">
    <header class="page-head"><h1>Заголовок</h1><p>Описание</p></header>
    ...
  </main>
  <script type="module" src="assets/js/pages/PAGE.js"></script>
</body>
</html>
```

```js
import { mountLayout, onUserChange, openAuth, getUser } from "../core/layout.js";
import { api } from "../data/api.js";
import { initReveal, initMagnetic } from "../core/fx.js";
import { $, esc, toast } from "../core/util.js";

const user = await mountLayout("PAGE");   // шапка, подвал, вход, фон, курсор
// ... отрисовать страницу; после вставки нового HTML вызвать initReveal(container) / initMagnetic(container)
onUserChange((u) => { /* перерисовать то, что зависит от пользователя */ });
```

## Правила

- **Безопасность:** любой текст от пользователя выводить через `esc()` или `textContent`. Никакого `innerHTML` с сырыми данными.
- **Права проверяет сервер** (api/ на хостинге). В интерфейсе кнопки админа просто скрыты у обычных пользователей.
- **Ошибки:** все методы `api` бросают `ApiError`; показывать `err.message`, ошибки по полям — `err.fields`.
- **Доступность:** у полей `<label>`, ошибки связаны через `aria-describedby`, фокус виден, всё работает с клавиатуры.
- **Анимации** уважают `prefers-reduced-motion` (флаг `motion` из util.js) и не мешают на телефонах (`fancyCursor`).
- **Палитра** только из токенов base.css: `--black --graphite --lime --forest --white` (+ `--danger --warn --info` для статусов).

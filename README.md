# Сайт ndze — ndze.fun

Личная страничка: Человек-паук на главной, проекты с GitHub с просмотром кода, стримы Twitch, видео YouTube,
оценка работ от зрителей и задания на стрим (Minecraft, CS2, GTA 5 RP · NovaRP), вход по email и через Discord.

## Как устроено

- **Сайт** — статические HTML/CSS/JS (`index.html`, `assets/`…).
- **Сервер** — PHP в папке `api/` + база **MySQL на хостинге Timeweb**: аккаунты, работы, задания, вход через Discord.
  Протокол — **API.md**, устройство кода — **ARCHITECTURE.md**.
- **Деплой** — GitHub Actions (`.github/workflows/deploy.yml`): при каждом push в `main` сначала прогоняются
  автотесты API на настоящей MySQL, потом сайт копируется по SSH (rsync) в `~/ndze/public_html/` на хостинге.
  Что не выкладывается — в `.deployignore`.

## Секреты (GitHub → репозиторий → Settings → Secrets and variables → Actions)

| Секрет | Что это | Обязательно |
|---|---|---|
| `TIMEWEB_PASSWORD` | пароль от хостинга (SSH) | да |
| `DB_NAME`, `DB_USER`, `DB_PASS` | база MySQL из панели Timeweb («Базы данных MySQL») | да |
| `DB_HOST` | хост базы, если не `localhost` | нет |
| `ADMIN_EMAILS` | твой email — этот аккаунт станет админом | да |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | приложение Discord для входа | для входа через Discord |
| `ADMIN_DISCORD_IDS` | твой Discord id — тоже админ | нет |
| `REPOS_TOKEN` | токен GitHub «Metadata: Read-only» — тогда на сайте видны и закрытые репозитории | нет |

Из этих секретов при каждом деплое собирается `api/config.php` (права 600). **В репозитории паролей нет и быть не должно.**

## Вход через Discord

1. https://discord.com/developers/applications → New Application → OAuth2.
2. Скопируй **Client ID** и **Client Secret** в секреты `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
3. В OAuth2 → Redirects добавь: `https://ndze.fun/api/discord-callback.php`.
4. Важно: Discord заблокирован в России. Если сервер хостинга не сможет до него достучаться, вход через Discord
   покажет понятную ошибку, а вход по email продолжит работать. Проверка (войдя админом):
   открой `https://ndze.fun/api/index.php?r=health/discord`.

## Домен и HTTPS

1. У регистратора ndze.fun укажи DNS Timeweb: `ns1.timeweb.ru`, `ns2.timeweb.ru`, `ns3.timeweb.org`, `ns4.timeweb.org`.
2. В панели Timeweb выпусти бесплатный SSL для ndze.fun, затем раскомментируй HTTPS-редирект в `.htaccess`.
3. В панели выбери PHP 8.1 или новее для сайта ndze.fun.

## Локальный просмотр

`start.bat` → http://localhost:8000. PHP там нет, поэтому включается демо-режим: данные хранятся только в браузере.

## Репозитории GitHub

Открытые репозитории видны всем, их код листается прямо на сайте (`repo.html`). Закрытые — только название и описание.
Список обновляется при деплое и раз в сутки (если задан `REPOS_TOKEN`), или вручную: `tools/sync-github.bat`.

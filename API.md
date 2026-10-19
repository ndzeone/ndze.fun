# API сайта ndze (PHP + MySQL на хостинге Timeweb)

Сервер: PHP ≥ 8.0 (PDO MySQL, GD, cURL), MySQL 5.7+/8 или MariaDB 10.4+, Apache.
Фронтенд вызывает API через `assets/js/data/php.js`, который реализует контракт из `assets/js/data/api.js`
(те же типы User / Submission / Task / Stats, те же коды ошибок).

## Файлы

```
api/index.php              единая точка входа: api/index.php?r=<маршрут>
api/discord-login.php      старт входа через Discord (302 на discord.com)
api/discord-callback.php   возврат с Discord (302 обратно на сайт)
api/lib/*.php              код (доступ из браузера запрещён api/lib/.htaccess)
api/config.php             секреты — НЕ в git; создаётся при деплое из GitHub Secrets (пример: api/config.example.php)
api/schema.sql             таблицы MySQL; применяется автоматически (таблица schema_version)
~/ndze/storage/uploads/    картинки работ — ВНЕ public_html, отдаются только через api (проверка прав)
~/ndze/storage/avatars/    аватарки 256×256 — ВНЕ public_html, отдаются через api (публично)
```

## Формат

- Запрос: `GET|POST api/index.php?r=<маршрут>[&параметры]`. POST — JSON (`Content-Type: application/json`)
  или `multipart/form-data` для загрузки картинок.
- Каждый POST обязан иметь заголовок `X-Requested-With: ndze`, а `Origin` (если есть) — совпадать с хостом сайта.
  Иначе 403 `forbidden` (защита от CSRF).
- Ответ всегда JSON:
  - успех: `{ "ok": true, "data": <данные> }`
  - ошибка: `{ "ok": false, "error": { "code": "...", "message": "по-русски", "fields": { "поле": "текст" } | null } }`
- HTTP-статусы: 200; 400 `validation`; 401 `auth_required` / `invalid_credentials`; 403 `forbidden`;
  404 `not_found`; 409 `email_taken` / `nick_taken`; 429 `rate_limited`; 500 `unknown`.
- Поля ответа — camelCase, даты — ISO 8601 UTC (`2026-10-19T12:00:00Z`), id — UUID v4 строкой.

## Сессия и безопасность

- PHP-сессия, cookie `ndze_sid`: HttpOnly, SameSite=Lax, Secure при HTTPS. `session_regenerate_id` при входе.
  Смена пароля и отвязка Discord увеличивают `user_profiles.auth_epoch` — все остальные сессии пользователя
  перестают действовать (текущая перевыпускается). Отвязанный Discord (`discord_unlinked`) больше не входит
  в аккаунт, вход им возвращает `reason=unlinked`, пока его не привяжут снова из кабинета.
- Пароли — `password_hash(PASSWORD_DEFAULT)`. Email хранится в нижнем регистре.
- Админ: email в `ADMIN_EMAILS` (config.php) **или** Discord id в `ADMIN_DISCORD_IDS`.
  Для Discord email учитывается только если Discord пометил его `verified`.
- Лимиты (таблица `rate_limits`): вход — 10 попыток / 15 мин на IP; регистрация — 5 / час на IP;
  новые работы — 20 / сутки на пользователя; задания — 20 / сутки; комментарии — 60 / час;
  аватарки — 20 / сутки; смена ника — 5 / сутки; неверный текущий пароль при смене — 10 / 15 мин.
- Все SQL — только подготовленные запросы PDO. Ошибки PHP не показываются клиенту (только `unknown`), пишутся в лог.
- Картинки: проверка через `getimagesize` + finfo, разрешены JPEG/PNG/WEBP/GIF до 10 МБ, до 5 файлов;
  JPEG/PNG/WEBP пересохраняются через GD (уменьшение до 1600px по длинной стороне, метаданные удаляются);
  GIF сохраняется как есть после проверки. Имя файла — UUID, расширение по реальному типу.

## Маршруты

| Метод | r= | Тело / параметры | data | Кто |
|---|---|---|---|---|
| GET | `me` | — | `User \| null` | все |
| POST | `auth/register` | `{nick,email,password}` | `User` (+вход) | гость |
| POST | `auth/login` | `{email,password}` | `User` | гость |
| POST | `auth/logout` | — | `null` | все |
| GET | `submissions` | `scope=mine\|all\|gallery` | `Submission[]` (новые сверху по updatedAt) | mine: вход; all: админ; gallery: все |
| GET | `submission` | `id` | `Submission` | автор, админ; статус ideal — все |
| POST | `submissions` | multipart: `title, description, category, note, files[]` | `Submission` (status pending, версия 1) | вход |
| POST | `submission/version` | multipart: `id, note, files[]` | `Submission` (status → pending) | автор |
| POST | `submission/comment` | `{id,text}` | `Comment` | автор, админ |
| POST | `submission/review` | `{id, rating?, status?}` (rating 1..10 или null) | `Submission` | админ |
| POST | `submission/delete` | `{id}` | `null` (+удаление файлов) | автор, админ |
| GET | `image` | `id` | картинка (не JSON); 404 если нет прав | как у работы |
| GET | `tasks` | `game?, status?` | `Task[]` (по голосам ↓, затем новые) | все |
| POST | `tasks` | `{game,title,description,difficulty}` | `Task` | вход |
| POST | `task/vote` | `{id}` | `{votes, myVote}` | вход |
| POST | `task/update` | `{id, status?, adminNote?}` | `Task` | админ |
| POST | `task/delete` | `{id}` | `null` | автор (пока status new), админ |
| GET | `me/profile` | — | `Profile` = `{ user, hasPassword, discordLinked, stats: { submissions, ideal, avgRating, tasks, tasksDone, votesReceived } }` | вход |
| POST | `me/update` | `{nick}` | `User` | вход |
| POST | `me/password` | `{currentPassword, newPassword}` (без пароля — только `newPassword`, нужен email) | `null` (+новый id сессии) | вход |
| POST | `me/avatar` | multipart: `files[]` — одна картинка | `User` (квадрат 256×256, обрезка по центру, WEBP/PNG) | вход |
| POST | `me/avatar/delete` | — | `User` (avatarUrl null; из Discord больше не подтягивается) | вход |
| POST | `me/discord/unlink` | — | `Profile` (400, если нет email+пароля) | вход |
| GET | `avatar` | `id` (id пользователя), `v` | картинка (не JSON); 404 если аватарки нет | все |
| GET | `stats` | — | `Stats` | админ |
| GET | `health` | — | `{ php, db, schema, storage, gd, curl }` (true/false + версия php) | все |
| GET | `health/discord` | — | `{ reachable, ms, error? }` — доступен ли discord.com с сервера | админ |

`Version.imageUrls` — относительные ссылки вида `api/index.php?r=image&id=<uuid>`.
`Comment.isAdmin` — роль автора комментария на момент чтения.
`User.avatarUrl`, `Submission.authorAvatar`, `Comment.authorAvatar`, `Task.authorAvatar` — `api/index.php?r=avatar&id=<uuid>&v=<8 hex>`
или `null`. `v` меняется с каждой новой картинкой, поэтому ответ кэшируется как `immutable`.

## Вход через Discord

1. Фронтенд: `location.href = "api/discord-login.php?return=" + encodeURIComponent(путь страницы)`.
2. `discord-login.php`: state в сессии, `return` — только относительный путь этого сайта (иначе `/`),
   302 на `https://discord.com/oauth2/authorize?response_type=code&client_id=…&scope=identify%20email&redirect_uri=…&state=…&prompt=none`.
3. `discord-callback.php`: проверка state → обмен `code` на токен (POST https://discord.com/api/oauth2/token, cURL, таймаут 10 с)
   → `GET https://discord.com/api/users/@me` → поиск пользователя по `discord_id`, иначе по подтверждённому email
   (привязка Discord к существующему аккаунту), иначе создание: ник из `global_name` → `username`,
   очищенный до `[\p{L}\d_]`, 3–20 символов, при совпадении — цифры в конце. Вход в сессию.
4. 302 обратно на `return` с `?auth=discord` (успех) или `?auth=discord_error&reason=<code>`.
   Фронтенд показывает тост и убирает параметры из адреса.
5. Аватарка Discord скачивается в хранилище при входе, если своей загруженной нет и пользователь её не удалял.

Привязка из личного кабинета: `discord-login.php?link=1&return=…` (нужен вход). Callback привязывает Discord
к пользователю той же сессии и возвращает `?auth=discord_linked`; ошибки — `reason=discord_taken`
(Discord уже у другого аккаунта) или `already_linked` (к аккаунту привязан другой Discord).

`redirect_uri` = `DISCORD_REDIRECT_URI` из config.php (по умолчанию `https://ndze.fun/api/discord-callback.php`).

## config.php (создаётся при деплое)

```php
<?php return [
  'db' => ['host' => 'localhost', 'name' => '...', 'user' => '...', 'pass' => '...'],
  'discord' => ['client_id' => '...', 'client_secret' => '...', 'redirect_uri' => 'https://ndze.fun/api/discord-callback.php'],
  'admin_emails' => ['dz2ell.official@gmail.com'],
  'admin_discord_ids' => [],
  'storage_dir' => null, // null → ~/ndze/storage (на уровень выше public_html)
  'debug' => false,
];
```

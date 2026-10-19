<?php
// Пример api/config.php. Настоящий config.php НЕ хранится в git: на хостинге его собирает
// GitHub Actions из секретов (.github/workflows/deploy.yml). Для локального запуска скопируй
// этот файл в api/config.php и впиши свои значения.
return [
    // База MySQL/MariaDB. Таблицы создаются сами при первом запросе (api/schema.sql).
    // Необязательно: 'port' => 3306, 'socket' => '/путь/к/mysql.sock'
    'db' => ['host' => 'localhost', 'name' => 'ndze', 'user' => 'ndze', 'pass' => 'secret'],

    // Приложение Discord (https://discord.com/developers/applications → OAuth2).
    // Redirect в настройках приложения должен совпадать с redirect_uri. Пустой client_id — вход через Discord выключен.
    'discord' => ['client_id' => '', 'client_secret' => '', 'redirect_uri' => 'https://ndze.fun/api/discord-callback.php'],

    // Админы: email (в нижнем регистре) и/или Discord id. Роль пересчитывается на каждом запросе.
    'admin_emails' => ['dz2ell.official@gmail.com'],
    'admin_discord_ids' => [],

    // Хранилище картинок и сессий. null → ~/ndze/storage (на уровень выше public_html).
    'storage_dir' => null,

    // Лимиты частоты (необязательно). По умолчанию — как в API.md:
    //   login [10, 900], register [5, 3600], submission [20, 86400], version [40, 86400], task [20, 86400], comment [60, 3600]
    // Переопределить: 'rate_limits' => ['register' => [50, 3600]]; выключить все (только для тестов): 'rate_limits' => false
    // 'rate_limits' => [],

    // true — в ответах 500 будет текст исключения. На боевом сервере всегда false.
    'debug' => false,
];

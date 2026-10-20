<?php
// Лимиты частоты (таблица rate_limits): счётчик в фиксированном окне.
// Настройка в config.php: 'rate_limits' => ['login' => [10, 900], ...] или 'rate_limits' => false (выключить, для тестов).
declare(strict_types=1);
defined('NDZE') || exit;

/** action => [лимит, окно в секундах]. */
const RATE_LIMITS = [
    'login' => [10, 900],         // неудачные входы: 10 / 15 мин на IP
    'register' => [5, 3600],      // регистрации: 5 / час на IP
    'submission' => [20, 86400],  // новые работы: 20 / сутки на пользователя
    'version' => [40, 86400],     // новые версии работ: 40 / сутки на пользователя (защита диска)
    'task' => [20, 86400],        // задания: 20 / сутки
    'comment' => [60, 3600],      // комментарии: 60 / час
    'avatar' => [20, 86400],      // смена аватарки: 20 / сутки
    'nick' => [5, 86400],         // смена ника: 5 / сутки
    'password' => [10, 900],      // неверный текущий пароль при смене: 10 / 15 мин
    'battle' => [300, 86400],     // голоса в битве работ: 300 / сутки
    'minecraft' => [10, 86400],   // смена ника Minecraft: 10 / сутки
    'whitelist' => [5, 86400],    // заявки в вайтлист: 5 / сутки
    'game' => [120, 3600],        // результаты игры: 120 / час
];

function rate_limit_conf(string $action): ?array
{
    $over = cfg('rate_limits', []);
    if ($over === false) return null;
    $conf = RATE_LIMITS[$action] ?? null;
    if (is_array($over) && isset($over[$action])) {
        if ($over[$action] === false) return null;
        if (is_array($over[$action]) && count($over[$action]) === 2) $conf = [(int) $over[$action][0], max(1, (int) $over[$action][1])];
    }
    return $conf;
}

/** Ключ для IP: HMAC, чтобы в базе не лежали адреса в открытом виде. */
function ip_subject(): string
{
    $secret = 'ndze-rl|' . (string) cfg('db.name', '') . '|' . (string) cfg('db.pass', '') . '|' . (string) cfg('discord.client_secret', '');
    return hash_hmac('sha256', client_ip(), $secret);
}

function user_subject(string $userId): string
{
    return hash('sha256', 'user|' . $userId);
}

function rate_window(array $conf): int
{
    return intdiv(time(), $conf[1]) * $conf[1];
}

/** Сколько попыток уже в текущем окне. */
function rate_limit_count(string $action, string $subject): int
{
    $conf = rate_limit_conf($action);
    if (!$conf) return 0;
    $row = q_one('SELECT hits FROM rate_limits WHERE action = ? AND subject = ? AND window_start = ?', [$action, $subject, rate_window($conf)]);
    return $row ? (int) $row['hits'] : 0;
}

/** 429, если лимит уже исчерпан (без увеличения счётчика). */
function rate_limit_check(string $action, string $subject): void
{
    $conf = rate_limit_conf($action);
    if ($conf && rate_limit_count($action, $subject) >= $conf[0]) throw new ApiError('rate_limited');
}

/** +1 к счётчику. */
function rate_limit_add(string $action, string $subject): void
{
    $conf = rate_limit_conf($action);
    if (!$conf) return;
    q('INSERT INTO rate_limits (action, subject, window_start, hits) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1',
        [$action, $subject, rate_window($conf)]);
    if (random_int(1, 100) === 1) {
        q('DELETE FROM rate_limits WHERE window_start < ?', [time() - 2 * 86400]);
    }
}

/** Проверить и засчитать попытку: 429, если лимит исчерпан. */
function rate_limit_hit(string $action, string $subject): void
{
    rate_limit_check($action, $subject);
    rate_limit_add($action, $subject);
}

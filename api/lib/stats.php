<?php
// Статистика для админки и проверка здоровья сервера.
declare(strict_types=1);
defined('NDZE') || exit;

function route_stats(): array
{
    require_admin();
    session_release();
    $count = static function (string $table, array $statuses): array {
        $rows = q_all("SELECT status, COUNT(*) AS n FROM $table GROUP BY status");
        $by = array_column($rows, 'n', 'status');
        $out = ['total' => array_sum(array_map('intval', $by))];
        foreach ($statuses as $s) $out[$s] = (int) ($by[$s] ?? 0);
        return $out;
    };
    return [
        'users' => (int) q_one('SELECT COUNT(*) AS n FROM users')['n'],
        'submissions' => $count('submissions', SUB_STATUSES),
        'tasks' => $count('tasks', TASK_STATUSES),
    ];
}

/** GET health — без config.php тоже отвечает. */
function route_health(): array
{
    $db = false;
    $schema = false;
    $dbError = config() === null ? 'not_configured' : null;
    if (config() !== null) {
        try {
            $pdo = db(); // заодно применяет миграцию
            $db = true;
            $schema = schema_version($pdo) >= NDZE_SCHEMA_VERSION;
        } catch (Throwable $e) {
            error_log('[ndze] health: база недоступна: ' . $e->getMessage());
            // Только категория ошибки — без текста, логинов и путей
            $code = $e instanceof PDOException ? (int) ($e->errorInfo[1] ?? 0) : 0;
            if ($code === 0 && $e instanceof PDOException && preg_match('/\[(\d{4})\]/', $e->getMessage(), $m)) $code = (int) $m[1];
            $dbError = [
                1045 => 'access_denied',     // неверный пользователь или пароль
                1044 => 'no_db_access',      // у пользователя нет прав на эту базу
                1049 => 'unknown_database',  // нет базы с таким именем
                2002 => 'cannot_connect',    // неверный хост
                2005 => 'cannot_connect',
                2006 => 'cannot_connect',
            ][$code] ?? ($db ? 'migration_failed' : 'other');
        }
    }
    return [
        'php' => PHP_VERSION,
        'db' => $db,
        'dbError' => $dbError,
        'schema' => $schema,
        'storage' => storage_dir('uploads') !== null,
        'gd' => function_exists('imagecreatetruecolor'),
        'curl' => function_exists('curl_init'),
    ];
}

/** GET health/discord (админ) — доступен ли discord.com с сервера (в России его блокируют). */
function route_health_discord(): array
{
    require_admin();
    session_release();
    $r = http_request('GET', 'https://discord.com/api/v10/gateway', [], null, 5);
    $out = ['reachable' => $r['status'] > 0, 'ms' => $r['ms']];
    if ($r['status'] === 0) $out['error'] = $r['error'] !== '' ? $r['error'] : 'нет ответа';
    elseif ($r['status'] !== 200) $out['error'] = 'HTTP ' . $r['status'];
    return $out;
}

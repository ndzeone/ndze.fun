<?php
// PDO MySQL + автоматическая миграция схемы (таблица schema_version) + время/UUID.
declare(strict_types=1);
defined('NDZE') || exit;

/** Подключение к базе (одно на запрос). Бросает ApiError 503, если config.php нет. */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    if (config() === null || !is_array(cfg('db'))) {
        throw new ApiError('unknown', 'Сервер ещё не настроен (нет api/config.php)', null, 503);
    }
    $host = (string) cfg('db.host', 'localhost');
    $dsn = 'mysql:host=' . $host . ';dbname=' . (string) cfg('db.name', '') . ';charset=utf8mb4';
    if (cfg('db.port')) $dsn .= ';port=' . (int) cfg('db.port');
    if (cfg('db.socket')) $dsn = 'mysql:unix_socket=' . (string) cfg('db.socket') . ';dbname=' . (string) cfg('db.name', '') . ';charset=utf8mb4';
    $pdo = new PDO($dsn, (string) cfg('db.user', ''), (string) cfg('db.pass', ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $pdo->exec("SET time_zone = '+00:00'");
    migrate($pdo);
    return $pdo;
}

/** Выполнить запрос с параметрами и вернуть PDOStatement. */
function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute(array_values($params));
    return $st;
}

function q_one(string $sql, array $params = []): ?array
{
    $row = q($sql, $params)->fetch();
    return $row === false ? null : $row;
}

function q_all(string $sql, array $params = []): array
{
    return q($sql, $params)->fetchAll();
}

/** '?, ?, ?' для IN (...). */
function placeholders(int $n): string
{
    return implode(', ', array_fill(0, max(1, $n), '?'));
}

function is_duplicate_key(Throwable $e): bool
{
    return $e instanceof PDOException && (($e->errorInfo[1] ?? null) === 1062 || $e->getCode() === '23000');
}

/** Текущая версия схемы в базе (0 — таблиц ещё нет). */
function schema_version(PDO $pdo): int
{
    try {
        return (int) $pdo->query('SELECT MAX(version) FROM schema_version')->fetchColumn();
    } catch (PDOException $e) {
        return 0;
    }
}

/**
 * Идемпотентная миграция: если версия схемы меньше NDZE_SCHEMA_VERSION, выполняем
 * api/schema.sql (только CREATE TABLE IF NOT EXISTS / INSERT IGNORE) под именованной блокировкой.
 */
function migrate(PDO $pdo): void
{
    if (schema_version($pdo) >= NDZE_SCHEMA_VERSION) return;
    $locked = (int) $pdo->query("SELECT GET_LOCK('ndze_migrate', 15)")->fetchColumn() === 1;
    try {
        if (schema_version($pdo) >= NDZE_SCHEMA_VERSION) return;
        $sql = file_get_contents(NDZE_API_DIR . '/schema.sql');
        if ($sql === false) throw new RuntimeException('Нет api/schema.sql');
        foreach (split_sql($sql) as $stmt) $pdo->exec($stmt);
        error_log('[ndze] схема базы обновлена до версии ' . NDZE_SCHEMA_VERSION);
    } finally {
        if ($locked) $pdo->query("SELECT RELEASE_LOCK('ndze_migrate')");
    }
}

/** Делит SQL-файл на запросы: «;» в конце строки, строки-комментарии «--» отбрасываются. */
function split_sql(string $sql): array
{
    $out = [];
    $buf = '';
    $sql = preg_replace('/^\xEF\xBB\xBF/', '', $sql); // BOM
    // не \R: без флага /u он считает байт 0x85 (часть кириллицы в UTF-8) переводом строки
    foreach (preg_split('/\r\n|\n|\r/', $sql) as $line) {
        $t = trim($line);
        if ($t === '' || str_starts_with($t, '--')) continue;
        $buf .= $line . "\n";
        if (str_ends_with($t, ';')) {
            $out[] = rtrim(trim($buf), ';');
            $buf = '';
        }
    }
    if (trim($buf) !== '') $out[] = trim($buf);
    return $out;
}

/* ---------- Время (всё в UTC) и id ---------- */

/** Сейчас в формате DATETIME(3): '2026-10-19 12:00:00.123'. */
function now_db(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s.v');
}

/** DATETIME из базы → ISO 8601 UTC с миллисекундами ('2026-10-19T12:00:00.123Z', как toISOString()). */
function iso(?string $dt): ?string
{
    if ($dt === null || $dt === '') return null;
    $dt = str_replace(' ', 'T', $dt);
    if (!str_contains($dt, '.')) $dt .= '.000';
    [$sec, $frac] = explode('.', $dt, 2);
    return $sec . '.' . str_pad(substr($frac, 0, 3), 3, '0') . 'Z';
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}

/** UUID в нижнем регистре или null, если строка не UUID. */
function norm_uuid($v): ?string
{
    if (!is_string($v)) return null;
    $v = strtolower(trim($v));
    return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $v) ? $v : null;
}

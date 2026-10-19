<?php
// Общий старт для api/index.php, api/discord-login.php, api/discord-callback.php.
// Ошибки PHP никогда не показываются клиенту: только лог + JSON `unknown` (или редирект для Discord).
declare(strict_types=1);

define('NDZE', true);
define('NDZE_API_DIR', dirname(__DIR__));          // …/public_html/api
define('NDZE_SCHEMA_VERSION', 2);

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
ini_set('html_errors', '0');
error_reporting(E_ALL);

// Предупреждения не превращаем в исключения (GD сыплет warning'ами на «кривых» PNG) — только пишем в лог.
set_error_handler(static function (int $no, string $msg, string $file, int $line): bool {
    if (!(error_reporting() & $no)) return true; // подавлено через @
    error_log("[ndze] PHP $no: $msg in $file:$line");
    return true;
});

// Режим ответа при фатальной ошибке: 'json' (api/index.php) или 'redirect' (Discord).
$GLOBALS['NDZE_FATAL_MODE'] = 'json';
ob_start();
register_shutdown_function(static function (): void {
    $e = error_get_last();
    if (!$e || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true)) return;
    error_log("[ndze] FATAL: {$e['message']} in {$e['file']}:{$e['line']}");
    if (headers_sent()) return;
    while (ob_get_level() > 0) @ob_end_clean();
    if (($GLOBALS['NDZE_FATAL_MODE'] ?? 'json') === 'redirect') {
        http_response_code(302);
        header('Cache-Control: no-store');
        header('Location: /?auth=discord_error&reason=server');
        return;
    }
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo '{"ok":false,"error":{"code":"unknown","message":"Что-то пошло не так","fields":null}}';
});

require __DIR__ . '/http.php';
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/validate.php';
require __DIR__ . '/ratelimit.php';
require __DIR__ . '/images.php';
require __DIR__ . '/submissions.php';
require __DIR__ . '/tasks.php';
require __DIR__ . '/stats.php';
require __DIR__ . '/discord.php';
require __DIR__ . '/profile.php';

/** config.php как массив или null, если файла нет / он битый. */
function config(): ?array
{
    static $cfg = false;
    if ($cfg === false) {
        $cfg = null;
        $file = NDZE_API_DIR . '/config.php';
        if (is_file($file)) {
            $c = require $file;
            if (is_array($c)) $cfg = $c;
            else error_log('[ndze] api/config.php не вернул массив');
        }
    }
    return $cfg;
}

/** Значение из config.php по пути 'a.b' (или $default). */
function cfg(string $path, $default = null)
{
    $v = config();
    foreach (explode('.', $path) as $k) {
        if (!is_array($v) || !array_key_exists($k, $v)) return $default;
        $v = $v[$k];
    }
    return $v ?? $default;
}

/** Корень хранилища: config storage_dir или ~/ndze/storage (на уровень выше public_html). */
function storage_root(): string
{
    $dir = cfg('storage_dir');
    if (!is_string($dir) || $dir === '') $dir = dirname(__DIR__, 3) . '/storage';
    return rtrim($dir, '/\\');
}

/** Подпапка хранилища; создаётся с правами 0700. Возвращает путь или null, если создать нельзя. */
function storage_dir(string $sub): ?string
{
    $root = storage_root();
    $dir = $root . '/' . $sub;
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
            error_log("[ndze] не удалось создать $dir");
            return null;
        }
        // на случай, если storage_dir указали внутри public_html
        $ht = $root . '/.htaccess';
        if (!is_file($ht)) {
            @file_put_contents($ht, "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
        }
    }
    return is_writable($dir) ? $dir : null;
}

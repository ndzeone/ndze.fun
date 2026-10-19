<?php
// Сессия (cookie ndze_sid), текущий пользователь, роль админа, регистрация и вход по email.
declare(strict_types=1);
defined('NDZE') || exit;

const SESSION_NAME = 'ndze_sid';
const SESSION_TTL = 30 * 24 * 3600; // 30 дней

function session_configure(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    ini_set('session.cookie_httponly', '1');
    ini_set('session.gc_maxlifetime', (string) SESSION_TTL);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    ini_set('session.cache_limiter', '');
    // Свои файлы сессий в ~/ndze/storage/sessions: системная уборка хостинга не удалит их через 24 минуты.
    $dir = storage_dir('sessions');
    if ($dir !== null) session_save_path($dir);
    session_name(SESSION_NAME);
    session_set_cookie_params([
        'lifetime' => SESSION_TTL,
        'path' => '/',
        'domain' => '',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Запустить сессию. $create=false — только если у клиента уже есть cookie (не плодим пустые сессии). */
function session_begin(bool $create = true): bool
{
    if (session_status() === PHP_SESSION_ACTIVE) return true;
    $sid = $_COOKIE[SESSION_NAME] ?? null;
    if (!$create && (!is_string($sid) || $sid === '')) return false;
    if (is_string($sid) && !preg_match('/^[a-zA-Z0-9,-]{22,256}$/', $sid)) {
        unset($_COOKIE[SESSION_NAME]); // мусор в cookie — пусть PHP выдаст новый id
        if (!$create) return false;
    }
    session_configure();
    if (!@session_start()) {
        error_log('[ndze] session_start не удался');
        return false;
    }
    // продлеваем cookie раз в сутки, чтобы активный пользователь не вылетал через 30 дней
    $t = time();
    $sameId = is_string($_COOKIE[SESSION_NAME] ?? null) && $_COOKIE[SESSION_NAME] === session_id();
    if ($sameId && ($_SESSION['cookie_at'] ?? 0) < $t - 86400) {
        $_SESSION['cookie_at'] = $t;
        setcookie(SESSION_NAME, session_id(), session_cookie_options($t + SESSION_TTL));
    }
    return true;
}

function session_cookie_options(int $expires): array
{
    return ['expires' => $expires, 'path' => '/', 'domain' => '', 'secure' => is_https(), 'httponly' => true, 'samesite' => 'Lax'];
}

/** Закрыть сессию (снять блокировку файла), когда больше не пишем в неё. */
function session_release(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
}

/** Вход: новый id сессии (защита от фиксации) + id пользователя. */
function session_login(string $userId): void
{
    session_begin(true);
    session_regenerate_id(true);
    $_SESSION['uid'] = $userId;
    $_SESSION['cookie_at'] = time();
    q('UPDATE users SET last_login_at = ? WHERE id = ?', [now_db(), $userId]);
    current_user(true);
}

function session_logout(): void
{
    if (!session_begin(false)) return;
    $_SESSION = [];
    session_destroy();
    setcookie(SESSION_NAME, '', session_cookie_options(time() - 3600));
}

/* ---------- Пользователь и роль ---------- */

/** Админ: email из admin_emails или Discord id из admin_discord_ids (считается при каждом запросе по config.php). */
function is_admin_row(?string $email, ?string $discordId): bool
{
    $emails = array_map(static fn($e) => mb_strtolower(trim((string) $e)), (array) cfg('admin_emails', []));
    $ids = array_map(static fn($e) => trim((string) $e), (array) cfg('admin_discord_ids', []));
    if ($email !== null && $email !== '' && in_array(mb_strtolower($email), $emails, true)) return true;
    if ($discordId !== null && $discordId !== '' && in_array($discordId, $ids, true)) return true;
    return false;
}

const USER_COLS = 'id, nick, email, discord_id, password_hash, created_at';

/** Строка users → User из контракта. */
function public_user(?array $u): ?array
{
    if (!$u) return null;
    return [
        'id' => $u['id'],
        'nick' => $u['nick'],
        'email' => $u['email'],
        'role' => is_admin_row($u['email'], $u['discord_id']) ? 'admin' : 'user',
        'createdAt' => iso($u['created_at']),
    ];
}

/** Текущий пользователь (строка users + 'role') или null. */
function current_user(bool $reload = false): ?array
{
    static $cache = false;
    if ($cache !== false && !$reload) return $cache;
    $cache = null;
    if (!session_begin(false)) return null;
    $uid = $_SESSION['uid'] ?? null;
    if (!is_string($uid) || $uid === '') return null;
    $u = q_one('SELECT ' . USER_COLS . ' FROM users WHERE id = ?', [$uid]);
    if (!$u) {
        unset($_SESSION['uid']);
        return null;
    }
    $u['role'] = is_admin_row($u['email'], $u['discord_id']) ? 'admin' : 'user';
    return $cache = $u;
}

function require_user(): array
{
    $u = current_user();
    if (!$u) throw new ApiError('auth_required');
    return $u;
}

function require_admin(): array
{
    $u = require_user();
    if ($u['role'] !== 'admin') throw new ApiError('forbidden');
    return $u;
}

/* ---------- Регистрация / вход ---------- */

function nick_key(string $nick): string
{
    return mb_strtolower($nick, 'UTF-8');
}

function nick_taken(string $nick, ?string $exceptId = null): bool
{
    $row = q_one('SELECT id FROM users WHERE nick_key = ?', [nick_key($nick)]);
    return $row !== null && $row['id'] !== $exceptId;
}

function auth_register(array $b): array
{
    $nick = clean_str($b['nick'] ?? null);
    $email = mb_strtolower(clean_str($b['email'] ?? null), 'UTF-8');
    $password = raw_str($b['password'] ?? null);
    assert_valid(check_sign_up($nick, $email, $password));

    rate_limit_hit('register', ip_subject());

    if (q_one('SELECT id FROM users WHERE email = ?', [$email])) {
        throw new ApiError('email_taken', null, ['email' => 'Этот email уже зарегистрирован']);
    }
    if (nick_taken($nick)) {
        throw new ApiError('nick_taken', null, ['nick' => 'Этот ник уже занят']);
    }
    $id = uuid4();
    $t = now_db();
    try {
        q('INSERT INTO users (id, nick, nick_key, email, password_hash, discord_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
            [$id, $nick, nick_key($nick), $email, password_hash($password, PASSWORD_DEFAULT), $t, $t]);
    } catch (PDOException $e) {
        if (!is_duplicate_key($e)) throw $e;
        // гонка двух одинаковых регистраций
        if (q_one('SELECT id FROM users WHERE email = ?', [$email])) throw new ApiError('email_taken', null, ['email' => 'Этот email уже зарегистрирован']);
        throw new ApiError('nick_taken', null, ['nick' => 'Этот ник уже занят']);
    }
    session_login($id);
    return public_user(current_user());
}

function auth_login(array $b): array
{
    $email = mb_strtolower(clean_str($b['email'] ?? null), 'UTF-8');
    $password = raw_str($b['password'] ?? null);
    assert_valid(check_sign_in($email, $password));

    $subject = ip_subject();
    rate_limit_check('login', $subject); // 10 неудачных попыток / 15 мин на IP

    $u = q_one('SELECT ' . USER_COLS . ' FROM users WHERE email = ?', [$email]);
    $hash = $u['password_hash'] ?? null;
    // для несуществующего email тоже считаем хеш — одинаковое время ответа
    $ok = password_verify($password, is_string($hash) ? $hash : '$2y$10$abcdefghijklmnopqrstuuJ0e0X2W9q6l7k0Yy5W8m8wWmH2T3u7G');
    if (!$u || !is_string($hash) || !$ok) {
        rate_limit_add('login', $subject);
        throw new ApiError('invalid_credentials');
    }
    if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $u['id']]);
    }
    session_login($u['id']);
    return public_user(current_user());
}

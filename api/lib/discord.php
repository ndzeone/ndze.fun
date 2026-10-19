<?php
// Вход через Discord (OAuth2 code flow). discord.com может быть недоступен с сервера (блокировка в РФ) —
// тогда возвращаем пользователя на сайт с ?auth=discord_error&reason=unreachable, без ошибок PHP.
declare(strict_types=1);
defined('NDZE') || exit;

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_ME = 'https://discord.com/api/users/@me';
const DISCORD_STATE_TTL = 600;

/**
 * HTTP-запрос через cURL. Никогда не бросает: status 0 + error — сеть недоступна.
 * @return array{status:int, body:string, ms:int, error:string}
 */
function http_request(string $method, string $url, array $headers = [], ?string $body = null, int $timeout = 10): array
{
    $t0 = microtime(true);
    if (!function_exists('curl_init')) return ['status' => 0, 'body' => '', 'ms' => 0, 'error' => 'нет расширения cURL'];
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => min(5, $timeout),
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTPHEADER => array_merge(['Accept: application/json', 'User-Agent: ndze-site (https://ndze.fun, 1.0)'], $headers),
        CURLOPT_CUSTOMREQUEST => $method,
    ];
    if (defined('CURLOPT_PROTOCOLS')) $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
    if ($body !== null) $opts[CURLOPT_POSTFIELDS] = $body;
    curl_setopt_array($ch, $opts);
    $resp = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = $resp === false ? curl_error($ch) : '';
    curl_close($ch);
    return [
        'status' => $resp === false ? 0 : $status,
        'body' => is_string($resp) ? $resp : '',
        'ms' => (int) round((microtime(true) - $t0) * 1000),
        'error' => $err,
    ];
}

function discord_configured(): bool
{
    return config() !== null && (string) cfg('discord.client_id', '') !== '' && (string) cfg('discord.client_secret', '') !== '';
}

function discord_redirect_uri(): string
{
    $uri = (string) cfg('discord.redirect_uri', '');
    return $uri !== '' ? $uri : 'https://ndze.fun/api/discord-callback.php';
}

/** return= только относительный путь этого сайта («/…», не «//…»), иначе «/». */
function safe_return_path($v): string
{
    if (!is_string($v) || $v === '' || strlen($v) > 2000) return '/';
    if ($v[0] !== '/' || (isset($v[1]) && ($v[1] === '/' || $v[1] === '\\'))) return '/';
    if (preg_match('/[\x00-\x20\x7F\\\\]/', $v)) return '/';
    // и закодированные: %0d%0a, %2f%2f…, %5c — тоже нельзя
    $dec = rawurldecode($v);
    if (preg_match('/[\x00-\x1F\x7F\\\\]/', $dec) || str_starts_with($dec, '//')) return '/';
    return $v;
}

/** Путь возврата + ?auth=… (старые auth/reason убираются, #hash сохраняется). */
function return_url(string $path, array $params): string
{
    $hash = '';
    if (($p = strpos($path, '#')) !== false) {
        $hash = substr($path, $p);
        $path = substr($path, 0, $p);
    }
    $query = '';
    if (($p = strpos($path, '?')) !== false) {
        $query = substr($path, $p + 1);
        $path = substr($path, 0, $p);
    }
    $keep = array_filter(explode('&', $query), static function ($pair) {
        $k = urldecode(explode('=', $pair, 2)[0]);
        return $pair !== '' && $k !== 'auth' && $k !== 'reason';
    });
    $keep[] = http_build_query($params, '', '&', PHP_QUERY_RFC3986);
    return $path . '?' . implode('&', $keep) . $hash;
}

function redirect(string $url): void
{
    while (ob_get_level() > 0) @ob_end_clean();
    http_response_code(302);
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('Location: ' . $url);
}

/* ---------- discord-login.php ---------- */

function discord_login(): void
{
    $return = safe_return_path($_GET['return'] ?? '/');
    if (!discord_configured()) {
        redirect(return_url($return, ['auth' => 'discord_error', 'reason' => 'not_configured']));
        return;
    }
    if (!session_begin(true)) {
        redirect(return_url($return, ['auth' => 'discord_error', 'reason' => 'server']));
        return;
    }
    $state = bin2hex(random_bytes(16));
    $_SESSION['discord_state'] = $state;
    $_SESSION['discord_state_at'] = time();
    $_SESSION['discord_return'] = $return;
    session_release();
    $q = http_build_query([
        'response_type' => 'code',
        'client_id' => (string) cfg('discord.client_id'),
        'scope' => 'identify email',
        'redirect_uri' => discord_redirect_uri(),
        'state' => $state,
        'prompt' => 'none',
    ], '', '&', PHP_QUERY_RFC3986);
    redirect(DISCORD_AUTHORIZE . '?' . $q);
}

/* ---------- discord-callback.php ---------- */

function discord_callback(): void
{
    $return = '/';
    try {
        $hasSession = session_begin(false);
        if ($hasSession && isset($_SESSION['discord_return'])) $return = safe_return_path($_SESSION['discord_return']);
        $fail = static function (string $reason) use (&$return): void {
            redirect(return_url($return, ['auth' => 'discord_error', 'reason' => $reason]));
        };

        $expected = $hasSession ? ($_SESSION['discord_state'] ?? null) : null;
        $at = $hasSession ? (int) ($_SESSION['discord_state_at'] ?? 0) : 0;
        if ($hasSession) {
            unset($_SESSION['discord_state'], $_SESSION['discord_state_at'], $_SESSION['discord_return']);
        }
        $state = $_GET['state'] ?? '';
        if (!is_string($expected) || !is_string($state) || $state === '' || !hash_equals($expected, $state) || time() - $at > DISCORD_STATE_TTL) {
            $fail('state');
            return;
        }
        if (isset($_GET['error'])) {
            $fail($_GET['error'] === 'access_denied' ? 'access_denied' : 'discord');
            return;
        }
        if (!discord_configured()) {
            $fail('not_configured');
            return;
        }
        $code = $_GET['code'] ?? '';
        if (!is_string($code) || $code === '' || strlen($code) > 512) {
            $fail('discord');
            return;
        }

        // 1) code → access_token
        $tok = http_request('POST', DISCORD_TOKEN, ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => discord_redirect_uri(),
            'client_id' => (string) cfg('discord.client_id'),
            'client_secret' => (string) cfg('discord.client_secret'),
        ], '', '&'), 10);
        if ($tok['status'] === 0) {
            error_log('[ndze] discord token: нет связи: ' . $tok['error']);
            $fail('unreachable');
            return;
        }
        $tokData = json_decode($tok['body'], true);
        $access = is_array($tokData) ? ($tokData['access_token'] ?? null) : null;
        if ($tok['status'] !== 200 || !is_string($access) || $access === '') {
            error_log('[ndze] discord token: HTTP ' . $tok['status'] . ' ' . substr($tok['body'], 0, 300));
            $fail('token');
            return;
        }

        // 2) профиль
        $me = http_request('GET', DISCORD_ME, ['Authorization: Bearer ' . $access], null, 10);
        if ($me['status'] === 0) {
            error_log('[ndze] discord @me: нет связи: ' . $me['error']);
            $fail('unreachable');
            return;
        }
        $profile = json_decode($me['body'], true);
        if ($me['status'] !== 200 || !is_array($profile) || !isset($profile['id']) || !preg_match('/^\d{1,32}$/', (string) $profile['id'])) {
            error_log('[ndze] discord @me: HTTP ' . $me['status']);
            $fail('profile');
            return;
        }

        // 3) найти / привязать / создать пользователя и войти
        $userId = discord_upsert_user($profile);
        session_login($userId);
        session_release();
        redirect(return_url($return, ['auth' => 'discord']));
    } catch (Throwable $e) {
        error_log('[ndze] discord callback: ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        redirect(return_url($return, ['auth' => 'discord_error', 'reason' => 'server']));
    }
}

/** Пользователь по discord_id → по подтверждённому email (привязка) → новый. Возвращает id. */
function discord_upsert_user(array $p): string
{
    $discordId = (string) $p['id'];
    $email = null;
    if (($p['verified'] ?? false) === true && is_string($p['email'] ?? null)) {
        $e = mb_strtolower(clean_str($p['email']), 'UTF-8');
        if (valid_email($e)) $email = $e;
    }
    $t = now_db();

    $u = q_one('SELECT id, email FROM users WHERE discord_id = ?', [$discordId]);
    if ($u) {
        // у аккаунта ещё нет email, а Discord дал подтверждённый и свободный — запомним
        if ($u['email'] === null && $email !== null && !q_one('SELECT id FROM users WHERE email = ?', [$email])) {
            q('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [$email, $t, $u['id']]);
        }
        return $u['id'];
    }

    if ($email !== null) {
        $u = q_one('SELECT id, discord_id FROM users WHERE email = ?', [$email]);
        if ($u && $u['discord_id'] === null) {
            q('UPDATE users SET discord_id = ?, updated_at = ? WHERE id = ? AND discord_id IS NULL', [$discordId, $t, $u['id']]);
            return $u['id'];
        }
        if ($u) $email = null; // email занят аккаунтом с другим Discord — новый аккаунт без email
    }

    $base = discord_nick_base($p);
    for ($i = 0; $i < 30; $i++) {
        $nick = discord_nick_candidate($base, $i);
        if (nick_taken($nick)) continue;
        $id = uuid4();
        try {
            q('INSERT INTO users (id, nick, nick_key, email, password_hash, discord_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
                [$id, $nick, nick_key($nick), $email, $discordId, $t, $t]);
            return $id;
        } catch (PDOException $e) {
            if (!is_duplicate_key($e)) throw $e;
            $again = q_one('SELECT id FROM users WHERE discord_id = ?', [$discordId]);
            if ($again) return $again['id']; // параллельный вход тем же Discord
            if ($email !== null && q_one('SELECT id FROM users WHERE email = ?', [$email])) $email = null;
        }
    }
    throw new RuntimeException('Не удалось подобрать ник для Discord-пользователя ' . $discordId);
}

/** Ник из global_name → username, только [\p{L}0-9_], 3–20 символов. */
function discord_nick_base(array $p): string
{
    foreach ([$p['global_name'] ?? null, $p['username'] ?? null] as $name) {
        if (!is_string($name)) continue;
        $s = preg_replace('/[^\p{L}0-9_]+/u', '', clean_str($name)) ?? '';
        $s = mb_substr($s, 0, 20);
        if (mb_strlen($s) >= 3) return $s;
    }
    return 'user';
}

/** 0 → база; 1..9 → база + 2..10; дальше — случайные цифры. Длина ≤ 20. */
function discord_nick_candidate(string $base, int $i): string
{
    if ($i === 0 && mb_strlen($base) >= 3) return $base;
    $suffix = $i < 10 ? (string) ($i + 1) : (string) random_int(100, 999999);
    return mb_substr($base, 0, 20 - strlen($suffix)) . $suffix;
}

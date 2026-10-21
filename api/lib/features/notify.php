<?php
// Уведомления: колокольчик (таблица notifications), браузерные push «я в эфире» (push_subscriptions)
// и Discord-вебхук на события сайта.
//
// Web Push — без шифрования содержимого: шлём ПУСТОЙ push с подписью VAPID (ES256), а service worker (/sw.js)
// сам забирает текст с api/index.php?r=push/latest. Поэтому не нужны ни ECDH, ни AES-GCM — только openssl_sign.
// Отправка push и вебхука идёт после ответа клиенту (register_shutdown_function + fastcgi_finish_request),
// чтобы недоступный discord.com (хостинг в РФ) или медленный push-сервис не тормозили запрос, вызвавший событие.
declare(strict_types=1);
defined('NDZE') || exit;

const NT_LIST_LIMIT = 30;     // столько уведомлений отдаём в колокольчик
const NT_KEEP = 200;          // столько храним на пользователя, остальное удаляем
const NT_READ_IDS_MAX = 100;

const PUSH_TOPICS = ['live', 'news'];
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_BATCH = 500;       // максимум адресатов на одно событие
const PUSH_PARALLEL = 100;    // одновременных запросов к push-сервисам
const PUSH_TIMEOUT = 5;
const PUSH_MAX_FAILS = 5;     // после стольких ошибок подряд подписка удаляется
const PUSH_MAX_SUBS = 50000;  // защита базы от спама подписками
const PUSH_TTL = 3600;

const WEBHOOK_RE = '~^https://(?:(?:canary|ptb)\.)?discord(?:app)?\.com/api(?:/v\d{1,2})?/webhooks/(\d{5,25})/([A-Za-z0-9_-]{20,120})$~D';
const WEBHOOK_COLOR = 0x5dd62c;
// ключ настройки => [подпись в пульте, включено по умолчанию]
const WEBHOOK_EVENTS = [
    'live' => ['Начало эфира', true],
    'news' => ['Новости и правила на форуме', true],
    'task' => ['Новое задание от зрителя', false],
    'prediction_open' => ['Открыта ставка', true],
    'prediction_resolve' => ['Итоги ставки', true],
    'wheel' => ['Колесо выбрало задание', true],
    'giveaway' => ['Итоги розыгрыша', true],
];

rate_limit_define('push_sub', 20, 3600);      // подписка/отписка: 20 / час на IP
rate_limit_define('push_state', 120, 3600);   // проверка подписки: 120 / час на IP
rate_limit_define('notif_read', 600, 3600);   // «прочитано»: 600 / час на пользователя
rate_limit_define('push_test', 10, 3600);     // тестовый push: 10 / час
rate_limit_define('webhook_test', 20, 3600);  // тест вебхука: 20 / час

route_add([
    'GET notifications' => 'route_notifications',
    'POST notifications/read' => 'route_notifications_read',
    'GET push/key' => 'route_push_key',
    'POST push/subscribe' => 'route_push_subscribe',
    'POST push/unsubscribe' => 'route_push_unsubscribe',
    'POST push/state' => 'route_push_state',
    'GET push/latest' => 'route_push_latest',
    'POST push/test' => 'route_push_test',
    'GET notify/admin' => 'route_notify_admin',
    'POST notify/webhook' => 'route_notify_webhook_save',
    'POST notify/webhook/test' => 'route_notify_webhook_test',
]);

/* ====================================================================
   Колокольчик
   ==================================================================== */

/** Ссылка уведомления: только относительная страница сайта (page.html, page.html#…, page.html?…), иначе null. */
function nt_link(?string $link): ?string
{
    if ($link === null || $link === '') return null;
    return preg_match('~^[a-z0-9_-]{1,40}\.html(?:[?#][^\s<>"\'\\\\]{0,250})?$~iD', $link) ? $link : null;
}

function nt_unread(string $userId): int
{
    return (int) q_one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [$userId])['n'];
}

/** Оставить пользователю только NT_KEEP последних уведомлений. */
function nt_prune(string $userId): void
{
    $edge = q_one('SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ' . (NT_KEEP - 1), [$userId]);
    if ($edge) q('DELETE FROM notifications WHERE user_id = ? AND id < ?', [$userId, $edge['id']]);
}

// каждое новое уведомление (platform.php → notify()) — подрезаем хвост
event_on('notify', static function (array $d): void {
    if (is_string($d['userId'] ?? null)) nt_prune($d['userId']);
});

/** GET notifications[?only=unread] → { items: [{id, kind, text, link, read, createdAt}], unread } */
function route_notifications(): array
{
    $me = require_user();
    session_release();
    if (query_str('only') === 'unread') return ['unread' => nt_unread($me['id'])]; // лёгкий опрос раз в минуту
    nt_prune($me['id']);
    $rows = q_all('SELECT id, kind, text, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ' . NT_LIST_LIMIT, [$me['id']]);
    return [
        'items' => array_map(static fn($r) => [
            'id' => (int) $r['id'], 'kind' => $r['kind'], 'text' => $r['text'], 'link' => nt_link($r['link']),
            'read' => (bool) $r['is_read'], 'createdAt' => iso($r['created_at']),
        ], $rows),
        'unread' => nt_unread($me['id']),
    ];
}

/** POST notifications/read { ids: int[] } | { all: true } → { unread } */
function route_notifications_read(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    rate_limit_hit('notif_read', user_subject($me['id']));
    if (($b['all'] ?? null) === true) {
        q('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [$me['id']]);
        return ['unread' => 0];
    }
    $ids = $b['ids'] ?? null;
    if (!is_array($ids) || !$ids || count($ids) > NT_READ_IDS_MAX || !array_is_list($ids)) {
        throw new ApiError('validation', 'Передай ids (1–' . NT_READ_IDS_MAX . ' номеров) или all: true', ['ids' => 'Неверный список']);
    }
    $clean = [];
    foreach ($ids as $id) {
        if (is_int($id) && $id > 0) $clean[] = $id;
        elseif (is_string($id) && preg_match('/^[1-9]\d{0,18}$/D', $id)) $clean[] = (int) $id;
        else throw new ApiError('validation', 'Неверный номер уведомления', ['ids' => 'Неверный номер']);
    }
    $clean = array_values(array_unique($clean));
    q('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (' . placeholders(count($clean)) . ')', array_merge([$me['id']], $clean));
    return ['unread' => nt_unread($me['id'])];
}

/* ====================================================================
   VAPID (ключи и подпись ES256)
   ==================================================================== */

function nt_b64u(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function nt_b64u_dec(string $s): ?string
{
    if (!preg_match('/^[A-Za-z0-9_-]*={0,2}$/D', $s)) return null;
    $s = rtrim($s, '=');
    $r = base64_decode(str_pad(strtr($s, '-_', '+/'), (int) (ceil(strlen($s) / 4) * 4), '=', STR_PAD_RIGHT), true);
    return $r === false ? null : $r;
}

/** openssl.cnf на случай Windows/хостинга, где OpenSSL не находит свой конфиг (тогда openssl_pkey_new = false). */
function nt_openssl_conf(): ?string
{
    foreach ([getenv('OPENSSL_CONF') ?: '', dirname(PHP_BINARY) . '/extras/ssl/openssl.cnf'] as $f) {
        if ($f !== '' && is_file($f)) return $f;
    }
    $f = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ndze-openssl.cnf';
    if (!is_file($f)) @file_put_contents($f, "[ req ]\ndefault_bits = 2048\ndefault_md = sha256\ndistinguished_name = req_dn\n[ req_dn ]\n");
    return is_file($f) ? $f : null;
}

/** Новая пара ключей P-256: { private: PEM, public: base64url(0x04||X||Y), createdAt }. */
function nt_vapid_generate(): array
{
    $opts = ['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC];
    $extra = [];
    $key = @openssl_pkey_new($opts);
    if ($key === false && ($conf = nt_openssl_conf()) !== null) {
        $extra = ['config' => $conf];
        $key = @openssl_pkey_new($opts + $extra);
    }
    $pem = '';
    if ($key === false || !@openssl_pkey_export($key, $pem, null, $extra)) {
        $err = (string) openssl_error_string();
        while (openssl_error_string() !== false) { /* очищаем очередь ошибок */ }
        throw new RuntimeException('VAPID: не удалось создать ключ: ' . $err);
    }
    while (openssl_error_string() !== false) { /* предупреждения про конфиг нам не важны */ }
    $d = openssl_pkey_get_details($key);
    $x = str_pad((string) ($d['ec']['x'] ?? ''), 32, "\0", STR_PAD_LEFT);
    $y = str_pad((string) ($d['ec']['y'] ?? ''), 32, "\0", STR_PAD_LEFT);
    if (strlen($x) !== 32 || strlen($y) !== 32) throw new RuntimeException('VAPID: неожиданная длина координат');
    return ['private' => $pem, 'public' => nt_b64u("\x04" . $x . $y), 'createdAt' => iso(now_db())];
}

function nt_vapid_valid($v): bool
{
    if (!is_array($v) || !is_string($v['private'] ?? null) || !is_string($v['public'] ?? null)) return false;
    $pub = nt_b64u_dec($v['public']);
    return $pub !== null && strlen($pub) === 65 && $pub[0] === "\x04" && str_contains($v['private'], 'PRIVATE KEY');
}

/** Ключи VAPID: создаются один раз и лежат в settings.vapid (закрытый ключ наружу не отдаётся никогда). */
function nt_vapid(): array
{
    static $keys = null;
    if ($keys !== null) return $keys;
    $v = setting_get('vapid');
    if (!nt_vapid_valid($v)) {
        $new = nt_vapid_generate();
        // INSERT IGNORE: если два запроса создали ключ одновременно, останется первый
        q('INSERT IGNORE INTO settings (k, v, updated_at) VALUES (?, ?, ?)', ['vapid', json_encode_safe($new), now_db()]);
        $v = setting_get('vapid');
        if (!nt_vapid_valid($v)) { // в базе лежал мусор — перезаписываем
            setting_set('vapid', $new);
            $v = $new;
        }
    }
    return $keys = $v;
}

/** sub в JWT: mailto: или https: (Apple требует). */
function nt_vapid_subject(): string
{
    $s = (string) cfg('vapid_subject', '');
    if (preg_match('~^(mailto:[^\s@]+@[^\s@]+|https://\S+)$~D', $s)) return $s;
    $site = site_url('');
    return str_starts_with($site, 'https://') ? $site : 'https://ndze.fun/';
}

/** Подпись ECDSA из openssl_sign (DER: SEQUENCE{INTEGER r, INTEGER s}) → «сырые» 64 байта r||s для JWS. */
function nt_der_to_raw(string $der): ?string
{
    $p = 0;
    $n = strlen($der);
    if ($n < 8 || ord($der[$p++]) !== 0x30) return null;
    $len = ord($der[$p++]);
    if ($len & 0x80) {
        $bytes = $len & 0x7f;
        $len = 0;
        for ($i = 0; $i < $bytes && $p < $n; $i++) $len = ($len << 8) | ord($der[$p++]);
    }
    if ($p + $len !== $n) return null;
    $out = '';
    for ($k = 0; $k < 2; $k++) {
        if ($p + 2 > $n || ord($der[$p++]) !== 0x02) return null;
        $l = ord($der[$p++]);
        if ($l < 1 || $l > 33 || $p + $l > $n) return null;
        $int = ltrim(substr($der, $p, $l), "\0");
        $p += $l;
        if (strlen($int) > 32) return null;
        $out .= str_pad($int, 32, "\0", STR_PAD_LEFT);
    }
    return $p === $n ? $out : null;
}

/** JWT для заголовка Authorization: vapid t=<jwt>, k=<public>. aud — origin push-сервиса. */
function nt_vapid_jwt(string $endpoint, array $keys, ?int $exp = null): string
{
    $u = parse_url($endpoint);
    $aud = 'https://' . strtolower((string) ($u['host'] ?? '')) . (isset($u['port']) ? ':' . (int) $u['port'] : '');
    $head = nt_b64u(json_encode_safe(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims = nt_b64u(json_encode_safe(['aud' => $aud, 'exp' => $exp ?? time() + 12 * 3600, 'sub' => nt_vapid_subject()]));
    $input = $head . '.' . $claims;
    $der = '';
    if (!openssl_sign($input, $der, $keys['private'], OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('VAPID: openssl_sign: ' . openssl_error_string());
    }
    $raw = nt_der_to_raw($der);
    if ($raw === null) throw new RuntimeException('VAPID: неожиданный формат подписи');
    return $input . '.' . nt_b64u($raw);
}

/* ====================================================================
   Подписки на push
   ==================================================================== */

/** Адрес подписки: https и известный push-сервис (никаких запросов сервера на произвольные адреса — SSRF). */
function nt_push_endpoint_ok(string $url): bool
{
    if (strlen($url) < 30 || strlen($url) > 1000 || preg_match('/[\x00-\x20\x7f"\'<>\\\\]/', $url)) return false;
    $u = parse_url($url);
    if (!is_array($u) || strtolower($u['scheme'] ?? '') !== 'https' || empty($u['host']) || isset($u['user']) || isset($u['pass'])) return false;
    if (isset($u['port']) && (int) $u['port'] !== 443) return false;
    $h = strtolower($u['host']);
    return in_array($h, PUSH_HOSTS, true) || preg_match('/^(?:[a-z0-9-]{1,63}\.){1,4}notify\.windows\.com$/D', $h) === 1;
}

/** topics из запроса → ['live', 'news'] (только известные, без повторов). null — неверный формат. */
function nt_topics($v): ?array
{
    if ($v === null) return ['live'];
    if (!is_array($v) || !array_is_list($v) || count($v) > 10) return null;
    $out = [];
    foreach ($v as $t) {
        if (!is_string($t) || !in_array($t, PUSH_TOPICS, true)) return null;
        $out[$t] = true;
    }
    return $out ? array_values(array_intersect(PUSH_TOPICS, array_keys($out))) : null;
}

function nt_endpoint_arg(array $b): string
{
    $e = $b['endpoint'] ?? null;
    if (!is_string($e) || !nt_push_endpoint_ok($e)) throw new ApiError('validation', 'Неверный адрес подписки', ['endpoint' => 'Неверный адрес подписки']);
    return $e;
}

/** GET push/key → { key } — открытый ключ VAPID (applicationServerKey). */
function route_push_key(): array
{
    session_release();
    try {
        return ['key' => nt_vapid()['public']];
    } catch (RuntimeException $e) {
        error_log('[ndze] ' . $e->getMessage());
        throw new ApiError('unknown', 'Push-уведомления на сервере пока не работают');
    }
}

/** POST push/subscribe { endpoint, keys: { p256dh, auth }, topics: ['live','news'] } → { subscribed, topics } (можно гостю) */
function route_push_subscribe(): array
{
    $me = current_user();
    session_release();
    $b = request_body();
    $endpoint = nt_endpoint_arg($b);
    $keys = is_array($b['keys'] ?? null) ? $b['keys'] : [];
    $p256 = is_string($keys['p256dh'] ?? null) ? $keys['p256dh'] : '';
    $auth = is_string($keys['auth'] ?? null) ? $keys['auth'] : '';
    $pRaw = strlen($p256) <= 120 ? nt_b64u_dec($p256) : null;
    $aRaw = strlen($auth) <= 40 ? nt_b64u_dec($auth) : null;
    $e = [];
    if ($pRaw === null || strlen($pRaw) !== 65 || $pRaw[0] !== "\x04") $e['keys'] = 'Неверный ключ подписки';
    if ($aRaw === null || strlen($aRaw) !== 16) $e['keys'] = 'Неверный ключ подписки';
    $topics = nt_topics($b['topics'] ?? null);
    if ($topics === null) $e['topics'] = 'Выбери, о чём уведомлять: эфир и/или новости';
    assert_valid($e);
    rate_limit_hit('push_sub', ip_subject());

    $hash = hash('sha256', $endpoint);
    if (!q_one('SELECT id FROM push_subscriptions WHERE endpoint_hash = ?', [$hash])
        && (int) q_one('SELECT COUNT(*) AS n FROM push_subscriptions')['n'] >= PUSH_MAX_SUBS) {
        throw new ApiError('validation', 'Слишком много подписок — попробуй позже');
    }
    q('INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth, topics, created_at, last_ok_at, fails)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON DUPLICATE KEY UPDATE user_id = COALESCE(VALUES(user_id), user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), topics = VALUES(topics), fails = 0',
        [$me['id'] ?? null, $hash, $endpoint, nt_b64u($pRaw), nt_b64u($aRaw), implode(',', $topics), now_db()]);
    return ['subscribed' => true, 'topics' => $topics];
}

/** POST push/unsubscribe { endpoint } → { subscribed: false } */
function route_push_unsubscribe(): array
{
    session_release();
    $endpoint = nt_endpoint_arg(request_body());
    rate_limit_hit('push_sub', ip_subject());
    q('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [hash('sha256', $endpoint)]);
    return ['subscribed' => false];
}

/** POST push/state { endpoint } → { subscribed, topics } — знает ли сервер эту подписку (POST: адрес не попадёт в логи). */
function route_push_state(): array
{
    session_release();
    $endpoint = nt_endpoint_arg(request_body());
    rate_limit_hit('push_state', ip_subject());
    $row = q_one('SELECT topics FROM push_subscriptions WHERE endpoint_hash = ?', [hash('sha256', $endpoint)]);
    return $row ? ['subscribed' => true, 'topics' => array_values(array_intersect(PUSH_TOPICS, explode(',', $row['topics'])))] : ['subscribed' => false, 'topics' => []];
}

/** GET push/latest → { title, body, url, tag } — что показать в уведомлении (sw.js спрашивает после пустого push). */
function route_push_latest(): array
{
    session_release();
    $l = setting_get('push_last');
    if (!is_array($l) || !is_string($l['title'] ?? null)) {
        return ['title' => 'ndze', 'body' => 'Загляни на сайт 🕷', 'url' => site_url(''), 'tag' => 'ndze'];
    }
    return ['title' => $l['title'], 'body' => (string) ($l['body'] ?? ''), 'url' => (string) ($l['url'] ?? site_url('')), 'tag' => (string) ($l['tag'] ?? 'ndze')];
}

/* ====================================================================
   Отправка push
   ==================================================================== */

/**
 * Разослать пустой push подписчикам темы ($topic = null — всем) и запомнить текст для push/latest.
 * Возвращает { sent, ok, removed, failed, error }.
 */
function nt_push_send(array $msg, ?string $topic): array
{
    $msg = [
        'title' => mb_substr((string) $msg['title'], 0, 120), 'body' => mb_substr((string) ($msg['body'] ?? ''), 0, 240),
        'url' => (string) ($msg['url'] ?? site_url('')), 'tag' => substr((string) ($msg['tag'] ?? 'ndze'), 0, 64),
    ];
    setting_set('push_last', $msg + ['topic' => $topic, 'at' => iso(now_db())]);
    $stats = ['sent' => 0, 'ok' => 0, 'removed' => 0, 'failed' => 0, 'error' => null];
    // всем подписчикам пачками по id (раньше — только 500 новейших: спам-подписки вытесняли настоящих)
    $afterId = 0;
    $okTotal = $goneTotal = $badTotal = 0;
    for ($batch = 0; $batch < 200; $batch++) {
    $rows = $topic === null
        ? q_all('SELECT id, endpoint FROM push_subscriptions WHERE id > ? ORDER BY id ASC LIMIT ' . PUSH_BATCH, [$afterId])
        : q_all('SELECT id, endpoint FROM push_subscriptions WHERE id > ? AND FIND_IN_SET(?, topics) > 0 ORDER BY id ASC LIMIT ' . PUSH_BATCH, [$afterId, $topic]);
    if (!$rows) break;
    $afterId = (int) end($rows)['id'];
    if ($rows) {
        try {
            $results = nt_push_deliver($rows, nt_vapid());
        } catch (Throwable $e) {
            error_log('[ndze] push: ' . $e->getMessage());
            $results = [];
            $stats['error'] = 'Ошибка подписи VAPID';
        }
        $okIds = $goneIds = $badIds = [];
        foreach ($results as $id => [$status, $err]) {
            $stats['sent']++;
            if ($status >= 200 && $status < 300) $okIds[] = $id;
            elseif ($status === 404 || $status === 410) $goneIds[] = $id;
            else {
                // в счётчик отказов — только ответы «подписка битая» (400/401/403); нет связи, 429 и 5xx —
                // проблема сети или сервиса, из-за неё рабочие подписки удалять нельзя
                if (in_array($status, [400, 401, 403], true)) $badIds[] = $id;
                $stats['error'] ??= $status === 0 ? "нет связи: $err" : "HTTP $status";
            }
        }
        if ($okIds) q('UPDATE push_subscriptions SET fails = 0, last_ok_at = ? WHERE id IN (' . placeholders(count($okIds)) . ')', array_merge([now_db()], $okIds));
        if ($goneIds) q('DELETE FROM push_subscriptions WHERE id IN (' . placeholders(count($goneIds)) . ')', $goneIds);
        if ($badIds) {
            q('UPDATE push_subscriptions SET fails = fails + 1 WHERE id IN (' . placeholders(count($badIds)) . ')', $badIds);
            q('DELETE FROM push_subscriptions WHERE fails >= ? AND id IN (' . placeholders(count($badIds)) . ')', array_merge([PUSH_MAX_FAILS], $badIds));
        }
        $okTotal += count($okIds);
        $goneTotal += count($goneIds);
        $badTotal += count($badIds);
    }
    }
    $stats['ok'] = $okTotal;
    $stats['removed'] = $goneTotal;
    $stats['failed'] = $badTotal;
    setting_set('push_status', $stats + ['title' => $msg['title'], 'topic' => $topic, 'at' => iso(now_db())]);
    return $stats;
}

/**
 * POST без тела на каждый endpoint (curl_multi, до PUSH_PARALLEL одновременно, таймаут PUSH_TIMEOUT).
 * @param array<array{id:int|string, endpoint:string}> $rows
 * @return array<int, array{0:int, 1:string}> id => [HTTP-статус (0 — нет связи), ошибка cURL]
 */
function nt_push_deliver(array $rows, array $keys): array
{
    if (!function_exists('curl_multi_init')) throw new RuntimeException('нет расширения cURL');
    $jwts = []; // один JWT на push-сервис (aud)
    $mh = curl_multi_init();
    $queue = $rows;
    $active = [];
    $out = [];
    $add = static function () use (&$queue, &$active, &$jwts, $mh, $keys): void {
        $row = array_shift($queue);
        $host = strtolower((string) parse_url($row['endpoint'], PHP_URL_HOST));
        $jwts[$host] ??= nt_vapid_jwt($row['endpoint'], $keys);
        $ch = curl_init($row['endpoint']);
        $opts = [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => '',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => PUSH_TIMEOUT,
            CURLOPT_TIMEOUT => PUSH_TIMEOUT,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => [
                'Authorization: vapid t=' . $jwts[$host] . ', k=' . $keys['public'],
                'TTL: ' . PUSH_TTL,
                'Urgency: high',
                'Content-Length: 0',
                'User-Agent: ndze-site (https://ndze.fun, 1.0)',
            ],
        ];
        if (defined('CURLOPT_PROTOCOLS')) $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($mh, $ch);
        $active[spl_object_id($ch)] = [(int) $row['id'], $ch];
    };
    try {
        while ($queue || $active) {
            while ($queue && count($active) < PUSH_PARALLEL) $add();
            do {
                $st = curl_multi_exec($mh, $running);
            } while ($st === CURLM_CALL_MULTI_PERFORM);
            while ($info = curl_multi_info_read($mh)) {
                $ch = $info['handle'];
                [$id] = $active[spl_object_id($ch)];
                $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                $out[$id] = [$info['result'] === CURLE_OK ? $code : 0, $info['result'] === CURLE_OK ? '' : curl_error($ch)];
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                unset($active[spl_object_id($ch)]);
            }
            if ($active && $running) curl_multi_select($mh, 0.5);
        }
    } finally {
        foreach ($active as [, $ch]) {
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return $out;
}

/** POST push/test (админ) → { sent, ok, removed, failed, error } — тестовый push всем подписчикам. */
function route_push_test(): array
{
    $me = require_admin();
    session_release();
    rate_limit_hit('push_test', user_subject($me['id']));
    if (!q_one('SELECT id FROM push_subscriptions LIMIT 1')) throw new ApiError('validation', 'Пока нет ни одного подписчика — включи уведомления в личном кабинете');
    try {
        nt_vapid();
    } catch (RuntimeException $e) {
        error_log('[ndze] ' . $e->getMessage());
        throw new ApiError('unknown', 'Не удалось создать ключи VAPID на сервере');
    }
    @set_time_limit(120);
    return nt_push_send(['title' => 'Тест push-уведомлений', 'body' => 'Если ты это видишь — уведомления работают 🕷', 'url' => site_url(''), 'tag' => 'test'], null);
}

/* ====================================================================
   Discord-вебхук
   ==================================================================== */

/** { url: string ('' — нет), events: { key: bool } } */
function nt_webhook_conf(): array
{
    $c = setting_get('webhook');
    $url = is_array($c) && is_string($c['url'] ?? null) && preg_match(WEBHOOK_RE, $c['url']) ? $c['url'] : '';
    $events = [];
    foreach (WEBHOOK_EVENTS as $k => [, $def]) $events[$k] = is_array($c) && is_bool($c['events'][$k] ?? null) ? $c['events'][$k] : $def;
    return ['url' => $url, 'events' => $events];
}

/** https://discord.com/api/webhooks/1234…789/••••abcd — полный адрес (с токеном) клиенту не отдаём. */
function nt_webhook_mask(string $url): ?string
{
    if (!preg_match(WEBHOOK_RE, $url, $m)) return null;
    $host = parse_url($url, PHP_URL_HOST);
    return "https://$host/api/webhooks/" . substr($m[1], 0, 4) . '…' . substr($m[1], -3) . '/••••' . substr($m[2], -4);
}

/** Отправить embed. Возвращает и сохраняет статус в settings.webhook_status. */
function nt_webhook_send(string $url, string $event, array $embed): array
{
    $embed = array_filter([
        'title' => mb_substr((string) ($embed['title'] ?? ''), 0, 250),
        'url' => $embed['url'] ?? null,
        'description' => mb_substr((string) ($embed['description'] ?? ''), 0, 1500),
        'color' => WEBHOOK_COLOR,
        'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        'footer' => ['text' => preg_replace('~^https?://~', '', rtrim(site_url(''), '/'))],
    ], static fn($v) => $v !== null && $v !== '');
    $payload = ['username' => 'ndze.fun', 'allowed_mentions' => ['parse' => []], 'embeds' => [$embed]];
    $r = http_request('POST', $url, ['Content-Type: application/json'], json_encode_safe($payload), 5);
    $ok = $r['status'] >= 200 && $r['status'] < 300;
    $err = null;
    if ($r['status'] === 0) $err = 'Нет связи с discord.com (с хостинга в РФ он может быть заблокирован): ' . mb_substr($r['error'], 0, 160);
    elseif (!$ok) {
        $j = json_decode($r['body'], true);
        $msg = is_array($j) && is_string($j['message'] ?? null) ? mb_substr($j['message'], 0, 160) : '';
        $err = "Discord ответил HTTP {$r['status']}" . ($msg !== '' ? ": $msg" : '') . ($r['status'] === 404 || $r['status'] === 401 ? ' — вебхук удалён или неверный, создай новый' : '');
    }
    $status = ['at' => iso(now_db()), 'ok' => $ok, 'status' => $r['status'], 'ms' => $r['ms'], 'error' => $err, 'event' => $event];
    setting_set('webhook_status', $status);
    if (!$ok) error_log('[ndze] discord webhook (' . $event . '): ' . $err);
    return $status;
}

/** Отправить событие в вебхук, если он настроен и событие включено (после ответа клиенту). */
function nt_webhook_emit(string $event, array $embed): void
{
    $c = nt_webhook_conf();
    if ($c['url'] === '' || empty($c['events'][$event])) return;
    nt_defer(static fn() => nt_webhook_send($c['url'], $event, $embed));
}

function nt_webhook_view(): array
{
    $c = nt_webhook_conf();
    $st = setting_get('webhook_status');
    return [
        'configured' => $c['url'] !== '',
        'masked' => $c['url'] !== '' ? nt_webhook_mask($c['url']) : null,
        'events' => $c['events'],
        'labels' => array_map(static fn($e) => $e[0], WEBHOOK_EVENTS),
        'status' => is_array($st) ? $st : null,
    ];
}

/** POST notify/webhook { url?: string ('' — удалить), events?: { key: bool } } (админ) → вид вебхука */
function route_notify_webhook_save(): array
{
    require_admin();
    session_release();
    $b = request_body();
    $c = nt_webhook_conf();
    if (array_key_exists('url', $b)) {
        $url = clean_str($b['url']);
        if ($url !== '' && !preg_match(WEBHOOK_RE, $url)) {
            throw new ApiError('validation', 'Нужна ссылка вида https://discord.com/api/webhooks/<id>/<token>', ['url' => 'Неверная ссылка вебхука']);
        }
        $c['url'] = $url;
    }
    if (array_key_exists('events', $b)) {
        if (!is_array($b['events'])) throw new ApiError('validation', 'Неверный список событий', ['events' => 'Неверный список']);
        foreach ($b['events'] as $k => $v) {
            if (!isset(WEBHOOK_EVENTS[$k]) || !is_bool($v)) throw new ApiError('validation', 'Неизвестное событие', ['events' => 'Неизвестное событие']);
            $c['events'][$k] = $v;
        }
    }
    setting_set('webhook', $c);
    return nt_webhook_view();
}

/** POST notify/webhook/test (админ) → статус отправки { at, ok, status, error, event } */
function route_notify_webhook_test(): array
{
    $me = require_admin();
    session_release();
    rate_limit_hit('webhook_test', user_subject($me['id']));
    $c = nt_webhook_conf();
    if ($c['url'] === '') throw new ApiError('validation', 'Сначала сохрани ссылку вебхука', ['url' => 'Сначала сохрани ссылку']);
    return nt_webhook_send($c['url'], 'test', [
        'title' => '🕷 Тест вебхука ndze.fun', 'url' => site_url(''),
        'description' => 'Если ты видишь это сообщение — сайт достучался до Discord. Сюда будут приходить эфиры, новости, ставки и розыгрыши.',
    ]);
}

/** GET notify/admin (админ) → { push: {...}, webhook: {...} } */
function route_notify_admin(): array
{
    require_admin();
    session_release();
    $r = q_one("SELECT COUNT(*) AS total, COALESCE(SUM(FIND_IN_SET('live', topics) > 0), 0) AS live, COALESCE(SUM(FIND_IN_SET('news', topics) > 0), 0) AS news,
        COALESCE(SUM(user_id IS NOT NULL), 0) AS users, COALESCE(SUM(fails > 0), 0) AS failing FROM push_subscriptions");
    $vapid = setting_get('vapid');
    $last = setting_get('push_last');
    $st = setting_get('push_status');
    return [
        'push' => [
            'total' => (int) $r['total'], 'live' => (int) $r['live'], 'news' => (int) $r['news'],
            'users' => (int) $r['users'], 'failing' => (int) $r['failing'],
            'keyReady' => nt_vapid_valid($vapid),
            'last' => is_array($last) ? array_intersect_key($last, array_flip(['title', 'body', 'url', 'topic', 'at'])) : null,
            'status' => is_array($st) ? $st : null,
        ],
        'webhook' => nt_webhook_view(),
    ];
}

/* ====================================================================
   Отложенная отправка (после ответа клиенту)
   ==================================================================== */

function nt_defer(callable $fn): void
{
    static $registered = false;
    $GLOBALS['NT_DEFER'][] = $fn;
    if (!$registered) {
        $registered = true;
        register_shutdown_function('nt_run_deferred');
    }
}

function nt_run_deferred(): void
{
    $jobs = $GLOBALS['NT_DEFER'] ?? [];
    $GLOBALS['NT_DEFER'] = [];
    if (!$jobs) return;
    ignore_user_abort(true);
    @set_time_limit(120);
    // ответ уже сформирован — отдаём его клиенту и рассылаем в фоне (PHP-FPM / LiteSpeed)
    if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
    elseif (function_exists('litespeed_finish_request')) @litespeed_finish_request();
    foreach ($jobs as $fn) {
        try {
            $fn();
        } catch (Throwable $e) {
            error_log('[ndze] notify deferred: ' . get_class($e) . ': ' . $e->getMessage());
        }
    }
}

/* ====================================================================
   Слушатели событий
   ==================================================================== */

function nt_str($v, int $max = 200): string
{
    return is_string($v) ? mb_substr(trim($v), 0, $max) : '';
}

// Начало эфира → push «live» + Discord
event_on('live.start', static function (array $d): void {
    $title = nt_str($d['title'] ?? null, 140);
    $game = nt_str($d['game'] ?? null, 60);
    $chan = is_string($d['channel'] ?? null) && preg_match('/^[A-Za-z0-9_]{3,25}$/D', $d['channel']) ? $d['channel'] : 'ndze_one';
    $url = 'https://www.twitch.tv/' . $chan;
    nt_defer(static fn() => nt_push_send([
        'title' => 'ndze в эфире' . ($title !== '' ? ": $title" : '!'),
        'body' => $game !== '' ? "Играем: $game · заходи 🕷" : 'Заходи на стрим 🕷',
        'url' => $url, 'tag' => 'live',
    ], 'live'));
    nt_webhook_emit('live', [
        'title' => '🔴 ndze в эфире!', 'url' => $url,
        'description' => trim(($title !== '' ? "**$title**" : '') . ($game !== '' ? "\nИгра: $game" : '') . "\n$url"),
    ]);
});

// Новая тема на форуме: «Новости» → push «news»; «Новости» и «Правила» → Discord
event_on('forum.thread', static function (array $d): void {
    $section = $d['section'] ?? '';
    if ($section !== 'news' && $section !== 'rules') return;
    $title = nt_str($d['title'] ?? null, 120);
    $excerpt = nt_str($d['excerpt'] ?? null, 300);
    $url = is_string($d['url'] ?? null) ? $d['url'] : site_url('forum.html');
    if ($section === 'news') {
        $id = is_string($d['id'] ?? null) ? $d['id'] : '';
        nt_defer(static fn() => nt_push_send(['title' => "Новость: $title", 'body' => $excerpt !== '' ? $excerpt : 'Читай на форуме', 'url' => $url, 'tag' => 'news-' . $id], 'news'));
    }
    nt_webhook_emit('news', [
        'title' => ($section === 'news' ? '📰 ' : '📜 Правила: ') . $title, 'url' => $url,
        'description' => $excerpt,
    ]);
});

event_on('task.created', static function (array $d): void {
    $t = is_array($d['task'] ?? null) ? $d['task'] : [];
    $game = nt_str($t['game'] ?? null, 30);
    nt_webhook_emit('task', [
        'title' => '🎯 Новое задание: ' . nt_str($t['title'] ?? null, 120), 'url' => site_url('tasks.html'),
        'description' => trim(nt_str($t['description'] ?? null, 400) . "\n" . ($game !== '' ? "Игра: $game · " : '') . 'от ' . nt_str($t['authorNick'] ?? null, 30)),
    ]);
});

event_on('prediction.open', static function (array $d): void {
    $p = is_array($d['prediction'] ?? null) ? $d['prediction'] : [];
    $opts = array_map(static fn($o) => '• ' . nt_str(is_array($o) ? ($o['text'] ?? null) : $o, 40), is_array($p['options'] ?? null) ? $p['options'] : []);
    nt_webhook_emit('prediction_open', [
        'title' => '🔮 Ставка: ' . nt_str($p['question'] ?? null, 160), 'url' => site_url('play.html#bets'),
        'description' => implode("\n", $opts) . "\n\nСтавь баллы на сайте — пока приём открыт.",
    ]);
});

event_on('prediction.resolve', static function (array $d): void {
    $p = is_array($d['prediction'] ?? null) ? $d['prediction'] : [];
    $res = $p['result'] ?? null;
    $win = is_int($res) && is_array($p['options'][$res] ?? null) ? nt_str($p['options'][$res]['text'] ?? null, 40) : '';
    nt_webhook_emit('prediction_resolve', [
        'title' => '🏁 Итоги ставки: ' . nt_str($p['question'] ?? null, 160), 'url' => site_url('play.html#bets'),
        'description' => ($win !== '' ? "Сыграл вариант: **$win**" : 'Ставка завершена') . (isset($p['totalPool']) ? "\nБанк: " . (int) $p['totalPool'] . ' баллов' : ''),
    ]);
});

event_on('wheel.spin', static function (array $d): void {
    $w = is_array($d['winner'] ?? null) ? $d['winner'] : [];
    $game = nt_str($w['game'] ?? null, 30);
    nt_webhook_emit('wheel', [
        'title' => '🎡 Колесо выбрало: ' . nt_str($w['title'] ?? null, 120), 'url' => site_url('tasks.html'),
        'description' => trim(($game !== '' ? "Игра: $game · " : '') . 'автор ' . nt_str($w['authorNick'] ?? null, 30) . ' · голосов: ' . (int) ($w['votes'] ?? 0)),
    ]);
});

// giveaway.drawn приходит из модуля розыгрышей: { giveaway: { title, prize }, winner: { nick } }
event_on('giveaway.drawn', static function (array $d): void {
    $g = is_array($d['giveaway'] ?? null) ? $d['giveaway'] : [];
    $nick = nt_str(is_array($d['winner'] ?? null) ? ($d['winner']['nick'] ?? null) : null, 30);
    nt_webhook_emit('giveaway', [
        'title' => '🎁 Розыгрыш: ' . nt_str($g['title'] ?? null, 120), 'url' => site_url('play.html#giveaways'),
        'description' => ($nick !== '' ? "Победитель — **$nick** 🎉" : 'Победителя нет') . (nt_str($g['prize'] ?? null) !== '' ? "\nПриз: " . nt_str($g['prize'] ?? null, 160) : ''),
    ]);
});

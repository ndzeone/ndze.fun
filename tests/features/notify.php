<?php
// Тесты модуля уведомлений (api/lib/features/notify.php): колокольчик, Web Push (VAPID), Discord-вебхук.
//
//   php tests/features/notify.php [http://127.0.0.1:8090]
//
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — тогда сбрасываются rate_limits и проверяются
// подрезка уведомлений (200 на пользователя), очистка ссылок и привязка подписки к пользователю.
// Тест ходит к fcm.googleapis.com (фейковая подписка) и discord.com (фейковый вебхук) — без связи эти проверки
// всё равно проходят: важно, что ошибка записана, а не что Discord ответил.
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

foreach (['curl', 'json', 'openssl'] as $ext) {
    if (!extension_loaded($ext)) { fwrite(STDERR, "Нужно расширение PHP: $ext\n"); exit(2); }
}

$BASE = rtrim((string) ($argv[1] ?? (getenv('API_BASE') ?: 'http://127.0.0.1:8090')), '/');
$ADMIN_EMAIL = getenv('TEST_ADMIN_EMAIL') ?: 'ndze-admin@example.com';
$ADMIN_PASS = getenv('TEST_ADMIN_PASS') ?: 'AdminTest_pw1';
$RUN = bin2hex(random_bytes(3));

/* ============================== Результаты ============================== */
$PASS = 0; $FAIL = 0; $FAILS = [];
function check(string $name, bool $cond, string $detail = ''): bool
{
    global $PASS, $FAIL, $FAILS;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; $FAILS[] = $name . ($detail !== '' ? " — $detail" : ''); echo "FAIL  $name" . ($detail !== '' ? " — $detail" : '') . "\n"; }
    return $cond;
}
function section(string $t): void { echo "\n== $t ==\n"; }
function info(string $t): void { echo "      · $t\n"; }

/* ============================== HTTP ============================== */
final class Actor
{
    public $ch;
    public ?array $user = null;
    public function __construct(public string $name) { $this->ch = curl_init(); }
}

function req(Actor $a, string $method, string $route, array $query = [], $body = null, array $opt = []): array
{
    global $BASE;
    $url = $BASE . '/api/index.php?' . http_build_query(['r' => $route] + $query, '', '&', PHP_QUERY_RFC3986);
    $ch = $a->ch;
    curl_reset($ch);
    $hdrs = ['Accept: application/json'];
    if ($method === 'POST' && ($opt['csrf'] ?? true)) $hdrs[] = 'X-Requested-With: ndze';
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_URL => $url, CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_COOKIEFILE => '', CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 90,
        CURLOPT_HEADERFUNCTION => static function ($c, string $line) use (&$respHeaders): int {
            $p = strpos($line, ':');
            if ($p !== false) $respHeaders[strtolower(trim(substr($line, 0, $p)))][] = trim(substr($line, $p + 1));
            return strlen($line);
        },
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        $hdrs[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, array_key_exists('raw', $opt) ? (string) $opt['raw'] : json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $t0 = microtime(true);
    $resBody = curl_exec($ch);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    if ($resBody === false) return ['status' => 0, 'body' => '', 'json' => null, 'err' => curl_error($ch), 'ms' => $ms];
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $r = ['status' => $status, 'body' => $resBody, 'json' => json_decode($resBody, true), 'err' => '', 'ms' => $ms];
    if ($status >= 500) check("no 500 on $method $route", false, short($resBody));
    if (preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace|Uncaught /', $resBody, $m)) check("no PHP/SQL leak in $method $route", false, $m[0]);
    return $r;
}
function short(string $s, int $n = 220): string { $s = preg_replace('/\s+/', ' ', $s); return mb_strlen($s) > $n ? mb_substr($s, 0, $n) . '…' : $s; }
function desc(array $r): string { return $r['status'] === 0 ? "connection error: {$r['err']}" : "HTTP {$r['status']} " . short($r['body']); }
function data(array $r) { return ($r['json']['ok'] ?? null) === true ? $r['json']['data'] : null; }
function isOk(array $r): bool { return $r['status'] === 200 && ($r['json']['ok'] ?? null) === true; }
function expectOk(string $name, array $r): bool { return check($name, isOk($r), desc($r)); }
function expectErr(string $name, array $r, $status, ?string $code = null, array $fields = []): bool
{
    $e = $r['json']['error'] ?? null;
    $good = in_array($r['status'], (array) $status, true) && ($r['json']['ok'] ?? null) === false && is_array($e)
        && ($code === null || ($e['code'] ?? null) === $code);
    foreach ($fields as $f) $good = $good && is_array($e['fields'] ?? null) && array_key_exists($f, $e['fields']);
    return check($name, $good, 'want ' . implode('/', (array) $status) . ($code ? " $code" : '') . ', got ' . desc($r));
}

/* ============================== БД (необязательно) ============================== */
$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try {
        $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    } catch (Throwable $e) {
        echo "WARN  TEST_DB_DSN задан, но подключиться не удалось: {$e->getMessage()}\n";
    }
}
function reset_rl(): void
{
    global $PDO;
    if ($PDO) $PDO->exec('DELETE FROM rate_limits');
}

function register(string $name): Actor
{
    global $RUN;
    $a = new Actor($name);
    $nick = substr($name, 0, 8) . '_' . $RUN;
    $r = req($a, 'POST', 'auth/register', [], ['nick' => $nick, 'email' => "nt-$name-$RUN@example.com", 'password' => 'TestPass_123']);
    $a->user = data($r);
    if (!$a->user) { echo "Не удалось зарегистрировать $name: " . desc($r) . "\n"; exit(1); }
    return $a;
}

/* ============================== Модуль в CLI: подпись VAPID ============================== */
// Подключаем notify.php напрямую (с заглушками платформы) и проверяем криптографию без сервера.
section('VAPID: ключи и подпись ES256 (юнит)');
define('NDZE', true);
function route_add(array $r): void {}
function rate_limit_define(string $a, int $l, int $w): void {}
function event_on(string $k, callable $fn): void {}
function cfg(string $p, $d = null) { return $d; }
function site_url(string $p = ''): string { return 'https://ndze.fun/' . ltrim($p, '/'); }
function json_encode_safe($v): string { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
function now_db(): string { return gmdate('Y-m-d H:i:s.000'); }
function iso(?string $dt): ?string { return $dt === null ? null : str_replace(' ', 'T', $dt) . 'Z'; }
require dirname(__DIR__, 2) . '/api/lib/features/notify.php';

/** raw r||s (64 байта) → DER для openssl_verify. */
function raw_to_der(string $raw): string
{
    $int = static function (string $x): string {
        $x = ltrim($x, "\0");
        if ($x === '' || ord($x[0]) & 0x80) $x = "\0" . $x;
        return "\x02" . chr(strlen($x)) . $x;
    };
    $body = $int(substr($raw, 0, 32)) . $int(substr($raw, 32, 32));
    return "\x30" . chr(strlen($body)) . $body;
}
/** Несжатая точка P-256 (65 байт) → PEM открытого ключа (SPKI). */
function point_to_pem(string $point): string
{
    $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

$keys = nt_vapid_generate();
$pub = nt_b64u_dec($keys['public']);
check('generated public key is 65-byte uncompressed point', $pub !== null && strlen($pub) === 65 && $pub[0] === "\x04");
check('public key is base64url without padding', (bool) preg_match('/^[A-Za-z0-9_-]{87}$/', $keys['public']));
check('private key is PEM', str_contains($keys['private'], 'PRIVATE KEY'));
check('nt_vapid_valid(generated)', nt_vapid_valid($keys));
check('nt_vapid_valid rejects garbage', !nt_vapid_valid(['private' => 'x', 'public' => 'abc']) && !nt_vapid_valid(null));

$okAll = true;
for ($i = 0; $i < 40; $i++) { // разные подписи — ловим r/s с ведущим нулём и с 0x80 в старшем байте
    $jwt = nt_vapid_jwt('https://fcm.googleapis.com/fcm/send/abc' . $i, $keys, 2000000000);
    [$h, $c, $s] = explode('.', $jwt);
    $raw = nt_b64u_dec($s);
    $okAll = $okAll && strlen((string) $raw) === 64
        && openssl_verify("$h.$c", raw_to_der($raw), point_to_pem($pub), OPENSSL_ALGO_SHA256) === 1;
}
check('40 JWT signatures verify with the published public key (raw r||s → DER)', $okAll);
$claims = json_decode((string) nt_b64u_dec(explode('.', $jwt)[1]), true);
$head = json_decode((string) nt_b64u_dec(explode('.', $jwt)[0]), true);
check('JWT header {typ: JWT, alg: ES256}', ($head['alg'] ?? '') === 'ES256' && ($head['typ'] ?? '') === 'JWT');
check('JWT aud = origin of push service', ($claims['aud'] ?? '') === 'https://fcm.googleapis.com');
check('JWT sub is https: or mailto:', (bool) preg_match('~^(https://|mailto:)~', (string) ($claims['sub'] ?? '')));
check('JWT exp kept', ($claims['exp'] ?? 0) === 2000000000);
check('der_to_raw rejects junk', nt_der_to_raw('xx') === null && nt_der_to_raw("\x30\x06\x02\x01\x01\x02\x01") === null);
check('der_to_raw pads short integers', nt_der_to_raw("\x30\x06\x02\x01\x05\x02\x01\x07") === str_repeat("\0", 31) . "\x05" . str_repeat("\0", 31) . "\x07");

// Живая проверка подписи: FCM сначала проверяет JWT (403 «invalid JWT»), и только потом ищет подписку (404/410).
$fakeFcm = 'https://fcm.googleapis.com/fcm/send/ndze-fake-' . bin2hex(random_bytes(8));
$good = nt_push_deliver([['id' => 1, 'endpoint' => $fakeFcm]], $keys)[1] ?? [0, 'нет ответа'];
$bad = nt_push_deliver([['id' => 1, 'endpoint' => $fakeFcm]], ['private' => $keys['private'], 'public' => nt_vapid_generate()['public']])[1] ?? [0, ''];
if ($good[0] === 0) info("fcm.googleapis.com недоступен ({$good[1]}) — живая проверка VAPID пропущена");
else {
    check("FCM accepts our VAPID JWT (fake token → {$good[0]}, not 401/403)", !in_array($good[0], [401, 403], true));
    check("FCM rejects JWT signed by another key (→ {$bad[0]})", in_array($bad[0], [401, 403], true));
}

foreach ([
    'https://fcm.googleapis.com/fcm/send/' . str_repeat('a', 20) => true,
    'https://updates.push.services.mozilla.com/wpush/v2/' . str_repeat('b', 20) => true,
    'https://web.push.apple.com/' . str_repeat('c', 30) => true,
    'https://wns2-par02p.notify.windows.com/w/?token=' . str_repeat('d', 20) => true,
    'http://fcm.googleapis.com/fcm/send/' . str_repeat('a', 20) => false,
    'https://fcm.googleapis.com.evil.com/fcm/send/' . str_repeat('a', 20) => false,
    'https://evil.com/fcm.googleapis.com/' . str_repeat('a', 20) => false,
    'https://user:pw@fcm.googleapis.com/fcm/send/' . str_repeat('a', 20) => false,
    'https://fcm.googleapis.com:8443/fcm/send/' . str_repeat('a', 20) => false,
    'https://notify.windows.com.evil.org/w/?token=' . str_repeat('d', 20) => false,
    'https://127.0.0.1/' . str_repeat('a', 30) => false,
] as $u => $want) {
    check(($want ? 'accepts ' : 'rejects ') . substr($u, 0, 60), nt_push_endpoint_ok($u) === $want);
}
check('nt_link keeps site pages', nt_link('forum.html#/t/abc/2') === 'forum.html#/t/abc/2' && nt_link('play.html#bets') === 'play.html#bets');
check('nt_link drops external/js links', nt_link('https://evil.com') === null && nt_link('javascript:alert(1)') === null && nt_link('//evil.com/a.html') === null);
check('webhook regex', (bool) preg_match(WEBHOOK_RE, 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-0123')
    && (bool) preg_match(WEBHOOK_RE, 'https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')
    && !preg_match(WEBHOOK_RE, 'https://discord.com.evil.io/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')
    && !preg_match(WEBHOOK_RE, 'http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')
    && !preg_match(WEBHOOK_RE, "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz\n"));
$mask = nt_webhook_mask('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzTOKN');
check('webhook mask hides token', $mask !== null && !str_contains($mask, 'abcdefghijkl') && str_ends_with($mask, 'TOKN'));

/* ============================== API ============================== */
reset_rl();
$guest = new Actor('guest');
$admin = new Actor('admin');
$r = req($admin, 'POST', 'auth/login', [], ['email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]);
$admin->user = data($r);
if (!$admin->user) { echo "Не удалось войти админом: " . desc($r) . "\n"; exit(1); }
$alice = register('ntalice');
$bob = register('ntbob');

section('Колокольчик: доступ и пустой список');
expectErr('guest GET notifications → 401', req($guest, 'GET', 'notifications'), 401, 'auth_required');
expectErr('guest POST notifications/read → 401', req($guest, 'POST', 'notifications/read', [], ['all' => true]), 401);
$r = req($alice, 'GET', 'notifications');
expectOk('alice GET notifications', $r);
check('fresh user: items [] and unread 0', data($r) === ['items' => [], 'unread' => 0], desc($r));

section('Колокольчик: уведомление от ответа на форуме');
$r = req($alice, 'POST', 'forum/thread', [], ['section' => 'talk', 'title' => "Тема для теста $RUN", 'body' => 'Проверяем колокольчик уведомлений, привет!']);
expectOk('alice creates forum thread', $r);
$thread = data($r)['id'] ?? '';
$r = req($bob, 'POST', 'forum/post', [], ['threadId' => $thread, 'body' => 'Ответ, который должен прозвенеть у alice']);
expectOk('bob replies', $r);
$r = req($alice, 'GET', 'notifications');
$items = data($r)['items'] ?? [];
$n = $items[0] ?? null;
check('alice has 1 unread forum notification', (data($r)['unread'] ?? null) === 1 && count($items) === 1, desc($r));
check('item shape {id:int, kind, text, link, read, createdAt}', is_array($n) && is_int($n['id']) && $n['kind'] === 'forum'
    && str_contains($n['text'], 'ответил') && str_starts_with((string) $n['link'], 'forum.html#/t/') && $n['read'] === false
    && preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/', (string) $n['createdAt']), json_encode($n, JSON_UNESCAPED_UNICODE));
$r = req($alice, 'GET', 'notifications', ['only' => 'unread']);
check('only=unread → {unread: 1} without items', data($r) === ['unread' => 1], desc($r));
$r = req($bob, 'GET', 'notifications');
check("bob doesn't see alice's notification", (data($r)['unread'] ?? -1) === 0 && (data($r)['items'] ?? null) === [], desc($r));

section('Колокольчик: отметка прочитанного');
expectErr('read without CSRF header → 403', req($alice, 'POST', 'notifications/read', [], ['ids' => [$n['id'] ?? 0]], ['csrf' => false]), 403, 'forbidden');
expectErr('read {} → 400', req($alice, 'POST', 'notifications/read', [], []), 400, 'validation', ['ids']);
expectErr('read ids [] → 400', req($alice, 'POST', 'notifications/read', [], ['ids' => []]), 400, 'validation');
expectErr('read ids ["abc"] → 400', req($alice, 'POST', 'notifications/read', [], ['ids' => ['abc']]), 400, 'validation');
expectErr('read ids [-1] → 400', req($alice, 'POST', 'notifications/read', [], ['ids' => [-1]]), 400, 'validation');
expectErr('read ids {"a":1} (object) → 400', req($alice, 'POST', 'notifications/read', [], ['ids' => ['a' => 1]]), 400, 'validation');
expectErr('read 101 ids → 400', req($alice, 'POST', 'notifications/read', [], ['ids' => range(1, 101)]), 400, 'validation');
expectErr('read all: "yes" → 400', req($alice, 'POST', 'notifications/read', [], ['all' => 'yes']), 400, 'validation');
$r = req($bob, 'POST', 'notifications/read', [], ['ids' => [$n['id'] ?? 0]]);
check("bob marking alice's id is a no-op", isOk($r) && (data(req($alice, 'GET', 'notifications', ['only' => 'unread']))['unread'] ?? null) === 1, desc($r));
$r = req($alice, 'POST', 'notifications/read', [], ['ids' => [$n['id'] ?? 0, (string) ($n['id'] ?? 0)]]);
check('alice marks it read → unread 0', isOk($r) && data($r) === ['unread' => 0], desc($r));
$r = req($alice, 'GET', 'notifications');
check('item now read: true', (data($r)['items'][0]['read'] ?? null) === true, desc($r));
req($bob, 'POST', 'forum/post', [], ['threadId' => $thread, 'body' => 'Ещё один ответ для «прочитать все»']);
check('second reply → unread 1', (data(req($alice, 'GET', 'notifications', ['only' => 'unread']))['unread'] ?? null) === 1);
$r = req($alice, 'POST', 'notifications/read', [], ['all' => true]);
check('read all → unread 0', isOk($r) && data($r) === ['unread' => 0], desc($r));

if ($PDO) {
    section('Колокольчик: ссылки и подрезка до 200 (через БД)');
    $uid = $alice->user['id'];
    $ins = $PDO->prepare('INSERT INTO notifications (user_id, kind, text, link, is_read, created_at) VALUES (?, ?, ?, ?, 0, UTC_TIMESTAMP(3))');
    $ins->execute([$uid, 'task', 'evil link', 'https://evil.com/']);
    $ins->execute([$uid, 'task', 'js link', 'javascript:alert(1)']);
    $r = req($alice, 'GET', 'notifications');
    $links = array_column(array_slice(data($r)['items'] ?? [], 0, 2), 'link');
    check('external / javascript: links are returned as null', $links === [null, null], json_encode($links));
    $PDO->beginTransaction();
    for ($i = 0; $i < 215; $i++) $ins->execute([$uid, 'bet', "Пачка $i", 'play.html#bets']);
    $PDO->commit();
    $r = req($alice, 'GET', 'notifications');
    $cnt = (int) $PDO->query('SELECT COUNT(*) FROM notifications WHERE user_id = ' . $PDO->quote($uid))->fetchColumn();
    check('GET returns 30 latest items', count(data($r)['items'] ?? []) === 30 && (data($r)['items'][0]['text'] ?? '') === 'Пачка 214', desc($r));
    check("prune keeps exactly 200 per user (got $cnt)", $cnt === 200);
    check('unread counter counts all unread (200)', (data($r)['unread'] ?? null) === 200);
    req($alice, 'POST', 'notifications/read', [], ['all' => true]);
}

section('Push: ключ и подписка');
$r = req($guest, 'GET', 'push/key');
$key = data($r)['key'] ?? '';
$raw = nt_b64u_dec((string) $key);
check('GET push/key (guest) → 65-byte base64url point', isOk($r) && $raw !== null && strlen($raw) === 65 && $raw[0] === "\x04", desc($r));
check('push/key is stable', (data(req($guest, 'GET', 'push/key'))['key'] ?? '') === $key);
check('push/key response has no private key', !str_contains($r['body'], 'PRIVATE'));

$p256 = nt_b64u(nt_b64u_dec(nt_vapid_generate()['public']));
$auth = nt_b64u(random_bytes(16));
$ep1 = 'https://fcm.googleapis.com/fcm/send/ndze-test-' . $RUN . '-' . bin2hex(random_bytes(12));
$ep2 = 'https://updates.push.services.mozilla.com/wpush/v2/ndze-test-' . $RUN . bin2hex(random_bytes(20));
$sub = static fn(string $ep, array $topics = ['live', 'news'], ?string $p = null, ?string $a = null) => ['endpoint' => $ep, 'keys' => ['p256dh' => $p ?? $p256, 'auth' => $a ?? $auth], 'topics' => $topics];

reset_rl();
expectErr('subscribe without CSRF → 403', req($guest, 'POST', 'push/subscribe', [], $sub($ep1), ['csrf' => false]), 403);
expectErr('subscribe http:// endpoint → 400', req($guest, 'POST', 'push/subscribe', [], $sub(str_replace('https:', 'http:', $ep1))), 400, 'validation', ['endpoint']);
expectErr('subscribe unknown host → 400', req($guest, 'POST', 'push/subscribe', [], $sub('https://evil.example.com/push/' . str_repeat('x', 30))), 400, 'validation', ['endpoint']);
expectErr('subscribe internal host (SSRF) → 400', req($guest, 'POST', 'push/subscribe', [], $sub('https://169.254.169.254/latest/meta-data/' . str_repeat('x', 10))), 400, 'validation');
expectErr('subscribe endpoint as array → 400', req($guest, 'POST', 'push/subscribe', [], ['endpoint' => [$ep1]] + $sub($ep1)), 400, 'validation');
expectErr('subscribe bad p256dh → 400', req($guest, 'POST', 'push/subscribe', [], $sub($ep1, ['live'], 'abc')), 400, 'validation', ['keys']);
expectErr('subscribe bad auth → 400', req($guest, 'POST', 'push/subscribe', [], $sub($ep1, ['live'], null, nt_b64u(random_bytes(8)))), 400, 'validation', ['keys']);
expectErr('subscribe topics [] → 400', req($guest, 'POST', 'push/subscribe', [], $sub($ep1, [])), 400, 'validation', ['topics']);
expectErr('subscribe topics ["spam"] → 400', req($guest, 'POST', 'push/subscribe', [], $sub($ep1, ['spam'])), 400, 'validation', ['topics']);
$r = req($guest, 'POST', 'push/subscribe', [], $sub($ep1, ['news', 'live', 'live']));
check('guest subscribe → {subscribed, topics: [live, news]}', isOk($r) && data($r) === ['subscribed' => true, 'topics' => ['live', 'news']], desc($r));
$r = req($guest, 'POST', 'push/state', [], ['endpoint' => $ep1]);
check('push/state → subscribed, topics', data($r) === ['subscribed' => true, 'topics' => ['live', 'news']], desc($r));
$r = req($alice, 'POST', 'push/subscribe', [], $sub($ep1, ['news']));
check('same endpoint re-subscribe (alice) updates topics', data($r) === ['subscribed' => true, 'topics' => ['news']], desc($r));
check('push/state reflects new topics', (data(req($guest, 'POST', 'push/state', [], ['endpoint' => $ep1]))['topics'] ?? null) === ['news']);
if ($PDO) {
    $row = $PDO->query('SELECT user_id, topics, COUNT(*) OVER () AS n FROM push_subscriptions WHERE endpoint_hash = ' . $PDO->quote(hash('sha256', $ep1)))->fetch();
    check('one row per endpoint, linked to alice', $row && $row['user_id'] === $alice->user['id'] && $row['topics'] === 'news' && (int) $row['n'] === 1, json_encode($row));
    req($guest, 'POST', 'push/subscribe', [], $sub($ep1, ['live', 'news']));
    $row = $PDO->query('SELECT user_id FROM push_subscriptions WHERE endpoint_hash = ' . $PDO->quote(hash('sha256', $ep1)))->fetch();
    check('guest re-subscribe keeps user link', $row && $row['user_id'] === $alice->user['id']);
}
$r = req($guest, 'POST', 'push/subscribe', [], $sub($ep2, ['live']));
expectOk('mozilla endpoint subscribe', $r);
$r = req($guest, 'POST', 'push/unsubscribe', [], ['endpoint' => $ep2]);
check('unsubscribe → {subscribed:false}', data($r) === ['subscribed' => false], desc($r));
check('push/state after unsubscribe → false', (data(req($guest, 'POST', 'push/state', [], ['endpoint' => $ep2]))['subscribed'] ?? null) === false);
expectErr('unsubscribe bad endpoint → 400', req($guest, 'POST', 'push/unsubscribe', [], ['endpoint' => 'nope']), 400, 'validation');

section('Push: лимит подписок с одного IP');
reset_rl();
$hit429 = false;
for ($i = 0; $i < 25 && !$hit429; $i++) {
    $r = req($guest, 'POST', 'push/unsubscribe', [], ['endpoint' => $ep2 . 'x' . $i]);
    if ($r['status'] === 429) $hit429 = true;
}
check('push/subscribe+unsubscribe rate-limited per IP (429 within 25 calls)', $hit429 || !$PDO, $PDO ? '' : 'без TEST_DB_DSN лимит мог быть уже израсходован');
reset_rl();

section('Push: пульт и тестовая рассылка');
expectErr('guest notify/admin → 401', req($guest, 'GET', 'notify/admin'), 401);
expectErr('user notify/admin → 403', req($alice, 'GET', 'notify/admin'), 403, 'forbidden');
expectErr('user push/test → 403', req($alice, 'POST', 'push/test'), 403, 'forbidden');
$r = req($admin, 'GET', 'notify/admin');
$adm = data($r);
check('admin notify/admin shape', isOk($r) && isset($adm['push']['total'], $adm['push']['live'], $adm['push']['news']) && $adm['push']['keyReady'] === true
    && array_key_exists('configured', $adm['webhook'] ?? []) && count($adm['webhook']['labels'] ?? []) === 7, desc($r));
check('subscriber count includes our endpoint', ($adm['push']['total'] ?? 0) >= 1 && ($adm['push']['news'] ?? 0) >= 1);
check('admin view never contains the VAPID private key', !str_contains($r['body'], 'PRIVATE'));

$r = req($admin, 'POST', 'push/test');
$st = data($r);
check('admin push/test → stats {sent, ok, removed, failed, error}', isOk($r) && is_int($st['sent'] ?? null) && $st['sent'] >= 1
    && $st['ok'] + $st['removed'] + $st['failed'] === $st['sent'], desc($r));
info('push/test → ' . json_encode($st, JSON_UNESCAPED_UNICODE) . " за {$r['ms']} мс");
$r = req($guest, 'GET', 'push/latest');
check('push/latest after test → test message', (data($r)['title'] ?? '') === 'Тест push-уведомлений' && (data($r)['tag'] ?? '') === 'test', desc($r));
check('push/latest has only {title, body, url, tag}', array_keys(data($r) ?? []) === ['title', 'body', 'url', 'tag']);
$state = data(req($guest, 'POST', 'push/state', [], ['endpoint' => $ep1]));
if ($PDO) {
    $row = $PDO->query('SELECT fails FROM push_subscriptions WHERE endpoint_hash = ' . $PDO->quote(hash('sha256', $ep1)))->fetch();
    check('fake FCM endpoint: deleted (404/410) or fails incremented', $row === false || (int) $row['fails'] >= 1, json_encode($row));
    // ошибка, не 404/410 → fails + 1; на пятой подписка удаляется
    $ep3 = 'https://web.push.apple.com/ndze-test-' . $RUN . bin2hex(random_bytes(16));
    $PDO->prepare('INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth, topics, created_at, fails) VALUES (NULL, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), 4)')
        ->execute([hash('sha256', $ep3), $ep3, $p256, $auth, 'live']);
    $r = req($admin, 'POST', 'push/test');
    info('push/test (apple, fails=4) → ' . json_encode(data($r), JSON_UNESCAPED_UNICODE));
    $gone = $PDO->query('SELECT COUNT(*) FROM push_subscriptions WHERE endpoint_hash = ' . $PDO->quote(hash('sha256', $ep3)))->fetchColumn();
    check('failing subscription (4 → 5 failures, or 404/410) is removed', (int) $gone === 0 && (data($r)['sent'] ?? 0) >= 1, desc($r));
}
$r = req($admin, 'GET', 'notify/admin');
check('push status recorded in admin view', is_array(data($r)['push']['status'] ?? null) && (data($r)['push']['last']['title'] ?? '') === 'Тест push-уведомлений', desc($r));

section('Discord-вебхук');
$hook = 'https://discord.com/api/webhooks/1234567890' . random_int(10000000, 99999999) . '/ndzeTestToken_' . $RUN . 'abcdefghijklmnopqrstuvwxyz0123';
expectErr('user notify/webhook → 403', req($alice, 'POST', 'notify/webhook', [], ['url' => $hook]), 403);
expectErr('user webhook test → 403', req($alice, 'POST', 'notify/webhook/test'), 403);
expectErr('webhook save without CSRF → 403', req($admin, 'POST', 'notify/webhook', [], ['url' => $hook], ['csrf' => false]), 403);
expectErr('webhook: evil host → 400', req($admin, 'POST', 'notify/webhook', [], ['url' => 'https://evil.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz']), 400, 'validation', ['url']);
expectErr('webhook: http:// → 400', req($admin, 'POST', 'notify/webhook', [], ['url' => str_replace('https:', 'http:', $hook)]), 400, 'validation', ['url']);
expectErr('webhook: not a webhook path → 400', req($admin, 'POST', 'notify/webhook', [], ['url' => 'https://discord.com/channels/123456789/123456789']), 400, 'validation', ['url']);
expectErr('webhook: unknown event → 400', req($admin, 'POST', 'notify/webhook', [], ['events' => ['hack' => true]]), 400, 'validation', ['events']);
expectErr('webhook: non-bool toggle → 400', req($admin, 'POST', 'notify/webhook', [], ['events' => ['live' => 'yes']]), 400, 'validation', ['events']);
$prev = data(req($admin, 'GET', 'notify/admin'))['webhook'] ?? null;
$r = req($admin, 'POST', 'notify/webhook', [], ['url' => $hook, 'events' => ['task' => true, 'news' => true, 'live' => false]]);
$w = data($r);
check('admin saves webhook → configured, masked', isOk($r) && $w['configured'] === true && is_string($w['masked']) && str_starts_with($w['masked'], 'https://discord.com/api/webhooks/'), desc($r));
check('saved response does not leak the token', !str_contains($r['body'], 'ndzeTestToken_'));
check('toggles saved', ($w['events']['task'] ?? null) === true && ($w['events']['live'] ?? null) === false && ($w['events']['news'] ?? null) === true);
$r = req($admin, 'GET', 'notify/admin');
check('admin view does not leak the token', isOk($r) && !str_contains($r['body'], 'ndzeTestToken_'));
$r = req($admin, 'POST', 'notify/webhook', [], ['events' => ['wheel' => false]]);
check('events-only update keeps url', (data($r)['configured'] ?? null) === true && (data($r)['events']['wheel'] ?? null) === false && (data($r)['events']['task'] ?? null) === true, desc($r));

$r = req($admin, 'POST', 'notify/webhook/test');
$ws = data($r);
check('webhook test → status {at, ok, status, error, event:test}', isOk($r) && is_bool($ws['ok'] ?? null) && is_int($ws['status'] ?? null) && ($ws['event'] ?? '') === 'test', desc($r));
check('fake webhook is reported as failed with a Russian error', ($ws['ok'] ?? true) === false && is_string($ws['error'] ?? null) && $ws['error'] !== '', json_encode($ws, JSON_UNESCAPED_UNICODE));
info('webhook test → ' . json_encode($ws, JSON_UNESCAPED_UNICODE));
$r = req($admin, 'GET', 'notify/admin');
check('last webhook status shown in admin view', (data($r)['webhook']['status']['event'] ?? '') === 'test');

section('События: новость на форуме → push «news» + вебхук');
$r = req($admin, 'POST', 'forum/thread', [], ['section' => 'news', 'title' => "Новость теста $RUN", 'body' => 'Тестовая новость: проверяем push и Discord-вебхук.']);
expectOk('admin posts news thread', $r);
$newsId = data($r)['id'] ?? '';
info("ответ на создание новости: {$r['ms']} мс");
$latest = null;
$hookEvent = null;
for ($i = 0; $i < 40; $i++) { // рассылка идёт после ответа — ждём до ~20 с
    $latest = data(req($guest, 'GET', 'push/latest'));
    $hookEvent = data(req($admin, 'GET', 'notify/admin'))['webhook']['status']['event'] ?? null;
    if (($latest['title'] ?? '') === "Новость: Новость теста $RUN" && $hookEvent === 'news') break;
    usleep(500000);
}
check('push/latest describes the news', ($latest['title'] ?? '') === "Новость: Новость теста $RUN" && str_contains((string) $latest['url'], "forum.html#/t/$newsId") && ($latest['tag'] ?? '') === "news-$newsId", json_encode($latest, JSON_UNESCAPED_UNICODE));
check('webhook got the news event', $hookEvent === 'news', (string) $hookEvent);
$r = req($admin, 'POST', 'forum/thread', [], ['section' => 'talk', 'title' => "Обычная тема $RUN", 'body' => 'Это не новость, push не нужен.']);
$talkId = data($r)['id'] ?? '';
usleep(1500000);
check('ordinary forum thread does not change push/latest', (data(req($guest, 'GET', 'push/latest'))['title'] ?? '') === "Новость: Новость теста $RUN");

section('Уборка');
$r = req($admin, 'POST', 'notify/webhook', [], ['url' => '']);
check('admin clears webhook', (data($r)['configured'] ?? null) === false && data($r)['masked'] === null, desc($r));
if ($prev && !empty($prev['events'])) req($admin, 'POST', 'notify/webhook', [], ['events' => $prev['events']]);
req($guest, 'POST', 'push/unsubscribe', [], ['endpoint' => $ep1]);
foreach ([$newsId, $talkId] as $id) if ($id) req($admin, 'POST', 'forum/delete', [], ['kind' => 'thread', 'id' => $id]);
if ($thread) req($alice, 'POST', 'forum/delete', [], ['kind' => 'thread', 'id' => $thread]);
if ($PDO) $PDO->exec("DELETE FROM push_subscriptions WHERE endpoint LIKE '%ndze-test-%'");
reset_rl();

echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
if ($FAILS) { echo "Failures:\n"; foreach ($FAILS as $f) echo "  - $f\n"; }
exit($FAIL ? 1 : 0);

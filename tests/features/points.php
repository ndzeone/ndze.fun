<?php
// Интеграционные тесты экономики баллов (api/lib/features/points.php):
// магазин, ежедневный бонус, сезоны и награды, команды, рамки аватарок.
//
//   php tests/features/points.php [http://127.0.0.1:8090]
//
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — тогда дополнительно проверяются
// серия 7 дней, награды прошлого сезона, «примеры» в пустом магазине и уведомления (через прямой доступ к БД).
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

$BASE = rtrim((string) ($argv[1] ?? (getenv('API_BASE') ?: 'http://127.0.0.1:8090')), '/');
$ADMIN_EMAIL = getenv('TEST_ADMIN_EMAIL') ?: 'ndze-admin@example.com';
$ADMIN_PASS = getenv('TEST_ADMIN_PASS') ?: 'AdminTest_pw1';
$RUN = bin2hex(random_bytes(3));

/* ---------- Результаты ---------- */
$PASS = 0; $FAIL = 0;
function check(string $name, bool $cond, string $detail = ''): bool
{
    global $PASS, $FAIL;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; echo "FAIL  $name" . ($detail !== '' ? " — $detail" : '') . "\n"; }
    return $cond;
}
function section(string $t): void { echo "\n== $t ==\n"; }

/* ---------- HTTP ---------- */
final class Actor
{
    public $ch;
    public ?array $user = null;
    public function __construct(public string $name) { $this->ch = curl_init(); }
    public function cookie(string $name): ?string
    {
        foreach (curl_getinfo($this->ch, CURLINFO_COOKIELIST) ?: [] as $line) {
            $p = explode("\t", $line);
            if (count($p) >= 7 && $p[5] === $name) return $p[6];
        }
        return null;
    }
}

function url_of(string $route, array $query = []): string
{
    global $BASE;
    return $BASE . '/api/index.php?' . http_build_query(['r' => $route] + $query, '', '&', PHP_QUERY_RFC3986);
}

function req(Actor $a, string $method, string $route, array $query = [], $body = null, array $opt = []): array
{
    $ch = $a->ch;
    curl_reset($ch);
    $hdrs = ['Accept: application/json'];
    if ($method === 'POST' && ($opt['csrf'] ?? true)) $hdrs[] = 'X-Requested-With: ndze';
    curl_setopt_array($ch, [CURLOPT_URL => url_of($route, $query), CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEFILE => '', CURLOPT_TIMEOUT => 60]);
    if ($method === 'POST') {
        $hdrs[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $res = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $r = ['status' => $status, 'body' => (string) $res, 'json' => json_decode((string) $res, true)];
    if ($status >= 500 || preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace/', (string) $res)) check("no server error in $method $route", false, short((string) $res));
    return $r;
}

/** Параллельные POST от нескольких актёров (гонки). */
function parallel_post(array $jobs): array
{
    $mh = curl_multi_init();
    $hs = [];
    foreach ($jobs as $i => [$actor, $route, $body]) {
        $h = curl_init(url_of($route));
        curl_setopt_array($h, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_TIMEOUT => 60,
            CURLOPT_POSTFIELDS => json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'X-Requested-With: ndze', 'Content-Type: application/json', 'Cookie: ndze_sid=' . $actor->cookie('ndze_sid')],
        ]);
        curl_multi_add_handle($mh, $h);
        $hs[$i] = $h;
    }
    do {
        $st = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running && $st === CURLM_OK);
    $out = [];
    foreach ($hs as $i => $h) {
        $out[$i] = ['status' => (int) curl_getinfo($h, CURLINFO_RESPONSE_CODE), 'json' => json_decode((string) curl_multi_getcontent($h), true)];
        curl_multi_remove_handle($mh, $h);
    }
    curl_multi_close($mh);
    return $out;
}

function short(string $s, int $n = 240): string { $s = preg_replace('/\s+/', ' ', $s); return mb_strlen($s) > $n ? mb_substr($s, 0, $n) . '…' : $s; }
function desc(array $r): string { return "HTTP {$r['status']} " . short($r['body'] ?? json_encode($r['json'], JSON_UNESCAPED_UNICODE)); }
function data(array $r) { return ($r['json']['ok'] ?? null) === true ? $r['json']['data'] : null; }
function isOk(array $r): bool { return $r['status'] === 200 && ($r['json']['ok'] ?? null) === true; }
function expectOk(string $name, array $r): bool { return check($name, isOk($r), desc($r)); }
function expectErr(string $name, array $r, int $status, ?string $code = null, array $fields = []): bool
{
    $e = $r['json']['error'] ?? null;
    $good = $r['status'] === $status && ($r['json']['ok'] ?? null) === false && is_array($e) && is_string($e['message'] ?? null)
        && ($code === null || ($e['code'] ?? null) === $code);
    foreach ($fields as $f) $good = $good && is_array($e['fields'] ?? null) && array_key_exists($f, $e['fields']);
    return check($name, $good, "want $status" . ($code ? " $code" : '') . ($fields ? ' fields[' . implode(',', $fields) . ']' : '') . ', got ' . desc($r));
}

/* ---------- БД (необязательно) ---------- */
$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try {
        $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $PDO->exec("SET time_zone = '+00:00'");
    } catch (Throwable $e) {
        echo "WARN  БД недоступна: {$e->getMessage()}\n";
        $PDO = null;
    }
}
function reset_rl(): void { global $PDO; if ($PDO) $PDO->exec('DELETE FROM rate_limits'); }
function db_one(string $sql, array $p = []): ?array { global $PDO; $st = $PDO->prepare($sql); $st->execute($p); $r = $st->fetch(); return $r === false ? null : $r; }
function db_exec(string $sql, array $p = []): void { global $PDO; $PDO->prepare($sql)->execute($p); }

function register(Actor $a, string $nick): array
{
    global $RUN;
    $r = req($a, 'POST', 'auth/register', [], ['nick' => $nick, 'email' => strtolower($nick) . "@example.com", 'password' => 'Test_pw_' . $RUN]);
    if (isOk($r)) $a->user = data($r);
    return $r;
}
function balance(Actor $a): int { return (int) (data(req($a, 'GET', 'shop'))['balance'] ?? -1); }

echo "API base: $BASE   run: $RUN   DB: " . ($PDO ? 'yes' : 'no') . "\n";
reset_rl();

$guest = new Actor('guest');
$admin = new Actor('admin');
$u1 = new Actor('u1');
$u2 = new Actor('u2');
$u3 = new Actor('u3');

section('accounts');
expectOk('admin login', req($admin, 'POST', 'auth/login', [], ['email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]));
foreach ([$u1, $u2, $u3] as $i => $a) expectOk("register {$a->name}", register($a, "pt{$i}_$RUN"));

/* ================= Магазин ================= */
section('shop: authz & validation');
$r = req($guest, 'GET', 'shop');
expectOk('guest GET shop', $r);
check('guest balance is null', array_key_exists('balance', data($r) ?? []) && data($r)['balance'] === null);
expectErr('guest buy → 401', req($guest, 'POST', 'shop/buy', [], ['itemId' => '00000000-0000-4000-8000-000000000000']), 401, 'auth_required');
expectErr('user create item → 403', req($u1, 'POST', 'shop/item', [], ['title' => 'Взлом', 'cost' => 1]), 403, 'forbidden');
expectErr('user GET shop/orders → 403', req($u1, 'GET', 'shop/orders'), 403, 'forbidden');
expectErr('user GET shop/admin → 403', req($u1, 'GET', 'shop/admin'), 403, 'forbidden');
expectErr('guest GET shop/admin → 401', req($guest, 'GET', 'shop/admin'), 401, 'auth_required');
expectErr('user order update → 403', req($u1, 'POST', 'shop/order', [], ['id' => '00000000-0000-4000-8000-000000000000', 'status' => 'refunded']), 403, 'forbidden');
expectErr('user seed → 403', req($u1, 'POST', 'shop/seed'), 403, 'forbidden');
expectErr('POST without CSRF header → 403', req($admin, 'POST', 'shop/item', [], ['title' => 'Без CSRF', 'cost' => 5], ['csrf' => false]), 403, 'forbidden');
expectErr('item: bad fields', req($admin, 'POST', 'shop/item', [], ['title' => 'x', 'cost' => 0, 'stock' => -1, 'icon' => '<script>']), 400, 'validation', ['title', 'cost', 'stock', 'icon']);
expectErr('item: title > 80', req($admin, 'POST', 'shop/item', [], ['title' => str_repeat('я', 81), 'cost' => 10]), 400, 'validation', ['title']);
expectErr('item: cost string', req($admin, 'POST', 'shop/item', [], ['title' => 'Норм', 'cost' => 'много']), 400, 'validation', ['cost']);
expectErr('item: unknown id → 404', req($admin, 'POST', 'shop/item', [], ['id' => '00000000-0000-4000-8000-000000000000', 'title' => 'Норм', 'cost' => 10]), 404, 'not_found');

if ($PDO) {
    section('shop: examples (empty shop)');
    db_exec('DELETE FROM shop_orders');
    db_exec('DELETE FROM shop_items');
    $r = req($admin, 'POST', 'shop/seed');
    expectOk('seed empty shop', $r);
    $titles = array_column(data($r)['items'] ?? [], 'cost', 'title');
    check('4 examples with right prices', $titles === ['Заказать трек' => 300, 'Ник в титрах стрима' => 500, 'Задание вне очереди' => 800, 'Выбрать игру на стрим' => 1500], json_encode($titles, JSON_UNESCAPED_UNICODE));
    expectErr('seed again → 400', req($admin, 'POST', 'shop/seed'), 400, 'validation');
}

section('shop: admin CRUD');
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Трек $RUN", 'description' => 'Поставлю трек', 'icon' => '🎵', 'cost' => 300, 'stock' => 1, 'active' => true, 'sort' => 1]);
expectOk('create item (stock 1)', $r);
$track = data($r);
check('item view', ($track['cost'] ?? 0) === 300 && ($track['stock'] ?? null) === 1 && ($track['active'] ?? null) === true && ($track['icon'] ?? '') === '🎵', json_encode($track, JSON_UNESCAPED_UNICODE));
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Дорогое $RUN", 'cost' => 999999, 'stock' => null]);
expectOk('create expensive unlimited item', $r);
$pricey = data($r);
check('stock null = unlimited', array_key_exists('stock', $pricey ?? []) && $pricey['stock'] === null);
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Скрытое $RUN", 'cost' => 10, 'active' => false]);
expectOk('create inactive item', $r);
$hidden = data($r);
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Дёшево $RUN", 'cost' => 50, 'stock' => '', 'sort' => '-5']);
expectOk('create cheap item (string sort)', $r);
$cheap = data($r);
$r = req($admin, 'POST', 'shop/item', [], ['id' => $cheap['id'], 'title' => "Дёшево $RUN!", 'description' => 'обновлено', 'cost' => 60, 'stock' => 5]);
expectOk('update item', $r);
check('update applied', (data($r)['cost'] ?? 0) === 60 && (data($r)['stock'] ?? 0) === 5 && (data($r)['title'] ?? '') === "Дёшево $RUN!");
$list = data(req($guest, 'GET', 'shop'))['items'] ?? [];
$ids = array_column($list, 'id');
check('public shop shows active items only', in_array($track['id'], $ids, true) && !in_array($hidden['id'], $ids, true));
check('public item has no admin fields', !array_key_exists('active', $list[0] ?? ['active' => 1]));

section('shop: buying');
$b0 = balance($u1);
check('start balance 1000', $b0 === 1000, (string) $b0);
expectErr('buy: bad itemId', req($u1, 'POST', 'shop/buy', [], ['itemId' => 'nope']), 400, 'validation', ['itemId']);
expectErr('buy: unknown item → 404', req($u1, 'POST', 'shop/buy', [], ['itemId' => '00000000-0000-4000-8000-000000000000']), 404, 'not_found');
expectErr('buy: inactive → 404', req($u1, 'POST', 'shop/buy', [], ['itemId' => $hidden['id']]), 404, 'not_found');
expectErr('buy: note > 300', req($u1, 'POST', 'shop/buy', [], ['itemId' => $track['id'], 'note' => str_repeat('а', 301)]), 400, 'validation', ['note']);
expectErr('buy: not enough points', req($u1, 'POST', 'shop/buy', [], ['itemId' => $pricey['id']]), 400, 'validation');
check('failed buys did not spend', balance($u1) === 1000);
$r = req($u1, 'POST', 'shop/buy', [], ['itemId' => $track['id'], 'note' => '<b>Linkin Park</b> — Numb']);
expectOk('buy track', $r);
$order = data($r)['order'] ?? [];
check('balance 700 after buy', (data($r)['balance'] ?? 0) === 700 && balance($u1) === 700);
check('order pending, note stored raw', ($order['status'] ?? '') === 'pending' && ($order['note'] ?? '') === '<b>Linkin Park</b> — Numb' && ($order['cost'] ?? 0) === 300);
check('stock decremented to 0 / soldOut', (data($r)['item']['stock'] ?? null) === 0 && (data($r)['item']['soldOut'] ?? false) === true);
expectErr('second buyer: sold out', req($u2, 'POST', 'shop/buy', [], ['itemId' => $track['id']]), 400, 'validation');
check('my orders in GET shop', (data(req($u1, 'GET', 'shop'))['orders'][0]['id'] ?? '') === ($order['id'] ?? 'x'));
check('other user does not see my orders', !in_array($order['id'] ?? 'x', array_column(data(req($u2, 'GET', 'shop'))['orders'] ?? [], 'id'), true));

section('shop: race — 3 buyers, stock 1');
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Гонка $RUN", 'cost' => 10, 'stock' => 1]);
$race = data($r);
$res = parallel_post([[$u1, 'shop/buy', ['itemId' => $race['id']]], [$u2, 'shop/buy', ['itemId' => $race['id']]], [$u3, 'shop/buy', ['itemId' => $race['id']]]]);
$wins = count(array_filter($res, static fn($x) => $x['status'] === 200));
check('exactly one buyer wins', $wins === 1, json_encode(array_column($res, 'status')));
$item = null;
foreach (data(req($admin, 'GET', 'shop/admin'))['items'] ?? [] as $it) if ($it['id'] === $race['id']) $item = $it;
check('race stock = 0, 1 order', ($item['stock'] ?? -1) === 0 && ($item['orders'] ?? 0) === 1, json_encode($item, JSON_UNESCAPED_UNICODE));

section('shop: race — one user, parallel buys beyond balance');
$r = req($admin, 'POST', 'shop/item', [], ['title' => "Жадина $RUN", 'cost' => 400, 'stock' => null]);
$greedy = data($r);
$bal3 = balance($u3);
$res = parallel_post(array_fill(0, 4, [$u3, 'shop/buy', ['itemId' => $greedy['id']]]));
$ok = count(array_filter($res, static fn($x) => $x['status'] === 200));
check('never below zero', balance($u3) >= 0 && $ok === intdiv($bal3, 400), "ok=$ok bal=" . balance($u3) . " start=$bal3");
reset_rl();

section('shop: orders queue');
$r = req($admin, 'GET', 'shop/orders');
expectOk('admin GET shop/orders', $r);
$q = data($r);
check('pending first + user info', ($q['items'][0]['status'] ?? '') === 'pending' && isset($q['items'][0]['user']['nick']) && $q['pendingCount'] >= 1);
expectOk('filter status=done', req($admin, 'GET', 'shop/orders', ['status' => 'done']));
expectErr('order: bad status', req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'pending']), 400, 'validation');
expectErr('order: unknown id', req($admin, 'POST', 'shop/order', [], ['id' => '00000000-0000-4000-8000-000000000000', 'status' => 'done']), 404, 'not_found');
expectErr('order: admin note > 300', req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'done', 'adminNote' => str_repeat('я', 301)]), 400, 'validation', ['adminNote']);
$b1 = balance($u1);
$r = req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'done', 'adminNote' => 'Поставил!']);
expectOk('mark done', $r);
check('done + note', (data($r)['status'] ?? '') === 'done' && (data($r)['adminNote'] ?? '') === 'Поставил!');
check('done does not change balance', balance($u1) === $b1);
$r = req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'refunded', 'adminNote' => 'Передумали']);
expectOk('refund', $r);
check('refund returns 300', balance($u1) === $b1 + 300, (string) (balance($u1) - $b1));
expectOk('refund again (note only)', req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'refunded']));
$res = parallel_post([[$admin, 'shop/order', ['id' => $order['id'], 'status' => 'refunded']], [$admin, 'shop/order', ['id' => $order['id'], 'status' => 'refunded']]]);
check('no double refund', balance($u1) === $b1 + 300, (string) (balance($u1) - $b1));
expectErr('refunded → done blocked', req($admin, 'POST', 'shop/order', [], ['id' => $order['id'], 'status' => 'done']), 400, 'validation');
$item = null;
foreach (data(req($admin, 'GET', 'shop/admin'))['items'] ?? [] as $it) if ($it['id'] === $track['id']) $item = $it;
check('refund restored stock to 1', ($item['stock'] ?? -1) === 1);
if ($PDO) {
    $n = db_one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'shop'", [$u1->user['id']]);
    check('buyer notified (done + refund)', (int) $n['n'] === 2, (string) $n['n']);
    $n = db_one("SELECT COUNT(*) AS n FROM points_ledger WHERE reason = 'shop_refund' AND ref = ?", [$order['id']]);
    check('exactly one refund row in ledger', (int) $n['n'] === 1);
}

section('shop: delete');
expectErr('delete item with orders → 400', req($admin, 'POST', 'shop/item/delete', [], ['id' => $track['id']]), 400, 'validation');
expectOk('delete item without orders', req($admin, 'POST', 'shop/item/delete', [], ['id' => $hidden['id']]));
expectErr('delete again → 404', req($admin, 'POST', 'shop/item/delete', [], ['id' => $hidden['id']]), 404, 'not_found');
expectErr('user delete → 403', req($u1, 'POST', 'shop/item/delete', [], ['id' => $cheap['id']]), 403, 'forbidden');

/* ================= Ежедневный бонус ================= */
section('daily bonus');
expectErr('guest GET daily → 401', req($guest, 'GET', 'daily'), 401, 'auth_required');
expectErr('guest claim → 401', req($guest, 'POST', 'daily/claim'), 401, 'auth_required');
$r = req($u2, 'GET', 'daily');
expectOk('GET daily', $r);
check('fresh: not claimed, next 20, streak 0', (data($r)['claimedToday'] ?? true) === false && (data($r)['nextAmount'] ?? 0) === 20 && (data($r)['streak'] ?? -1) === 0, json_encode(data($r)));
$before = balance($u2);
$res = parallel_post(array_fill(0, 4, [$u2, 'daily/claim', null]));
$ok = count(array_filter($res, static fn($x) => $x['status'] === 200));
check('parallel claims: exactly one wins', $ok === 1, json_encode(array_column($res, 'status')));
check('balance +20', balance($u2) === $before + 20, (string) (balance($u2) - $before));
$r = req($u2, 'GET', 'daily');
check('claimed today, streak 1, tomorrow 25', (data($r)['claimedToday'] ?? false) === true && (data($r)['streak'] ?? 0) === 1 && (data($r)['nextAmount'] ?? 0) === 25 && (data($r)['todayAmount'] ?? 0) === 20);
expectErr('claim twice → 400', req($u2, 'POST', 'daily/claim'), 400, 'validation');

if ($PDO) {
    section('daily: streak 7 (seeded yesterday = 6)');
    $yday = (new DateTimeImmutable('now', new DateTimeZone('Europe/Moscow')))->modify('-1 day')->format('Y-m-d');
    db_exec('INSERT INTO daily_claims (user_id, day, streak, amount, created_at) VALUES (?, ?, 6, 45, UTC_TIMESTAMP(3))', [$u3->user['id'], $yday]);
    $r = req($u3, 'GET', 'daily');
    check('streak alive from yesterday: 6, next 50', (data($r)['streak'] ?? 0) === 6 && (data($r)['nextAmount'] ?? 0) === 50, json_encode(data($r)));
    $r = req($u3, 'POST', 'daily/claim');
    expectOk('claim day 7', $r);
    check('amount 50, streak 7', (data($r)['amount'] ?? 0) === 50 && (data($r)['streak'] ?? 0) === 7, json_encode(data($r)));
    $prog = data(req($u3, 'GET', 'me/profile'))['progress'] ?? [];
    $badge = null;
    foreach ($prog['badges'] ?? [] as $bdg) if ($bdg['id'] === 'streak7') $badge = $bdg;
    check('badge streak7 earned', ($badge['earned'] ?? false) === true, json_encode($badge, JSON_UNESCAPED_UNICODE));
    check('streak notification', (int) db_one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'streak'", [$u3->user['id']])['n'] === 1);
    // день 12+: бонус упирается в 70
    db_exec('DELETE FROM daily_claims WHERE user_id = ?', [$u1->user['id']]);
    db_exec('INSERT INTO daily_claims (user_id, day, streak, amount, created_at) VALUES (?, ?, 15, 70, UTC_TIMESTAMP(3))', [$u1->user['id'], $yday]);
    check('streak 16 → 70 (cap)', (data(req($u1, 'POST', 'daily/claim'))['amount'] ?? 0) === 70);
    $streakAfter = data(req($u3, 'GET', 'daily'))['maxStreak'] ?? 0;
    check('maxStreak 7', $streakAfter === 7, (string) $streakAfter);
}

/* ================= Рамки ================= */
section('frames');
expectErr('guest frames → 401', req($guest, 'GET', 'me/frames'), 401, 'auth_required');
$r = req($u2, 'GET', 'me/frames');
expectOk('GET me/frames', $r);
check('6 frames, none open for newbie', count(data($r)['frames'] ?? []) === 6 && !array_filter(array_column(data($r)['frames'] ?? [], 'available')));
expectErr('bogus frame → 400', req($u1, 'POST', 'me/frame', [], ['frame' => 'diamond']), 400, 'validation', ['frame']);
expectErr('locked frame → 403', req($u1, 'POST', 'me/frame', [], ['frame' => 'gold']), 403, 'forbidden');
expectOk('clear frame (null) always ok', req($u1, 'POST', 'me/frame', [], ['frame' => null]));
if ($PDO) {
    $r = req($u3, 'POST', 'me/frame', [], ['frame' => 'lime']);
    expectOk('lime frame after 7-day streak', $r);
    check('response user.frame = lime', (data($r)['user']['frame'] ?? '') === 'lime' && (data($r)['current'] ?? '') === 'lime');
    check('GET me exposes frame', (data(req($u3, 'GET', 'me'))['frame'] ?? '') === 'lime');
    expectOk('remove frame', req($u3, 'POST', 'me/frame', [], ['frame' => '']));
    check('GET me frame null', array_key_exists('frame', data(req($u3, 'GET', 'me')) ?? []) && data(req($u3, 'GET', 'me'))['frame'] === null);
    expectOk('set lime again', req($u3, 'POST', 'me/frame', [], ['frame' => 'lime']));
}

/* ================= Команды ================= */
section('teams');
expectErr('guest join → 401', req($guest, 'POST', 'team/join', [], ['team' => 'lime']), 401, 'auth_required');
expectErr('bad team → 400', req($u1, 'POST', 'team/join', [], ['team' => 'blue']), 400, 'validation', ['team']);
expectErr('team as array → 400', req($u1, 'POST', 'team/join', [], ['team' => ['lime']]), 400, 'validation');
$r = req($guest, 'GET', 'teams');
expectOk('guest GET teams', $r);
$limeBefore = data($r)['lime']['members'] ?? 0;
check('guest mine = null', array_key_exists('mine', data($r) ?? []) && data($r)['mine'] === null);
$r = req($u1, 'POST', 'team/join', [], ['team' => 'lime']);
expectOk('u1 joins lime', $r);
check('mine = lime, members +1', (data($r)['mine'] ?? '') === 'lime' && (data($r)['lime']['members'] ?? 0) === $limeBefore + 1);
expectErr('switch team → 400', req($u1, 'POST', 'team/join', [], ['team' => 'red']), 400, 'validation');
expectErr('join same again → 400', req($u1, 'POST', 'team/join', [], ['team' => 'lime']), 400, 'validation');
$res = parallel_post([[$u2, 'team/join', ['team' => 'red']], [$u2, 'team/join', ['team' => 'lime']]]);
check('parallel join: exactly one', count(array_filter($res, static fn($x) => $x['status'] === 200)) === 1, json_encode(array_column($res, 'status')));

/* ================= Сезон ================= */
section('season');
$r = req($u2, 'GET', 'season');
expectOk('GET season', $r);
$s = data($r);
check('season shape', preg_match('/^\d{4}-\d{2}$/', $s['season'] ?? '') === 1 && is_string($s['endsAt'] ?? null) && is_array($s['top'] ?? null)
    && isset($s['teams']['lime'], $s['teams']['red']) && array_key_exists('lastAwards', $s) && ($s['prizes']['1'] ?? $s['prizes'][1] ?? 0) === 1000, short(json_encode($s, JSON_UNESCAPED_UNICODE)));
// таблица сезона кэшируется на минуту — свежий бонус может ещё не попасть в неё
check('me: { place, xp }', is_array($s['me'] ?? null) && array_key_exists('place', $s['me']) && is_int($s['me']['xp'] ?? null), json_encode($s['me'] ?? null));
$xs = array_column($s['top'], 'xp');
$sorted = $xs;
rsort($sorted);
check('top ≤ 10, sorted by XP', count($xs) <= 10 && $xs === $sorted);
check('endsAt after now', strtotime($s['endsAt']) > time());
$g = data(req($guest, 'GET', 'season'));
check('guest season me = null', is_array($g) && array_key_exists('me', $g) && $g['me'] === null);

if ($PDO) {
    section('season awards (previous season)');
    $msk = new DateTimeZone('Europe/Moscow');
    $prev = (new DateTimeImmutable('now', $msk))->modify('first day of last month')->format('Y-m');
    $prevStart = DateTimeImmutable::createFromFormat('!Y-m', $prev, $msk);
    // чистим прошлый сезон и даём трём тестовым пользователям активность в нём (бонусы: 2 XP за день)
    db_exec('DELETE FROM points_ledger WHERE reason = ? AND ref = ?', ['season', $prev]);
    db_exec('DELETE FROM season_awards WHERE season = ?', [$prev]);
    db_exec("DELETE FROM settings WHERE k = 'pt_season_awarded'");
    $seed = static function (Actor $a, int $days) use ($prevStart): void {
        for ($d = 0; $d < $days; $d++) {
            $day = $prevStart->modify("+$d day");
            db_exec('INSERT IGNORE INTO daily_claims (user_id, day, streak, amount, created_at) VALUES (?, ?, 1, 20, ?)',
                [$a->user['id'], $day->format('Y-m-d'), $day->setTime(12, 0)->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.000')]);
        }
    };
    $seed($u1, 28); $seed($u2, 27); $seed($u3, 26); // 56 / 54 / 52 XP за прошлый сезон
    req($guest, 'GET', 'season');
    req($u1, 'GET', 'season');
    $st = $PDO->prepare('SELECT user_id, place, xp FROM season_awards WHERE season = ? ORDER BY place');
    $st->execute([$prev]);
    $rows = $st->fetchAll();
    check('1–3 award rows written', count($rows) >= 1 && count($rows) <= 3, (string) count($rows));
    check('places are 1..n', array_map('intval', array_column($rows, 'place')) === range(1, count($rows)));
    $prizes = [1 => 1000, 2 => 500, 3 => 250];
    $okPrize = true;
    foreach ($rows as $row) {
        $n = db_one('SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE user_id = ? AND reason = ? AND ref = ?', [$row['user_id'], 'season', $prev]);
        $okPrize = $okPrize && (int) $n['n'] === 1 && (int) $n['s'] === $prizes[(int) $row['place']];
    }
    check('each winner got exactly one prize', $okPrize);
    req($u2, 'GET', 'season');
    $n = db_one('SELECT COUNT(*) AS n FROM points_ledger WHERE reason = ? AND ref = ?', ['season', $prev]);
    check('repeat requests do not re-award', (int) $n['n'] === count($rows));
    $last = data(req($guest, 'GET', 'season'))['lastAwards'] ?? null;
    check('lastAwards podium', ($last['season'] ?? '') === $prev && count($last['podium'] ?? []) === count($rows), json_encode($last, JSON_UNESCAPED_UNICODE));
    $winnerIds = array_column($rows, 'user_id');
    $place = ['gold' => 1, 'silver' => 2, 'bronze' => 3];
    foreach ([$u1, $u2, $u3] as $a) {
        $i = array_search($a->user['id'], $winnerIds, true);
        if ($i === false) continue;
        $fr = array_column(data(req($a, 'GET', 'me/frames'))['frames'] ?? [], 'available', 'id');
        $want = array_search($i + 1, $place, true);
        check("{$a->name}: frame $want unlocked", ($fr[$want] ?? false) === true, json_encode($fr));
        expectOk("{$a->name}: set frame $want", req($a, 'POST', 'me/frame', [], ['frame' => $want]));
    }
    check('winner notified', (int) db_one("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'season' AND user_id = ?", [$rows[0]['user_id']])['n'] >= 1);
}

/* ================= Пульт: сводка ================= */
section('admin overview');
$r = req($admin, 'GET', 'shop/admin');
expectOk('admin GET shop/admin', $r);
$a = data($r);
check('overview shape', is_array($a['items'] ?? null) && is_int($a['pendingCount'] ?? null) && isset($a['season']['teams']['lime']) && is_int($a['season']['dailyToday'] ?? null) && is_array($a['awards'] ?? null));
check('admin items include inactive flag', array_key_exists('active', $a['items'][0] ?? []));

echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
exit($FAIL > 0 ? 1 : 0);

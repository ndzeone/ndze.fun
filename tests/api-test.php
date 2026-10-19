<?php
// Интеграционные тесты API (API.md) — PHP CLI, без Composer.
//
//   php tests/api-test.php [http://127.0.0.1:8090]        (или env API_BASE)
//
// Нужны расширения curl и gd (картинки генерируются на лету).
// Ожидает api/config.php с 'admin_emails' => ['ndze-admin@example.com'] и пустым discord.client_id.
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — тогда между группами тестов
// очищается таблица rate_limits (все «пользователи» теста ходят с одного IP 127.0.0.1).
// Каждый запуск использует уникальные email/ники, поэтому повторный запуск на той же базе тоже работает.
// Код выхода: 0 — всё прошло, 1 — есть провалы.
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

foreach (['curl', 'gd', 'json'] as $ext) {
    if (!extension_loaded($ext)) { fwrite(STDERR, "Нужно расширение PHP: $ext\n"); exit(2); }
}

$BASE = rtrim((string) ($argv[1] ?? (getenv('API_BASE') ?: 'http://127.0.0.1:8090')), '/');
$ADMIN_EMAIL = getenv('TEST_ADMIN_EMAIL') ?: 'ndze-admin@example.com';
$ADMIN_PASS = getenv('TEST_ADMIN_PASS') ?: 'AdminTest_pw1';
$RUN = bin2hex(random_bytes(3)); // 6 hex — уникальность email/ников в рамках запуска
$TMP = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ndze-api-test-' . $RUN;
@mkdir($TMP, 0700, true);

const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';
const ISO_RE = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/';
const IMG_URL_RE = '#^api/index\.php\?r=image&id=([0-9a-f-]{36})$#i';

/* ============================== Результаты ============================== */
$PASS = 0; $FAIL = 0; $FAILS = [];
function check(string $name, bool $cond, string $detail = ''): bool
{
    global $PASS, $FAIL, $FAILS;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; $FAILS[] = "$name" . ($detail !== '' ? " — $detail" : ''); echo "FAIL  $name" . ($detail !== '' ? " — $detail" : '') . "\n"; }
    return $cond;
}
function section(string $t): void { echo "\n== $t ==\n"; }
function info(string $t): void { echo "      · $t\n"; }

/* ============================== HTTP ============================== */
final class Actor
{
    public $ch;
    public ?array $user = null;
    public string $password = '';
    public function __construct(public string $name)
    {
        $this->ch = curl_init();
    }
    public function cookie(string $name): ?string
    {
        foreach (curl_getinfo($this->ch, CURLINFO_COOKIELIST) ?: [] as $line) {
            $p = explode("\t", $line);
            if (count($p) >= 7 && $p[5] === $name) return $p[6];
        }
        return null;
    }
}

/**
 * Запрос. $route — значение r= (или полный URL, если начинается с http).
 * $body: null | array (JSON) | array с CURLFile (multipart, если $opt['multipart']).
 * $opt: csrf (bool, по умолчанию true для POST), origin, headers[], multipart, raw (строка тела как есть).
 */
function req(Actor $a, string $method, string $route, array $query = [], $body = null, array $opt = []): array
{
    global $BASE;
    if (preg_match('#^https?://#', $route)) $url = $route;
    else $url = $BASE . '/api/index.php?' . http_build_query(['r' => $route] + $query, '', '&', PHP_QUERY_RFC3986);
    if (preg_match('#^https?://#', $route) && $query) $url .= (str_contains($url, '?') ? '&' : '?') . http_build_query($query, '', '&', PHP_QUERY_RFC3986);

    $ch = $a->ch;
    curl_reset($ch); // куки в памяти хэндла сохраняются
    $hdrs = ['Accept: application/json'];
    if ($method === 'POST' && ($opt['csrf'] ?? true)) $hdrs[] = 'X-Requested-With: ndze';
    if (isset($opt['origin'])) $hdrs[] = 'Origin: ' . $opt['origin'];
    foreach ($opt['headers'] ?? [] as $h) $hdrs[] = $h;
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_COOKIEFILE => '', // включить cookie engine (в памяти, отдельный на актёра)
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_HEADERFUNCTION => static function ($c, string $line) use (&$respHeaders): int {
            $p = strpos($line, ':');
            if ($p !== false) $respHeaders[strtolower(trim(substr($line, 0, $p)))][] = trim(substr($line, $p + 1));
            return strlen($line);
        },
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if (array_key_exists('raw', $opt)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, (string) $opt['raw']);
        } elseif (!empty($opt['multipart'])) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? []); // массив с CURLFile → multipart/form-data
        } else {
            $hdrs[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
        }
    } elseif ($method !== 'GET') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $resBody = curl_exec($ch);
    if ($resBody === false) {
        return ['status' => 0, 'headers' => [], 'body' => '', 'json' => null, 'ctype' => '', 'err' => curl_error($ch), 'url' => $url];
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $ctype = strtolower($respHeaders['content-type'][0] ?? '');
    $json = str_contains($ctype, 'json') ? json_decode($resBody, true) : null;
    $r = ['status' => $status, 'headers' => $respHeaders, 'body' => $resBody, 'json' => $json, 'ctype' => $ctype, 'err' => '', 'url' => $url];
    leak_check($r, "$method $route");
    return $r;
}

/** Любой ответ: не должно быть утечек ошибок PHP/SQL; все 500 запоминаем. */
$SEEN500 = [];
function leak_check(array $r, string $what): void
{
    global $SEEN500;
    if ($r['status'] >= 500) $SEEN500[] = "$what → {$r['status']}";
    if (str_starts_with($r['ctype'], 'image/')) return;
    if (preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace|<b>(Warning|Notice|Deprecated)<\/b>|Uncaught /', $r['body'], $m)) {
        check("no PHP/SQL error leak in $what", false, "body contains '{$m[0]}': " . short($r['body']));
    }
}

function short(string $s, int $n = 220): string
{
    $s = preg_replace('/\s+/', ' ', $s);
    return mb_strlen($s) > $n ? mb_substr($s, 0, $n) . '…' : $s;
}
function desc(array $r): string
{
    if ($r['status'] === 0) return "connection error: {$r['err']}";
    return "HTTP {$r['status']} " . short($r['body']);
}
function data(array $r) { return ($r['json']['ok'] ?? null) === true ? $r['json']['data'] : null; }
function isOk(array $r): bool { return $r['status'] === 200 && ($r['json']['ok'] ?? null) === true && array_key_exists('data', $r['json']); }
function errCode(array $r): ?string { return $r['json']['error']['code'] ?? null; }

function expectOk(string $name, array $r): bool { return check($name, isOk($r), desc($r)); }

/** Ошибка: статус (или список), код ошибки и формат конверта. */
function expectErr(string $name, array $r, $status, ?string $code = null, array $fields = []): bool
{
    $statuses = (array) $status;
    $e = $r['json']['error'] ?? null;
    $okShape = is_array($r['json']) && ($r['json']['ok'] ?? null) === false && is_array($e)
        && is_string($e['code'] ?? null) && is_string($e['message'] ?? null) && array_key_exists('fields', $e)
        && ($e['fields'] === null || is_array($e['fields']));
    $good = in_array($r['status'], $statuses, true) && $okShape && ($code === null || $e['code'] === $code);
    foreach ($fields as $f) $good = $good && is_array($e['fields'] ?? null) && array_key_exists($f, $e['fields']);
    $want = implode('/', $statuses) . ($code ? " $code" : '') . ($fields ? ' fields[' . implode(',', $fields) . ']' : '');
    return check($name, $good, "want $want, got " . desc($r));
}
/** Для проб: что угодно 4xx (ok:false), но не 500 и не 200. */
function expect4xx(string $name, array $r): bool
{
    return check($name, $r['status'] >= 400 && $r['status'] < 500 && ($r['json']['ok'] ?? null) === false, 'got ' . desc($r));
}

/* ============================== Помощники БД (необязательно) ============================== */
$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try {
        $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    } catch (Throwable $e) {
        echo "WARN  TEST_DB_DSN задан, но подключиться не удалось: {$e->getMessage()}\n";
    }
}
function reset_rl(): void
{
    global $PDO;
    if (!$PDO) return;
    try { $PDO->exec('DELETE FROM rate_limits'); } catch (Throwable $e) { /* таблицы ещё нет — схема создаётся при первом запросе */ }
}

/* ============================== Картинки ============================== */
function gd_png(int $w, int $h, string $file): string
{
    $im = imagecreatetruecolor($w, $h);
    for ($i = 0; $i < 12; $i++) imagefilledrectangle($im, random_int(0, $w - 1), random_int(0, $h - 1), random_int(0, $w - 1), random_int(0, $h - 1), imagecolorallocate($im, random_int(0, 255), random_int(0, 255), random_int(0, 255)));
    imagepng($im, $file);
    imagedestroy($im);
    return $file;
}
function gd_jpeg(int $w, int $h, string $file): string
{
    $im = imagecreatetruecolor($w, $h);
    imagefilledrectangle($im, 0, 0, $w - 1, $h - 1, imagecolorallocate($im, 200, 60, 90));
    imagefilledellipse($im, intdiv($w, 2), intdiv($h, 2), intdiv($w, 2), intdiv($h, 2), imagecolorallocate($im, 30, 200, 120));
    imagejpeg($im, $file, 90);
    imagedestroy($im);
    return $file;
}
function gd_gif(int $w, int $h, string $file): string
{
    $im = imagecreate($w, $h);
    imagecolorallocate($im, 10, 20, 30);
    imagefilledrectangle($im, 2, 2, $w - 3, $h - 3, imagecolorallocate($im, 250, 200, 0));
    imagegif($im, $file);
    imagedestroy($im);
    return $file;
}
function cf(string $path, string $mime, ?string $name = null): CURLFile { return new CURLFile($path, $mime, $name ?? basename($path)); }
/** multipart-поля: files[0], files[1]… (PHP разбирает так же, как files[] из браузера). */
function form(array $fields, array $files): array
{
    foreach (array_values($files) as $i => $f) $fields["files[$i]"] = $f;
    return $fields;
}
function imageId(string $url): ?string { return preg_match(IMG_URL_RE, $url, $m) ? $m[1] : null; }
function imageUrls(array $sub): array
{
    $out = [];
    foreach ($sub['versions'] ?? [] as $v) foreach ($v['imageUrls'] ?? [] as $u) $out[] = $u;
    return $out;
}
function getImage(Actor $a, string $relUrl): array
{
    global $BASE;
    return req($a, 'GET', $BASE . '/' . ltrim($relUrl, '/'));
}

/* ============================== Формы данных ============================== */
function hasKeys(?array $o, array $keys): array
{
    if (!is_array($o)) return ['<not an object>'];
    return array_values(array_diff($keys, array_keys($o)));
}
function checkUser(string $name, $u): bool
{
    $miss = hasKeys($u, ['id', 'nick', 'email', 'role', 'createdAt']);
    $leak = is_array($u) ? array_intersect(array_keys($u), ['password', 'passwordHash', 'password_hash', 'hash', 'pass']) : [];
    return check($name, !$miss && !$leak && preg_match(UUID_RE, (string) $u['id']) && preg_match(ISO_RE, (string) $u['createdAt'])
        && in_array($u['role'], ['admin', 'user'], true),
        'missing [' . implode(',', $miss) . '] leak [' . implode(',', $leak) . '] ' . short(json_encode($u, JSON_UNESCAPED_UNICODE)));
}
function checkSubmissionShape(string $name, $s): bool
{
    $miss = hasKeys($s, ['id', 'userId', 'authorNick', 'title', 'description', 'category', 'status', 'rating', 'createdAt', 'updatedAt', 'versions', 'comments']);
    $good = !$miss && preg_match(UUID_RE, (string) $s['id']) && preg_match(ISO_RE, (string) $s['createdAt']) && preg_match(ISO_RE, (string) $s['updatedAt'])
        && is_array($s['versions']) && is_array($s['comments']) && ($s['rating'] === null || is_int($s['rating']));
    if ($good) {
        $n = 0;
        foreach ($s['versions'] as $v) {
            $n++;
            $good = $good && !hasKeys($v, ['id', 'n', 'imageUrls', 'note', 'createdAt']) && $v['n'] === $n && is_array($v['imageUrls']);
            foreach ($v['imageUrls'] ?? [] as $u) $good = $good && imageId((string) $u) !== null;
        }
        foreach ($s['comments'] as $c) $good = $good && !hasKeys($c, ['id', 'userId', 'authorNick', 'isAdmin', 'text', 'createdAt']) && is_bool($c['isAdmin']);
    }
    return check($name, (bool) $good, 'missing [' . implode(',', $miss) . '] ' . short(json_encode($s, JSON_UNESCAPED_UNICODE), 400));
}
function checkTaskShape(string $name, $t): bool
{
    $miss = hasKeys($t, ['id', 'userId', 'authorNick', 'game', 'title', 'description', 'difficulty', 'status', 'adminNote', 'votes', 'myVote', 'createdAt', 'updatedAt']);
    $good = !$miss && preg_match(UUID_RE, (string) $t['id']) && is_int($t['difficulty']) && is_int($t['votes']) && is_bool($t['myVote'])
        && preg_match(ISO_RE, (string) $t['createdAt']) && preg_match(ISO_RE, (string) $t['updatedAt']);
    return check($name, (bool) $good, 'missing [' . implode(',', $miss) . '] ' . short(json_encode($t, JSON_UNESCAPED_UNICODE), 300));
}
function findById(?array $list, string $id): ?array
{
    foreach ($list ?? [] as $x) if (($x['id'] ?? null) === $id) return $x;
    return null;
}
function ids(?array $list): array { return array_map(fn($x) => $x['id'] ?? null, $list ?? []); }

/* ============================== Учёт для stats ============================== */
$LEDGER = ['users' => 0, 'subs' => [], 'tasks' => []];

/* ============================== Актёры ============================== */
$guest = new Actor('guest');
$admin = new Actor('admin');
$A = new Actor('A');
$B = new Actor('B');
$C = new Actor('C');

function register(Actor $a, string $nick, string $email, string $password): array
{
    global $LEDGER;
    $r = req($a, 'POST', 'auth/register', [], ['nick' => $nick, 'email' => $email, 'password' => $password]);
    if (isOk($r)) { $a->user = data($r); $a->password = $password; $LEDGER['users']++; }
    return $r;
}
function login(Actor $a, string $email, string $password): array
{
    $r = req($a, 'POST', 'auth/login', [], ['email' => $email, 'password' => $password]);
    if (isOk($r)) { $a->user = data($r); $a->password = $password; }
    return $r;
}

echo "API base: $BASE   run: $RUN   DB reset of rate_limits: " . ($PDO ? 'yes' : 'no (TEST_DB_DSN not set)') . "\n";

/* ============================== health / формат ============================== */
section('health & envelope');
$r = req($guest, 'GET', 'health');
if ($r['status'] === 0) {
    check('server reachable', false, desc($r));
    echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
    exit(1);
}
expectOk('GET health → 200 ok', $r);
$h = data($r);
check('health has php/db/schema/storage/gd/curl', !hasKeys($h, ['php', 'db', 'schema', 'storage', 'gd', 'curl']), short($r['body']));
check('health: db/schema/storage/gd/curl all true', ($h['db'] ?? 0) === true && ($h['schema'] ?? 0) === true && ($h['storage'] ?? 0) === true && ($h['gd'] ?? 0) === true && ($h['curl'] ?? 0) === true, short($r['body']));
check('JSON content-type', str_starts_with($r['ctype'], 'application/json'), $r['ctype']);
reset_rl(); // схема уже создана первым запросом

$r = req($guest, 'GET', 'me');
check('GET me as guest → ok, data null', isOk($r) && data($r) === null, desc($r));
expectErr('unknown route → 404 not_found', req($guest, 'GET', 'no/such/route'), 404, 'not_found');
expectErr('missing r → 404', req($guest, 'GET', $BASE . '/api/index.php'), [400, 404]);
expectErr('r=../../config → 404', req($guest, 'GET', '../../config'), 404, 'not_found');
expectErr('r[]=array → 4xx not 500', req($guest, 'GET', $BASE . '/api/index.php?r[]=me'), [400, 404]);
expectErr('GET on POST-only route (auth/login) → 4xx', req($guest, 'GET', 'auth/login'), [400, 404, 405]);
expectErr('malformed JSON body → 400', req($guest, 'POST', 'auth/login', [], null, ['raw' => '{bad json', 'headers' => ['Content-Type: application/json']]), 400);

/* ============================== CSRF ============================== */
section('CSRF');
expectErr('POST without X-Requested-With → 403 forbidden', req($guest, 'POST', 'auth/logout', [], [], ['csrf' => false]), 403, 'forbidden');
expectErr('POST with wrong X-Requested-With → 403', req($guest, 'POST', 'auth/logout', [], [], ['csrf' => false, 'headers' => ['X-Requested-With: XMLHttpRequest']]), 403, 'forbidden');
expectErr('POST with foreign Origin → 403 forbidden', req($guest, 'POST', 'auth/logout', [], [], ['origin' => 'https://evil.com']), 403, 'forbidden');
expectErr('POST with Origin "null" → 403', req($guest, 'POST', 'auth/logout', [], [], ['origin' => 'null']), 403, 'forbidden');
$host = parse_url($BASE, PHP_URL_SCHEME) . '://' . parse_url($BASE, PHP_URL_HOST) . (parse_url($BASE, PHP_URL_PORT) ? ':' . parse_url($BASE, PHP_URL_PORT) : '');
expectOk('POST with same-site Origin → allowed', req($guest, 'POST', 'auth/logout', [], [], ['origin' => $host]));
expectErr('register without X-Requested-With → 403 (no account created)', req($guest, 'POST', 'auth/register', [], ['nick' => "csrf_$RUN", 'email' => "csrf_$RUN@example.com", 'password' => 'password123'], ['csrf' => false]), 403, 'forbidden');

/* ============================== Регистрация / вход ============================== */
section('auth');
reset_rl();
// админ: email из config.admin_emails; на не-чистой базе он уже есть — входим
$r = register($admin, "adm_$RUN", $ADMIN_EMAIL, $ADMIN_PASS);
if (errCode($r) === 'email_taken') { $r = login($admin, $ADMIN_EMAIL, $ADMIN_PASS); info('admin already existed → logged in'); }
expectOk('admin register/login', $r);
check('configured admin email → role admin', ($admin->user['role'] ?? null) === 'admin', short(json_encode($admin->user)));
$S0 = data(req($admin, 'GET', 'stats'));
$LEDGER['users'] = 0; // baseline S0 уже включает админа
reset_rl();

expectErr('register validation → 400 with fields nick/email/password',
    req($guest, 'POST', 'auth/register', [], ['nick' => 'a', 'email' => 'not-an-email', 'password' => 'short']), 400, 'validation', ['nick', 'email', 'password']);
expectErr('register nick with space/symbols → 400 fields.nick',
    req($guest, 'POST', 'auth/register', [], ['nick' => "bad nick!$RUN", 'email' => "x$RUN@example.com", 'password' => 'password123']), 400, 'validation', ['nick']);
expectErr('register nick 21 chars → 400', req($guest, 'POST', 'auth/register', [], ['nick' => str_repeat('n', 21), 'email' => "y$RUN@example.com", 'password' => 'password123']), 400, 'validation', ['nick']);
expectErr('register missing body fields → 400', req($guest, 'POST', 'auth/register', [], []), 400, 'validation');
expectErr('register fields of wrong type → 400', req($guest, 'POST', 'auth/register', [], ['nick' => ['x'], 'email' => 5, 'password' => true]), 400, 'validation');

reset_rl();
$emailA = "UserA_$RUN@Example.COM";
$r = register($A, "userA_$RUN", $emailA, 'passwordA1');
expectOk('register A', $r);
checkUser('register returns User shape', data($r));
check('email stored lowercase', ($A->user['email'] ?? '') === strtolower($emailA), (string) ($A->user['email'] ?? ''));
check('new user role = user', ($A->user['role'] ?? '') === 'user');
$sc = implode("\n", array_filter($r['headers']['set-cookie'] ?? [], fn($c) => stripos($c, 'ndze_sid=') === 0));
check('session cookie ndze_sid set on register', $sc !== '', 'Set-Cookie: ' . implode(' | ', $r['headers']['set-cookie'] ?? []));
check('ndze_sid HttpOnly', stripos($sc, 'httponly') !== false, $sc);
check('ndze_sid SameSite=Lax', (bool) preg_match('/samesite=lax/i', $sc), $sc);
if (str_starts_with($BASE, 'http://')) check('ndze_sid not Secure over plain HTTP', stripos($sc, 'secure') === false, $sc);
$r = req($A, 'GET', 'me');
check('me after register → A', isOk($r) && (data($r)['id'] ?? null) === $A->user['id'], desc($r));
expectOk('register B', register($B, "userB_$RUN", "userb_$RUN@example.com", 'passwordB1'));
reset_rl();

expectErr('email_taken (different case) → 409', req($guest, 'POST', 'auth/register', [], ['nick' => "other_$RUN", 'email' => strtoupper($emailA), 'password' => 'password123']), 409, 'email_taken');
expectErr('nick_taken (different case) → 409', req($guest, 'POST', 'auth/register', [], ['nick' => strtoupper("userA_$RUN"), 'email' => "other_$RUN@example.com", 'password' => 'password123']), 409, 'nick_taken');
reset_rl();
$cyr = "Тест_$RUN";
$r = register($C, $cyr, "userc_$RUN@example.com", 'passwordC1');
expectOk('register Cyrillic nick', $r);
check('Cyrillic nick preserved', ($C->user['nick'] ?? null) === $cyr, short(json_encode($C->user, JSON_UNESCAPED_UNICODE)));
expectErr('nick_taken Cyrillic case-insensitive (тЕСТ…) → 409', req($guest, 'POST', 'auth/register', [], ['nick' => 'тЕСТ_' . strtoupper($RUN), 'email' => "userd_$RUN@example.com", 'password' => 'password123']), 409, 'nick_taken');
expectErr('register while logged in still validates (email_taken)', req($A, 'POST', 'auth/register', [], ['nick' => "zz_$RUN", 'email' => "userb_$RUN@example.com", 'password' => 'password123']), [403, 409]);

reset_rl();
$sidBefore = $A->cookie('ndze_sid');
expectOk('logout A', req($A, 'POST', 'auth/logout'));
$r = req($A, 'GET', 'me');
check('me after logout → null', isOk($r) && data($r) === null, desc($r));
expectErr('login wrong password → 401 invalid_credentials', req($A, 'POST', 'auth/login', [], ['email' => $emailA, 'password' => 'wrong-password']), 401, 'invalid_credentials');
expectErr('login unknown email → 401 invalid_credentials', req($A, 'POST', 'auth/login', [], ['email' => "nobody_$RUN@example.com", 'password' => 'whatever1']), 401, 'invalid_credentials');
expectErr('login validation (empty password) → 400', req($A, 'POST', 'auth/login', [], ['email' => $emailA, 'password' => '']), 400, 'validation', ['password']);
$r = login($A, strtoupper($emailA), 'passwordA1');
expectOk('login A (email in other case)', $r);
check('login returns same user id', ($A->user['id'] ?? null) === (data($r)['id'] ?? 'x'));
$sidAfter = $A->cookie('ndze_sid');
check('session id regenerated on login', $sidAfter !== null && $sidAfter !== $sidBefore, "before=$sidBefore after=$sidAfter");
$r = req($A, 'GET', 'me');
check('me after login → A', (data($r)['id'] ?? null) === $A->user['id'], desc($r));
$r = req($admin, 'GET', 'me');
check('me as admin → role admin', (data($r)['role'] ?? null) === 'admin', desc($r));
// фиксация сессии: подставленная злоумышленником кука не должна стать сессией после входа
$fx = new Actor('fixation');
req($fx, 'GET', 'me', [], null, ['headers' => ['Cookie: ndze_sid=attackerchosenid1234567890']]);
$r = req($fx, 'POST', 'auth/login', [], ['email' => "userb_$RUN@example.com", 'password' => 'passwordB1'], ['headers' => ['Cookie: ndze_sid=attackerchosenid1234567890']]);
$rr = req(new Actor('attacker'), 'GET', 'me', [], null, ['headers' => ['Cookie: ndze_sid=attackerchosenid1234567890']]);
check('session fixation: attacker-chosen sid is not logged in', isOk($rr) && data($rr) === null, desc($rr));

/* ============================== Работы ============================== */
section('submissions: create & validation');
reset_rl();
$big = gd_png(2000, 1000, "$TMP/big.png");
$jpg = gd_jpeg(320, 200, "$TMP/small.jpg");
$png2 = gd_png(64, 48, "$TMP/p2.png");
expectErr('create as guest → 401', req($guest, 'POST', 'submissions', [], form(['title' => 'Guest work', 'category' => 'art'], [cf($png2, 'image/png')]), ['multipart' => true]), 401, 'auth_required');
$r = req($A, 'POST', 'submissions', [], form(['title' => "Работа A $RUN", 'description' => 'Описание', 'category' => 'art', 'note' => 'v1 note'], [cf($big, 'image/png'), cf($jpg, 'image/jpeg')]), ['multipart' => true]);
expectOk('create submission (PNG 2000x1000 + JPEG)', $r);
$S1 = data($r) ?? [];
checkSubmissionShape('submission shape', $S1);
check('status pending, rating null, 1 version n=1, 2 images, 0 comments',
    ($S1['status'] ?? '') === 'pending' && array_key_exists('rating', $S1) && $S1['rating'] === null && count($S1['versions'] ?? []) === 1 && ($S1['versions'][0]['n'] ?? 0) === 1
    && count($S1['versions'][0]['imageUrls'] ?? []) === 2 && ($S1['comments'] ?? null) === [], short(json_encode($S1, JSON_UNESCAPED_UNICODE), 400));
check('userId/authorNick = A', ($S1['userId'] ?? '') === ($A->user['id'] ?? '-') && ($S1['authorNick'] ?? '') === "userA_$RUN");
check('title/description/note stored', ($S1['title'] ?? '') === "Работа A $RUN" && ($S1['description'] ?? '') === 'Описание' && ($S1['versions'][0]['note'] ?? '') === 'v1 note');
if (!empty($S1['id'])) $LEDGER['subs'][$S1['id']] = 'pending';
$S1urls = imageUrls($S1);

expectErr('create: no title, bad category → 400 fields title/category',
    req($A, 'POST', 'submissions', [], form(['title' => '', 'category' => 'nope'], [cf($png2, 'image/png')]), ['multipart' => true]), 400, 'validation', ['title', 'category']);
expectErr('create: title 81 chars → 400', req($A, 'POST', 'submissions', [], form(['title' => str_repeat('я', 81), 'category' => 'art'], [cf($png2, 'image/png')]), ['multipart' => true]), 400, 'validation', ['title']);
expectErr('create: description 1501 chars → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Title ok', 'category' => 'art', 'description' => str_repeat('d', 1501)], [cf($png2, 'image/png')]), ['multipart' => true]), 400, 'validation', ['description']);
expectErr('create: note 501 chars → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Title ok', 'category' => 'art', 'note' => str_repeat('n', 501)], [cf($png2, 'image/png')]), ['multipart' => true]), 400, 'validation', ['note']);
expectErr('create: no files → 400 fields.files', req($A, 'POST', 'submissions', [], ['title' => 'No files', 'category' => 'art'], ['multipart' => true]), 400, 'validation', ['files']);
file_put_contents("$TMP/fake.png", "this is definitely not an image\n");
expectErr('create: text file renamed .png → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Fake image', 'category' => 'art'], [cf("$TMP/fake.png", 'image/png')]), ['multipart' => true]), 400, 'validation');
file_put_contents("$TMP/fake.gif", "GIF89a<html><script>alert(1)</script></html>");
expectErr('create: HTML with GIF magic → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Fake gif', 'category' => 'art'], [cf("$TMP/fake.gif", 'image/gif')]), ['multipart' => true]), 400, 'validation');
file_put_contents("$TMP/shell.php", "<?php echo 'PWNED'; ?>");
expectErr('create: .php upload → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Shell', 'category' => 'art'], [cf("$TMP/shell.php", 'image/png', 'shell.php')]), ['multipart' => true]), 400, 'validation');
$six = [];
for ($i = 0; $i < 6; $i++) $six[] = cf(gd_png(20 + $i, 20, "$TMP/six$i.png"), 'image/png');
expectErr('create: 6 files → 400 (max 5)', req($A, 'POST', 'submissions', [], form(['title' => 'Six files', 'category' => 'art'], $six), ['multipart' => true]), 400, 'validation');
// > 10 МБ: настоящий PNG + 10.5 МБ мусора в конце
copy($png2, "$TMP/huge.png");
$fh = fopen("$TMP/huge.png", 'ab'); fwrite($fh, str_repeat("\0", (int) (10.5 * 1024 * 1024))); fclose($fh);
expectErr('create: file > 10 MB → 400', req($A, 'POST', 'submissions', [], form(['title' => 'Huge', 'category' => 'art'], [cf("$TMP/huge.png", 'image/png')]), ['multipart' => true]), [400, 413]);

section('submissions: polyglots & real-type handling');
// PNG + PHP-код в конце
copy($png2, "$TMP/poly.png");
file_put_contents("$TMP/poly.png", "<?php echo 'PWN'.'ED'; system(\$_GET['c']); ?>", FILE_APPEND);
$r = req($A, 'POST', 'submissions', [], form(['title' => "Poly PNG $RUN", 'category' => 'code'], [cf("$TMP/poly.png", 'image/png', 'poly.php.png')]), ['multipart' => true]);
if (isOk($r)) {
    $ps = data($r); $LEDGER['subs'][$ps['id']] = 'pending';
    $img = getImage($A, imageUrls($ps)[0] ?? '');
    check('PNG+PHP polyglot neutralized (re-encoded, no <?php)', $img['status'] === 200 && !str_contains($img['body'], '<?php') && str_starts_with($img['ctype'], 'image/png'), "HTTP {$img['status']} {$img['ctype']} has<?php=" . (str_contains($img['body'], '<?php') ? 'yes' : 'no'));
} else {
    expectErr('PNG+PHP polyglot rejected', $r, 400, 'validation');
}
// JPEG с PHP в COM-сегменте
$j = file_get_contents($jpg);
$payload = "<?php echo 'PWNED'; ?>";
file_put_contents("$TMP/poly.jpg", substr($j, 0, 2) . "\xFF\xFE" . pack('n', strlen($payload) + 2) . $payload . substr($j, 2));
check('test fixture: JPEG polyglot is a valid image', @getimagesize("$TMP/poly.jpg") !== false);
$r = req($A, 'POST', 'submissions', [], form(['title' => "Poly JPG $RUN", 'category' => 'code'], [cf("$TMP/poly.jpg", 'image/jpeg')]), ['multipart' => true]);
if (isOk($r)) {
    $ps = data($r); $LEDGER['subs'][$ps['id']] = 'pending';
    $img = getImage($A, imageUrls($ps)[0] ?? '');
    check('JPEG(COM)+PHP polyglot neutralized (metadata stripped)', $img['status'] === 200 && !str_contains($img['body'], '<?php') && str_starts_with($img['ctype'], 'image/jpeg'), "HTTP {$img['status']} {$img['ctype']}");
} else {
    expectErr('JPEG+PHP polyglot rejected', $r, 400, 'validation');
}
// GIF хранится как есть (API.md) — проверяем, что отдаётся только как image/gif с nosniff
gd_gif(40, 30, "$TMP/poly.gif");
file_put_contents("$TMP/poly.gif", "<?php echo 'PWNED'; ?>", FILE_APPEND);
$r = req($A, 'POST', 'submissions', [], form(['title' => "Poly GIF $RUN", 'category' => 'code'], [cf("$TMP/poly.gif", 'image/gif', 'x.php')]), ['multipart' => true]);
if (isOk($r)) {
    $ps = data($r); $LEDGER['subs'][$ps['id']] = 'pending';
    $img = getImage($A, imageUrls($ps)[0] ?? '');
    check('GIF+PHP polyglot served only as image/gif + nosniff', $img['status'] === 200 && str_starts_with($img['ctype'], 'image/gif')
        && strtolower($img['headers']['x-content-type-options'][0] ?? '') === 'nosniff', "HTTP {$img['status']} {$img['ctype']}");
} else {
    expectErr('GIF+PHP polyglot rejected', $r, 400, 'validation');
}
// настоящий PNG, но с именем .jpg и типом image/jpeg → тип определяется по содержимому
$r = req($A, 'POST', 'submissions', [], form(['title' => "Misnamed $RUN", 'category' => 'photo'], [cf($png2, 'image/jpeg', 'photo.jpg')]), ['multipart' => true]);
if (expectOk('PNG uploaded as photo.jpg accepted', $r)) {
    $ps = data($r); $LEDGER['subs'][$ps['id']] = 'pending';
    $img = getImage($A, imageUrls($ps)[0] ?? '');
    check('served with real type image/png', str_starts_with($img['ctype'], 'image/png'), $img['ctype']);
}

section('submissions: images');
if ($S1urls) {
    $img = getImage($A, $S1urls[0]);
    check('image as owner → 200 image/png', $img['status'] === 200 && str_starts_with($img['ctype'], 'image/png'), "HTTP {$img['status']} {$img['ctype']}");
    check('image has X-Content-Type-Options: nosniff', strtolower($img['headers']['x-content-type-options'][0] ?? '') === 'nosniff', json_encode($img['headers']['x-content-type-options'] ?? null));
    $sz = @getimagesizefromstring($img['body']);
    check('large image downscaled to ≤1600px long side', $sz && max($sz[0], $sz[1]) <= 1600 && max($sz[0], $sz[1]) >= 1500, $sz ? "{$sz[0]}x{$sz[1]}" : 'not an image');
    $img2 = getImage($A, $S1urls[1] ?? '');
    check('JPEG served as image/jpeg', $img2['status'] === 200 && str_starts_with($img2['ctype'], 'image/jpeg'), "HTTP {$img2['status']} {$img2['ctype']}");
    $img = getImage($admin, $S1urls[0]);
    check('image as admin → 200', $img['status'] === 200, "HTTP {$img['status']}");
    $img = getImage($B, $S1urls[0]);
    check('image as other user B → 404', $img['status'] === 404, "HTTP {$img['status']} {$img['ctype']}");
    check('image 404 leaks no image bytes', !str_starts_with($img['ctype'], 'image/'), $img['ctype']);
    $img = getImage($guest, $S1urls[0]);
    check('image as guest → 404', $img['status'] === 404, "HTTP {$img['status']}");
}
$img = req($A, 'GET', 'image', ['id' => '00000000-0000-4000-8000-000000000000']);
check('image unknown id → 404', $img['status'] === 404, "HTTP {$img['status']}");

section('submissions: access & scopes');
$id1 = $S1['id'] ?? 'missing';
$r = req($A, 'GET', 'submission', ['id' => $id1]);
check('get own submission → 200', isOk($r) && (data($r)['id'] ?? '') === $id1, desc($r));
$r = req($admin, 'GET', 'submission', ['id' => $id1]);
check('admin gets any submission → 200', isOk($r), desc($r));
expectErr('B gets A\'s submission → 403/404', req($B, 'GET', 'submission', ['id' => $id1]), [403, 404]);
expectErr('guest gets pending submission → 401/404', req($guest, 'GET', 'submission', ['id' => $id1]), [401, 404]);
expectErr('unknown submission id → 404', req($A, 'GET', 'submission', ['id' => '00000000-0000-4000-8000-000000000000']), 404, 'not_found');
expectErr('submission without id → 400/404', req($A, 'GET', 'submission'), [400, 404]);

$r = req($A, 'GET', 'submissions', ['scope' => 'mine']);
$mineA = data($r);
check('scope=mine (A) contains A\'s work', isOk($r) && in_array($id1, ids($mineA), true), desc($r));
check('scope=mine (A) only A\'s works', is_array($mineA) && count(array_filter($mineA, fn($s) => $s['userId'] !== $A->user['id'])) === 0);
$r = req($B, 'GET', 'submissions', ['scope' => 'mine']);
check('scope=mine (B) does not contain A\'s work', isOk($r) && !in_array($id1, ids(data($r)), true), desc($r));
expectErr('scope=mine as guest → 401', req($guest, 'GET', 'submissions', ['scope' => 'mine']), 401, 'auth_required');
expectErr('scope=all as user → 403', req($A, 'GET', 'submissions', ['scope' => 'all']), 403, 'forbidden');
expectErr('scope=all as guest → 401/403', req($guest, 'GET', 'submissions', ['scope' => 'all']), [401, 403]);
$r = req($admin, 'GET', 'submissions', ['scope' => 'all']);
check('scope=all as admin contains A\'s work', isOk($r) && in_array($id1, ids(data($r)), true), desc($r));
$r = req($guest, 'GET', 'submissions', ['scope' => 'gallery']);
check('gallery (guest) excludes pending work', isOk($r) && !in_array($id1, ids(data($r)), true), desc($r));
check('gallery contains only ideal', is_array(data($r)) && count(array_filter(data($r), fn($s) => $s['status'] !== 'ideal')) === 0);

// второй работы A — для порядка и удаления
$r = req($A, 'POST', 'submissions', [], form(['title' => "Вторая $RUN", 'category' => 'design'], [cf($png2, 'image/png')]), ['multipart' => true]);
expectOk('create second submission', $r);
$S2 = data($r) ?? []; $id2 = $S2['id'] ?? 'missing';
if (isset($S2['id'])) $LEDGER['subs'][$id2] = 'pending';
$r = req($A, 'GET', 'submissions', ['scope' => 'mine']);
$list = data($r) ?? [];
$sorted = true;
for ($i = 1; $i < count($list); $i++) if (strcmp($list[$i - 1]['updatedAt'], $list[$i]['updatedAt']) < 0) $sorted = false;
check('scope=mine sorted by updatedAt desc', $sorted && ($list[0]['id'] ?? '') === $id2, 'order: ' . implode(',', array_map(fn($s) => substr($s['id'], 0, 8) . '@' . $s['updatedAt'], $list)));

section('submissions: versions, comments, review');
expectErr('add version as B → 403/404', req($B, 'POST', 'submission/version', [], form(['id' => $id1, 'note' => 'hack'], [cf($png2, 'image/png')]), ['multipart' => true]), [403, 404]);
expectErr('add version as admin (not author) → 403', req($admin, 'POST', 'submission/version', [], form(['id' => $id1, 'note' => 'adm'], [cf($png2, 'image/png')]), ['multipart' => true]), 403, 'forbidden');
expectErr('add version as guest → 401', req($guest, 'POST', 'submission/version', [], form(['id' => $id1], [cf($png2, 'image/png')]), ['multipart' => true]), 401);
expectErr('add version without files → 400', req($A, 'POST', 'submission/version', [], ['id' => $id1, 'note' => 'x'], ['multipart' => true]), 400, 'validation', ['files']);
expectErr('add version to unknown id → 404', req($A, 'POST', 'submission/version', [], form(['id' => '00000000-0000-4000-8000-000000000000'], [cf($png2, 'image/png')]), ['multipart' => true]), 404, 'not_found');

expectErr('review as user → 403', req($A, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 10]), 403, 'forbidden');
expectErr('review as guest → 401', req($guest, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 10]), 401);
expectErr('review rating 0 → 400', req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 0]), 400, 'validation', ['rating']);
expectErr('review rating 11 → 400', req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 11]), 400, 'validation', ['rating']);
expectErr('review rating 5.5 → 400', req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 5.5]), 400, 'validation', ['rating']);
expectErr('review rating "abc" → 400', req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 'abc']), 400, 'validation', ['rating']);
expectErr('review unknown status → 400', req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'status' => 'approved']), 400, 'validation', ['status']);
expectErr('review unknown id → 404', req($admin, 'POST', 'submission/review', [], ['id' => '00000000-0000-4000-8000-000000000000', 'rating' => 5]), 404, 'not_found');
$r = req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 7, 'status' => 'revision']);
check('review rating 7 + status revision', isOk($r) && (data($r)['rating'] ?? 0) === 7 && (data($r)['status'] ?? '') === 'revision', desc($r));
$LEDGER['subs'][$id1] = 'revision';
$r = req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => null]);
check('review rating null clears rating, keeps status', isOk($r) && array_key_exists('rating', data($r) ?? []) && data($r)['rating'] === null && (data($r)['status'] ?? '') === 'revision', desc($r));
$r = req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'rating' => 9]);
check('review rating only keeps status', isOk($r) && (data($r)['rating'] ?? 0) === 9 && (data($r)['status'] ?? '') === 'revision', desc($r));

$r = req($A, 'POST', 'submission/version', [], form(['id' => $id1, 'note' => 'v2 fixed'], [cf($jpg, 'image/jpeg'), cf($png2, 'image/png')]), ['multipart' => true]);
expectOk('add version as author', $r);
$v = data($r) ?? [];
check('version: 2 versions, n=2, status back to pending, note', count($v['versions'] ?? []) === 2 && ($v['versions'][1]['n'] ?? 0) === 2 && ($v['status'] ?? '') === 'pending' && ($v['versions'][1]['note'] ?? '') === 'v2 fixed', short(json_encode($v, JSON_UNESCAPED_UNICODE), 300));
check('version: v1 images unchanged', ($v['versions'][0]['imageUrls'] ?? null) === ($S1['versions'][0]['imageUrls'] ?? []));
$LEDGER['subs'][$id1] = 'pending';
$S1urls = imageUrls($v);

expectErr('comment as B → 403/404', req($B, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => 'not mine']), [403, 404]);
expectErr('comment as guest → 401', req($guest, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => 'guest']), 401);
expectErr('comment empty → 400', req($A, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => '   ']), 400, 'validation', ['text']);
expectErr('comment 1001 chars → 400', req($A, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => str_repeat('к', 1001)]), 400, 'validation', ['text']);
expectErr('comment unknown id → 404', req($A, 'POST', 'submission/comment', [], ['id' => '00000000-0000-4000-8000-000000000000', 'text' => 'x']), 404, 'not_found');
$r = req($A, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => "  Спасибо <b>за</b> отзыв  "]);
$c1 = data($r);
check('comment as author → Comment, isAdmin false, trimmed', isOk($r) && !hasKeys($c1, ['id', 'userId', 'authorNick', 'isAdmin', 'text', 'createdAt']) && $c1['isAdmin'] === false && $c1['text'] === 'Спасибо <b>за</b> отзыв' && $c1['userId'] === $A->user['id'], desc($r));
sleep(1);
$r = req($admin, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => 'Админ: хорошо']);
check('comment as admin → isAdmin true', isOk($r) && (data($r)['isAdmin'] ?? null) === true, desc($r));
$r = req($A, 'GET', 'submission', ['id' => $id1]);
$s = data($r) ?? [];
checkSubmissionShape('submission shape after versions/comments', $s);
check('comments ascending, 2 items', count($s['comments'] ?? []) === 2 && ($s['comments'][0]['isAdmin'] ?? 1) === false && ($s['comments'][1]['isAdmin'] ?? 0) === true, short(json_encode($s['comments'] ?? null, JSON_UNESCAPED_UNICODE)));

section('submissions: gallery visibility');
expectErr('B cannot see A\'s work before ideal', req($B, 'GET', 'submission', ['id' => $id1]), [403, 404]);
$r = req($admin, 'POST', 'submission/review', [], ['id' => $id1, 'status' => 'ideal', 'rating' => 10]);
check('review status ideal', isOk($r) && (data($r)['status'] ?? '') === 'ideal', desc($r));
$LEDGER['subs'][$id1] = 'ideal';
$r = req($guest, 'GET', 'submission', ['id' => $id1]);
check('guest can get ideal work', isOk($r) && (data($r)['id'] ?? '') === $id1, desc($r));
$r = req($guest, 'GET', 'submissions', ['scope' => 'gallery']);
check('gallery (guest) contains ideal work', isOk($r) && in_array($id1, ids(data($r)), true), desc($r));
check('gallery does not contain A\'s pending work', !in_array($id2, ids(data($r)), true));
if ($S1urls) {
    $img = getImage($guest, $S1urls[0]);
    check('guest can load ideal work image', $img['status'] === 200 && str_starts_with($img['ctype'], 'image/'), "HTTP {$img['status']}");
    $img = getImage($B, end($S1urls));
    check('B can load ideal work image (v2)', $img['status'] === 200, "HTTP {$img['status']}");
}
expectErr('B still cannot comment on ideal work of A', req($B, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => 'nice']), [403, 404]);
expectErr('B cannot delete ideal work of A', req($B, 'POST', 'submission/delete', [], ['id' => $id1]), [403, 404]);

/* ============================== Задания ============================== */
section('tasks');
reset_rl();
$r = req($guest, 'GET', 'tasks');
check('list tasks as guest → 200 array', isOk($r) && is_array(data($r)), desc($r));
expectErr('create task as guest → 401', req($guest, 'POST', 'tasks', [], ['game' => 'minecraft', 'title' => 'Guest task', 'description' => '', 'difficulty' => 1]), 401, 'auth_required');
expectErr('create task bad game → 400 fields.game', req($A, 'POST', 'tasks', [], ['game' => 'fortnite', 'title' => 'Valid title', 'description' => '', 'difficulty' => 1]), 400, 'validation', ['game']);
expectErr('create task difficulty 4 → 400', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => 'Valid title', 'description' => '', 'difficulty' => 4]), 400, 'validation', ['difficulty']);
expectErr('create task difficulty 0 → 400', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => 'Valid title', 'difficulty' => 0]), 400, 'validation', ['difficulty']);
expectErr('create task difficulty array → 400', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => 'Valid title', 'difficulty' => [2]]), 400, 'validation', ['difficulty']);
expectErr('create task title too short → 400', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => 'ab', 'difficulty' => 2]), 400, 'validation', ['title']);
expectErr('create task description 1501 → 400', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => 'Valid title', 'description' => str_repeat('x', 1501), 'difficulty' => 2]), 400, 'validation', ['description']);
$r = req($A, 'POST', 'tasks', [], ['game' => 'minecraft', 'title' => "Задание 1 $RUN", 'description' => 'Построй замок', 'difficulty' => 2]);
expectOk('create task T1 (A, minecraft)', $r);
$T1 = data($r) ?? [];
checkTaskShape('task shape', $T1);
check('new task: status new, votes 0, myVote false, adminNote null, difficulty 2', ($T1['status'] ?? '') === 'new' && ($T1['votes'] ?? -1) === 0 && ($T1['myVote'] ?? null) === false && array_key_exists('adminNote', $T1) && $T1['adminNote'] === null && ($T1['difficulty'] ?? 0) === 2);
$t1 = $T1['id'] ?? 'missing'; $LEDGER['tasks'][$t1] = 'new';
sleep(1);
$r = req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => "Задание 2 $RUN", 'description' => '', 'difficulty' => 1]);
expectOk('create task T2 (A, cs2)', $r);
$t2 = data($r)['id'] ?? 'missing'; $LEDGER['tasks'][$t2] = 'new';
sleep(1);
$r = req($B, 'POST', 'tasks', [], ['game' => 'gta5rp', 'title' => "Задание 3 $RUN", 'description' => '', 'difficulty' => 3]);
expectOk('create task T3 (B, gta5rp)', $r);
$t3 = data($r)['id'] ?? 'missing'; $LEDGER['tasks'][$t3] = 'new';

expectErr('vote as guest → 401', req($guest, 'POST', 'task/vote', [], ['id' => $t1]), 401, 'auth_required');
expectErr('vote unknown task → 404', req($B, 'POST', 'task/vote', [], ['id' => '00000000-0000-4000-8000-000000000000']), 404, 'not_found');
$r = req($B, 'POST', 'task/vote', [], ['id' => $t1]);
check('B votes T1 → {votes 1, myVote true}', isOk($r) && data($r) == ['votes' => 1, 'myVote' => true] && is_int(data($r)['votes']), desc($r));
$r = req($A, 'POST', 'task/vote', [], ['id' => $t1]);
check('A votes T1 → votes 2', isOk($r) && (data($r)['votes'] ?? 0) === 2 && (data($r)['myVote'] ?? null) === true, desc($r));
$r = req($B, 'POST', 'task/vote', [], ['id' => $t1]);
check('B votes again → toggled off (votes 1, myVote false)', isOk($r) && (data($r)['votes'] ?? 0) === 1 && (data($r)['myVote'] ?? null) === false, desc($r));
$r = req($B, 'POST', 'task/vote', [], ['id' => $t1]);
check('B votes third time → votes 2 (no double vote)', isOk($r) && (data($r)['votes'] ?? 0) === 2 && (data($r)['myVote'] ?? null) === true, desc($r));
// параллельные голоса B — после двух переключений итог должен остаться 2 (каждый toggle атомарен) либо хотя бы ≤ 2
$mh = curl_multi_init(); $hs = [];
foreach ([1, 2] as $_) {
    $c = curl_init($BASE . '/api/index.php?r=task/vote');
    curl_setopt_array($c, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => json_encode(['id' => $t1]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Requested-With: ndze', 'Cookie: ndze_sid=' . $B->cookie('ndze_sid')]]);
    curl_multi_add_handle($mh, $c); $hs[] = $c;
}
do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.2); } while ($running);
foreach ($hs as $c) { curl_multi_remove_handle($mh, $c); curl_close($c); }
$r = req($guest, 'GET', 'tasks', ['game' => 'minecraft']);
$tv = findById(data($r), $t1);
check('concurrent double toggle by B: votes never exceed 2', $tv !== null && $tv['votes'] <= 2 && $tv['votes'] >= 1, json_encode($tv['votes'] ?? null));
if (($tv['votes'] ?? 2) !== 2) { req($B, 'POST', 'task/vote', [], ['id' => $t1]); info('re-synced B vote after concurrent toggles'); }

$r = req($guest, 'GET', 'tasks');
$tg = findById(data($r), $t1);
check('guest sees votes 2, myVote false', ($tg['votes'] ?? 0) === 2 && ($tg['myVote'] ?? null) === false, json_encode($tg));
$tA = findById(data(req($A, 'GET', 'tasks')), $t1);
$tB = findById(data(req($B, 'GET', 'tasks')), $t1);
$tC = findById(data(req($C, 'GET', 'tasks')), $t1);
check('myVote per user: A true, B true, C false', ($tA['myVote'] ?? null) === true && ($tB['myVote'] ?? null) === true && ($tC['myVote'] ?? null) === false, json_encode([$tA['myVote'] ?? null, $tB['myVote'] ?? null, $tC['myVote'] ?? null]));

$all = data(req($guest, 'GET', 'tasks')) ?? [];
$ok = true;
for ($i = 1; $i < count($all); $i++) {
    $p = $all[$i - 1]; $q = $all[$i];
    if ($p['votes'] < $q['votes'] || ($p['votes'] === $q['votes'] && strcmp($p['createdAt'], $q['createdAt']) < 0)) { $ok = false; break; }
}
check('tasks sorted by votes desc, then createdAt desc', $ok);
$pos = array_flip(ids($all));
check('order: T1 (2 votes) < T3 (newer) < T2', isset($pos[$t1], $pos[$t2], $pos[$t3]) && $pos[$t1] < $pos[$t3] && $pos[$t3] < $pos[$t2], json_encode([$pos[$t1] ?? null, $pos[$t3] ?? null, $pos[$t2] ?? null]));
$r = req($guest, 'GET', 'tasks', ['game' => 'cs2']);
check('filter game=cs2 → only cs2, contains T2', isOk($r) && in_array($t2, ids(data($r)), true) && !array_filter(data($r), fn($t) => $t['game'] !== 'cs2'), desc($r));
$r = req($guest, 'GET', 'tasks', ['status' => 'new', 'game' => 'gta5rp']);
check('filter status=new&game=gta5rp contains T3 only that game/status', isOk($r) && in_array($t3, ids(data($r)), true) && !array_filter(data($r), fn($t) => $t['game'] !== 'gta5rp' || $t['status'] !== 'new'), desc($r));

expectErr('update task as user → 403', req($A, 'POST', 'task/update', [], ['id' => $t1, 'status' => 'accepted']), 403, 'forbidden');
expectErr('update task as guest → 401', req($guest, 'POST', 'task/update', [], ['id' => $t1, 'status' => 'accepted']), 401);
expectErr('update task bad status → 400', req($admin, 'POST', 'task/update', [], ['id' => $t1, 'status' => 'started']), 400, 'validation', ['status']);
expectErr('update task adminNote 501 → 400', req($admin, 'POST', 'task/update', [], ['id' => $t1, 'adminNote' => str_repeat('a', 501)]), 400, 'validation', ['adminNote']);
expectErr('update unknown task → 404', req($admin, 'POST', 'task/update', [], ['id' => '00000000-0000-4000-8000-000000000000', 'status' => 'done']), 404, 'not_found');
$r = req($admin, 'POST', 'task/update', [], ['id' => $t1, 'status' => 'accepted', 'adminNote' => 'Сделаю в пятницу']);
check('admin update → status accepted + adminNote', isOk($r) && (data($r)['status'] ?? '') === 'accepted' && (data($r)['adminNote'] ?? '') === 'Сделаю в пятницу' && (data($r)['votes'] ?? 0) === 2, desc($r));
checkTaskShape('updated task shape', data($r));
$LEDGER['tasks'][$t1] = 'accepted';
$r = req($admin, 'POST', 'task/update', [], ['id' => $t1, 'adminNote' => null]);
check('adminNote null clears it, status unchanged', isOk($r) && array_key_exists('adminNote', data($r) ?? []) && data($r)['adminNote'] === null &&(data($r)['status'] ?? '') === 'accepted', desc($r));
$r = req($admin, 'POST', 'task/update', [], ['id' => $t3, 'status' => 'live']);
check('admin sets T3 live', isOk($r) && (data($r)['status'] ?? '') === 'live', desc($r));
$LEDGER['tasks'][$t3] = 'live';

expectErr('A deletes own accepted task → 403', req($A, 'POST', 'task/delete', [], ['id' => $t1]), 403, 'forbidden');
expectErr('B deletes A\'s new task → 403', req($B, 'POST', 'task/delete', [], ['id' => $t2]), 403, 'forbidden');
expectErr('guest deletes task → 401', req($guest, 'POST', 'task/delete', [], ['id' => $t2]), 401);
$r = req($A, 'POST', 'task/delete', [], ['id' => $t2]);
check('A deletes own new task → ok null', isOk($r) && data($r) === null, desc($r));
unset($LEDGER['tasks'][$t2]);
expectErr('deleted task: vote → 404', req($B, 'POST', 'task/vote', [], ['id' => $t2]), 404, 'not_found');
expectErr('delete twice → 404', req($A, 'POST', 'task/delete', [], ['id' => $t2]), 404, 'not_found');
$r = req($admin, 'POST', 'task/delete', [], ['id' => $t1]);
check('admin deletes accepted task with votes', isOk($r), desc($r));
unset($LEDGER['tasks'][$t1]);
$all = data(req($guest, 'GET', 'tasks')) ?? [];
check('deleted tasks gone from list', !in_array($t1, ids($all), true) && !in_array($t2, ids($all), true) && in_array($t3, ids($all), true));

/* ============================== SQL-инъекции и мусор во входе ============================== */
section('injection & malformed input');
$probes = ["' OR 1=1 --", "1' OR '1'='1", "\" OR \"\"=\"", "1; DROP TABLE users; --", "') UNION SELECT 1,2,3 -- ", '%27%20OR%201=1', str_repeat('A', 5000), "\0", 'all\' --'];
foreach ($probes as $i => $p) {
    $n = "probe#$i";
    expect4xx("$n submission id (admin)", req($admin, 'GET', 'submission', ['id' => $p]));
    $img = req($admin, 'GET', 'image', ['id' => $p]);
    check("$n image id → 404/400", in_array($img['status'], [400, 404], true), "HTTP {$img['status']}");
    $r = req($guest, 'GET', 'submissions', ['scope' => $p]);
    check("$n scope (guest) → 4xx, no private data", $r['status'] >= 400 && $r['status'] < 500 || (isOk($r) && !array_filter(data($r) ?? [], fn($s) => $s['status'] !== 'ideal')), desc($r));
    $r = req($admin, 'GET', 'tasks', ['status' => $p]);
    check("$n tasks status → 400 or empty list", ($r['status'] === 400) || (isOk($r) && data($r) === []), desc($r));
    $r = req($admin, 'GET', 'tasks', ['game' => $p]);
    check("$n tasks game → 400 or empty list", ($r['status'] === 400) || (isOk($r) && data($r) === []), desc($r));
    expect4xx("$n task/vote id", req($B, 'POST', 'task/vote', [], ['id' => $p]));
    expect4xx("$n submission/delete id (admin)", req($admin, 'POST', 'submission/delete', [], ['id' => $p]));
}
expect4xx('submission/review id as array', req($admin, 'POST', 'submission/review', [], ['id' => ['$ne' => 1], 'rating' => 5]));
expect4xx('task/vote id as object', req($B, 'POST', 'task/vote', [], ['id' => ['a' => 'b']]));
expect4xx('task/update status as array', req($admin, 'POST', 'task/update', [], ['id' => $t3, 'status' => ['live']]));
expect4xx('submission/comment text as array', req($A, 'POST', 'submission/comment', [], ['id' => $id1, 'text' => ['x']]));
expect4xx('tasks title as number object', req($A, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => ['x' => 1], 'difficulty' => 1]));
$r = req($admin, 'GET', 'submissions', ['scope[]' => 'all']);
check('scope as array → not 500', $r['status'] < 500, desc($r));
$r = req($A, 'GET', 'submission', ['id' => $id1]);
check('data intact after probes (submission still there)', isOk($r), desc($r));
check('tasks intact after probes', in_array($t3, ids(data(req($guest, 'GET', 'tasks')) ?? []), true));
reset_rl();
expectErr('login SQLi probe → 400/401', req($guest, 'POST', 'auth/login', [], ['email' => "' OR 1=1 --@x.com", 'password' => "x' OR '1'='1"]), [400, 401]);
expectErr('login with email of A + SQLi password → 401', req($guest, 'POST', 'auth/login', [], ['email' => strtolower($emailA), 'password' => "' OR '1'='1"]), 401, 'invalid_credentials');
expectErr('login password as array → 400/401', req($guest, 'POST', 'auth/login', [], ['email' => strtolower($emailA), 'password' => ['x']]), [400, 401]);

/* ============================== stats ============================== */
section('stats');
expectErr('stats as guest → 401', req($guest, 'GET', 'stats'), 401, 'auth_required');
expectErr('stats as user → 403', req($A, 'GET', 'stats'), 403, 'forbidden');
$r = req($admin, 'GET', 'stats');
expectOk('stats as admin', $r);
$st = data($r);
check('stats shape', !hasKeys($st, ['users', 'submissions', 'tasks']) && !hasKeys($st['submissions'] ?? null, ['total', 'pending', 'revision', 'ideal', 'rejected'])
    && !hasKeys($st['tasks'] ?? null, ['total', 'new', 'accepted', 'live', 'done', 'rejected']), short($r['body']));
if ($PDO && is_array($st) && !hasKeys($st, ['users', 'submissions', 'tasks'])) {
    // сверка с базой напрямую (устойчиво к параллельной активности других клиентов)
    $exp = ['users' => (int) $PDO->query('SELECT COUNT(*) FROM users')->fetchColumn(),
        'submissions' => ['total' => 0, 'pending' => 0, 'revision' => 0, 'ideal' => 0, 'rejected' => 0],
        'tasks' => ['total' => 0, 'new' => 0, 'accepted' => 0, 'live' => 0, 'done' => 0, 'rejected' => 0]];
    foreach (['submissions', 'tasks'] as $tbl) {
        foreach ($PDO->query("SELECT status, COUNT(*) c FROM $tbl GROUP BY status")->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $exp[$tbl][$row['status']] = (int) $row['c'];
            $exp[$tbl]['total'] += (int) $row['c'];
        }
    }
    check('stats numbers match DB counts', $exp == $st, 'DB ' . json_encode($exp) . ' API ' . json_encode($st));
}
if (!$PDO && is_array($S0) && is_array($st) && !hasKeys($st, ['users', 'submissions', 'tasks'])) {
    $exp = $S0;
    $exp['users'] += $LEDGER['users']; // пользователи, зарегистрированные после S0
    foreach ($LEDGER['subs'] as $stt) { $exp['submissions']['total']++; $exp['submissions'][$stt]++; }
    foreach ($LEDGER['tasks'] as $stt) { $exp['tasks']['total']++; $exp['tasks'][$stt]++; }
    check('stats numbers match (baseline + this run)', $exp == $st, 'expected ' . json_encode($exp) . ' got ' . json_encode($st));
    $sumS = array_sum(array_intersect_key($st['submissions'], array_flip(['pending', 'revision', 'ideal', 'rejected'])));
    $sumT = array_sum(array_intersect_key($st['tasks'], array_flip(['new', 'accepted', 'live', 'done', 'rejected'])));
    check('stats totals = sum of statuses', $sumS === $st['submissions']['total'] && $sumT === $st['tasks']['total']);
}
expectErr('health/discord as guest → 401', req($guest, 'GET', 'health/discord'), 401);
expectErr('health/discord as user → 403', req($A, 'GET', 'health/discord'), 403, 'forbidden');
$r = req($admin, 'GET', 'health/discord');
check('health/discord as admin → {reachable, ms}', isOk($r) && is_bool(data($r)['reachable'] ?? null) && array_key_exists('ms', data($r) ?? []), desc($r));

/* ============================== удаление работ ============================== */
section('submission delete');
$urls2 = imageUrls($S2);
expectErr('B deletes A\'s submission → 403/404', req($B, 'POST', 'submission/delete', [], ['id' => $id2]), [403, 404]);
expectErr('guest deletes → 401', req($guest, 'POST', 'submission/delete', [], ['id' => $id2]), 401);
$r = req($A, 'POST', 'submission/delete', [], ['id' => $id2]);
check('owner deletes own submission → ok null', isOk($r) && data($r) === null, desc($r));
unset($LEDGER['subs'][$id2]);
expectErr('deleted submission → 404', req($A, 'GET', 'submission', ['id' => $id2]), 404, 'not_found');
foreach ($urls2 as $u) { $img = getImage($A, $u); check('deleted submission image → 404', $img['status'] === 404, "HTTP {$img['status']}"); }
expectErr('delete twice → 404', req($A, 'POST', 'submission/delete', [], ['id' => $id2]), 404, 'not_found');
$r = req($admin, 'POST', 'submission/delete', [], ['id' => $id1]);
check('admin deletes A\'s ideal submission', isOk($r), desc($r));
unset($LEDGER['subs'][$id1]);
foreach ($S1urls as $u) { $img = getImage($guest, $u); check('admin-deleted images → 404 (guest)', $img['status'] === 404, "HTTP {$img['status']}"); }
$r = req($guest, 'GET', 'submissions', ['scope' => 'gallery']);
check('deleted work gone from gallery', isOk($r) && !in_array($id1, ids(data($r)), true));

/* ============================== Личный кабинет и аватарки ============================== */
section('profile & avatars');
const AVATAR_URL_RE = '#^api/index\.php\?r=avatar&id=([0-9a-f-]{36})&v=[0-9a-f]{8}$#';
function upAvatar(Actor $a, array $files): array { return req($a, 'POST', 'me/avatar', [], form([], $files), ['multipart' => true]); }

expectErr('me/profile as guest → 401', req($guest, 'GET', 'me/profile'), 401, 'auth_required');
$r = req($A, 'GET', 'me/profile');
$p = data($r) ?? [];
check('me/profile → {user, hasPassword, discordLinked, stats}', isOk($r) && !hasKeys($p, ['user', 'hasPassword', 'discordLinked', 'stats'])
    && $p['hasPassword'] === true && $p['discordLinked'] === false, desc($r));
$st = $p['stats'] ?? null;
check('profile stats: ints (+ avgRating number|null)', !hasKeys($st, ['submissions', 'ideal', 'avgRating', 'tasks', 'tasksDone', 'votesReceived'])
    && is_int($st['submissions']) && is_int($st['ideal']) && is_int($st['tasks']) && is_int($st['tasksDone']) && is_int($st['votesReceived'])
    && ($st['avgRating'] === null || is_int($st['avgRating']) || is_float($st['avgRating'])), short(json_encode($st)));
checkUser('profile.user shape', $p['user'] ?? null);
check('User.avatarUrl is null before upload', is_array($p['user'] ?? null) && array_key_exists('avatarUrl', $p['user']) && $p['user']['avatarUrl'] === null, short(json_encode($p['user'] ?? null)));

$avPng = gd_png(600, 400, "$TMP/avatar.png");
expectErr('avatar as guest → 401', upAvatar($guest, [cf($avPng, 'image/png')]), 401, 'auth_required');
expectErr('avatar without CSRF header → 403', req($A, 'POST', 'me/avatar/delete', [], [], ['csrf' => false]), 403, 'forbidden');
expectErr('avatar without file → 400 files', req($A, 'POST', 'me/avatar', [], ['x' => '1'], ['multipart' => true]), 400, 'validation', ['files']);
file_put_contents("$TMP/fake-avatar.png", "not an image at all\n");
expectErr('avatar: text renamed to .png → 400', upAvatar($A, [cf("$TMP/fake-avatar.png", 'image/png')]), 400, 'validation', ['files']);
expectErr('avatar: two files → 400', upAvatar($A, [cf($avPng, 'image/png'), cf($avPng, 'image/png')]), 400, 'validation', ['files']);

$r = upAvatar($A, [cf($avPng, 'image/png')]);
$av1 = (string) (data($r)['avatarUrl'] ?? '');
check('avatar upload → User.avatarUrl', isOk($r) && preg_match(AVATAR_URL_RE, $av1, $m) && $m[1] === $A->user['id'], desc($r));
$img = getImage($guest, $av1);
check('guest loads avatar → 200 image/*', $img['status'] === 200 && str_starts_with($img['ctype'], 'image/'), "HTTP {$img['status']} {$img['ctype']}");
$sz = @getimagesizefromstring($img['body']);
check('avatar is cropped to 256×256', is_array($sz) && $sz[0] === 256 && $sz[1] === 256, json_encode($sz));
check('avatar URL is cached as immutable', str_contains(strtolower(implode(',', $img['headers']['cache-control'] ?? [])), 'immutable'), implode(',', $img['headers']['cache-control'] ?? []));
$r = req($A, 'GET', 'me');
check('GET me returns the same avatarUrl', isOk($r) && (data($r)['avatarUrl'] ?? null) === $av1, desc($r));
$r = req($guest, 'GET', 'tasks');
$allHaveKey = isOk($r) && array_reduce(data($r) ?? [], fn($ok, $t) => $ok && array_key_exists('authorAvatar', $t), true);
check('tasks carry authorAvatar', $allHaveKey, desc($r));
$mineA = array_values(array_filter(data($r) ?? [], fn($t) => ($t['userId'] ?? '') === $A->user['id']));
if ($mineA) check('A\'s task shows A\'s avatar', $mineA[0]['authorAvatar'] === $av1, (string) $mineA[0]['authorAvatar']);

$r = upAvatar($A, [cf(gd_jpeg(300, 500, "$TMP/avatar2.jpg"), 'image/jpeg')]);
$av2 = (string) (data($r)['avatarUrl'] ?? '');
check('second avatar (JPEG) → new URL', isOk($r) && preg_match(AVATAR_URL_RE, $av2) && $av2 !== $av1, desc($r));
$img = getImage($guest, $av1);
check('old avatar URL is not cached forever any more', $img['status'] === 200 && !str_contains(strtolower(implode(',', $img['headers']['cache-control'] ?? [])), 'immutable'), "HTTP {$img['status']}");
$r = upAvatar($A, [cf(gd_gif(64, 64, "$TMP/avatar.gif"), 'image/gif')]);
check('GIF avatar accepted', isOk($r) && preg_match(AVATAR_URL_RE, (string) (data($r)['avatarUrl'] ?? '')), desc($r));
$av3 = (string) (data($r)['avatarUrl'] ?? '');

$r = req($A, 'POST', 'me/avatar/delete');
check('avatar delete → avatarUrl null', isOk($r) && array_key_exists('avatarUrl', data($r) ?? []) && data($r)['avatarUrl'] === null, desc($r));
$img = getImage($guest, $av3);
check('deleted avatar → 404', $img['status'] === 404, "HTTP {$img['status']}");
expectErr('avatar of user without one → 404', req($guest, 'GET', 'avatar', ['id' => $B->user['id']]), 404, 'not_found');
expectErr('avatar with bad id → 404', req($guest, 'GET', 'avatar', ['id' => '../../config']), 404, 'not_found');

expectErr('nick change as guest → 401', req($guest, 'POST', 'me/update', [], ['nick' => "ghost_$RUN"]), 401, 'auth_required');
expectErr('nick change: invalid → 400 nick', req($A, 'POST', 'me/update', [], ['nick' => 'a b']), 400, 'validation', ['nick']);
expectErr('nick change: taken (other case) → 409', req($A, 'POST', 'me/update', [], ['nick' => strtoupper("userB_$RUN")]), 409, 'nick_taken', ['nick']);
$newNick = "renA_$RUN";
$r = req($A, 'POST', 'me/update', [], ['nick' => $newNick]);
check('nick change → User.nick', isOk($r) && (data($r)['nick'] ?? null) === $newNick, desc($r));
$r = req($guest, 'GET', 'tasks');
$mineA = array_values(array_filter(data($r) ?? [], fn($t) => ($t['userId'] ?? '') === $A->user['id']));
if ($mineA) check('tasks show the new nick', $mineA[0]['authorNick'] === $newNick, (string) $mineA[0]['authorNick']);
$r = req($A, 'POST', 'me/update', [], ['nick' => "userA_$RUN"]);
check('nick changed back', isOk($r) && (data($r)['nick'] ?? null) === "userA_$RUN", desc($r));

expectErr('password: wrong current → 400 currentPassword', req($A, 'POST', 'me/password', [], ['currentPassword' => 'wrong-pass', 'newPassword' => 'newPassA_123']), 400, 'validation', ['currentPassword']);
expectErr('password: too short → 400 newPassword', req($A, 'POST', 'me/password', [], ['currentPassword' => 'passwordA1', 'newPassword' => 'short']), 400, 'validation', ['newPassword']);
$A3 = new Actor('A3');
expectOk('A logs in on a second device', req($A3, 'POST', 'auth/login', [], ['email' => $emailA, 'password' => 'passwordA1']));
$r = req($A, 'POST', 'me/password', [], ['currentPassword' => 'passwordA1', 'newPassword' => 'newPassA_123']);
check('password change → ok null', isOk($r) && data($r) === null, desc($r));
$r = req($A3, 'GET', 'me');
check('password change logs out the other device', isOk($r) && data($r) === null, desc($r));
expectErr('other device can no longer post', req($A3, 'POST', 'me/update', [], ['nick' => "zzz_$RUN"]), 401, 'auth_required');
$r = req($A, 'GET', 'me');
check('still logged in after password change', isOk($r) && (data($r)['id'] ?? null) === $A->user['id'], desc($r));
$A2 = new Actor('A2');
expectErr('old password no longer works', req($A2, 'POST', 'auth/login', [], ['email' => $emailA, 'password' => 'passwordA1']), 401, 'invalid_credentials');
expectOk('new password works', req($A2, 'POST', 'auth/login', [], ['email' => $emailA, 'password' => 'newPassA_123']));
expectOk('password changed back', req($A, 'POST', 'me/password', [], ['currentPassword' => 'newPassA_123', 'newPassword' => 'passwordA1']));
$r = req($A, 'POST', 'me/discord/unlink');
check('discord unlink when not linked → profile, discordLinked false', isOk($r) && (data($r)['discordLinked'] ?? null) === false, desc($r));
reset_rl();

/* ============================== Discord ============================== */
section('discord');
$dl = $BASE . '/api/discord-login.php';
function noPhpError(array $r): bool { return $r['status'] !== 500 && !preg_match('/Fatal error|Warning:|Notice:|Stack trace|Uncaught/i', $r['body']); }
function badLocation(string $loc): bool
{
    global $BASE;
    // как браузер: убрать ведущие/хвостовые C0+пробел и все \t \r \n внутри
    $l = strtolower(str_replace(["\t", "\r", "\n"], '', trim($loc, "\x00..\x20")));
    if (preg_match('#^(/[/\\\\]|\\\\|[a-z][a-z0-9+.-]*:)#', $l)) { // абсолютный / протокол-относительный
        $ok = str_starts_with($l, strtolower($BASE) . '/') || str_starts_with($l, 'https://discord.com/');
        return !$ok;
    }
    return false;
}
$r = req($guest, 'GET', $dl, ['return' => '/tasks.html']);
check('discord-login without client_id → graceful (no 500/PHP error)', noPhpError($r), desc($r));
$loc = $r['headers']['location'][0] ?? '';
check('discord-login without client_id → redirect back with auth=discord_error (or 4xx/503 JSON)', ($r['status'] === 302 && str_contains($loc, 'auth=discord_error') && !str_contains($loc, 'discord.com/oauth2')) || in_array($r['status'], [400, 503], true), "HTTP {$r['status']} Location: $loc");
foreach (['https://evil.com', '//evil.com', '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)', 'https:evil.com', "/\r\nLocation: https://evil.com", "/%0d%0aLocation:%20https://evil.com", ' //evil.com', "/\t/evil.com", "/\n/evil.com", '/%2F/evil.com', '/%5Cevil.com', 'HTTPS://EVIL.COM'] as $ret) {
    $r = req($guest, 'GET', $dl, ['return' => $ret]);
    $loc = $r['headers']['location'][0] ?? '';
    check("open redirect blocked: return=" . json_encode($ret), noPhpError($r) && !badLocation($loc) && count($r['headers']['location'] ?? []) <= 1, "HTTP {$r['status']} Location: $loc");
}
$r = req($guest, 'GET', $dl, ['return' => 'https://evil.com']);
$loc = $r['headers']['location'][0] ?? '';
if ($r['status'] === 302) check('return=https://evil.com falls back to /', (bool) preg_match('#^(' . preg_quote($BASE, '#') . ')?/(\?|$)#', $loc), "Location: $loc");
$cb = $BASE . '/api/discord-callback.php';
$r = req($guest, 'GET', $cb, ['code' => 'x', 'state' => 'forged']);
$loc = $r['headers']['location'][0] ?? '';
check('discord-callback with forged state → 302 discord_error, no PHP error', noPhpError($r) && $r['status'] === 302 && str_contains($loc, 'auth=discord_error') && !badLocation($loc), "HTTP {$r['status']} Location: $loc");
$r = req($guest, 'GET', $cb);
$loc = $r['headers']['location'][0] ?? '';
check('discord-callback with no params → 302 discord_error', noPhpError($r) && $r['status'] === 302 && str_contains($loc, 'auth=discord_error'), "HTTP {$r['status']} Location: $loc");
$r = req($guest, 'GET', $cb, ['error' => 'access_denied', 'state' => 'x']);
check('discord-callback error=access_denied → 302, no PHP error', noPhpError($r) && $r['status'] === 302 && !badLocation($r['headers']['location'][0] ?? ''), desc($r));
$r = req($guest, 'GET', 'me');
check('still guest after failed discord flow', isOk($r) && data($r) === null);

/* ============================== Лимиты (в конце: общий IP) ============================== */
section('rate limits');
if ($PDO) {
    reset_rl();
    $first429 = null;
    for ($i = 1; $i <= 11; $i++) {
        $r = req($guest, 'POST', 'auth/login', [], ['email' => "bad_$RUN@example.com", 'password' => "wrong-pass-$i"]);
        if ($r['status'] === 429) { $first429 = $i; break; }
    }
    check('login: 10 bad attempts allowed, 11th → 429', $first429 === 11, 'first 429 at attempt ' . var_export($first429, true));
    if ($first429) expectErr('429 envelope rate_limited', $r, 429, 'rate_limited');
    expectErr('login with correct password while limited → 429', req(new Actor('late'), 'POST', 'auth/login', [], ['email' => strtolower($emailA), 'password' => 'passwordA1']), 429, 'rate_limited');
    reset_rl();
    $first429 = null;
    for ($i = 1; $i <= 6; $i++) {
        $r = req(new Actor("reg$i"), 'POST', 'auth/register', [], ['nick' => "rl{$i}_$RUN", 'email' => "rl{$i}_$RUN@example.com", 'password' => 'password123']);
        if ($r['status'] === 429) { $first429 = $i; break; }
    }
    check('register: 5 per hour allowed, 6th → 429', $first429 === 6, 'first 429 at attempt ' . var_export($first429, true));
    reset_rl();
} else {
    // без доступа к БД: предыдущие попытки уже могли израсходовать лимит
    $first429 = null;
    for ($i = 1; $i <= 11; $i++) {
        $r = req($guest, 'POST', 'auth/login', [], ['email' => "bad_$RUN@example.com", 'password' => "wrong-pass-$i"]);
        if ($r['status'] === 429) { $first429 = $i; break; }
    }
    check('login: 429 reached within 11 bad attempts', $first429 !== null, 'no 429 after 11 attempts');
    if ($first429) expectErr('429 envelope rate_limited', $r, 429, 'rate_limited');
    info('TEST_DB_DSN not set: exact-threshold and register-limit checks skipped');
}

/* ============================== Итог ============================== */
section('server errors seen');
check('no HTTP 500 responses during the whole run', !$SEEN500, implode('; ', array_slice($SEEN500, 0, 10)));

foreach (glob("$TMP/*") ?: [] as $f) @unlink($f);
@rmdir($TMP);
echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
if ($FAILS) { echo "Failures:\n"; foreach ($FAILS as $f) echo "  - $f\n"; }
exit($FAIL ? 1 : 0);

<?php
// Тесты фичи «Сообщество»: клипы, публичные профили, квест-пауки, карта Penta и постройки.
//
//   php tests/features/community.php [http://127.0.0.1:8090]
//
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — очистка rate_limits и проверка лимитов.
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');
foreach (['curl', 'gd', 'json'] as $ext) {
    if (!extension_loaded($ext)) { fwrite(STDERR, "Нужно расширение PHP: $ext\n"); exit(2); }
}

$BASE = rtrim((string) ($argv[1] ?? (getenv('API_BASE') ?: 'http://127.0.0.1:8090')), '/');
$ADMIN_EMAIL = getenv('TEST_ADMIN_EMAIL') ?: 'ndze-admin@example.com';
$ADMIN_PASS = getenv('TEST_ADMIN_PASS') ?: 'AdminTest_pw1';
$RUN = bin2hex(random_bytes(3));
$TMP = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ndze-cm-test-' . $RUN;
@mkdir($TMP, 0700, true);

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
}

function req(Actor $a, string $method, string $route, array $query = [], $body = null, array $opt = []): array
{
    global $BASE;
    $url = preg_match('#^https?://#', $route) ? $route : $BASE . '/api/index.php?' . http_build_query(['r' => $route] + $query, '', '&', PHP_QUERY_RFC3986);
    $ch = $a->ch;
    curl_reset($ch);
    $hdrs = ['Accept: application/json'];
    if ($method === 'POST' && ($opt['csrf'] ?? true)) $hdrs[] = 'X-Requested-With: ndze';
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_URL => $url, CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_COOKIEFILE => '',
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 60,
        CURLOPT_HEADERFUNCTION => static function ($c, string $line) use (&$respHeaders): int {
            $p = strpos($line, ':');
            if ($p !== false) $respHeaders[strtolower(trim(substr($line, 0, $p)))][] = trim(substr($line, $p + 1));
            return strlen($line);
        },
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if (!empty($opt['multipart'])) curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? []);
        else {
            $hdrs[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
        }
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $res = curl_exec($ch);
    if ($res === false) return ['status' => 0, 'headers' => [], 'body' => '', 'json' => null, 'ctype' => '', 'err' => curl_error($ch)];
    $ctype = strtolower($respHeaders['content-type'][0] ?? '');
    $r = ['status' => (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'headers' => $respHeaders, 'body' => $res,
        'json' => str_contains($ctype, 'json') ? json_decode($res, true) : null, 'ctype' => $ctype, 'err' => ''];
    if (!str_starts_with($ctype, 'image/') && preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace|Uncaught /', $res, $m)) {
        check("no PHP/SQL leak in $method $route", false, $m[0]);
    }
    if ($r['status'] >= 500) check("no 500 in $method $route", false, short($res));
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
    $good = in_array($r['status'], (array) $status, true) && is_array($e) && ($code === null || ($e['code'] ?? null) === $code);
    foreach ($fields as $f) $good = $good && is_array($e['fields'] ?? null) && array_key_exists($f, $e['fields']);
    return check($name, $good, 'want ' . implode('/', (array) $status) . ($code ? " $code" : '') . ', got ' . desc($r));
}

/* ---------- БД (необязательно) ---------- */
$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try {
        $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    } catch (Throwable $e) { echo "WARN  нет подключения к БД: {$e->getMessage()}\n"; }
}
function reset_rl(): void { global $PDO; if ($PDO) $PDO->exec('DELETE FROM rate_limits'); }

/* ---------- Картинки ---------- */
function gd_png(int $w, int $h, string $file): string
{
    $im = imagecreatetruecolor($w, $h);
    for ($i = 0; $i < 10; $i++) imagefilledrectangle($im, random_int(0, $w - 1), random_int(0, $h - 1), random_int(0, $w - 1), random_int(0, $h - 1), imagecolorallocate($im, random_int(0, 255), random_int(0, 255), random_int(0, 255)));
    imagepng($im, $file);
    imagedestroy($im);
    return $file;
}
function cf(string $path, string $mime, ?string $name = null): CURLFile { return new CURLFile($path, $mime, $name ?? basename($path)); }

function register(Actor $a, string $nick): array
{
    global $RUN;
    $r = req($a, 'POST', 'auth/register', [], ['nick' => $nick, 'email' => strtolower($nick) . "@example.com", 'password' => 'Passw0rd_' . $RUN]);
    if (isOk($r)) $a->user = data($r);
    return $r;
}

echo "API base: $BASE  run: $RUN  DB: " . ($PDO ? 'yes' : 'no') . "\n";
reset_rl();

$guest = new Actor('guest');
$admin = new Actor('admin');
$A = new Actor('A');
$B = new Actor('B');

section('setup');
$r = req($admin, 'POST', 'auth/login', [], ['email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]);
expectOk('admin login', $r);
$admin->user = data($r);
expectOk('register A', register($A, "cmA_$RUN"));
expectOk('register B', register($B, "cmB_$RUN"));

/* ================= Клипы ================= */
section('clips');
expectErr('guest cannot submit clip', req($guest, 'POST', 'clip', [], ['url' => 'https://clips.twitch.tv/AbcDef', 'title' => 'Тест']), 401, 'auth_required');
expectErr('POST without CSRF header rejected', req($A, 'POST', 'clip', [], ['url' => 'https://clips.twitch.tv/Abc', 'title' => 'Тест'], ['csrf' => false]), 403, 'forbidden');
$bad = [
    'http (not https)' => 'http://clips.twitch.tv/SomeClip',
    'other host' => 'https://evil.com/clip/SomeClip',
    'twitch channel page' => 'https://www.twitch.tv/ndze_one',
    'embed page' => 'https://clips.twitch.tv/embed?clip=Abc',
    'slug too short' => 'https://clips.twitch.tv/ab',
    'bad chars' => 'https://clips.twitch.tv/abc%3Cscript',
    'userinfo' => 'https://user:pw@clips.twitch.tv/SomeClip',
    'javascript' => 'javascript:alert(1)//clips.twitch.tv/x',
    'subdomain trick' => 'https://clips.twitch.tv.evil.com/SomeClip',
];
foreach ($bad as $what => $url) {
    expectErr("clip url rejected: $what", req($A, 'POST', 'clip', [], ['url' => $url, 'title' => 'Нормальное название']), 400, 'validation', ['url']);
}
expectErr('clip title too short', req($A, 'POST', 'clip', [], ['url' => "https://clips.twitch.tv/Good{$RUN}Slug", 'title' => 'ab']), 400, 'validation', ['title']);
expectErr('clip title too long', req($A, 'POST', 'clip', [], ['url' => "https://clips.twitch.tv/Good{$RUN}Slug", 'title' => str_repeat('я', 121)]), 400, 'validation', ['title']);

$slug1 = "FunnyClip{$RUN}-Ab_9";
$r = req($A, 'POST', 'clip', [], ['url' => "https://clips.twitch.tv/$slug1?filter=clips", 'title' => '<b>Эпичный</b> момент']);
expectOk('A submits clip (clips.twitch.tv)', $r);
$clip1 = data($r);
check('clip shape', is_array($clip1) && $clip1['slug'] === $slug1 && $clip1['votes'] === 0 && $clip1['myVote'] === false
    && $clip1['author']['nick'] === "cmA_$RUN" && $clip1['url'] === "https://clips.twitch.tv/$slug1" && !isset($clip1['author']['email']), short(json_encode($clip1, JSON_UNESCAPED_UNICODE)));
check('clip title stored raw (escaped on client)', ($clip1['title'] ?? '') === '<b>Эпичный</b> момент');
$slug2 = "Second{$RUN}Clip";
$r = req($B, 'POST', 'clip', [], ['url' => "https://www.twitch.tv/ndze_one/clip/$slug2", 'title' => 'Второй клип']);
expectOk('B submits clip (www.twitch.tv/<channel>/clip/)', $r);
$clip2 = data($r);
expectErr('duplicate slug rejected', req($B, 'POST', 'clip', [], ['url' => "https://www.twitch.tv/other_chan/clip/$slug1", 'title' => 'Дубль']), 400, 'validation', ['url']);

expectErr('guest cannot vote', req($guest, 'POST', 'clip/vote', [], ['id' => $clip1['id']]), 401);
expectErr('cannot vote own clip', req($A, 'POST', 'clip/vote', [], ['id' => $clip1['id']]), 400, 'validation');
expectErr('vote bad id → 404', req($B, 'POST', 'clip/vote', [], ['id' => 'nope']), 404, 'not_found');
$r = req($B, 'POST', 'clip/vote', [], ['id' => $clip1['id']]);
check('B votes for A clip', isOk($r) && data($r)['votes'] === 1 && data($r)['myVote'] === true, desc($r));
$r = req($admin, 'POST', 'clip/vote', [], ['id' => $clip1['id']]);
check('admin votes too → 2', isOk($r) && data($r)['votes'] === 2, desc($r));
$r = req($B, 'POST', 'clip/vote', [], ['id' => $clip1['id']]);
check('B toggles vote off → 1', isOk($r) && data($r)['votes'] === 1 && data($r)['myVote'] === false, desc($r));
req($B, 'POST', 'clip/vote', [], ['id' => $clip1['id']]);

$r = req($B, 'GET', 'clips', ['period' => 'week']);
expectOk('GET clips week', $r);
$d = data($r);
$ids = array_column($d['items'] ?? [], 'id');
check('week list contains both clips', in_array($clip1['id'], $ids, true) && in_array($clip2['id'], $ids, true));
$mine = array_values(array_filter($d['items'] ?? [], fn($x) => $x['id'] === $clip1['id']))[0] ?? null;
check('myVote=true for B in list', $mine && $mine['myVote'] === true && $mine['votes'] === 2, short(json_encode($mine)));
check('top of week is set', is_array($d['top'] ?? null));
$r = req($guest, 'GET', 'clips', ['period' => 'all', 'sort' => 'new']);
check('GET clips all/new (guest) — newest first, myVote false', isOk($r) && data($r)['period'] === 'all' && data($r)['items'][0]['id'] === $clip2['id'] && data($r)['items'][0]['myVote'] === false, desc($r));
$r = req($guest, 'GET', 'clips/week');
check('GET clips/week → clip', isOk($r) && is_array(data($r)['clip']), desc($r));

expectErr('B cannot delete A clip', req($B, 'POST', 'clip/delete', [], ['id' => $clip1['id']]), 403, 'forbidden');
expectOk('B deletes own clip', req($B, 'POST', 'clip/delete', [], ['id' => $clip2['id']]));
expectOk('admin deletes A clip', req($admin, 'POST', 'clip/delete', [], ['id' => $clip1['id']]));
$r = req($guest, 'GET', 'clips', ['period' => 'all']);
check('deleted clips are gone', isOk($r) && !array_intersect([$clip1['id'], $clip2['id']], array_column(data($r)['items'], 'id')));

if ($PDO) {
    reset_rl();
    $codes = [];
    for ($i = 0; $i < 6; $i++) $codes[] = req($A, 'POST', 'clip', [], ['url' => "https://clips.twitch.tv/Rl{$RUN}x$i", 'title' => "Лимит $i"])['status'];
    check('clip rate limit: 5 ok, 6th → 429', array_slice($codes, 0, 5) === [200, 200, 200, 200, 200] && $codes[5] === 429, implode(',', $codes));
    $PDO->prepare("DELETE FROM clips WHERE slug LIKE ?")->execute(["Rl{$RUN}x%"]);
    reset_rl();
}

/* ================= Квест ================= */
section('quest');
expectErr('guest GET quest → 401', req($guest, 'GET', 'quest'), 401, 'auth_required');
expectErr('guest find → 401', req($guest, 'POST', 'quest/find', [], ['egg' => 'home']), 401);
$r = req($A, 'GET', 'quest');
check('A quest empty', isOk($r) && data($r)['found'] === [] && data($r)['total'] === 5 && data($r)['done'] === false, desc($r));
foreach (['nope', '', 'HOME', 'play', ['home']] as $egg) {
    expectErr('unknown egg rejected: ' . json_encode($egg), req($A, 'POST', 'quest/find', [], ['egg' => $egg]), 400, 'validation');
}
$r = req($A, 'GET', 'me/profile');
$bal0 = data($r)['points'] ?? null;
$eggs = ['home', 'projects', 'forum', 'review'];
foreach ($eggs as $i => $egg) {
    $r = req($A, 'POST', 'quest/find', [], ['egg' => $egg]);
    check("find $egg → " . ($i + 1) . '/5', isOk($r) && data($r)['count'] === $i + 1 && data($r)['isNew'] === true && data($r)['reward'] === 0, desc($r));
}
$r = req($A, 'POST', 'quest/find', [], ['egg' => 'home']);
check('repeat find is idempotent', isOk($r) && data($r)['count'] === 4 && data($r)['isNew'] === false, desc($r));
$r = req($A, 'POST', 'quest/find', [], ['egg' => '404']);
check('5th spider → done + reward 300', isOk($r) && data($r)['done'] === true && data($r)['reward'] === 300, desc($r));
$r = req($A, 'POST', 'quest/find', [], ['egg' => '404']);
check('no second reward', isOk($r) && data($r)['reward'] === 0 && data($r)['done'] === true, desc($r));
$p = data(req($A, 'GET', 'me/profile'));
check('balance +300 exactly once', $bal0 !== null && ($p['points'] ?? null) === $bal0 + 300, "before $bal0 after " . ($p['points'] ?? 'null'));
$badge = array_values(array_filter($p['progress']['badges'] ?? [], fn($b) => $b['id'] === 'spider_sense'))[0] ?? null;
check('badge spider_sense earned', $badge && $badge['earned'] === true && $badge['icon'] === '🕷', short(json_encode($badge, JSON_UNESCAPED_UNICODE)));
expectErr('user cannot read quest/stats', req($A, 'GET', 'quest/stats'), 403, 'forbidden');
$r = req($admin, 'GET', 'quest/stats');
check('admin quest/stats', isOk($r) && count(data($r)['eggs']) === 5 && data($r)['completed'] >= 1, desc($r));

/* ================= Публичный профиль ================= */
section('public profile');
$r = req($guest, 'GET', 'user', ['nick' => strtoupper("cmA_$RUN")]);
expectOk('guest GET user (case-insensitive nick)', $r);
$u = data($r);
$json = $r['body'];
check('public profile shape', is_array($u) && $u['user']['nick'] === "cmA_$RUN" && isset($u['progress']['level'], $u['stats']['forumPosts'], $u['quest']['found'])
    && is_array($u['gallery']) && is_array($u['threads']) && $u['isMe'] === false && $u['quest']['found'] === 5, short($json, 400));
check('no email / discord / password leak', !preg_match('/example\.com|"email"|discord_id|"discordId"|password/i', $json), short($json, 400));
check('only earned badges listed', is_array($u['progress']['badges']) && !array_filter($u['progress']['badges'], fn($b) => array_key_exists('earned', $b) && !$b['earned'])
    && in_array('spider_sense', array_column($u['progress']['badges'], 'id'), true));
$r = req($A, 'GET', 'user', ['nick' => "cma_$RUN"]);
check('isMe for own profile', isOk($r) && data($r)['isMe'] === true);
expectErr('unknown nick → 404', req($guest, 'GET', 'user', ['nick' => "ghost_$RUN"]), 404, 'not_found');
expectErr('invalid nick → 404', req($guest, 'GET', 'user', ['nick' => "<script>"]), 404, 'not_found');
expectErr('empty nick → 404', req($guest, 'GET', 'user'), 404, 'not_found');

// приватная работа не должна попасть в галерею
$png = gd_png(80, 60, "$TMP/sub.png");
$r = req($A, 'POST', 'submissions', [], ['title' => 'Секретная работа', 'description' => '', 'category' => 'art', 'note' => '', 'files[0]' => cf($png, 'image/png')], ['multipart' => true]);
expectOk('A creates private submission', $r);
$subId = data($r)['id'] ?? '';
$r = req($guest, 'GET', 'user', ['nick' => "cmA_$RUN"]);
check('pending submission NOT in public gallery', isOk($r) && !in_array($subId, array_column(data($r)['gallery'], 'id'), true) && !str_contains($r['body'], 'Секретная'));
check('stats count submissions', isOk($r) && data($r)['stats']['submissions'] === 1);
req($admin, 'POST', 'submission/review', [], ['id' => $subId, 'status' => 'ideal']);
$r = req($guest, 'GET', 'user', ['nick' => "cmA_$RUN"]);
$g = isOk($r) ? (data($r)['gallery'][0] ?? null) : null;
check('ideal submission in gallery with image', $g && $g['id'] === $subId && preg_match('#^api/index\.php\?r=image&id=[0-9a-f-]{36}$#', (string) $g['imageUrl']), short($r['body']));

/* ================= Карта Penta ================= */
section('penta map');
expectErr('user cannot set map', req($A, 'POST', 'penta/map', [], ['url' => 'https://map.example.com/']), 403, 'forbidden');
foreach (['http://map.example.com/', 'javascript:alert(1)', 'https://map.example.com/"onload="x', 'https:///nohost', 'ftp://x.y', 'https://user:p@map.example.com/'] as $bad) {
    expectErr("bad map url rejected: $bad", req($admin, 'POST', 'penta/map', [], ['url' => $bad]), 400, 'validation');
}
$r = req($admin, 'POST', 'penta/map', [], ['url' => 'https://map.penta.example.com/#world:0:64:0']);
check('admin sets map url', isOk($r) && data($r)['mapUrl'] === 'https://map.penta.example.com/#world:0:64:0', desc($r));
$r = req($guest, 'GET', 'builds');
check('builds returns mapUrl', isOk($r) && data($r)['mapUrl'] === 'https://map.penta.example.com/#world:0:64:0', desc($r));
expectOk('admin clears map url', req($admin, 'POST', 'penta/map', [], ['url' => '']));
check('map url cleared', data(req($guest, 'GET', 'builds'))['mapUrl'] === '');

/* ================= Постройки ================= */
section('builds');
$img = gd_png(320, 200, "$TMP/build.png");
$img2 = gd_png(64, 64, "$TMP/build2.png");
$txt = "$TMP/fake.png";
file_put_contents($txt, '<?php echo 1; ?>');
expectErr('guest cannot upload build', req($guest, 'POST', 'build', [], ['title' => 'Замок', 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 401);
expectErr('build without image', req($A, 'POST', 'build', [], ['title' => 'Замок'], ['multipart' => true]), 400, 'validation', ['files']);
expectErr('build with two images', req($A, 'POST', 'build', [], ['title' => 'Замок', 'files[0]' => cf($img, 'image/png'), 'files[1]' => cf($img2, 'image/png')], ['multipart' => true]), 400, 'validation', ['files']);
expectErr('build fake image rejected', req($A, 'POST', 'build', [], ['title' => 'Замок', 'files[0]' => cf($txt, 'image/png')], ['multipart' => true]), 400, 'validation', ['files']);
expectErr('build title too short', req($A, 'POST', 'build', [], ['title' => 'ab', 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 400, 'validation', ['title']);
expectErr('build title too long', req($A, 'POST', 'build', [], ['title' => str_repeat('a', 81), 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 400, 'validation', ['title']);
expectErr('build coords too long', req($A, 'POST', 'build', [], ['title' => 'Замок', 'coords' => str_repeat('1 ', 21), 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 400, 'validation', ['coords']);
expectErr('build coords with markup', req($A, 'POST', 'build', [], ['title' => 'Замок', 'coords' => '<b>1</b>', 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 400, 'validation', ['coords']);
expectErr('build description too long', req($A, 'POST', 'build', [], ['title' => 'Замок', 'description' => str_repeat('д', 501), 'files[0]' => cf($img, 'image/png')], ['multipart' => true]), 400, 'validation', ['description']);
$r = req($A, 'POST', 'build', [], ['title' => 'Замок паука', 'coords' => '120 64 -340', 'description' => 'Мой замок у спавна', 'files[0]' => cf($img, 'image/png')], ['multipart' => true]);
expectOk('A uploads build', $r);
$b1 = data($r);
check('build shape', is_array($b1) && $b1['title'] === 'Замок паука' && $b1['coords'] === '120 64 -340' && $b1['status'] === 'visible'
    && $b1['width'] === 320 && preg_match('#^api/index\.php\?r=build/image&id=[0-9a-f-]{36}$#', $b1['imageUrl']), short(json_encode($b1, JSON_UNESCAPED_UNICODE)));
$r = req($B, 'POST', 'build', [], ['title' => 'Ферма', 'files[0]' => cf($img2, 'image/png')], ['multipart' => true]);
expectOk('B uploads build (no coords)', $r);
$b2 = data($r);
check('empty coords → null', is_array($b2) && array_key_exists('coords', $b2) && $b2['coords'] === null);

$r = req($guest, 'GET', $BASE . '/' . $b1['imageUrl']);
check('guest gets build image with safe headers', $r['status'] === 200 && $r['ctype'] === 'image/png'
    && ($r['headers']['x-content-type-options'][0] ?? '') === 'nosniff' && str_contains($r['headers']['content-security-policy'][0] ?? '', 'sandbox'), desc($r));
$r = req($guest, 'GET', 'build/image', ['id' => '00000000-0000-4000-8000-000000000000']);
expectErr('missing build image → 404', $r, 404, 'not_found');

expectErr('cannot vote own build', req($A, 'POST', 'build/vote', [], ['id' => $b1['id']]), 400, 'validation');
$r = req($B, 'POST', 'build/vote', [], ['id' => $b1['id']]);
check('B votes A build', isOk($r) && data($r)['votes'] === 1 && data($r)['myVote'] === true, desc($r));
$r = req($B, 'GET', 'builds', ['sort' => 'top']);
$items = data($r)['items'] ?? [];
$pos1 = array_search($b1['id'], array_column($items, 'id'), true);
$pos2 = array_search($b2['id'], array_column($items, 'id'), true);
check('sort=top puts voted build higher', $pos1 !== false && $pos2 !== false && $pos1 < $pos2, "pos1=$pos1 pos2=$pos2");
$r = req($B, 'GET', 'builds', ['sort' => 'new']);
check('sort=new puts newest first', isOk($r) && data($r)['items'][0]['id'] === $b2['id']);

expectErr('user cannot moderate', req($B, 'POST', 'build/moderate', [], ['id' => $b1['id'], 'status' => 'hidden']), 403);
expectErr('moderate bad status', req($admin, 'POST', 'build/moderate', [], ['id' => $b1['id'], 'status' => 'deleted']), 400, 'validation');
$r = req($admin, 'POST', 'build/moderate', [], ['id' => $b1['id'], 'status' => 'hidden']);
check('admin hides build', isOk($r) && data($r)['status'] === 'hidden', desc($r));
$r = req($guest, 'GET', 'builds');
check('hidden build not in public list', isOk($r) && !in_array($b1['id'], array_column(data($r)['items'], 'id'), true));
expectErr('hidden build image → 404 for guest', req($guest, 'GET', $BASE . '/' . $b1['imageUrl']), 404, 'not_found');
check('admin still sees hidden image', req($admin, 'GET', $BASE . '/' . $b1['imageUrl'])['status'] === 200);
expectErr('vote hidden build → 404', req($B, 'POST', 'build/vote', [], ['id' => $b1['id']]), 404);
expectErr('user cannot list scope=admin', req($B, 'GET', 'builds', ['scope' => 'admin']), 403, 'forbidden');
$r = req($admin, 'GET', 'builds', ['scope' => 'admin']);
check('admin scope=admin includes hidden', isOk($r) && in_array($b1['id'], array_column(data($r)['items'], 'id'), true));
expectOk('admin shows build again', req($admin, 'POST', 'build/moderate', [], ['id' => $b1['id'], 'status' => 'visible']));

expectErr('B cannot delete A build', req($B, 'POST', 'build/delete', [], ['id' => $b1['id']]), 403, 'forbidden');
expectOk('B deletes own build', req($B, 'POST', 'build/delete', [], ['id' => $b2['id']]));
expectErr('deleted build image → 404', req($guest, 'GET', $BASE . '/' . $b2['imageUrl']), 404);

// значок «Архитектор» за 3 постройки
for ($i = 2; $i <= 3; $i++) {
    expectOk("A uploads build #$i", req($A, 'POST', 'build', [], ['title' => "Постройка $i", 'files[0]' => cf(gd_png(50, 50, "$TMP/b$i.png"), 'image/png')], ['multipart' => true]));
}
$p = data(req($A, 'GET', 'me/profile'));
$arch = array_values(array_filter($p['progress']['badges'] ?? [], fn($b) => $b['id'] === 'architect'))[0] ?? null;
check('badge architect earned at 3 builds', $arch && $arch['earned'] === true, short(json_encode($arch, JSON_UNESCAPED_UNICODE)));
$r = req($guest, 'GET', 'user', ['nick' => "cmA_$RUN"]);
check('public stats count builds', isOk($r) && data($r)['stats']['builds'] === 3);

if ($PDO) {
    reset_rl();
    $codes = [];
    for ($i = 0; $i < 6; $i++) $codes[] = req($B, 'POST', 'build', [], ['title' => "Лимит $i", 'files[0]' => cf($img2, 'image/png')], ['multipart' => true])['status'];
    check('build rate limit: 5 ok, 6th → 429', array_slice($codes, 0, 5) === [200, 200, 200, 200, 200] && $codes[5] === 429, implode(',', $codes));
    reset_rl();
}

// уборка: постройки тестовых пользователей (файлы удаляются маршрутом)
$all = data(req($admin, 'GET', 'builds', ['scope' => 'admin']))['items'] ?? [];
foreach ($all as $b) {
    if (in_array($b['author']['nick'], ["cmA_$RUN", "cmB_$RUN"], true)) req($admin, 'POST', 'build/delete', [], ['id' => $b['id']]);
}
req($admin, 'POST', 'submission/delete', [], ['id' => $subId]);
array_map('unlink', glob("$TMP/*") ?: []);
@rmdir($TMP);

echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
exit($FAIL > 0 ? 1 : 0);

<?php
// Интеграционные тесты стрим-инструментов (api/lib/features/streamtools.php):
// расписание + .ics, архив эфиров с таймкодами и подсказками, цели канала, зритель дня.
//
//   php tests/features/streamtools.php [http://127.0.0.1:8090]
//
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — очистка rate_limits и кэша «зрителя дня».
// Код выхода: 0 — всё прошло, 1 — есть провалы.
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');
if (!extension_loaded('curl')) { fwrite(STDERR, "Нужно расширение PHP: curl\n"); exit(2); }

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
        $hdrs[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, array_key_exists('raw', $opt) ? (string) $opt['raw'] : json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $resBody = curl_exec($ch);
    if ($resBody === false) return ['status' => 0, 'headers' => [], 'body' => '', 'json' => null, 'ctype' => '', 'err' => curl_error($ch)];
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $ctype = strtolower($respHeaders['content-type'][0] ?? '');
    $json = str_contains($ctype, 'json') ? json_decode($resBody, true) : null;
    $r = ['status' => $status, 'headers' => $respHeaders, 'body' => $resBody, 'json' => $json, 'ctype' => $ctype, 'err' => ''];
    if ($status >= 500) check("no 5xx on $method $route", false, short($resBody));
    if (preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace|Uncaught /', $resBody, $m)) check("no PHP/SQL leak on $method $route", false, $m[0]);
    return $r;
}
function short(string $s, int $n = 220): string { $s = preg_replace('/\s+/', ' ', $s); return mb_strlen($s) > $n ? mb_substr($s, 0, $n) . '…' : $s; }
function desc(array $r): string { return $r['status'] === 0 ? "connection error: {$r['err']}" : "HTTP {$r['status']} " . short($r['body']); }
function data(array $r) { return ($r['json']['ok'] ?? null) === true ? $r['json']['data'] : null; }
function isOk(array $r): bool { return $r['status'] === 200 && ($r['json']['ok'] ?? null) === true && array_key_exists('data', $r['json']); }
function expectOk(string $name, array $r): bool { return check($name, isOk($r), desc($r)); }
function expectErr(string $name, array $r, $status, ?string $code = null, array $fields = []): bool
{
    $e = $r['json']['error'] ?? null;
    $good = in_array($r['status'], (array) $status, true) && ($r['json']['ok'] ?? null) === false && is_array($e) && ($code === null || ($e['code'] ?? '') === $code);
    foreach ($fields as $f) $good = $good && is_array($e['fields'] ?? null) && array_key_exists($f, $e['fields']);
    return check($name, $good, 'want ' . implode('/', (array) $status) . ($code ? " $code" : '') . ($fields ? ' fields[' . implode(',', $fields) . ']' : '') . ', got ' . desc($r));
}

/* ============================== БД (необязательно) ============================== */
$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try { $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); }
    catch (Throwable $e) { echo "WARN  нет подключения к БД: {$e->getMessage()}\n"; }
}
function db_exec(string $sql): void { global $PDO; if ($PDO) { try { $PDO->exec($sql); } catch (Throwable $e) { /* нет таблицы */ } } }
function reset_rl(): void { db_exec('DELETE FROM rate_limits'); }

/** «Сейчас + $sec» по Москве в формате формы. */
function msk(int $sec): string
{
    return (new DateTimeImmutable('@' . (time() + $sec)))->setTimezone(new DateTimeZone('Europe/Moscow'))->format('Y-m-d\TH:i');
}
/** Московское «Y-m-d\TH:i» → ISO UTC, как отдаёт API. */
function msk_to_iso(string $local): string
{
    return (new DateTimeImmutable($local, new DateTimeZone('Europe/Moscow')))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s') . '.000Z';
}

echo "API base: $BASE   run: $RUN   DB: " . ($PDO ? 'yes' : 'no') . "\n";

/* ============================== Актёры ============================== */
section('actors');
reset_rl();
$guest = new Actor('guest');
$admin = new Actor('admin');
$U = new Actor('user');
$r = req($admin, 'POST', 'auth/login', [], ['email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]);
if (!isOk($r)) $r = req($admin, 'POST', 'auth/register', [], ['nick' => "adm_$RUN", 'email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]);
expectOk('admin login', $r);
$admin->user = data($r);
check('admin has role admin', ($admin->user['role'] ?? '') === 'admin', json_encode($admin->user));
$r = req($U, 'POST', 'auth/register', [], ['nick' => "stx_$RUN", 'email' => "stx_$RUN@example.com", 'password' => 'password123']);
expectOk('register user', $r);
$U->user = data($r);

/* ============================== Расписание ============================== */
section('schedule');
$r = req($guest, 'GET', 'schedule');
expectOk('guest GET schedule', $r);
$d = data($r);
check('schedule shape', is_array($d) && array_key_exists('next', $d) && is_array($d['items'] ?? null) && is_string($d['now'] ?? null), short($r['body']));

$evBody = ['title' => "Тестовый стрим $RUN", 'game' => 'Minecraft', 'startsAt' => msk(2 * 3600), 'durationMin' => 180, 'note' => 'Строим базу'];
expectErr('guest schedule/save → 401', req($guest, 'POST', 'schedule/save', [], $evBody), 401, 'auth_required');
expectErr('user schedule/save → 403', req($U, 'POST', 'schedule/save', [], $evBody), 403, 'forbidden');
expectErr('schedule/save without CSRF header → 403', req($admin, 'POST', 'schedule/save', [], $evBody, ['csrf' => false]), 403, 'forbidden');
expectErr('schedule/save empty → 400 title,startsAt', req($admin, 'POST', 'schedule/save', [], []), 400, 'validation', ['title', 'startsAt']);
expectErr('schedule/save 30 Feb → 400 startsAt', req($admin, 'POST', 'schedule/save', [], ['startsAt' => '2027-02-30T20:00'] + $evBody), 400, 'validation', ['startsAt']);
expectErr('schedule/save 25:00 → 400 startsAt', req($admin, 'POST', 'schedule/save', [], ['startsAt' => substr(msk(86400), 0, 10) . 'T25:00'] + $evBody), 400, 'validation', ['startsAt']);
expectErr('schedule/save in 3 years → 400 startsAt', req($admin, 'POST', 'schedule/save', [], ['startsAt' => (date('Y') + 3) . '-01-01T20:00'] + $evBody), 400, 'validation', ['startsAt']);
expectErr('schedule/save duration 5 → 400', req($admin, 'POST', 'schedule/save', [], ['durationMin' => 5] + $evBody), 400, 'validation', ['durationMin']);
expectErr('schedule/save duration string → 400', req($admin, 'POST', 'schedule/save', [], ['durationMin' => 'abc'] + $evBody), 400, 'validation', ['durationMin']);
expectErr('schedule/save title 121 → 400', req($admin, 'POST', 'schedule/save', [], ['title' => str_repeat('я', 121)] + $evBody), 400, 'validation', ['title']);
expectErr('schedule/save title array → 400', req($admin, 'POST', 'schedule/save', [], ['title' => ['x']] + $evBody), 400, 'validation', ['title']);
expectErr('schedule/save bad id → 400', req($admin, 'POST', 'schedule/save', [], ['id' => 'nope'] + $evBody), 400, 'validation');
expectErr('schedule/save unknown id → 404', req($admin, 'POST', 'schedule/save', [], ['id' => '11111111-1111-4111-8111-111111111111'] + $evBody), 404, 'not_found');

$r = req($admin, 'POST', 'schedule/save', [], $evBody);
expectOk('admin creates event (+2h)', $r);
$ev = data($r) ?? [];
check('event times: MSK input → UTC startsAt', ($ev['startsAt'] ?? '') === msk_to_iso($evBody['startsAt']), ($ev['startsAt'] ?? '') . ' vs ' . msk_to_iso($evBody['startsAt']));
check('event startsAtMsk round-trips', ($ev['startsAtMsk'] ?? '') === $evBody['startsAt']);
check('event endsAt = start + 180 min', isset($ev['endsAt']) && strtotime($ev['endsAt']) - strtotime($ev['startsAt']) === 180 * 60);
check('event not isNow', ($ev['isNow'] ?? null) === false);

$r = req($admin, 'POST', 'schedule/save', [], ['title' => "Далёкий стрим $RUN", 'startsAt' => msk(20 * 86400), 'durationMin' => 60] + $evBody);
expectOk('admin creates event (+20d)', $r);
$far = data($r) ?? [];
$special = "Спецсимволы, точка; слэш\\ $RUN " . str_repeat('длинный текст ', 8);
$r = req($admin, 'POST', 'schedule/save', [], ['title' => mb_substr($special, 0, 120), 'startsAt' => msk(26 * 3600), 'note' => "строка1\nстрока2"] + $evBody);
expectOk('admin creates event with special chars', $r);
$sp = data($r) ?? [];
$r = req($admin, 'POST', 'schedule/save', [], ['title' => "Идёт сейчас $RUN", 'startsAt' => msk(-30 * 60), 'durationMin' => 120] + $evBody);
expectOk('admin creates running event (−30 min)', $r);
$nowEv = data($r) ?? [];
check('running event isNow', ($nowEv['isNow'] ?? null) === true, json_encode($nowEv));

$d = data(req($guest, 'GET', 'schedule')) ?? [];
$ids = array_column($d['items'] ?? [], 'id');
check('schedule contains +2h event', in_array($ev['id'] ?? '-', $ids, true));
check('schedule hides +20d event (14-day window)', !in_array($far['id'] ?? '-', $ids, true));
check('schedule next is running event (or earlier)', isset($d['next']['startsAt']) && strtotime($d['next']['startsAt']) <= strtotime($nowEv['startsAt'] ?? 'now'), json_encode($d['next'] ?? null));
$starts = array_map('strtotime', array_column($d['items'] ?? [], 'startsAt'));
$sorted = $starts; sort($sorted);
check('schedule items sorted by start', $starts === $sorted);

$r = req($admin, 'POST', 'schedule/save', [], ['id' => $ev['id'] ?? '', 'title' => "Переименован $RUN"] + $evBody);
expectOk('admin updates event', $r);
check('event renamed', (data($r)['title'] ?? '') === "Переименован $RUN");

expectErr('guest schedule/all → 401', req($guest, 'GET', 'schedule/all'), 401);
expectErr('user schedule/all → 403', req($U, 'GET', 'schedule/all'), 403);
$r = req($admin, 'GET', 'schedule/all');
expectOk('admin schedule/all', $r);
check('schedule/all contains +20d event', in_array($far['id'] ?? '-', array_column(data($r)['items'] ?? [], 'id'), true));

/* ---------- .ics ---------- */
section('ics');
$r = req($guest, 'GET', 'schedule/ics');
check('ics 200 text/calendar', $r['status'] === 200 && str_starts_with($r['ctype'], 'text/calendar'), "{$r['status']} {$r['ctype']}");
check('ics attachment header', str_contains(strtolower($r['headers']['content-disposition'][0] ?? ''), 'attachment'));
$ics = $r['body'];
check('ics VCALENDAR wrapper', str_starts_with($ics, "BEGIN:VCALENDAR\r\n") && str_ends_with($ics, "END:VCALENDAR\r\n"));
check('ics CRLF only (no bare LF)', !preg_match("/(?<!\r)\n/", $ics));
$maxLine = max(array_map('strlen', explode("\r\n", $ics)));
check('ics lines ≤ 75 octets', $maxLine <= 75, "max $maxLine");
$unfolded = str_replace("\r\n ", '', $ics);
check('ics UID for event', str_contains($unfolded, 'UID:' . ($ev['id'] ?? '?') . '@'));
$dt = gmdate('Ymd\THis\Z', strtotime($ev['startsAt'] ?? 'now'));
check('ics DTSTART in UTC with Z', str_contains($unfolded, "DTSTART:$dt"), $dt);
check('ics DTEND in UTC with Z', str_contains($unfolded, 'DTEND:' . gmdate('Ymd\THis\Z', strtotime($ev['endsAt'] ?? 'now'))));
check('ics escapes , ; \\', str_contains($unfolded, 'Спецсимволы\\, точка\\; слэш\\\\'), short($unfolded, 400));
check('ics escapes newline in description', str_contains($unfolded, 'строка1\\nстрока2'));
check('ics has no +20d? (all upcoming → yes, it is upcoming)', str_contains($unfolded, 'UID:' . ($far['id'] ?? '?') . '@'));
check('ics folded lines are valid UTF-8', mb_check_encoding($ics, 'UTF-8'));
$r = req($guest, 'GET', 'schedule/ics', ['id' => $ev['id'] ?? '']);
check('ics single event', $r['status'] === 200 && substr_count($r['body'], 'BEGIN:VEVENT') === 1);
expectErr('ics unknown id → 404', req($guest, 'GET', 'schedule/ics', ['id' => '11111111-1111-4111-8111-111111111111']), 404, 'not_found');
expectErr('ics garbage id → 404', req($guest, 'GET', 'schedule/ics', ['id' => "x'; DROP TABLE stream_events;--"]), 404);

/* ============================== Архив ============================== */
section('archive');
$arBody = ['title' => "Эфир $RUN", 'game' => 'CS2', 'startedAt' => msk(-5 * 60), 'vodUrl' => 'https://twitch.tv/videos/2233445566', 'summary' => "Итоги\nвторая строка"];
expectErr('guest archive/save → 401', req($guest, 'POST', 'archive/save', [], $arBody), 401);
expectErr('user archive/save → 403', req($U, 'POST', 'archive/save', [], $arBody), 403);
foreach ([
    'http twitch' => 'http://www.twitch.tv/videos/1',
    'twitch channel' => 'https://www.twitch.tv/ndze_one',
    'evil host' => 'https://twitch.tv.evil.com/videos/1',
    'javascript:' => 'javascript:alert(1)',
    'userinfo' => 'https://user@www.twitch.tv/videos/1',
    'youtube bad id' => 'https://www.youtube.com/watch?v=short',
    'port' => 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
] as $what => $url) {
    expectErr("archive/save vod $what → 400", req($admin, 'POST', 'archive/save', [], ['vodUrl' => $url] + $arBody), 400, 'validation', ['vodUrl']);
}
expectErr('archive/save future start → 400', req($admin, 'POST', 'archive/save', [], ['startedAt' => msk(3 * 86400)] + $arBody), 400, 'validation', ['startedAt']);
expectErr('archive/save empty → 400', req($admin, 'POST', 'archive/save', [], []), 400, 'validation', ['title', 'startedAt']);
$r = req($admin, 'POST', 'archive/save', [], $arBody);
expectOk('admin creates archive entry', $r);
$st = data($r) ?? [];
check('vod canonical twitch', ($st['vodUrl'] ?? '') === 'https://www.twitch.tv/videos/2233445566' && ($st['vodKind'] ?? '') === 'twitch', json_encode($st));
$r = req($admin, 'POST', 'archive/save', [], ['title' => "YT эфир $RUN", 'vodUrl' => 'https://youtu.be/dQw4w9WgXcQ', 'startedAt' => msk(-86400)] + $arBody);
expectOk('admin creates youtube entry', $r);
$yt = data($r) ?? [];
check('vod canonical youtube', ($yt['vodUrl'] ?? '') === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' && ($yt['vodKind'] ?? '') === 'youtube', json_encode($yt));
$r = req($admin, 'POST', 'archive/save', [], ['id' => $yt['id'] ?? '', 'vodUrl' => 'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc'] + $arBody);
check('youtube /live/ link accepted', isOk($r) && (data($r)['vodUrl'] ?? '') === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', desc($r));
$r = req($admin, 'POST', 'archive/save', [], ['id' => $yt['id'] ?? '', 'vodUrl' => ''] + $arBody);
check('vodUrl can be cleared', isOk($r) && array_key_exists('vodUrl', data($r)) && data($r)['vodUrl'] === null, desc($r));

// таймкоды
$mk = ['streamId' => $st['id'] ?? '', 'at' => '1:02:03', 'label' => 'Клатч 1v4', 'kind' => 'moment'];
expectErr('user archive/mark → 403', req($U, 'POST', 'archive/mark', [], $mk), 403);
expectErr('mark bad time → 400', req($admin, 'POST', 'archive/mark', [], ['at' => '1:99:00'] + $mk), 400, 'validation', ['at']);
expectErr('mark > 48h → 400', req($admin, 'POST', 'archive/mark', [], ['at' => '49:00:00'] + $mk), 400, 'validation', ['at']);
expectErr('mark negative → 400', req($admin, 'POST', 'archive/mark', [], ['at' => -5] + $mk), 400, 'validation', ['at']);
expectErr('mark bad kind → 400', req($admin, 'POST', 'archive/mark', [], ['kind' => 'evil'] + $mk), 400, 'validation', ['kind']);
expectErr('mark empty label → 400', req($admin, 'POST', 'archive/mark', [], ['label' => '  '] + $mk), 400, 'validation', ['label']);
expectErr('mark label 161 → 400', req($admin, 'POST', 'archive/mark', [], ['label' => str_repeat('a', 161)] + $mk), 400, 'validation', ['label']);
expectErr('mark bad refId → 400', req($admin, 'POST', 'archive/mark', [], ['refId' => 'zzz'] + $mk), 400, 'validation', ['refId']);
expectErr('mark unknown stream → 404', req($admin, 'POST', 'archive/mark', [], ['streamId' => '11111111-1111-4111-8111-111111111111'] + $mk), 404, 'not_found');
$r = req($admin, 'POST', 'archive/mark', [], $mk);
expectOk('admin adds mark 1:02:03', $r);
$marks = data($r)['marks'] ?? [];
check('mark at = 3723 s', ($marks[0]['at'] ?? null) === 3723 && ($marks[0]['atText'] ?? '') === '1:02:03', json_encode($marks));
$r = req($admin, 'POST', 'archive/mark', [], ['at' => 65, 'label' => 'Начало', 'kind' => 'moment'] + $mk);
expectOk('admin adds mark as seconds', $r);
$r = req($admin, 'POST', 'archive/mark', [], ['at' => '12:30', 'label' => '<img src=x onerror=alert(1)>', 'kind' => 'task', 'refId' => '22222222-2222-4222-8222-222222222222'] + $mk);
expectOk('admin adds mark mm:ss with refId', $r);
$marks = data($r)['marks'] ?? [];
check('marks sorted by time', array_column($marks, 'at') === [65, 750, 3723], json_encode(array_column($marks, 'at')));
check('label stored verbatim (escaped on output by client)', in_array('<img src=x onerror=alert(1)>', array_column($marks, 'label'), true));
expectErr('duplicate refId mark → 400', req($admin, 'POST', 'archive/mark', [], ['at' => '0:10', 'label' => 'дубль', 'kind' => 'task', 'refId' => '22222222-2222-4222-8222-222222222222'] + $mk), 400, 'validation');
$m65 = null;
foreach ($marks as $m) if ($m['at'] === 65) $m65 = $m;
$r = req($admin, 'POST', 'archive/mark', [], ['id' => $m65['id'] ?? '', 'at' => '0:01:10', 'label' => 'Старт', 'kind' => 'moment'] + $mk);
check('admin edits mark', isOk($r) && in_array('Старт', array_column(data($r)['marks'] ?? [], 'label'), true), desc($r));
expectErr('edit mark of другой эфир → 404', req($admin, 'POST', 'archive/mark', [], ['id' => $m65['id'] ?? '', 'streamId' => $yt['id'] ?? ''] + $mk), 404);
expectErr('user mark/delete → 403', req($U, 'POST', 'archive/mark/delete', [], ['id' => $m65['id'] ?? '']), 403);
$r = req($admin, 'POST', 'archive/mark/delete', [], ['id' => $m65['id'] ?? '']);
check('admin deletes mark', isOk($r) && count(data($r)['marks'] ?? []) === 2, desc($r));
expectErr('delete mark again → 404', req($admin, 'POST', 'archive/mark/delete', [], ['id' => $m65['id'] ?? '']), 404);

$r = req($guest, 'GET', 'archive');
expectOk('guest GET archive', $r);
$a = data($r) ?? [];
check('archive shape', isset($a['items'], $a['page'], $a['pages'], $a['total']) && $a['page'] === 1);
$found = null;
foreach ($a['items'] ?? [] as $it) if ($it['id'] === ($st['id'] ?? '')) $found = $it;
check('archive lists entry with marks', $found && count($found['marks']) === 2 && $found['summary'] === "Итоги\nвторая строка", json_encode($found));
expectOk('archive page beyond end clamps', req($guest, 'GET', 'archive', ['page' => '999']));
expectOk('archive page garbage ignored', req($guest, 'GET', 'archive', ['page' => '-1 OR 1=1']));

// подсказки из того же дня: задание пользователя → «Выполнено» админом
section('archive suggest');
$r = req($U, 'POST', 'tasks', [], ['game' => 'minecraft', 'title' => "Задание $RUN", 'description' => 'для таймкода', 'difficulty' => 2]);
expectOk('user creates task', $r);
$task = data($r) ?? [];
expectOk('admin marks task done', req($admin, 'POST', 'task/update', [], ['id' => $task['id'] ?? '', 'status' => 'done']));
expectErr('guest suggest → 401', req($guest, 'GET', 'archive/suggest', ['id' => $st['id'] ?? '']), 401);
expectErr('user suggest → 403', req($U, 'GET', 'archive/suggest', ['id' => $st['id'] ?? '']), 403);
expectErr('suggest unknown → 404', req($admin, 'GET', 'archive/suggest', ['id' => '11111111-1111-4111-8111-111111111111']), 404);
$r = req($admin, 'GET', 'archive/suggest', ['id' => $st['id'] ?? '']);
expectOk('admin suggest', $r);
$sg = data($r) ?? [];
$hit = null;
foreach ($sg['items'] ?? [] as $it) if ($it['refId'] === ($task['id'] ?? '')) $hit = $it;
check('suggest contains done task', $hit && $hit['kind'] === 'task' && $hit['added'] === false && str_contains($hit['label'], "Задание $RUN"), json_encode($sg));
check('suggest time offset ≥ 0 and sane', $hit && $hit['at'] >= 0 && $hit['at'] < 3600, json_encode($hit));
if ($hit) {
    expectOk('add suggested mark', req($admin, 'POST', 'archive/mark', [], ['streamId' => $st['id'], 'at' => $hit['at'], 'label' => $hit['label'], 'kind' => 'task', 'refId' => $hit['refId']]));
    $sg2 = data(req($admin, 'GET', 'archive/suggest', ['id' => $st['id'] ?? ''])) ?? [];
    $again = array_values(array_filter($sg2['items'] ?? [], static fn($x) => $x['refId'] === $hit['refId']));
    check('suggest marks added=true', ($again[0]['added'] ?? false) === true);
}

/* ============================== Цели ============================== */
section('goals');
$gb = ['title' => "Цель $RUN", 'current' => 5, 'target' => 10, 'unit' => 'сабов', 'sort' => 1, 'status' => 'active'];
expectErr('guest goals/save → 401', req($guest, 'POST', 'goals/save', [], $gb), 401);
expectErr('user goals/save → 403', req($U, 'POST', 'goals/save', [], $gb), 403);
expectErr('goal target 0 → 400', req($admin, 'POST', 'goals/save', [], ['target' => 0] + $gb), 400, 'validation', ['target']);
expectErr('goal target float → 400', req($admin, 'POST', 'goals/save', [], ['target' => 10.5] + $gb), 400, 'validation', ['target']);
expectErr('goal status bad → 400', req($admin, 'POST', 'goals/save', [], ['status' => 'hidden'] + $gb), 400, 'validation', ['status']);
expectErr('goal title short → 400', req($admin, 'POST', 'goals/save', [], ['title' => 'a'] + $gb), 400, 'validation', ['title']);
expectErr('goal current huge → 400', req($admin, 'POST', 'goals/save', [], ['current' => 99999999999] + $gb), 400, 'validation', ['current']);
$r = req($admin, 'POST', 'goals/save', [], $gb);
expectOk('admin creates goal', $r);
$g = data($r) ?? [];
check('goal percent 50, not reached', ($g['percent'] ?? null) === 50 && ($g['reached'] ?? null) === false, json_encode($g));
expectErr('user bump → 403', req($U, 'POST', 'goals/bump', [], ['id' => $g['id'] ?? '', 'delta' => 1]), 403);
expectErr('bump 0 → 400', req($admin, 'POST', 'goals/bump', [], ['id' => $g['id'] ?? '', 'delta' => 0]), 400, 'validation');
expectErr('bump text → 400', req($admin, 'POST', 'goals/bump', [], ['id' => $g['id'] ?? '', 'delta' => 'x']), 400, 'validation');
$r = req($admin, 'POST', 'goals/bump', [], ['id' => $g['id'] ?? '', 'delta' => 6]);
expectOk('admin bumps +6', $r);
check('goal reached, percent capped 100', (data($r)['current'] ?? null) === 11 && (data($r)['percent'] ?? null) === 100 && (data($r)['reached'] ?? null) === true, desc($r));
$r = req($guest, 'GET', 'goals');
expectOk('guest GET goals', $r);
check('goals list contains goal', in_array($g['id'] ?? '-', array_column(data($r)['items'] ?? [], 'id'), true));
$r = req($admin, 'POST', 'goals/save', [], ['id' => $g['id'] ?? '', 'status' => 'done'] + $gb);
check('admin marks goal done', isOk($r) && (data($r)['status'] ?? '') === 'done', desc($r));
expectErr('user goals/delete → 403', req($U, 'POST', 'goals/delete', [], ['id' => $g['id'] ?? '']), 403);
expectOk('admin deletes goal', req($admin, 'POST', 'goals/delete', [], ['id' => $g['id'] ?? '']));
expectErr('delete goal again → 404', req($admin, 'POST', 'goals/delete', [], ['id' => $g['id'] ?? '']), 404);

/* ============================== Зритель дня ============================== */
section('viewer of the day');
// активность: пользователь — задание (уже есть) + голос; админ — задание (админ не должен попасть в список)
req($U, 'POST', 'task/vote', [], ['id' => $task['id'] ?? '']);
req($admin, 'POST', 'tasks', [], ['game' => 'cs2', 'title' => "Админ $RUN", 'description' => '', 'difficulty' => 1]);
db_exec("DELETE FROM settings WHERE k = 'viewer_today'");
$r = req($guest, 'GET', 'viewer/today');
expectOk('guest GET viewer/today', $r);
$v = data($r) ?? [];
check('viewer shape', array_key_exists('top', $v) && is_array($v['list'] ?? null) && count($v['list']) <= 5 && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v['day'] ?? ''), short($r['body']));
$okShape = true;
foreach ($v['list'] ?? [] as $row) {
    $okShape = $okShape && is_string($row['user']['id'] ?? null) && is_string($row['user']['nick'] ?? null) && array_key_exists('avatarUrl', $row['user'])
        && is_int($row['score'] ?? null) && is_array($row['breakdown'] ?? null);
}
check('viewer rows shape', $okShape);
check('viewer top == list[0]', ($v['top']['user']['id'] ?? null) === ($v['list'][0]['user']['id'] ?? null));
check('viewer list never contains admin', !in_array($admin->user['id'] ?? '-', array_map(static fn($x) => $x['user']['id'], $v['list'] ?? []), true));
$scores = array_column($v['list'] ?? [], 'score');
$sortedS = $scores; rsort($sortedS);
check('viewer list sorted by score', $scores === $sortedS);
if ($PDO) {
    // пользователь с заданием (5) и голосом (1) должен набрать ≥ 6 очков — и попасть в топ, если он не переполнен
    $mine = array_values(array_filter($v['list'] ?? [], static fn($x) => $x['user']['id'] === ($U->user['id'] ?? '')));
    $minTop = $scores ? min($scores) : 0;
    check('viewer counts user activity (tasks 5 + vote 1)', ($mine && $mine[0]['score'] >= 6 && ($mine[0]['breakdown']['tasks'] ?? 0) >= 1) || (count($scores) === 5 && $minTop >= 6), json_encode($mine));
}
$r2 = req($guest, 'GET', 'viewer/today');
check('viewer cached (same payload)', isOk($r2) && data($r2) == $v);

/* ============================== Уборка ============================== */
section('cleanup');
foreach ([$ev, $far, $sp, $nowEv] as $e) if (!empty($e['id'])) req($admin, 'POST', 'schedule/delete', [], ['id' => $e['id']]);
expectErr('deleted event → 404', req($admin, 'POST', 'schedule/delete', [], ['id' => $ev['id'] ?? '']), 404);
expectErr('user schedule/delete → 403', req($U, 'POST', 'schedule/delete', [], ['id' => $far['id'] ?? '']), 403);
expectErr('user archive/delete → 403', req($U, 'POST', 'archive/delete', [], ['id' => $st['id'] ?? '']), 403);
expectOk('admin deletes archive entry (marks cascade)', req($admin, 'POST', 'archive/delete', [], ['id' => $st['id'] ?? '']));
expectOk('admin deletes youtube entry', req($admin, 'POST', 'archive/delete', [], ['id' => $yt['id'] ?? '']));
expectErr('marks gone with stream → 404 on mark delete', req($admin, 'POST', 'archive/mark/delete', [], ['id' => $marks[0]['id'] ?? '']), 404);

echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
if ($FAILS) { echo "Failures:\n"; foreach ($FAILS as $f) echo " - $f\n"; }
exit($FAIL ? 1 : 0);

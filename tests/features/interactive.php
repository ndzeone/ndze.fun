<?php
// Интеграционные тесты интерактива (api/lib/features/interactive.php): опросы, розыгрыши, бинго, квиз, тир-листы.
//
//   php tests/features/interactive.php [http://127.0.0.1:8090]
//
// Необязательно: TEST_DB_DSN / TEST_DB_USER / TEST_DB_PASS — чистит rate_limits перед группами тестов.
// Код выхода: 0 — всё прошло, 1 — есть провалы.
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

$BASE = rtrim((string) ($argv[1] ?? (getenv('API_BASE') ?: 'http://127.0.0.1:8090')), '/');
$ADMIN_EMAIL = getenv('TEST_ADMIN_EMAIL') ?: 'ndze-admin@example.com';
$ADMIN_PASS = getenv('TEST_ADMIN_PASS') ?: 'AdminTest_pw1';
$RUN = bin2hex(random_bytes(3));

/* ---------- Результаты ---------- */
$PASS = 0; $FAIL = 0; $FAILS = [];
function check(string $name, bool $cond, string $detail = ''): bool
{
    global $PASS, $FAIL, $FAILS;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; $FAILS[] = $name . ($detail !== '' ? " — $detail" : ''); echo "FAIL  $name" . ($detail !== '' ? " — $detail" : '') . "\n"; }
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
    $url = $BASE . '/api/index.php?' . http_build_query(['r' => $route] + $query, '', '&', PHP_QUERY_RFC3986);
    $ch = $a->ch;
    curl_reset($ch);
    $hdrs = ['Accept: application/json'];
    if ($method === 'POST' && ($opt['csrf'] ?? true)) $hdrs[] = 'X-Requested-With: ndze';
    curl_setopt_array($ch, [CURLOPT_URL => $url, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEFILE => '', CURLOPT_TIMEOUT => 60]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        $hdrs[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body ?? new stdClass(), JSON_UNESCAPED_UNICODE));
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrs);
    $res = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $json = is_string($res) ? json_decode($res, true) : null;
    if (is_string($res) && preg_match('/SQLSTATE|PDOException|Fatal error|Stack trace|Uncaught /', $res, $m)) {
        check("no PHP/SQL leak in $method $route", false, $m[0]);
    }
    return ['status' => $status, 'body' => (string) $res, 'json' => $json];
}
function data(array $r) { return ($r['json']['ok'] ?? null) === true ? $r['json']['data'] : null; }
function isOk(array $r): bool { return $r['status'] === 200 && ($r['json']['ok'] ?? null) === true; }
function desc(array $r): string { return "HTTP {$r['status']} " . mb_substr(preg_replace('/\s+/', ' ', $r['body']), 0, 300); }
function expectOk(string $name, array $r): bool { return check($name, isOk($r), desc($r)); }
function expectErr(string $name, array $r, $status, ?string $code = null): bool
{
    $good = in_array($r['status'], (array) $status, true) && ($r['json']['ok'] ?? null) === false
        && ($code === null || ($r['json']['error']['code'] ?? null) === $code);
    return check($name, $good, 'want ' . implode('/', (array) $status) . ($code ? " $code" : '') . ', got ' . desc($r));
}

$PDO = null;
if (getenv('TEST_DB_DSN')) {
    try {
        $PDO = new PDO((string) getenv('TEST_DB_DSN'), (string) getenv('TEST_DB_USER'), (string) getenv('TEST_DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    } catch (Throwable $e) {
        echo "WARN  нет подключения к базе: {$e->getMessage()}\n";
    }
}
function reset_rl(): void
{
    global $PDO;
    if ($PDO) $PDO->exec('DELETE FROM rate_limits');
}

/* ---------- Актёры ---------- */
$guest = new Actor('guest');
$admin = new Actor('admin');
$A = new Actor('A');
$B = new Actor('B');
$C = new Actor('C');

reset_rl();
$r = req($admin, 'POST', 'auth/login', [], ['email' => $ADMIN_EMAIL, 'password' => $ADMIN_PASS]);
expectOk('admin login', $r);
$admin->user = data($r);
foreach (['A' => $A, 'B' => $B, 'C' => $C] as $n => $act) {
    $r = req($act, 'POST', 'auth/register', [], ['nick' => "ix{$n}_$RUN", 'email' => "ix{$n}_$RUN@example.com", 'password' => 'password123']);
    expectOk("register $n", $r);
    $act->user = data($r);
}
function balance(Actor $a): int { return (int) (data(req($a, 'GET', 'predictions'))['balance'] ?? -1); }

// чужие открытые опросы и раунды бинго (прошлые прогоны, демо-данные) мешают проверкам poll/live и GET bingo — закрываем
$pre = data(req($admin, 'GET', 'interactive/admin')) ?? [];
foreach ($pre['polls'] ?? [] as $x) if ($x['status'] === 'open') req($admin, 'POST', 'poll/update', [], ['id' => $x['id'], 'action' => 'close']);
foreach ($pre['bingo'] ?? [] as $x) if ($x['status'] === 'open') req($admin, 'POST', 'bingo/update', [], ['id' => $x['id'], 'action' => 'close']);

/* ================= Опросы ================= */
section('polls');
$pollBody = ['question' => "Во что играть дальше? $RUN", 'options' => ['Minecraft', 'CS2', 'GTA5RP']];
expectErr('guest create poll → 401', req($guest, 'POST', 'poll/create', [], $pollBody), 401, 'auth_required');
expectErr('user create poll → 403', req($A, 'POST', 'poll/create', [], $pollBody), 403, 'forbidden');
expectErr('create poll without CSRF header → 403', req($admin, 'POST', 'poll/create', [], $pollBody, ['csrf' => false]), 403, 'forbidden');
expectErr('poll with 1 option → 400', req($admin, 'POST', 'poll/create', [], ['question' => 'Вопрос?', 'options' => ['Одна']]), 400, 'validation');
expectErr('poll with 7 options → 400', req($admin, 'POST', 'poll/create', [], ['question' => 'Вопрос?', 'options' => ['1', '2', '3', '4', '5', '6', '7']]), 400, 'validation');
expectErr('poll question 161 chars → 400', req($admin, 'POST', 'poll/create', [], ['question' => str_repeat('я', 161), 'options' => ['a', 'b']]), 400, 'validation');
expectErr('poll option 61 chars → 400', req($admin, 'POST', 'poll/create', [], ['question' => 'Вопрос?', 'options' => ['a', str_repeat('б', 61)]]), 400, 'validation');
$r = req($admin, 'POST', 'poll/create', [], $pollBody);
expectOk('admin creates poll', $r);
$poll = data($r);
$pid = $poll['id'] ?? '';
check('poll shape', ($poll['status'] ?? '') === 'open' && count($poll['options'] ?? []) === 3 && $poll['total'] === 0 && $poll['myVote'] === null);
expectErr('guest vote → 401', req($guest, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 0]), 401);
expectErr('vote bad option → 400', req($A, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 5]), 400, 'validation');
expectErr('vote option as string garbage → 400', req($A, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 'x']), 400, 'validation');
expectErr('vote unknown poll → 404', req($A, 'POST', 'poll/vote', [], ['id' => '00000000-0000-4000-8000-000000000000', 'option' => 0]), 404, 'not_found');
expectOk('A votes 0', req($A, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 0]));
expectOk('B votes 1', req($B, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 1]));
$r = req($A, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 1]);
expectOk('A changes vote to 1', $r);
$v = data($r);
check('vote change counted once', ($v['total'] ?? 0) === 2 && ($v['options'][1]['votes'] ?? 0) === 2 && ($v['options'][1]['percent'] ?? 0) === 100 && $v['myVote'] === 1, json_encode($v, JSON_UNESCAPED_UNICODE));
$list = data(req($B, 'GET', 'polls'))['items'] ?? [];
$mine = array_values(array_filter($list, fn($p) => $p['id'] === $pid))[0] ?? null;
check('GET polls shows myVote for B', ($mine['myVote'] ?? null) === 1);
$live = data(req($guest, 'GET', 'poll/live'))['poll'] ?? null;
check('poll/live → latest open poll', ($live['id'] ?? null) === $pid);
expectErr('user close poll → 403', req($A, 'POST', 'poll/update', [], ['id' => $pid, 'action' => 'close']), 403);
expectErr('poll bad action → 400', req($admin, 'POST', 'poll/update', [], ['id' => $pid, 'action' => 'explode']), 400);
expectOk('admin closes poll', req($admin, 'POST', 'poll/update', [], ['id' => $pid, 'action' => 'close']));
expectErr('vote in closed poll → 400', req($C, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 0]), 400, 'validation');
check('poll/live still shows just-closed poll', (data(req($guest, 'GET', 'poll/live'))['poll']['id'] ?? null) === $pid);
expectOk('admin reopens poll', req($admin, 'POST', 'poll/update', [], ['id' => $pid, 'action' => 'open']));
expectOk('C votes after reopen', req($C, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 2]));

/* ================= Розыгрыши ================= */
section('giveaways');
reset_rl();
expectErr('user create giveaway → 403', req($A, 'POST', 'giveaway/create', [], ['title' => 'Ключ', 'prize' => 'Steam']), 403);
expectErr('giveaway no prize → 400', req($admin, 'POST', 'giveaway/create', [], ['title' => 'Розыгрыш', 'prize' => '']), 400);
$r = req($admin, 'POST', 'giveaway/create', [], ['title' => "Розыгрыш $RUN", 'prize' => 'Ключ Steam']);
expectOk('admin creates giveaway', $r);
$g = data($r);
$gid = $g['id'] ?? '';
check('giveaway has seedHash, seed hidden', preg_match('/^[0-9a-f]{64}$/', (string) ($g['seedHash'] ?? '')) === 1 && $g['seed'] === null);
expectErr('draw with no entries → 400', req($admin, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'draw']), 400);
expectErr('guest join → 401', req($guest, 'POST', 'giveaway/join', [], ['id' => $gid]), 401);
expectOk('A joins', req($A, 'POST', 'giveaway/join', [], ['id' => $gid]));
expectOk('A joins twice (idempotent)', req($A, 'POST', 'giveaway/join', [], ['id' => $gid]));
expectOk('B joins', req($B, 'POST', 'giveaway/join', [], ['id' => $gid]));
expectOk('C joins', req($C, 'POST', 'giveaway/join', [], ['id' => $gid]));
$r = req($C, 'POST', 'giveaway/join', [], ['id' => $gid, 'join' => false]);
check('C leaves', isOk($r) && data($r)['joined'] === false && data($r)['entries'] === 2, desc($r));
expectOk('C joins again', req($C, 'POST', 'giveaway/join', [], ['id' => $gid]));
$gv = data(req($A, 'GET', 'giveaways'));
$gA = array_values(array_filter($gv['items'] ?? [], fn($x) => $x['id'] === $gid))[0] ?? null;
check('GET giveaways: 3 entries, A joined, seed hidden', ($gA['entries'] ?? 0) === 3 && $gA['joined'] === true && $gA['seed'] === null);
$det = data(req($guest, 'GET', 'giveaway', ['id' => $gid]));
check('participants hidden before draw', is_array($det) && array_key_exists('participants', $det) && $det['participants'] === null && $det['seed'] === null);
expectOk('admin closes giveaway', req($admin, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'close']));
expectErr('join closed giveaway → 400', req($A, 'POST', 'giveaway/join', [], ['id' => $gid, 'join' => false]), 400);
expectErr('user draw → 403', req($A, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'draw']), 403);
$r = req($admin, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'draw']);
expectOk('admin draws', $r);
$d = data($r);
$seed = (string) ($d['seed'] ?? '');
check('seed revealed and matches hash', $seed !== '' && hash('sha256', $seed) === $g['seedHash']);
$ids = array_column($d['participants'] ?? [], 'id');
$sorted = $ids;
sort($sorted, SORT_STRING);
check('participants sorted by id', count($ids) === 3 && $ids === $sorted);
$h = hash_hmac('sha256', implode(',', $ids), $seed);
$idx = hexdec(substr($h, 0, 13)) % count($ids);
check('winner = HMAC pick (independent recompute)', ($d['winner']['id'] ?? null) === $ids[$idx], "idx $idx");
expectErr('draw twice → 400', req($admin, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'draw']), 400);
$live = data(req($guest, 'GET', 'giveaway/live'))['giveaway'] ?? null;
check('giveaway/live shows fresh draw with nicks', ($live['id'] ?? null) === $gid && ($live['status'] ?? '') === 'drawn' && count($live['nicks'] ?? []) === 3);
$winnerActor = null;
foreach ([$A, $B, $C] as $act) if ($act->user['id'] === ($d['winner']['id'] ?? '')) $winnerActor = $act;
if ($PDO && $winnerActor) {
    $n = $PDO->prepare("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'giveaway'");
    $n->execute([$winnerActor->user['id']]);
    check('winner notified', (int) $n->fetchColumn() === 1);
}

/* ================= Бинго ================= */
section('bingo');
reset_rl();
$items = [];
for ($i = 1; $i <= 24; $i++) $items[] = "Событие $i";
expectErr('user create bingo → 403', req($A, 'POST', 'bingo/create', [], ['title' => 'Бинго', 'items' => $items, 'reward' => 100]), 403);
expectErr('bingo 23 items → 400', req($admin, 'POST', 'bingo/create', [], ['title' => 'Бинго', 'items' => array_slice($items, 0, 23), 'reward' => 100]), 400);
expectErr('bingo item 61 chars → 400', req($admin, 'POST', 'bingo/create', [], ['title' => 'Бинго', 'items' => array_merge(array_slice($items, 0, 23), [str_repeat('x', 61)]), 'reward' => 100]), 400);
expectErr('bingo negative reward → 400', req($admin, 'POST', 'bingo/create', [], ['title' => 'Бинго', 'items' => $items, 'reward' => -5]), 400);
$r = req($admin, 'POST', 'bingo/create', [], ['title' => "Бинго $RUN", 'items' => $items, 'reward' => 100]);
expectOk('admin creates bingo', $r);
$bid = data($r)['id'] ?? '';
$ra = data(req($A, 'GET', 'bingo'))['round'] ?? null;
$ra2 = data(req($A, 'GET', 'bingo'))['round'] ?? null;
$rb = data(req($B, 'GET', 'bingo'))['round'] ?? null;
$cardA = $ra['card'] ?? [];
check('A card: 25 cells, free center, 24 distinct', count($cardA) === 25 && $cardA[12] === null && count(array_unique(array_filter($cardA, fn($x) => $x !== null))) === 24);
check('A card deterministic', $cardA === ($ra2['card'] ?? null));
check('A and B cards differ', $cardA !== ($rb['card'] ?? null));
$gr = data(req($guest, 'GET', 'bingo'))['round'] ?? [];
check('guest gets no card', array_key_exists('card', $gr) && $gr['card'] === null && $gr['canClaim'] === false);
expectErr('claim without line → 400', req($A, 'POST', 'bingo/claim', [], ['id' => $bid]), 400, 'validation');
expectErr('user mark → 403', req($A, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => 0, 'on' => true]), 403);
expectErr('mark bad index → 400', req($admin, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => 99, 'on' => true]), 400);
// отмечаем 1-ю строку карточки A (без центра) и 3-ю строку (с центром — 4 клетки)
foreach ([0, 1, 2, 3, 4] as $k) req($admin, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => $cardA[$k], 'on' => true]);
$r = req($admin, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => $cardA[0], 'on' => true]);
check('marking twice keeps unique', isOk($r) && count(data($r)['marked']) === 5, desc($r));
$ra = data(req($A, 'GET', 'bingo'))['round'];
check('A canClaim after full row', $ra['canClaim'] === true && $ra['lines'] >= 1);
$balA = balance($A);
$r = req($A, 'POST', 'bingo/claim', [], ['id' => $bid]);
expectOk('A claims bingo', $r);
check('A place 1, full reward', (data($r)['place'] ?? 0) === 1 && (data($r)['prize'] ?? 0) === 100);
check('A balance +100', balance($A) === $balA + 100);
expectErr('A claims twice → 400', req($A, 'POST', 'bingo/claim', [], ['id' => $bid]), 400);
// отмечаем всё — B тоже собирает линию, получает половину
foreach (range(0, 23) as $k) req($admin, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => $k, 'on' => true]);
$balB = balance($B);
$r = req($B, 'POST', 'bingo/claim', [], ['id' => $bid]);
check('B place 2, half reward', isOk($r) && data($r)['place'] === 2 && data($r)['prize'] === 50, desc($r));
check('B balance +50', balance($B) === $balB + 50);
$r = req($admin, 'POST', 'bingo/mark', [], ['id' => $bid, 'index' => 0, 'on' => false]);
check('unmark works', isOk($r) && !in_array(0, data($r)['marked'], true));
expectOk('admin closes bingo', req($admin, 'POST', 'bingo/update', [], ['id' => $bid, 'action' => 'close']));
expectErr('claim in closed round → 400', req($C, 'POST', 'bingo/claim', [], ['id' => $bid]), 400);
$pub = data(req($guest, 'GET', 'bingo'))['round'] ?? null;
check('public bingo shows winners', count($pub['claims'] ?? []) === 2 && ($pub['claims'][0]['user']['id'] ?? '') === $A->user['id']);

/* ================= Квиз ================= */
section('quiz');
reset_rl();
$qs = [
    ['q' => 'Какой цвет у паутины на сайте?', 'options' => ['Лайм', 'Синий'], 'correct' => 0],
    ['q' => 'Сколько ног у паука?', 'options' => ['6', '8', '10'], 'correct' => 1],
    ['q' => 'Ник стримера?', 'options' => ['ndze', 'ninja', 'shroud', 'pokimane'], 'correct' => 0],
];
expectErr('user create quiz → 403', req($A, 'POST', 'quiz/create', [], ['title' => 'Квиз', 'reward' => 10, 'questions' => $qs]), 403);
expectErr('quiz 2 questions → 400', req($admin, 'POST', 'quiz/create', [], ['title' => 'Квиз', 'reward' => 10, 'questions' => array_slice($qs, 0, 2)]), 400);
expectErr('quiz bad correct → 400', req($admin, 'POST', 'quiz/create', [], ['title' => 'Квиз', 'reward' => 10, 'questions' => [$qs[0], $qs[1], ['q' => 'Вопрос?', 'options' => ['a', 'b'], 'correct' => 2]]]), 400);
expectErr('quiz 5 options → 400', req($admin, 'POST', 'quiz/create', [], ['title' => 'Квиз', 'reward' => 10, 'questions' => [$qs[0], $qs[1], ['q' => 'Вопрос?', 'options' => ['a', 'b', 'c', 'd', 'e'], 'correct' => 0]]]), 400);
$r = req($admin, 'POST', 'quiz/create', [], ['title' => "Квиз недели $RUN", 'reward' => 10, 'questions' => $qs]);
expectOk('admin creates quiz (draft)', $r);
$qid = data($r)['id'] ?? '';
check('quiz is draft', (data($r)['status'] ?? '') === 'draft');
expectErr('answer draft quiz → 400', req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 5000]), 400);
// закрыть чужие открытые квизы (прошлые прогоны)
foreach (data(req($admin, 'GET', 'interactive/admin'))['quizzes'] ?? [] as $old) {
    if ($old['status'] === 'open') req($admin, 'POST', 'quiz/update', [], ['id' => $old['id'], 'action' => 'close']);
}
expectOk('admin opens quiz', req($admin, 'POST', 'quiz/update', [], ['id' => $qid, 'action' => 'open']));
$open = data(req($A, 'GET', 'quiz'))['open'] ?? null;
check('open quiz hides correct answers', ($open['id'] ?? '') === $qid && !str_contains(json_encode($open), 'correct') && $open['mine'] === null);
expectErr('guest answer → 401', req($guest, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 5000]), 401);
expectErr('answer wrong count → 400', req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1], 'ms' => 5000]), 400);
expectErr('answer out of range → 400', req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 9, 0], 'ms' => 5000]), 400);
$balA = balance($A);
$r = req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 9000]);
check('A answers all correct → 3, +30 points', isOk($r) && data($r)['score'] === 3 && data($r)['points'] === 30, desc($r));
check('A balance +30', balance($A) === $balA + 30);
expectErr('A answers twice → 400', req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 1000]), 400);
$r = req($B, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 4000]);
check('B 3/3 faster', isOk($r) && data($r)['score'] === 3, desc($r));
$r = req($C, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [1, -1, 0], 'ms' => 999999999]);
check('C 1/3 with timeout answer, ms clamped', isOk($r) && data($r)['score'] === 1 && data($r)['ms'] === 3600000, desc($r));
check('GET quiz shows my result', (data(req($A, 'GET', 'quiz'))['open']['mine']['score'] ?? null) === 3);
expectErr('open second quiz while one open → 400', req($admin, 'POST', 'quiz/update', [], ['id' => $qid, 'action' => 'open']), 400);
expectOk('admin closes quiz', req($admin, 'POST', 'quiz/update', [], ['id' => $qid, 'action' => 'close']));
$res = data(req($C, 'GET', 'quiz'))['results'] ?? null;
$lb = $res['leaderboard'] ?? [];
check('results: correct answers revealed', ($res['id'] ?? '') === $qid && ($res['questions'][1]['correct'] ?? null) === 1);
// при равных очках выше тот, кто ответил раньше (время ms присылает клиент — ему не верим)
check('leaderboard: score desc, earlier answer first (A, B, C)', count($lb) === 3 && $lb[0]['user']['id'] === $A->user['id'] && $lb[1]['user']['id'] === $B->user['id'] && $lb[2]['user']['id'] === $C->user['id']);
check('results: my answers', ($res['mine']['answers'] ?? null) === [1, -1, 0]);
expectErr('answer closed quiz → 400', req($A, 'POST', 'quiz/answer', [], ['quizId' => $qid, 'answers' => [0, 1, 0], 'ms' => 1]), 400);

/* ================= Тир-листы ================= */
section('tierlists');
reset_rl();
$tItems = [['text' => 'Minecraft', 'emoji' => '⛏'], ['text' => 'CS2', 'emoji' => '🔫'], ['text' => 'GTA5RP', 'emoji' => '🚗'], ['text' => 'Terraria', 'emoji' => '']];
expectErr('user create tierlist → 403', req($A, 'POST', 'tierlist/create', [], ['title' => 'Игры', 'items' => $tItems]), 403);
expectErr('tierlist 3 items → 400', req($admin, 'POST', 'tierlist/create', [], ['title' => 'Игры', 'items' => array_slice($tItems, 0, 3)]), 400);
expectErr('tierlist item 41 chars → 400', req($admin, 'POST', 'tierlist/create', [], ['title' => 'Игры', 'items' => array_merge(array_slice($tItems, 0, 3), [['text' => str_repeat('x', 41)]])]), 400);
expectErr('tierlist emoji with markup → 400', req($admin, 'POST', 'tierlist/create', [], ['title' => 'Игры', 'items' => array_merge(array_slice($tItems, 0, 3), [['text' => 'X', 'emoji' => '<b>']])]), 400);
$r = req($admin, 'POST', 'tierlist/create', [], ['title' => "Игры стрима $RUN", 'items' => $tItems]);
expectOk('admin creates tierlist', $r);
$tid = data($r)['id'] ?? '';
check('tierlist item without emoji → null', array_key_exists('emoji', data($r)['items'][3] ?? []) && data($r)['items'][3]['emoji'] === null);
expectErr('guest vote → 401', req($guest, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'S']]), 401);
expectErr('incomplete placement → 400', req($A, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'S', '1' => 'A']]), 400);
expectErr('bad tier → 400', req($A, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'S', '1' => 'A', '2' => 'Z', '3' => 'D']]), 400);
expectErr('index out of range → 400', req($A, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'S', '1' => 'A', '2' => 'B', '9' => 'D']]), 400);
$r = req($A, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'S', '1' => 'A', '2' => 'B', '3' => 'D']]);
check('A votes', isOk($r) && data($r)['mine'] === ['S', 'A', 'B', 'D'], desc($r));
$r = req($B, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['0' => 'A', '1' => 'A', '2' => 'D', '3' => 'D']]);
expectOk('B votes', $r);
$v = data($r);
check('community: avg 4.5 → S, 4 → A, 2 → C, 1 → D', ($v['community'][0]['tier'] ?? '') === 'S' && $v['community'][0]['avg'] == 4.5
    && $v['community'][1]['tier'] === 'A' && $v['community'][2]['tier'] === 'C' && $v['community'][3]['tier'] === 'D' && $v['votes'] === 2, json_encode($v['community'] ?? null));
$r = req($A, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['D', 'D', 'D', 'D']]);
check('A changes vote (list form accepted)', isOk($r) && data($r)['votes'] === 2 && data($r)['mine'] === ['D', 'D', 'D', 'D'], desc($r));
expectOk('admin closes tierlist', req($admin, 'POST', 'tierlist/update', [], ['id' => $tid, 'action' => 'close']));
expectErr('vote closed tierlist → 400', req($C, 'POST', 'tierlist/vote', [], ['listId' => $tid, 'placement' => ['S', 'S', 'S', 'S']]), 400);

/* ================= Админ-сводка, метрики, лимиты, удаление ================= */
section('admin, metrics, limits, delete');
expectErr('guest interactive/admin → 401', req($guest, 'GET', 'interactive/admin'), 401);
expectErr('user interactive/admin → 403', req($A, 'GET', 'interactive/admin'), 403);
$adm = data(req($admin, 'GET', 'interactive/admin'));
check('admin summary has all sections', is_array($adm) && isset($adm['polls'], $adm['giveaways'], $adm['bingo'], $adm['quizzes'], $adm['tierlists']));
$aq = array_values(array_filter($adm['quizzes'] ?? [], fn($x) => $x['id'] === $qid))[0] ?? null;
check('admin sees quiz answers count + correct', ($aq['answers'] ?? 0) === 3 && isset($aq['questions'][0]['correct']));
$prof = data(req($A, 'GET', 'me/profile'));
$badges = [];
foreach ($prof['progress']['badges'] ?? [] as $bd) $badges[$bd['id']] = $bd;
check('badge «Бинго!» earned by A', ($badges['ix_bingo']['earned'] ?? false) === true);
check('badge «Знаток» progress 3/20', ($badges['ix_quiz']['have'] ?? 0) === 3 && ($badges['ix_quiz']['need'] ?? 0) === 20);
if ($PDO) {
    reset_rl();
    $hit429 = false;
    for ($i = 0; $i < 125; $i++) {
        $r = req($C, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => $i % 3]);
        if ($r['status'] === 429) { $hit429 = true; break; }
    }
    check('poll votes rate-limited (429)', $hit429);
    reset_rl();
}
expectOk('admin deletes poll', req($admin, 'POST', 'poll/update', [], ['id' => $pid, 'action' => 'delete']));
expectErr('deleted poll → 404', req($A, 'POST', 'poll/vote', [], ['id' => $pid, 'option' => 0]), 404);
expectOk('admin deletes giveaway', req($admin, 'POST', 'giveaway/update', [], ['id' => $gid, 'action' => 'delete']));
expectOk('admin deletes bingo', req($admin, 'POST', 'bingo/update', [], ['id' => $bid, 'action' => 'delete']));
expectOk('admin deletes quiz', req($admin, 'POST', 'quiz/update', [], ['id' => $qid, 'action' => 'delete']));
expectOk('admin deletes tierlist', req($admin, 'POST', 'tierlist/update', [], ['id' => $tid, 'action' => 'delete']));
expectErr('garbage id → 404', req($admin, 'POST', 'tierlist/update', [], ['id' => "1' OR 1=1 --", 'action' => 'delete']), 404);

echo "\nSUMMARY: $PASS passed, $FAIL failed\n";
foreach ($FAILS as $f) echo "  - $f\n";
exit($FAIL ? 1 : 0);

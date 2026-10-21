<?php
// Интерактив для стрима: опросы «во что играть дальше», честные розыгрыши (seed_hash заранее, HMAC при розыгрыше),
// стрим-бинго с личными карточками, еженедельный квиз и тир-листы сообщества.
// Фронтенд: assets/js/play/{polls,giveaways,bingo,quiz,tierlists}.js, пульт — assets/js/admin/interactive.js,
// оверлеи — assets/js/overlay/{poll,giveaway,bingo}.js.
declare(strict_types=1);
defined('NDZE') || exit;

const IX_TIERS = ['S' => 5, 'A' => 4, 'B' => 3, 'C' => 2, 'D' => 1];
const IX_POLL_LIVE_SEC = 120;      // закрытый опрос ещё 2 минуты висит в оверлее
const IX_GIVEAWAY_LIVE_SEC = 300;  // разыгранный розыгрыш 5 минут висит в оверлее
const IX_QUIZ_MS_MAX = 3600000;

rate_limit_define('ix_vote', 120, 3600);   // голоса в опросах и тир-листах: 120 / час
rate_limit_define('ix_join', 60, 3600);    // вход/выход из розыгрышей: 60 / час
rate_limit_define('ix_bingo', 30, 3600);   // попытки «БИНГО!»: 30 / час
rate_limit_define('ix_quiz', 20, 3600);    // ответы на квизы: 20 / час
rate_limit_define('ix_admin', 600, 3600);  // действия админа в пульте: 600 / час

route_add([
    'GET interactive/admin' => 'route_ix_admin',
    // опросы
    'GET polls' => 'route_polls',
    'GET poll/live' => 'route_poll_live',
    'POST poll/vote' => 'route_poll_vote',
    'POST poll/create' => 'route_poll_create',
    'POST poll/update' => 'route_poll_update',
    // розыгрыши
    'GET giveaways' => 'route_giveaways',
    'GET giveaway' => 'route_giveaway_get',
    'GET giveaway/live' => 'route_giveaway_live',
    'POST giveaway/join' => 'route_giveaway_join',
    'POST giveaway/create' => 'route_giveaway_create',
    'POST giveaway/update' => 'route_giveaway_update',
    // бинго
    'GET bingo' => 'route_bingo',
    'POST bingo/claim' => 'route_bingo_claim',
    'POST bingo/create' => 'route_bingo_create',
    'POST bingo/mark' => 'route_bingo_mark',
    'POST bingo/update' => 'route_bingo_update',
    // квиз
    'GET quiz' => 'route_quiz',
    'POST quiz/answer' => 'route_quiz_answer',
    'POST quiz/create' => 'route_quiz_create',
    'POST quiz/update' => 'route_quiz_update',
    // тир-листы
    'GET tierlists' => 'route_tierlists',
    'POST tierlist/vote' => 'route_tierlist_vote',
    'POST tierlist/create' => 'route_tierlist_create',
    'POST tierlist/update' => 'route_tierlist_update',
]);

/* ================= Метрики, значки, опыт ================= */

/** [uid => n] по таблице: $sql — «SELECT <uid> AS uid, <agg> AS n FROM … WHERE 1=1», $group — колонка GROUP BY. */
function ix_metric(string $sql, string $uidCol, string $atCol, ?string $userId, ?string $since): array
{
    $params = [];
    if ($userId !== null) { $sql .= " AND $uidCol = ?"; $params[] = $userId; }
    if ($since !== null) { $sql .= " AND $atCol >= ?"; $params[] = $since; }
    $out = [];
    foreach (q_all("$sql GROUP BY $uidCol", $params) as $r) $out[$r['uid']] = (int) $r['n'];
    return $out;
}

metric_add('pollVotes', static fn(?string $u, ?string $s): array => ix_metric('SELECT user_id AS uid, COUNT(*) AS n FROM poll_votes WHERE 1=1', 'user_id', 'created_at', $u, $s));
metric_add('giveawayEntries', static fn(?string $u, ?string $s): array => ix_metric('SELECT user_id AS uid, COUNT(*) AS n FROM giveaway_entries WHERE 1=1', 'user_id', 'created_at', $u, $s));
metric_add('giveawayWins', static fn(?string $u, ?string $s): array => ix_metric("SELECT winner_id AS uid, COUNT(*) AS n FROM giveaways WHERE status = 'drawn' AND winner_id IS NOT NULL", 'winner_id', 'drawn_at', $u, $s));
metric_add('bingoWins', static fn(?string $u, ?string $s): array => ix_metric('SELECT user_id AS uid, COUNT(*) AS n FROM bingo_claims WHERE 1=1', 'user_id', 'created_at', $u, $s));
metric_add('quizScore', static fn(?string $u, ?string $s): array => ix_metric('SELECT user_id AS uid, SUM(score) AS n FROM quiz_answers WHERE 1=1', 'user_id', 'created_at', $u, $s));
metric_add('tierVotes', static fn(?string $u, ?string $s): array => ix_metric('SELECT user_id AS uid, COUNT(*) AS n FROM tierlist_votes WHERE 1=1', 'user_id', 'updated_at', $u, $s));

badge_add('ix_voter', ['Избиратель', 'Проголосовать в 10 опросах', '🗳', 'pollVotes', 10]);
badge_add('ix_quiz', ['Знаток', 'Набрать 20 верных ответов в квизах', '🧠', 'quizScore', 20]);
badge_add('ix_bingo', ['Бинго!', 'Собрать линию в стрим-бинго', '🎱', 'bingoWins', 1]);
badge_add('ix_lucky', ['Везунчик', 'Выиграть розыгрыш', '🍀', 'giveawayWins', 1]);
badge_add('ix_critic', ['Критик', 'Собрать 5 тир-листов', '🏅', 'tierVotes', 5]);

xp_add('pollVotes', 2, 100);
xp_add('giveawayEntries', 2, 60);
xp_add('bingoWins', 30, 300);
xp_add('quizScore', 3, 300);
xp_add('tierVotes', 5, 100);

/* ================= Общие помощники ================= */

function ix_json(?string $s): array
{
    $v = json_decode((string) $s, true);
    return is_array($v) ? $v : [];
}

/** Целое из JSON: 3, "3" (и "-1", если $neg). Иначе null. */
function ix_int($v, bool $neg = false): ?int
{
    if (is_int($v)) return $v;
    if (is_float($v) && floor($v) === $v && abs($v) < 1e9) return (int) $v;
    if (is_string($v) && preg_match($neg ? '/^-?\d{1,9}$/' : '/^\d{1,9}$/', $v)) return (int) $v;
    return null;
}

/** Действие админа: проверка роли + лимит. */
function ix_admin(): array
{
    $me = require_admin();
    session_release();
    rate_limit_hit('ix_admin', user_subject($me['id']));
    return $me;
}

/** Пользователи по id → [id => {id, nick, avatarUrl}]. */
function ix_users(array $ids): array
{
    $ids = array_values(array_unique(array_filter($ids, 'is_string')));
    if (!$ids) return [];
    $out = [];
    foreach (q_all(USER_SELECT . ' WHERE u.id IN (' . placeholders(count($ids)) . ')', $ids) as $u) {
        $out[$u['id']] = ['id' => $u['id'], 'nick' => $u['nick'], 'avatarUrl' => avatar_url($u['id'], $u['avatar_file'] ?? null)];
    }
    return $out;
}

/** Список непустых строк из тела (с обрезкой пробелов). */
function ix_str_list($v): array
{
    if (!is_array($v)) return [];
    return array_values(array_filter(array_map('clean_str', $v), static fn($s) => $s !== ''));
}

function ix_action(array $b, array $allowed): string
{
    $a = (string) ($b['action'] ?? '');
    if (!in_array($a, $allowed, true)) throw new ApiError('validation', 'Неизвестное действие');
    return $a;
}

/** Выполнить $fn в транзакции. */
function ix_tx(callable $fn)
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $r = $fn();
        $pdo->commit();
        return $r;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/** GET interactive/admin → всё для пульта (админ): опросы, розыгрыши, бинго, квизы (с ответами), тир-листы. */
function route_ix_admin(): array
{
    $me = require_admin();
    session_release();
    $quizzes = [];
    foreach (q_all('SELECT q.*, (SELECT COUNT(*) FROM quiz_answers a WHERE a.quiz_id = q.id) AS answers FROM quizzes q ORDER BY q.created_at DESC LIMIT 30') as $q) {
        $quizzes[] = [
            'id' => $q['id'], 'title' => $q['title'], 'status' => $q['status'], 'reward' => (int) $q['reward'],
            'questions' => ix_json($q['questions']), 'answers' => (int) $q['answers'],
            'createdAt' => iso($q['created_at']), 'closedAt' => iso($q['closed_at']),
        ];
    }
    return [
        'polls' => polls_view(q_all('SELECT * FROM polls ORDER BY created_at DESC LIMIT 30'), $me),
        'giveaways' => giveaways_view(q_all('SELECT * FROM giveaways ORDER BY created_at DESC LIMIT 30'), $me),
        'bingo' => array_map(static fn($r) => bingo_view($r, null), q_all('SELECT * FROM bingo_rounds ORDER BY created_at DESC LIMIT 20')),
        'quizzes' => $quizzes,
        'tierlists' => tierlists_view(q_all('SELECT * FROM tierlists ORDER BY created_at DESC LIMIT 30'), $me),
    ];
}

/* ================= Опросы ================= */

function find_poll(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT * FROM polls WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Опрос не найден');
    return $row;
}

/** Строки polls → [{ id, question, status, options:[{text,votes,percent}], total, myVote, createdAt, closedAt }]. */
function polls_view(array $rows, ?array $me): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $in = placeholders(count($ids));
    $counts = [];
    foreach (q_all("SELECT poll_id, option_idx, COUNT(*) AS n FROM poll_votes WHERE poll_id IN ($in) GROUP BY poll_id, option_idx", $ids) as $r) {
        $counts[$r['poll_id']][(int) $r['option_idx']] = (int) $r['n'];
    }
    $mine = [];
    if ($me) {
        foreach (q_all("SELECT poll_id, option_idx FROM poll_votes WHERE user_id = ? AND poll_id IN ($in)", array_merge([$me['id']], $ids)) as $r) {
            $mine[$r['poll_id']] = (int) $r['option_idx'];
        }
    }
    $out = [];
    foreach ($rows as $p) {
        $opts = ix_json($p['options']);
        $total = array_sum($counts[$p['id']] ?? []);
        $list = [];
        foreach ($opts as $i => $text) {
            $n = $counts[$p['id']][$i] ?? 0;
            $list[] = ['text' => (string) $text, 'votes' => $n, 'percent' => $total ? (int) round($n * 100 / $total) : 0];
        }
        $out[] = [
            'id' => $p['id'], 'question' => $p['question'], 'status' => $p['status'], 'options' => $list, 'total' => $total,
            'myVote' => $mine[$p['id']] ?? null, 'createdAt' => iso($p['created_at']), 'closedAt' => iso($p['closed_at']),
        ];
    }
    return $out;
}

/** GET polls → { items } — открытые сверху, затем 6 последних закрытых. */
function route_polls(): array
{
    $me = current_user();
    session_release();
    $rows = array_merge(
        q_all("SELECT * FROM polls WHERE status = 'open' ORDER BY created_at DESC LIMIT 10"),
        q_all("SELECT * FROM polls WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 6")
    );
    return ['items' => polls_view($rows, $me)];
}

/** GET poll/live → { poll } — последний открытый опрос или закрытый не раньше 2 минут назад (для оверлея, публично). */
function route_poll_live(): array
{
    session_release();
    $row = q_one("SELECT * FROM polls WHERE status = 'open' ORDER BY created_at DESC LIMIT 1")
        ?? q_one("SELECT * FROM polls WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 1",
            [gmdate('Y-m-d H:i:s', time() - IX_POLL_LIVE_SEC)]);
    return ['poll' => $row ? polls_view([$row], null)[0] : null];
}

/** POST poll/vote { id, option } — голос можно менять, пока опрос открыт. */
function route_poll_vote(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    $opt = ix_int($b['option'] ?? null);
    if ($opt === null) throw new ApiError('validation', 'Выбери вариант', ['option' => 'Выбери вариант']);
    $p = find_poll($id);
    if ($p['status'] !== 'open') throw new ApiError('validation', 'Опрос уже закрыт');
    if ($opt < 0 || $opt >= count(ix_json($p['options']))) throw new ApiError('validation', 'Нет такого варианта', ['option' => 'Нет такого варианта']);
    rate_limit_hit('ix_vote', user_subject($me['id']));
    q('INSERT INTO poll_votes (poll_id, user_id, option_idx, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE option_idx = VALUES(option_idx)',
        [$p['id'], $me['id'], $opt, now_db()]);
    return polls_view([find_poll($p['id'])], $me)[0];
}

/** POST poll/create { question, options: string[] } (админ) */
function route_poll_create(): array
{
    $me = ix_admin();
    $b = request_body();
    $q = clean_str($b['question'] ?? null);
    $opts = ix_str_list($b['options'] ?? null);
    $e = [];
    if (str_len($q) < 3 || str_len($q) > 160) $e['question'] = 'Вопрос от 3 до 160 символов';
    if (count($opts) < 2 || count($opts) > 6) $e['options'] = 'Нужно от 2 до 6 вариантов';
    foreach ($opts as $o) if (str_len($o) > 60) $e['options'] = 'Вариант — не длиннее 60 символов';
    if (count(array_unique(array_map('mb_strtolower', $opts))) !== count($opts)) $e['options'] = 'Варианты не должны повторяться';
    assert_valid($e);
    $id = uuid4();
    q("INSERT INTO polls (id, question, options, status, created_at, closed_at) VALUES (?, ?, ?, 'open', ?, NULL)",
        [$id, $q, json_encode_safe($opts), now_db()]);
    $view = polls_view([find_poll($id)], $me)[0];
    event_emit('poll.open', ['poll' => $view]);
    return $view;
}

/** POST poll/update { id, action: close | open | delete } (админ) */
function route_poll_update(): ?array
{
    $me = ix_admin();
    $b = request_body();
    $action = ix_action($b, ['close', 'open', 'delete']);
    $p = find_poll(norm_uuid($b['id'] ?? null));
    if ($action === 'delete') {
        q('DELETE FROM polls WHERE id = ?', [$p['id']]);
        return null;
    }
    if ($action === 'close') q("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?", [now_db(), $p['id']]);
    else q("UPDATE polls SET status = 'open', closed_at = NULL WHERE id = ?", [$p['id']]);
    return polls_view([find_poll($p['id'])], $me)[0];
}

/* ================= Розыгрыши ================= */

function find_giveaway(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT * FROM giveaways WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Розыгрыш не найден');
    return $row;
}

/** Индекс победителя: HMAC-SHA256(ключ = seed, сообщение = id участников по возрастанию через запятую), первые 13 hex → число → mod n. */
function giveaway_pick(array $sortedIds, string $seed): int
{
    $h = hash_hmac('sha256', implode(',', $sortedIds), $seed);
    return hexdec(substr($h, 0, 13)) % count($sortedIds);
}

/** Участники розыгрыша: id по возрастанию (тот же порядок, что при розыгрыше). */
function giveaway_entry_ids(string $gid): array
{
    $ids = array_column(q_all('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', [$gid]), 'user_id');
    sort($ids, SORT_STRING);
    return $ids;
}

/** Строки giveaways → вид для фронтенда. seed — только после розыгрыша. */
function giveaways_view(array $rows, ?array $me): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $in = placeholders(count($ids));
    $counts = [];
    foreach (q_all("SELECT giveaway_id, COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id IN ($in) GROUP BY giveaway_id", $ids) as $r) {
        $counts[$r['giveaway_id']] = (int) $r['n'];
    }
    $mine = [];
    if ($me) {
        foreach (q_all("SELECT giveaway_id FROM giveaway_entries WHERE user_id = ? AND giveaway_id IN ($in)", array_merge([$me['id']], $ids)) as $r) {
            $mine[$r['giveaway_id']] = true;
        }
    }
    $users = ix_users(array_column($rows, 'winner_id'));
    $out = [];
    foreach ($rows as $g) {
        $drawn = $g['status'] === 'drawn';
        $out[] = [
            'id' => $g['id'], 'title' => $g['title'], 'prize' => $g['prize'], 'status' => $g['status'],
            'seedHash' => $g['seed_hash'], 'seed' => $drawn ? $g['seed'] : null,
            'entries' => $counts[$g['id']] ?? 0, 'joined' => isset($mine[$g['id']]),
            'winner' => $drawn && $g['winner_id'] ? ($users[$g['winner_id']] ?? ['id' => $g['winner_id'], 'nick' => 'удалённый аккаунт', 'avatarUrl' => null]) : null,
            'createdAt' => iso($g['created_at']), 'drawnAt' => iso($g['drawn_at']),
        ];
    }
    return $out;
}

/** Подробности: + participants [{id,nick}] по возрастанию id (после розыгрыша — для проверки честности). */
function giveaway_detail(array $g, ?array $me): array
{
    $view = giveaways_view([$g], $me)[0];
    $view['participants'] = null;
    if ($g['status'] === 'drawn') {
        $ids = giveaway_entry_ids($g['id']);
        $users = ix_users($ids);
        $view['participants'] = array_map(static fn($id) => ['id' => $id, 'nick' => $users[$id]['nick'] ?? '?'], $ids);
    }
    return $view;
}

/** GET giveaways → { items } — открытые и закрытые сверху, затем последние разыгранные. */
function route_giveaways(): array
{
    $me = current_user();
    session_release();
    $rows = q_all("SELECT * FROM giveaways ORDER BY FIELD(status, 'open', 'closed', 'drawn'), COALESCE(drawn_at, created_at) DESC LIMIT 12");
    return ['items' => giveaways_view($rows, $me)];
}

/** GET giveaway?id= → подробности с участниками. */
function route_giveaway_get(): array
{
    $me = current_user();
    session_release();
    return giveaway_detail(find_giveaway(norm_uuid(query_str('id'))), $me);
}

/** GET giveaway/live → { giveaway } для оверлея: открытый/закрытый или разыгранный за последние 5 минут (+ ники для рулетки). */
function route_giveaway_live(): array
{
    session_release();
    $row = q_one("SELECT * FROM giveaways WHERE status = 'drawn' AND drawn_at >= ? ORDER BY drawn_at DESC LIMIT 1",
        [gmdate('Y-m-d H:i:s', time() - IX_GIVEAWAY_LIVE_SEC)])
        ?? q_one("SELECT * FROM giveaways WHERE status IN ('open', 'closed') ORDER BY created_at DESC LIMIT 1");
    if (!$row) return ['giveaway' => null];
    $v = giveaways_view([$row], null)[0];
    $v['nicks'] = [];
    if ($row['status'] === 'drawn') {
        // для рулетки хватит 40 случайных ников (победитель добавится на фронте)
        $v['nicks'] = array_column(q_all('SELECT u.nick FROM giveaway_entries e JOIN users u ON u.id = e.user_id WHERE e.giveaway_id = ? ORDER BY RAND() LIMIT 40', [$row['id']]), 'nick');
    }
    return ['giveaway' => $v];
}

/** POST giveaway/join { id, join: bool } — войти в розыгрыш или выйти, пока он открыт. */
function route_giveaway_join(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    $join = ($b['join'] ?? true) !== false;
    rate_limit_hit('ix_join', user_subject($me['id']));
    ix_tx(static function () use ($id, $join, $me): void {
        $g = find_giveaway($id, true); // розыгрыш не начнётся посреди входа
        if ($g['status'] !== 'open') throw new ApiError('validation', 'Приём участников закрыт');
        if ($join) q('INSERT IGNORE INTO giveaway_entries (giveaway_id, user_id, created_at) VALUES (?, ?, ?)', [$g['id'], $me['id'], now_db()]);
        else q('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', [$g['id'], $me['id']]);
    });
    return giveaways_view([find_giveaway($id)], $me)[0];
}

/** POST giveaway/create { title, prize } (админ) — seed создаётся сразу, публикуется только его sha256. */
function route_giveaway_create(): array
{
    $me = ix_admin();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $prize = clean_str($b['prize'] ?? null);
    $e = [];
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if (str_len($prize) < 1 || str_len($prize) > 160) $e['prize'] = 'Приз — от 1 до 160 символов';
    assert_valid($e);
    $id = uuid4();
    $seed = bin2hex(random_bytes(32));
    q("INSERT INTO giveaways (id, title, prize, status, seed_hash, seed, winner_id, created_at, drawn_at) VALUES (?, ?, ?, 'open', ?, ?, NULL, ?, NULL)",
        [$id, $title, $prize, hash('sha256', $seed), $seed, now_db()]);
    $view = giveaways_view([find_giveaway($id)], $me)[0];
    event_emit('giveaway.open', ['giveaway' => ['id' => $id, 'title' => $title, 'prize' => $prize, 'seedHash' => $view['seedHash']]]);
    return $view;
}

/** POST giveaway/update { id, action: close | open | draw | delete } (админ) */
function route_giveaway_update(): ?array
{
    $me = ix_admin();
    $b = request_body();
    $action = ix_action($b, ['close', 'open', 'draw', 'delete']);
    $id = norm_uuid($b['id'] ?? null);
    if ($action === 'delete') {
        find_giveaway($id);
        q('DELETE FROM giveaways WHERE id = ?', [$id]);
        return null;
    }
    $winner = ix_tx(static function () use ($id, $action): ?string {
        $g = find_giveaway($id, true);
        if ($g['status'] === 'drawn') throw new ApiError('validation', 'Розыгрыш уже проведён');
        if ($action === 'close' || $action === 'open') {
            q('UPDATE giveaways SET status = ? WHERE id = ?', [$action === 'close' ? 'closed' : 'open', $g['id']]);
            return null;
        }
        $ids = giveaway_entry_ids($g['id']);
        if (!$ids) throw new ApiError('validation', 'В розыгрыше пока нет участников');
        $winner = $ids[giveaway_pick($ids, $g['seed'])];
        q("UPDATE giveaways SET status = 'drawn', winner_id = ?, drawn_at = ? WHERE id = ?", [$winner, now_db(), $g['id']]);
        return $winner;
    });
    $g = find_giveaway($id);
    if ($winner !== null) {
        $nick = ix_users([$winner])[$winner]['nick'] ?? '?';
        notify($winner, 'giveaway', "Ты выиграл розыгрыш «{$g['title']}»: {$g['prize']} 🎁", 'play.html#giveaways');
        event_emit('giveaway.drawn', [
            'giveaway' => ['id' => $g['id'], 'title' => $g['title'], 'prize' => $g['prize']],
            'winner' => ['id' => $winner, 'nick' => $nick],
        ]);
    }
    return giveaway_detail($g, $me);
}

/* ================= Бинго ================= */

function find_bingo(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT * FROM bingo_rounds WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Раунд бинго не найден');
    return $row;
}

/**
 * Карточка 5×5 игрока: индексы событий, центр (12) — null (свободная клетка).
 * Перемешивание Фишера — Йетса, случайность — sha256(seed:i), seed = sha256(roundId + userId): у игрока всегда та же карточка.
 */
function bingo_card(string $roundId, string $userId, int $n): array
{
    $seed = hash('sha256', $roundId . $userId);
    $idx = range(0, $n - 1);
    for ($i = $n - 1; $i > 0; $i--) {
        $j = hexdec(substr(hash('sha256', $seed . ':' . $i), 0, 13)) % ($i + 1);
        [$idx[$i], $idx[$j]] = [$idx[$j], $idx[$i]];
    }
    $card = array_slice($idx, 0, 24);
    array_splice($card, 12, 0, [null]);
    return $card;
}

/** Сколько полных линий (5 строк, 5 столбцов, 2 диагонали) на карточке. */
function bingo_lines(array $card, array $marked): int
{
    $on = array_flip($marked);
    $hit = static fn(int $k): bool => $card[$k] === null || isset($on[$card[$k]]);
    $lines = [];
    for ($i = 0; $i < 5; $i++) {
        $lines[] = [$i * 5, $i * 5 + 1, $i * 5 + 2, $i * 5 + 3, $i * 5 + 4];
        $lines[] = [$i, $i + 5, $i + 10, $i + 15, $i + 20];
    }
    $lines[] = [0, 6, 12, 18, 24];
    $lines[] = [4, 8, 12, 16, 20];
    $n = 0;
    foreach ($lines as $l) if (count(array_filter($l, $hit)) === 5) $n++;
    return $n;
}

/** Раунд → вид: события, отмеченные, победители; для игрока — его карточка и можно ли кричать «БИНГО!». */
function bingo_view(array $r, ?array $me): array
{
    $items = ix_json($r['items']);
    $marked = array_values(array_map('intval', ix_json($r['marked'])));
    $claims = q_all('SELECT user_id, place, created_at FROM bingo_claims WHERE round_id = ? ORDER BY place', [$r['id']]);
    $users = ix_users(array_column($claims, 'user_id'));
    $reward = (int) $r['reward'];
    $view = [
        'id' => $r['id'], 'title' => $r['title'], 'status' => $r['status'], 'reward' => $reward,
        'items' => $items, 'marked' => $marked,
        'claims' => array_map(static fn($c) => [
            'place' => (int) $c['place'], 'prize' => (int) $c['place'] === 1 ? $reward : intdiv($reward, 2),
            'user' => $users[$c['user_id']] ?? ['id' => $c['user_id'], 'nick' => '?', 'avatarUrl' => null], 'createdAt' => iso($c['created_at']),
        ], $claims),
        'card' => null, 'lines' => 0, 'myPlace' => null, 'canClaim' => false,
        'createdAt' => iso($r['created_at']), 'closedAt' => iso($r['closed_at']),
    ];
    if ($me) {
        $card = bingo_card($r['id'], $me['id'], count($items));
        $view['card'] = $card;
        $view['lines'] = bingo_lines($card, $marked);
        foreach ($claims as $c) if ($c['user_id'] === $me['id']) $view['myPlace'] = (int) $c['place'];
        $view['canClaim'] = $r['status'] === 'open' && $view['myPlace'] === null && $view['lines'] > 0;
    }
    return $view;
}

/** GET bingo → { round } — открытый раунд, иначе последний закрытый (или null). */
function route_bingo(): array
{
    $me = current_user();
    session_release();
    $r = q_one("SELECT * FROM bingo_rounds WHERE status = 'open' ORDER BY created_at DESC LIMIT 1")
        ?? q_one("SELECT * FROM bingo_rounds ORDER BY created_at DESC LIMIT 1");
    return ['round' => $r ? bingo_view($r, $me) : null];
}

/** POST bingo/claim { id } — сервер сам проверяет линию на карточке игрока. */
function route_bingo_claim(): array
{
    $me = require_user();
    session_release();
    $id = norm_uuid(request_body()['id'] ?? null);
    rate_limit_hit('ix_bingo', user_subject($me['id']));
    [$place, $prize, $title] = ix_tx(static function () use ($id, $me): array {
        $r = find_bingo($id, true); // места 1, 2, 3… раздаются строго по очереди
        if ($r['status'] !== 'open') throw new ApiError('validation', 'Раунд уже закрыт');
        if (q_one('SELECT 1 AS x FROM bingo_claims WHERE round_id = ? AND user_id = ?', [$r['id'], $me['id']])) {
            throw new ApiError('validation', 'Ты уже забрал бинго в этом раунде');
        }
        $card = bingo_card($r['id'], $me['id'], count(ix_json($r['items'])));
        if (bingo_lines($card, array_map('intval', ix_json($r['marked']))) === 0) {
            throw new ApiError('validation', 'Пока нет полной линии — ждём, что ещё случится на стриме');
        }
        $place = (int) q_one('SELECT COUNT(*) AS n FROM bingo_claims WHERE round_id = ?', [$r['id']])['n'] + 1;
        q('INSERT INTO bingo_claims (round_id, user_id, place, created_at) VALUES (?, ?, ?, ?)', [$r['id'], $me['id'], $place, now_db()]);
        $prize = $place === 1 ? (int) $r['reward'] : intdiv((int) $r['reward'], 2);
        if ($prize > 0) points_add($me['id'], $prize, 'bingo', $r['id']);
        return [$place, $prize, $r['title']];
    });
    notify($me['id'], 'bingo', "Бинго «{$title}»: $place место" . ($prize > 0 ? ", +$prize баллов" : '') . ' 🎱', 'play.html#bingo');
    return ['place' => $place, 'prize' => $prize, 'round' => bingo_view(find_bingo($id), $me)];
}

/** POST bingo/create { title, items: string[] (24–75), reward } (админ) */
function route_bingo_create(): array
{
    ix_admin();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $items = ix_str_list($b['items'] ?? null);
    $reward = ix_int($b['reward'] ?? 100);
    $e = [];
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if (count($items) < 24 || count($items) > 75) $e['items'] = 'Нужно от 24 до 75 событий (по одному в строке)';
    foreach ($items as $it) if (str_len($it) > 60) $e['items'] = 'Событие — не длиннее 60 символов: «' . mb_substr($it, 0, 30) . '…»';
    if (count(array_unique(array_map('mb_strtolower', $items))) !== count($items)) $e['items'] = 'События не должны повторяться';
    if ($reward === null || $reward < 0 || $reward > 10000) $e['reward'] = 'Награда от 0 до 10000 баллов';
    assert_valid($e);
    $id = uuid4();
    q("INSERT INTO bingo_rounds (id, title, items, marked, status, reward, created_at, closed_at) VALUES (?, ?, ?, '[]', 'open', ?, ?, NULL)",
        [$id, $title, json_encode_safe($items), $reward, now_db()]);
    $view = bingo_view(find_bingo($id), null);
    event_emit('bingo.open', ['round' => ['id' => $id, 'title' => $title, 'reward' => $reward]]);
    return $view;
}

/** POST bingo/mark { id, index, on: bool } (админ) — событие случилось / отмена. */
function route_bingo_mark(): array
{
    ix_admin();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    $idx = ix_int($b['index'] ?? null);
    $on = ($b['on'] ?? true) !== false;
    ix_tx(static function () use ($id, $idx, $on): void {
        $r = find_bingo($id, true);
        if ($r['status'] !== 'open') throw new ApiError('validation', 'Раунд уже закрыт');
        if ($idx === null || $idx < 0 || $idx >= count(ix_json($r['items']))) throw new ApiError('validation', 'Нет такого события');
        $marked = array_map('intval', ix_json($r['marked']));
        $marked = $on ? array_merge($marked, [$idx]) : array_diff($marked, [$idx]);
        $marked = array_values(array_unique($marked));
        sort($marked);
        q('UPDATE bingo_rounds SET marked = ? WHERE id = ?', [json_encode_safe($marked), $r['id']]);
    });
    return bingo_view(find_bingo($id), null);
}

/** POST bingo/update { id, action: close | delete } (админ) */
function route_bingo_update(): ?array
{
    ix_admin();
    $b = request_body();
    $action = ix_action($b, ['close', 'delete']);
    $r = find_bingo(norm_uuid($b['id'] ?? null));
    if ($action === 'delete') {
        q('DELETE FROM bingo_rounds WHERE id = ?', [$r['id']]);
        return null;
    }
    q("UPDATE bingo_rounds SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE id = ?", [now_db(), $r['id']]);
    return bingo_view(find_bingo($r['id']), null);
}

/* ================= Квиз ================= */

function find_quiz(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT * FROM quizzes WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Квиз не найден');
    return $row;
}

/** GET quiz → { open: квиз без правильных ответов + мой результат, results: последний закрытый с ответами и таблицей } */
function route_quiz(): array
{
    $me = current_user();
    session_release();
    $open = null;
    if ($q = q_one("SELECT * FROM quizzes WHERE status = 'open' ORDER BY created_at DESC LIMIT 1")) {
        $qs = ix_json($q['questions']);
        $mine = $me ? q_one('SELECT score, ms FROM quiz_answers WHERE quiz_id = ? AND user_id = ?', [$q['id'], $me['id']]) : null;
        $open = [
            'id' => $q['id'], 'title' => $q['title'], 'reward' => (int) $q['reward'],
            'questions' => array_map(static fn($x) => ['q' => (string) $x['q'], 'options' => array_values($x['options'])], $qs),
            'players' => (int) q_one('SELECT COUNT(*) AS n FROM quiz_answers WHERE quiz_id = ?', [$q['id']])['n'],
            'mine' => $mine ? ['score' => (int) $mine['score'], 'total' => count($qs), 'ms' => (int) $mine['ms']] : null,
            'createdAt' => iso($q['created_at']),
        ];
    }
    $results = null;
    if ($q = q_one("SELECT * FROM quizzes WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 1")) {
        $qs = ix_json($q['questions']);
        $rows = q_all('SELECT user_id, score, ms FROM quiz_answers WHERE quiz_id = ? ORDER BY score DESC, created_at ASC LIMIT 20', [$q['id']]);
        $users = ix_users(array_column($rows, 'user_id'));
        $mine = $me ? q_one('SELECT answers, score, ms FROM quiz_answers WHERE quiz_id = ? AND user_id = ?', [$q['id'], $me['id']]) : null;
        $results = [
            'id' => $q['id'], 'title' => $q['title'], 'reward' => (int) $q['reward'],
            'questions' => array_map(static fn($x) => ['q' => (string) $x['q'], 'options' => array_values($x['options']), 'correct' => (int) $x['correct']], $qs),
            'players' => (int) q_one('SELECT COUNT(*) AS n FROM quiz_answers WHERE quiz_id = ?', [$q['id']])['n'],
            'leaderboard' => array_map(static fn($r, $i) => [
                'place' => $i + 1, 'user' => $users[$r['user_id']] ?? ['id' => $r['user_id'], 'nick' => '?', 'avatarUrl' => null],
                'score' => (int) $r['score'], 'ms' => (int) $r['ms'],
            ], $rows, array_keys($rows)),
            'mine' => $mine ? ['score' => (int) $mine['score'], 'total' => count($qs), 'ms' => (int) $mine['ms'], 'answers' => array_map('intval', ix_json($mine['answers']))] : null,
            'closedAt' => iso($q['closed_at']),
        ];
    }
    return ['open' => $open, 'results' => $results];
}

/** POST quiz/answer { quizId, answers: int[] (-1 — не успел), ms } — один раз; баллы = верные × награда. */
function route_quiz_answer(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['quizId'] ?? null);
    $q = find_quiz($id);
    if ($q['status'] !== 'open') throw new ApiError('validation', 'Этот квиз сейчас не идёт');
    $qs = ix_json($q['questions']);
    $raw = $b['answers'] ?? null;
    if (!is_array($raw) || !array_is_list($raw) || count($raw) !== count($qs)) throw new ApiError('validation', 'Ответь на все вопросы', ['answers' => 'Нужно ' . count($qs) . ' ответов']);
    $answers = [];
    $score = 0;
    foreach ($raw as $i => $a) {
        $a = ix_int($a, true);
        if ($a === null || $a < -1 || $a >= count($qs[$i]['options'])) throw new ApiError('validation', 'Неверный ответ на вопрос ' . ($i + 1), ['answers' => 'Неверный ответ']);
        $answers[] = $a;
        if ($a === (int) $qs[$i]['correct']) $score++;
    }
    $ms = ix_int($b['ms'] ?? 0) ?? 0;
    $ms = max(0, min(IX_QUIZ_MS_MAX, $ms));
    rate_limit_hit('ix_quiz', user_subject($me['id']));
    $points = $score * (int) $q['reward'];
    try {
        ix_tx(static function () use ($q, $me, $answers, $score, $ms, $points): void {
            q('INSERT INTO quiz_answers (quiz_id, user_id, answers, score, ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$q['id'], $me['id'], json_encode_safe($answers), $score, $ms, now_db()]);
            if ($points > 0) points_add($me['id'], $points, 'quiz', $q['id']);
        });
    } catch (PDOException $e) {
        if (is_duplicate_key($e)) throw new ApiError('validation', 'Ты уже прошёл этот квиз');
        throw $e;
    }
    return ['score' => $score, 'total' => count($qs), 'points' => $points, 'ms' => $ms];
}

/** POST quiz/create { title, reward, questions: [{ q, options: string[2..4], correct }] } (админ) → черновик. */
function route_quiz_create(): array
{
    ix_admin();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $reward = ix_int($b['reward'] ?? 10);
    $raw = $b['questions'] ?? null;
    $e = [];
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if ($reward === null || $reward < 0 || $reward > 1000) $e['reward'] = 'Награда за ответ от 0 до 1000 баллов';
    $qs = [];
    if (!is_array($raw) || !array_is_list($raw) || count($raw) < 3 || count($raw) > 15) {
        $e['questions'] = 'Нужно от 3 до 15 вопросов';
    } else {
        foreach ($raw as $i => $x) {
            $n = $i + 1;
            $text = clean_str(is_array($x) ? ($x['q'] ?? null) : null);
            $opts = ix_str_list(is_array($x) ? ($x['options'] ?? null) : null);
            $correct = ix_int(is_array($x) ? ($x['correct'] ?? null) : null);
            if (str_len($text) < 3 || str_len($text) > 200) { $e['questions'] = "Вопрос $n: от 3 до 200 символов"; break; }
            if (count($opts) < 2 || count($opts) > 4) { $e['questions'] = "Вопрос $n: от 2 до 4 вариантов"; break; }
            foreach ($opts as $o) if (str_len($o) > 200) $e['questions'] = "Вопрос $n: вариант не длиннее 200 символов";
            if ($correct === null || $correct >= count($opts)) { $e['questions'] = "Вопрос $n: отметь правильный вариант"; break; }
            $qs[] = ['q' => $text, 'options' => $opts, 'correct' => $correct];
        }
    }
    assert_valid($e);
    $id = uuid4();
    q("INSERT INTO quizzes (id, title, questions, status, reward, created_at, closed_at) VALUES (?, ?, ?, 'draft', ?, ?, NULL)",
        [$id, $title, json_encode_safe($qs), $reward, now_db()]);
    return ['id' => $id, 'title' => $title, 'status' => 'draft', 'reward' => $reward, 'questions' => $qs, 'answers' => 0];
}

/** POST quiz/update { id, action: open | close | delete } (админ): черновик → открыт → закрыт. */
function route_quiz_update(): ?array
{
    ix_admin();
    $b = request_body();
    $action = ix_action($b, ['open', 'close', 'delete']);
    $id = norm_uuid($b['id'] ?? null);
    $q = find_quiz($id);
    if ($action === 'delete') {
        q('DELETE FROM quizzes WHERE id = ?', [$q['id']]);
        return null;
    }
    if ($action === 'open') {
        if ($q['status'] !== 'draft') throw new ApiError('validation', 'Открыть можно только черновик');
        if (q_one("SELECT id FROM quizzes WHERE status = 'open' LIMIT 1")) throw new ApiError('validation', 'Сначала закрой идущий квиз');
        q("UPDATE quizzes SET status = 'open' WHERE id = ?", [$q['id']]);
        event_emit('quiz.open', ['quiz' => ['id' => $q['id'], 'title' => $q['title'], 'reward' => (int) $q['reward']]]);
    } else {
        if ($q['status'] !== 'open') throw new ApiError('validation', 'Закрыть можно только идущий квиз');
        q("UPDATE quizzes SET status = 'closed', closed_at = ? WHERE id = ?", [now_db(), $q['id']]);
    }
    $q = find_quiz($id);
    return ['id' => $q['id'], 'title' => $q['title'], 'status' => $q['status'], 'reward' => (int) $q['reward'], 'questions' => ix_json($q['questions'])];
}

/* ================= Тир-листы ================= */

function find_tierlist(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM tierlists WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Тир-лист не найден');
    return $row;
}

function tier_of(float $avg): string
{
    return $avg >= 4.5 ? 'S' : ($avg >= 3.5 ? 'A' : ($avg >= 2.5 ? 'B' : ($avg >= 1.5 ? 'C' : 'D')));
}

/** Строки tierlists → [{ id, title, status, items:[{text,emoji}], votes, community:[{avg,tier}|null], mine:string[]|null }]. */
function tierlists_view(array $rows, ?array $me): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $votes = [];
    foreach (q_all('SELECT list_id, user_id, placement FROM tierlist_votes WHERE list_id IN (' . placeholders(count($ids)) . ')', $ids) as $v) {
        $votes[$v['list_id']][] = $v;
    }
    $out = [];
    foreach ($rows as $l) {
        $items = ix_json($l['items']);
        $sum = array_fill(0, count($items), 0);
        $mine = null;
        foreach ($votes[$l['id']] ?? [] as $v) {
            $p = ix_json($v['placement']);
            foreach ($items as $i => $_) $sum[$i] += IX_TIERS[$p[$i] ?? 'D'] ?? 1;
            if ($me && $v['user_id'] === $me['id']) $mine = array_values($p);
        }
        $n = count($votes[$l['id']] ?? []);
        $out[] = [
            'id' => $l['id'], 'title' => $l['title'], 'status' => $l['status'], 'items' => $items, 'votes' => $n,
            'community' => array_map(static fn($s) => $n ? ['avg' => round($s / $n, 2), 'tier' => tier_of($s / $n)] : null, $sum),
            'mine' => $mine, 'createdAt' => iso($l['created_at']),
        ];
    }
    return $out;
}

/** GET tierlists → { items } — открытые сверху, затем закрытые. */
function route_tierlists(): array
{
    $me = current_user();
    session_release();
    return ['items' => tierlists_view(q_all("SELECT * FROM tierlists ORDER BY FIELD(status, 'open', 'closed'), created_at DESC LIMIT 12"), $me)];
}

/** POST tierlist/vote { listId, placement: { itemIndex: "S"|"A"|"B"|"C"|"D" } } — все предметы обязательны, менять можно, пока открыт. */
function route_tierlist_vote(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $l = find_tierlist(norm_uuid($b['listId'] ?? null));
    if ($l['status'] !== 'open') throw new ApiError('validation', 'Голосование по этому тир-листу закрыто');
    $n = count(ix_json($l['items']));
    $raw = $b['placement'] ?? null;
    if (!is_array($raw)) throw new ApiError('validation', 'Расставь предметы по тирам', ['placement' => 'Нет расстановки']);
    $placement = array_fill(0, $n, null);
    foreach ($raw as $k => $tier) {
        $i = ix_int($k);
        if ($i === null || $i >= $n || !is_string($tier) || !isset(IX_TIERS[$tier])) throw new ApiError('validation', 'Неверная расстановка', ['placement' => 'Неверная расстановка']);
        $placement[$i] = $tier;
    }
    $left = count(array_filter($placement, static fn($t) => $t === null));
    if ($left > 0) throw new ApiError('validation', "Осталось расставить: $left", ['placement' => 'Расставь все предметы']);
    rate_limit_hit('ix_vote', user_subject($me['id']));
    q('INSERT INTO tierlist_votes (list_id, user_id, placement, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE placement = VALUES(placement), updated_at = VALUES(updated_at)',
        [$l['id'], $me['id'], json_encode_safe($placement), now_db()]);
    return tierlists_view([find_tierlist($l['id'])], $me)[0];
}

/** POST tierlist/create { title, items: [{ text, emoji? }] | string[] } (админ) */
function route_tierlist_create(): array
{
    $me = ix_admin();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $raw = is_array($b['items'] ?? null) ? $b['items'] : [];
    $items = [];
    $e = [];
    foreach ($raw as $x) {
        $text = clean_str(is_array($x) ? ($x['text'] ?? null) : $x);
        $emoji = clean_str(is_array($x) ? ($x['emoji'] ?? null) : null);
        if ($text === '') continue;
        if (str_len($text) > 40) $e['items'] = 'Предмет — не длиннее 40 символов: «' . mb_substr($text, 0, 20) . '…»';
        if (str_len($emoji) > 8 || preg_match('/[<>&"\']/', $emoji)) $e['items'] = 'Эмодзи — один символ-картинка';
        $items[] = ['text' => $text, 'emoji' => $emoji === '' ? null : $emoji];
    }
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if (count($items) < 4 || count($items) > 30) $e['items'] = 'Нужно от 4 до 30 предметов';
    assert_valid($e);
    $id = uuid4();
    q("INSERT INTO tierlists (id, title, items, status, created_at) VALUES (?, ?, ?, 'open', ?)", [$id, $title, json_encode_safe($items), now_db()]);
    event_emit('tierlist.open', ['tierlist' => ['id' => $id, 'title' => $title]]);
    return tierlists_view([find_tierlist($id)], $me)[0];
}

/** POST tierlist/update { id, action: close | open | delete } (админ) */
function route_tierlist_update(): ?array
{
    $me = ix_admin();
    $b = request_body();
    $action = ix_action($b, ['close', 'open', 'delete']);
    $l = find_tierlist(norm_uuid($b['id'] ?? null));
    if ($action === 'delete') {
        q('DELETE FROM tierlists WHERE id = ?', [$l['id']]);
        return null;
    }
    q('UPDATE tierlists SET status = ? WHERE id = ?', [$action === 'close' ? 'closed' : 'open', $l['id']]);
    return tierlists_view([find_tierlist($l['id'])], $me)[0];
}

<?php
// Уровни, опыт (XP) и значки зрителей — считаются на лету из активности, отдельно не хранятся.
declare(strict_types=1);
defined('NDZE') || exit;

const LEVEL_TITLES = [1 => 'Новичок', 3 => 'Паучок', 5 => 'Дружелюбный сосед', 8 => 'Мститель', 12 => 'Легенда паутины'];

/** Все метрики активности: [userId => [метрика => число]]. $userId — только для одного пользователя. */
function progress_metrics(?string $userId = null): array
{
    $w = static fn(string $col) => $userId === null ? '' : " WHERE $col = ?";
    $p = $userId === null ? [] : [$userId];
    $m = [];
    $put = static function (array $rows, array $map) use (&$m): void {
        foreach ($rows as $r) foreach ($map as $from => $to) $m[$r['uid']][$to] = (int) $r[$from];
    };
    $put(q_all("SELECT s.user_id AS uid, COUNT(*) AS n, COALESCE(SUM(s.status = 'ideal'), 0) AS ideal,
                  COALESCE(SUM(GREATEST((SELECT COUNT(*) FROM submission_versions v WHERE v.submission_id = s.id) - 1, 0)), 0) AS extra,
                  COALESCE(MAX((SELECT COUNT(*) FROM submission_versions v WHERE v.submission_id = s.id)), 0) AS maxv
                FROM submissions s" . $w('s.user_id') . ' GROUP BY s.user_id', $p),
        ['n' => 'subs', 'ideal' => 'ideal', 'extra' => 'extraVersions', 'maxv' => 'maxVersions']);
    $put(q_all("SELECT t.user_id AS uid, COUNT(*) AS n, COALESCE(SUM(t.status = 'done'), 0) AS done, COALESCE(SUM(t.difficulty = 3), 0) AS hard,
                  COALESCE(MAX((SELECT COUNT(*) FROM task_votes v WHERE v.task_id = t.id)), 0) AS maxvotes,
                  COALESCE(SUM((SELECT COUNT(*) FROM task_votes v WHERE v.task_id = t.id)), 0) AS votes
                FROM tasks t" . $w('t.user_id') . ' GROUP BY t.user_id', $p),
        ['n' => 'tasks', 'done' => 'tasksDone', 'hard' => 'hardTasks', 'maxvotes' => 'maxTaskVotes', 'votes' => 'votesReceived']);
    $put(q_all('SELECT user_id AS uid, COUNT(*) AS n FROM submission_comments' . $w('user_id') . ' GROUP BY user_id', $p), ['n' => 'comments']);
    $put(q_all('SELECT user_id AS uid, COUNT(*) AS n FROM battle_votes' . $w('user_id') . ' GROUP BY user_id', $p), ['n' => 'battleVotes']);
    $put(q_all("SELECT b.user_id AS uid, COUNT(*) AS n FROM prediction_bets b JOIN predictions pr ON pr.id = b.prediction_id
                WHERE pr.status = 'resolved' AND b.option_idx = pr.result" . ($userId === null ? '' : ' AND b.user_id = ?') . ' GROUP BY b.user_id', $p),
        ['n' => 'betsWon']);
    $put(q_all('SELECT user_id AS uid, COUNT(*) AS n FROM canvas_log' . ($userId === null ? ' WHERE user_id IS NOT NULL' : ' WHERE user_id = ?') . ' GROUP BY user_id', $p), ['n' => 'pixels']);
    $put(q_all('SELECT user_id AS uid, MAX(score) AS n FROM game_scores' . $w('user_id') . ' GROUP BY user_id', $p), ['n' => 'gameBest']);
    $put(q_all('SELECT user_id AS uid, 1 AS n FROM user_minecraft' . $w('user_id'), $p), ['n' => 'minecraft']);
    // король крыш — лучший результат в игре за 7 дней
    $king = q_one('SELECT user_id FROM game_scores WHERE created_at >= ? ORDER BY score DESC, created_at ASC LIMIT 1',
        [gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
    if ($king && ($userId === null || $king['user_id'] === $userId)) $m[$king['user_id']]['roofKing'] = 1;
    return $m;
}

function badge_defs(): array
{
    // id => [название, как получить, иконка, метрика, сколько нужно]
    return [
        'first_web' => ['Первая паутина', 'Отправить первую работу на оценку', '🕸', 'subs', 1],
        'ideal' => ['Идеал', 'Довести работу до идеала', '💎', 'ideal', 1],
        'perfectionist' => ['Перфекционист', 'Три работы в статусе «Идеал»', '👑', 'ideal', 3],
        'reworker' => ['Доработчик', 'Работа с тремя и больше версиями', '🔧', 'maxVersions', 3],
        'tasker' => ['Заказчик', 'Предложить первое задание на стрим', '📜', 'tasks', 1],
        'hardcore' => ['Хардкорщик', 'Предложить задание сложности «Хардкор»', '🔥', 'hardTasks', 1],
        'on_stream' => ['Выполнено на стриме', 'Твоё задание выполнили в эфире', '🎬', 'tasksDone', 1],
        'crowd' => ['Народный выбор', '10 голосов за одно твоё задание', '📣', 'maxTaskVotes', 10],
        'judge' => ['Судья', '20 голосов в битве работ', '⚖', 'battleVotes', 20],
        'oracle' => ['Ясновидящий', 'Угадать исход ставки', '🔮', 'betsWon', 1],
        'painter' => ['Художник холста', 'Поставить 100 пикселей на холст', '🎨', 'pixels', 100],
        'miner' => ['Майнкрафтер', 'Указать ник Minecraft в кабинете', '⛏', 'minecraft', 1],
        'runner' => ['Раннер', 'Набрать 1000 очков в игре на странице 404', '🏃', 'gameBest', 1000],
        'roof_king' => ['Король крыш', 'Лучший результат недели в игре', '🏆', 'roofKing', 1],
    ];
}

function xp_of(array $m): int
{
    $g = static fn(string $k) => (int) ($m[$k] ?? 0);
    return $g('subs') * 20 + $g('ideal') * 60 + $g('extraVersions') * 10 + $g('tasks') * 15 + $g('tasksDone') * 50
        + $g('votesReceived') * 3 + $g('comments') * 2 + $g('battleVotes') * 2 + $g('betsWon') * 20
        + min($g('pixels'), 500) + min(intdiv($g('gameBest'), 100), 50) + $g('minecraft') * 10;
}

/** Порог уровня L: 50·L·(L−1) XP (2 → 100, 3 → 300, 4 → 600, 5 → 1000…). */
function level_floor(int $level): int
{
    return 50 * $level * ($level - 1);
}

function level_of(int $xp): int
{
    return max(1, (int) floor((1 + sqrt(1 + 4 * $xp / 50)) / 2));
}

function level_title(int $level): string
{
    $t = 'Новичок';
    foreach (LEVEL_TITLES as $from => $title) if ($level >= $from) $t = $title;
    return $t;
}

/** Прогресс пользователя для кабинета. */
function progress_view(array $m): array
{
    $xp = xp_of($m);
    $level = level_of($xp);
    $badges = [];
    foreach (badge_defs() as $id => [$title, $desc, $icon, $metric, $need]) {
        $have = min((int) ($m[$metric] ?? 0), $need);
        $badges[] = ['id' => $id, 'title' => $title, 'description' => $desc, 'icon' => $icon, 'earned' => $have >= $need, 'have' => $have, 'need' => $need];
    }
    return [
        'xp' => $xp, 'level' => $level, 'title' => level_title($level),
        'levelXp' => level_floor($level), 'nextLevelXp' => level_floor($level + 1),
        'badges' => $badges,
    ];
}

function user_progress(string $userId): array
{
    return progress_view(progress_metrics($userId)[$userId] ?? []);
}

/** GET leaderboard → топ-10 по XP: [{ user:{id,nick,avatarUrl}, xp, level, title, badges }] */
function route_leaderboard(): array
{
    session_release();
    // таблицу считают агрегаты по всем пользователям — для главной хватит кэша на минуту
    $cache = setting_get('leaderboard');
    if (is_array($cache) && time() - (int) ($cache['at'] ?? 0) < 60 && is_array($cache['data'] ?? null)) return $cache['data'];
    $data = leaderboard_build();
    setting_set('leaderboard', ['at' => time(), 'data' => $data]);
    return $data;
}

function leaderboard_build(): array
{
    $all = progress_metrics();
    if (!$all) return [];
    $rows = [];
    foreach ($all as $uid => $m) {
        $pv = progress_view($m);
        if ($pv['xp'] <= 0) continue;
        $rows[] = ['uid' => $uid, 'xp' => $pv['xp'], 'level' => $pv['level'], 'title' => $pv['title'],
            'badges' => count(array_filter($pv['badges'], static fn($b) => $b['earned']))];
    }
    usort($rows, static fn($a, $b) => $b['xp'] <=> $a['xp'] ?: $b['badges'] <=> $a['badges']);
    $rows = array_slice($rows, 0, 10);
    if (!$rows) return [];
    $users = [];
    foreach (q_all(USER_SELECT . ' WHERE u.id IN (' . placeholders(count($rows)) . ')', array_column($rows, 'uid')) as $u) $users[$u['id']] = $u;
    $out = [];
    foreach ($rows as $r) {
        $u = $users[$r['uid']] ?? null;
        if (!$u) continue;
        $out[] = [
            'user' => ['id' => $u['id'], 'nick' => $u['nick'], 'avatarUrl' => avatar_url($u['id'], $u['avatar_file'] ?? null)],
            'xp' => $r['xp'], 'level' => $r['level'], 'title' => $r['title'], 'badges' => $r['badges'],
        ];
    }
    return $out;
}

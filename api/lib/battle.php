<?php
// Битва работ: две работы из галереи (статус ideal), зрители выбирают лучшую, рейтинг — Эло (K = 32).
declare(strict_types=1);
defined('NDZE') || exit;

const ELO_K = 32;

/** Работа для битвы: id, название, автор, первая картинка последней версии, рейтинг. */
function battle_lean(array $ids): array
{
    if (!$ids) return [];
    $in = placeholders(count($ids));
    $rows = q_all(SUB_SELECT_BATTLE . " WHERE s.id IN ($in)", $ids);
    $imgs = [];
    foreach (q_all("SELECT i.submission_id, i.id FROM submission_images i JOIN submission_versions v ON v.id = i.version_id
                    WHERE i.submission_id IN ($in) ORDER BY v.n DESC, i.position ASC", $ids) as $r) {
        $imgs[$r['submission_id']] ??= image_url($r['id']);
    }
    $out = [];
    foreach ($rows as $s) {
        $out[$s['id']] = [
            'id' => $s['id'], 'title' => $s['title'], 'category' => $s['category'],
            'authorNick' => $s['author_nick'], 'authorAvatar' => avatar_url($s['user_id'], $s['author_avatar'] ?? null),
            'imageUrl' => $imgs[$s['id']] ?? null,
            'rating' => (int) ($s['rating'] ?? 1000), 'wins' => (int) ($s['wins'] ?? 0), 'losses' => (int) ($s['losses'] ?? 0),
        ];
    }
    return $out;
}

const SUB_SELECT_BATTLE = 'SELECT s.id, s.title, s.category, s.user_id, u.nick AS author_nick, ap.avatar_file AS author_avatar,
    br.rating, br.wins, br.losses
  FROM submissions s JOIN users u ON u.id = s.user_id
  LEFT JOIN user_profiles ap ON ap.user_id = s.user_id
  LEFT JOIN battle_ratings br ON br.submission_id = s.id';

function pair_key(string $a, string $b): string
{
    return strcmp($a, $b) < 0 ? "$a|$b" : "$b|$a";
}

/** GET battle/pair → { pair: [A, B] | null, total } — пара, за которую этот зритель ещё не голосовал. */
function route_battle_pair(): array
{
    $me = current_user();
    if (!$me) session_release(); // для вошедшего ниже запомним выданную пару в сессии
    // свои работы зрителю не показываем — за них голосовать нельзя
    $rows = q_all("SELECT s.id, s.user_id FROM submissions s WHERE s.status = 'ideal'
        AND EXISTS (SELECT 1 FROM submission_images i WHERE i.submission_id = s.id) ORDER BY RAND() LIMIT 60");
    $ids = array_column(array_filter($rows, static fn($r) => !$me || $r['user_id'] !== $me['id']), 'id');
    $total = (int) q_one("SELECT COUNT(*) AS n FROM submissions WHERE status = 'ideal'")['n'];
    $voted = [];
    if ($me) foreach (q_all('SELECT pair_key FROM battle_votes WHERE user_id = ?', [$me['id']]) as $r) $voted[$r['pair_key']] = true;
    $pick = null;
    for ($i = 0; $i < 40 && !$pick && count($ids) >= 2; $i++) {
        $a = $ids[random_int(0, count($ids) - 1)];
        $b = $ids[random_int(0, count($ids) - 1)];
        if ($a !== $b && !isset($voted[pair_key($a, $b)])) $pick = [$a, $b];
    }
    if ($me) {
        $_SESSION['battle_pair'] = $pick ? pair_key($pick[0], $pick[1]) : null; // голос принимается только за эту пару
        session_release();
    }
    if (!$pick) return ['pair' => null, 'total' => $total, 'allVoted' => $me !== null && count($ids) >= 2];
    $lean = battle_lean($pick);
    return ['pair' => [$lean[$pick[0]], $lean[$pick[1]]], 'total' => $total];
}

/** POST battle/vote { winnerId, loserId } → { winner, loser } (новые рейтинги). */
function route_battle_vote(): array
{
    $me = require_user();
    $b = request_body();
    $win = norm_uuid($b['winnerId'] ?? null);
    $lose = norm_uuid($b['loserId'] ?? null);
    if (!$win || !$lose || $win === $lose) {
        session_release();
        throw new ApiError('validation', 'Выбери одну из двух работ');
    }
    // голос — только за пару, которую сервер выдал этому зрителю (иначе можно стравливать свою работу со слабыми)
    $served = $_SESSION['battle_pair'] ?? null;
    if ($served === pair_key($win, $lose)) unset($_SESSION['battle_pair']);
    session_release();
    if ($served !== pair_key($win, $lose)) throw new ApiError('validation', 'Эта пара устарела — обнови битву');
    $ok = q_all("SELECT id, user_id FROM submissions WHERE id IN (?, ?) AND status = 'ideal'", [$win, $lose]);
    if (count($ok) !== 2) throw new ApiError('not_found', 'Одной из работ уже нет в галерее');
    if (in_array($me['id'], array_column($ok, 'user_id'), true)) throw new ApiError('forbidden', 'За свою работу голосовать нельзя');

    rate_limit_hit('battle', user_subject($me['id']));

    $t = now_db();
    $pdo = db();
    $pdo->beginTransaction();
    try {
        try {
            q('INSERT INTO battle_votes (user_id, winner_id, loser_id, pair_key, created_at) VALUES (?, ?, ?, ?, ?)',
                [$me['id'], $win, $lose, pair_key($win, $lose), $t]);
        } catch (PDOException $e) {
            if (!is_duplicate_key($e)) throw $e;
            throw new ApiError('validation', 'Ты уже голосовал за эту пару');
        }
        // сразу эксклюзивная блокировка строк рейтинга в одном порядке (INSERT IGNORE + FOR UPDATE давал дедлок)
        $pair = [$win, $lose];
        sort($pair);
        foreach ($pair as $id) {
            q('INSERT INTO battle_ratings (submission_id, rating, wins, losses, updated_at) VALUES (?, 1000, 0, 0, ?) ON DUPLICATE KEY UPDATE rating = rating', [$id, $t]);
        }
        $r = [];
        foreach (q_all('SELECT submission_id, rating FROM battle_ratings WHERE submission_id IN (?, ?) ORDER BY submission_id FOR UPDATE', [$win, $lose]) as $row) $r[$row['submission_id']] = (int) $row['rating'];
        $expect = 1 / (1 + 10 ** (($r[$lose] - $r[$win]) / 400));
        $delta = max(1, (int) round(ELO_K * (1 - $expect)));
        q('UPDATE battle_ratings SET rating = rating + ?, wins = wins + 1, updated_at = ? WHERE submission_id = ?', [$delta, $t, $win]);
        q('UPDATE battle_ratings SET rating = rating - ?, losses = losses + 1, updated_at = ? WHERE submission_id = ?', [$delta, $t, $lose]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    $lean = battle_lean([$win, $lose]);
    return ['winner' => $lean[$win], 'loser' => $lean[$lose], 'delta' => $delta];
}

/** GET battle/top → { week: работа недели | null, top: топ-5 по рейтингу } */
function route_battle_top(): array
{
    session_release();
    $week = q_one("SELECT v.winner_id AS id, COUNT(*) AS wins FROM battle_votes v JOIN submissions s ON s.id = v.winner_id
                   WHERE v.created_at >= ? AND s.status = 'ideal' GROUP BY v.winner_id ORDER BY wins DESC, MAX(v.created_at) DESC LIMIT 1",
        [gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
    $topIds = array_column(q_all("SELECT br.submission_id AS id FROM battle_ratings br JOIN submissions s ON s.id = br.submission_id
                                  WHERE s.status = 'ideal' ORDER BY br.rating DESC, br.wins DESC LIMIT 5"), 'id');
    $lean = battle_lean(array_values(array_unique(array_merge($topIds, $week ? [$week['id']] : []))));
    return [
        'week' => $week && isset($lean[$week['id']]) ? $lean[$week['id']] + ['weekWins' => (int) $week['wins']] : null,
        'top' => array_values(array_filter(array_map(static fn($id) => $lean[$id] ?? null, $topIds))),
    ];
}

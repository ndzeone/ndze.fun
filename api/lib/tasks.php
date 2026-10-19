<?php
// Задания на стрим: читать могут все, создавать/голосовать — после входа, менять — админ.
declare(strict_types=1);
defined('NDZE') || exit;

const TASK_SELECT = 'SELECT t.*, u.nick AS author_nick, ap.avatar_file AS author_avatar,
    (SELECT COUNT(*) FROM task_votes v WHERE v.task_id = t.id) AS votes,
    (SELECT COUNT(*) FROM task_votes v WHERE v.task_id = t.id AND v.user_id = ?) AS my_vote
  FROM tasks t JOIN users u ON u.id = t.user_id LEFT JOIN user_profiles ap ON ap.user_id = t.user_id';

function task_view(array $t): array
{
    return [
        'id' => $t['id'],
        'userId' => $t['user_id'],
        'authorNick' => $t['author_nick'],
        'authorAvatar' => avatar_url($t['user_id'], $t['author_avatar'] ?? null),
        'game' => $t['game'],
        'title' => $t['title'],
        'description' => $t['description'],
        'difficulty' => (int) $t['difficulty'],
        'status' => $t['status'],
        'adminNote' => $t['admin_note'],
        'votes' => (int) $t['votes'],
        'myVote' => (int) $t['my_vote'] > 0,
        'createdAt' => iso($t['created_at']),
        'updatedAt' => iso($t['updated_at']),
    ];
}

function find_task(?string $id): array
{
    $row = $id ? q_one('SELECT id, user_id, status FROM tasks WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Задание не найдено');
    return $row;
}

function task_get_view(string $id, ?array $me): array
{
    $row = q_one(TASK_SELECT . ' WHERE t.id = ?', [$me['id'] ?? '', $id]);
    if (!$row) throw new ApiError('not_found', 'Задание не найдено');
    return task_view($row);
}

function route_tasks_list(): array
{
    $me = current_user();
    session_release();
    $where = [];
    $params = [$me['id'] ?? ''];
    $game = query_str('game');
    $status = query_str('status');
    if ($game !== '') {
        $where[] = 't.game = ?';
        $params[] = $game;
    }
    if ($status !== '') {
        $where[] = 't.status = ?';
        $params[] = $status;
    }
    $sql = TASK_SELECT . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY votes DESC, t.created_at DESC, t.id DESC';
    return array_map('task_view', q_all($sql, $params));
}

function route_task_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $game = clean_str($b['game'] ?? null);
    $title = clean_str($b['title'] ?? null);
    $description = clean_str($b['description'] ?? null);
    $difficulty = $b['difficulty'] ?? null;
    assert_valid(check_task($game, $title, $description, $difficulty));

    rate_limit_hit('task', user_subject($me['id']));

    $id = uuid4();
    $t = now_db();
    q('INSERT INTO tasks (id, user_id, game, title, description, difficulty, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        [$id, $me['id'], $game, $title, $description, to_difficulty($difficulty), 'new', $t, $t]);
    return task_get_view($id, $me);
}

function route_task_vote(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $task = find_task(norm_uuid($b['id'] ?? null));
    $del = q('DELETE FROM task_votes WHERE task_id = ? AND user_id = ?', [$task['id'], $me['id']]);
    $myVote = false;
    if ($del->rowCount() === 0) {
        q('INSERT IGNORE INTO task_votes (task_id, user_id, created_at) VALUES (?, ?, ?)', [$task['id'], $me['id'], now_db()]);
        $myVote = true;
    }
    $votes = (int) q_one('SELECT COUNT(*) AS n FROM task_votes WHERE task_id = ?', [$task['id']])['n'];
    return ['votes' => $votes, 'myVote' => $myVote];
}

function route_task_update(): array
{
    $me = require_admin();
    session_release();
    $b = request_body();
    assert_valid(check_task_update($b));
    $task = find_task(norm_uuid($b['id'] ?? null));
    $sets = ['updated_at = ?'];
    $params = [now_db()];
    if (array_key_exists('status', $b)) {
        $sets[] = 'status = ?';
        $params[] = $b['status'];
    }
    if (array_key_exists('adminNote', $b)) {
        $note = $b['adminNote'] === null ? '' : clean_str($b['adminNote']);
        $sets[] = 'admin_note = ?';
        $params[] = $note === '' ? null : $note;
    }
    $params[] = $task['id'];
    q('UPDATE tasks SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
    return task_get_view($task['id'], $me);
}

function route_task_delete(): ?array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $task = find_task(norm_uuid($b['id'] ?? null));
    $allowed = $me['role'] === 'admin' || ($task['user_id'] === $me['id'] && $task['status'] === 'new');
    if (!$allowed) throw new ApiError('forbidden', 'Удалить можно только своё новое задание');
    q('DELETE FROM tasks WHERE id = ?', [$task['id']]); // голоса — ON DELETE CASCADE
    return null;
}

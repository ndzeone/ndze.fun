<?php
// Пульт стрима: колесо заданий и оверлеи для OBS (страницы overlay.html?w=…&key=…).
// OBS не входит в аккаунт, поэтому оверлей читает данные по секретному ключу из настроек.
declare(strict_types=1);
defined('NDZE') || exit;

function overlay_key(): string
{
    $k = setting_get('overlay_key');
    if (!is_string($k) || !preg_match('/^[0-9a-f]{32}$/', $k)) {
        $k = bin2hex(random_bytes(16));
        setting_set('overlay_key', $k);
    }
    return $k;
}

function overlay_key_ok($k): bool
{
    if (!is_string($k) || !preg_match('/^[0-9a-f]{32}$/', $k)) return false;
    $real = setting_get('overlay_key');
    return is_string($real) && hash_equals($real, $k);
}

/** Задания, которые могут выпасть на колесе: принятые; вес = голоса + 1. */
function wheel_candidates(): array
{
    $rows = q_all(TASK_SELECT . " WHERE t.status = 'accepted' ORDER BY votes DESC, t.created_at ASC LIMIT 24", ['']);
    return array_map(static fn($t) => [
        'id' => $t['id'], 'title' => $t['title'], 'game' => $t['game'],
        'votes' => (int) $t['votes'], 'weight' => (int) $t['votes'] + 1, 'authorNick' => $t['author_nick'],
    ], $rows);
}

/** Текущее задание оверлея: выбранное в пульте, иначе последнее «На стриме». */
function current_task(): ?array
{
    $id = setting_get('current_task');
    $row = null;
    if (is_string($id) && norm_uuid($id)) $row = q_one(TASK_SELECT . ' WHERE t.id = ?', ['', $id]);
    if (!$row) $row = q_one(TASK_SELECT . " WHERE t.status = 'live' ORDER BY t.updated_at DESC LIMIT 1", ['']);
    return $row ? task_view($row) : null;
}

function stream_admin_view(): array
{
    $task = current_task();
    return [
        'overlayKey' => overlay_key(),
        'currentTaskId' => $task['id'] ?? null,
        'currentTask' => $task,
        'wheel' => setting_get('wheel'),
        'candidates' => wheel_candidates(),
    ];
}

/** GET stream (админ) — всё для пульта. */
function route_stream_admin(): array
{
    require_admin();
    session_release();
    return stream_admin_view();
}

/** POST stream { regenerateKey?, currentTaskId? (uuid|null) } (админ) */
function route_stream_update(): array
{
    require_admin();
    session_release();
    $b = request_body();
    if (!empty($b['regenerateKey'])) setting_set('overlay_key', bin2hex(random_bytes(16)));
    if (array_key_exists('currentTaskId', $b)) {
        $id = $b['currentTaskId'] === null ? null : norm_uuid($b['currentTaskId']);
        if ($b['currentTaskId'] !== null && $id === null) throw new ApiError('validation', 'Неверное задание');
        if ($id !== null) find_task($id);
        setting_set('current_task', $id);
    }
    return stream_admin_view();
}

/**
 * POST wheel/spin (админ): случайное принятое задание с весом по голосам.
 * Победитель получает статус «На стриме» и становится текущим заданием оверлея.
 */
function route_wheel_spin(): array
{
    require_admin();
    session_release();
    $cands = wheel_candidates();
    if (!$cands) throw new ApiError('validation', 'Нет принятых заданий — прими пару заданий из новых');
    $total = array_sum(array_column($cands, 'weight'));
    $roll = random_int(1, $total);
    $win = 0;
    foreach ($cands as $i => $c) {
        $roll -= $c['weight'];
        if ($roll <= 0) { $win = $i; break; }
    }
    $spin = [
        'id' => uuid4(),
        'at' => iso(now_db()),
        'candidates' => $cands,
        'winnerIndex' => $win,
        'winnerId' => $cands[$win]['id'],
    ];
    q("UPDATE tasks SET status = 'live', updated_at = ? WHERE id = ?", [now_db(), $spin['winnerId']]);
    setting_set('wheel', $spin);
    setting_set('current_task', $spin['winnerId']);
    event_emit('wheel.spin', ['spin' => $spin, 'winner' => $cands[$win]]);
    return $spin;
}

/** GET overlay&key=… — данные для оверлеев OBS. */
function route_overlay(): array
{
    session_release();
    $key = query_str('key');
    if (!overlay_key_ok($key)) throw new ApiError('forbidden', 'Неверный ключ оверлея — скопируй ссылку из пульта заново');
    $top = array_map('task_view', q_all(TASK_SELECT . " WHERE t.status IN ('new', 'accepted') ORDER BY votes DESC, t.created_at ASC LIMIT 3", ['']));
    $last = q_one(SUB_SELECT . ' ORDER BY s.created_at DESC LIMIT 1');
    $work = null;
    if ($last) {
        $img = q_one('SELECT i.id FROM submission_images i JOIN submission_versions v ON v.id = i.version_id
                      WHERE i.submission_id = ? ORDER BY v.n DESC, i.position ASC LIMIT 1', [$last['id']]);
        $work = [
            'id' => $last['id'], 'title' => $last['title'], 'authorNick' => $last['author_nick'],
            'authorAvatar' => avatar_url($last['user_id'], $last['author_avatar'] ?? null),
            'category' => $last['category'], 'status' => $last['status'], 'createdAt' => iso($last['created_at']),
            'imageUrl' => $img ? image_url($img['id']) . '&key=' . $key : null,
        ];
    }
    return [
        'currentTask' => current_task(),
        'topTasks' => $top,
        'lastWork' => $work,
        'wheel' => setting_get('wheel'),
        'live' => live_status(),
    ];
}

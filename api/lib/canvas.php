<?php
// Общий пиксельный холст 64×64 (как r/place): один пиксель раз в CANVAS_COOLDOWN секунд на аккаунт.
// Журнал canvas_log хранит каждую постановку — из него кулдаун, «версия» холста и таймлапс.
declare(strict_types=1);
defined('NDZE') || exit;

const CANVAS_W = 64;
const CANVAS_H = 64;
const CANVAS_BG = 1; // индекс цвета пустой клетки (графит)
const CANVAS_PALETTE = [
    '#0f0f0f', '#202020', '#5a5a5a', '#a0a0a0', '#f8f8f8', '#5dd62c', '#337418', '#2fd673',
    '#4aa8ff', '#1d3f9e', '#8b6cff', '#e05cff', '#ff3b4a', '#ff8a3d', '#ffd166', '#7a4a2b',
];

function canvas_cooldown(): int
{
    return max(0, (int) cfg('canvas_cooldown', 300));
}

function canvas_version(): int
{
    return (int) (q_one('SELECT COALESCE(MAX(id), 0) AS v FROM canvas_log WHERE epoch = ?', [canvas_epoch()])['v'] ?? 0);
}

/** Сколько секунд ещё ждать этому пользователю (0 — можно ставить). */
function canvas_wait(array $me): int
{
    if ($me['role'] === 'admin') return 0;
    $last = q_one('SELECT created_at FROM canvas_log WHERE user_id = ? ORDER BY id DESC LIMIT 1', [$me['id']]);
    if (!$last) return 0;
    $since = time() - (int) strtotime($last['created_at'] . ' UTC');
    return max(0, canvas_cooldown() - $since);
}

/** GET canvas → { w, h, palette, data (W·H символов 0-f по строкам), version, wait, cooldown } */
function route_canvas(): array
{
    $me = current_user();
    session_release();
    // версия — до чтения сетки: пиксель, поставленный между запросами, придёт клиенту в следующем canvas/changes
    $version = canvas_version();
    $grid = array_fill(0, CANVAS_W * CANVAS_H, dechex(CANVAS_BG));
    foreach (q_all('SELECT x, y, color FROM canvas_pixels') as $p) {
        $grid[(int) $p['y'] * CANVAS_W + (int) $p['x']] = dechex((int) $p['color']);
    }
    return [
        'w' => CANVAS_W, 'h' => CANVAS_H, 'palette' => CANVAS_PALETTE, 'data' => implode('', $grid),
        'version' => $version, 'epoch' => canvas_epoch(), 'wait' => $me ? canvas_wait($me) : null, 'cooldown' => canvas_cooldown(),
    ];
}

/** Номер «эпохи» — меняется при очистке холста, чтобы открытые страницы перезагрузили его целиком. */
function canvas_epoch(): int
{
    return (int) setting_get('canvas_epoch', 0);
}

/**
 * GET canvas/changes&after=<version>&epoch=<epoch> → { version, changes: [[x, y, c], …] }
 * или { reset: true }, если холст очистили или клиент сильно отстал.
 */
function route_canvas_changes(): array
{
    session_release();
    $after = max(0, (int) query_str('after'));
    if (query_str('epoch') !== '' && (int) query_str('epoch') !== canvas_epoch()) return ['reset' => true];
    $rows = q_all('SELECT id, x, y, color FROM canvas_log WHERE epoch = ? AND id > ? ORDER BY id ASC LIMIT 2001', [canvas_epoch(), $after]);
    if (count($rows) > 2000) return ['reset' => true];
    $last = $rows ? (int) end($rows)['id'] : $after;
    return ['version' => $last, 'changes' => array_map(static fn($r) => [(int) $r['x'], (int) $r['y'], (int) $r['color']], $rows)];
}

/** GET canvas/log&after=<id>&limit=<n ≤ 5000> → { items: [[id, x, y, c]], more } — для таймлапса. */
function route_canvas_log(): array
{
    session_release();
    $after = max(0, (int) query_str('after'));
    $limit = min(5000, max(1, (int) (query_str('limit') ?: 5000)));
    $rows = q_all('SELECT id, x, y, color FROM canvas_log WHERE epoch = ? AND id > ? ORDER BY id ASC LIMIT ' . ($limit + 1), [canvas_epoch(), $after]);
    $more = count($rows) > $limit;
    if ($more) array_pop($rows);
    return ['items' => array_map(static fn($r) => [(int) $r['id'], (int) $r['x'], (int) $r['y'], (int) $r['color']], $rows), 'more' => $more];
}

/** POST canvas/place { x, y, c } → { version, wait } */
function route_canvas_place(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $x = $b['x'] ?? null;
    $y = $b['y'] ?? null;
    $c = $b['c'] ?? null;
    if (!is_int($x) || !is_int($y) || !is_int($c) || $x < 0 || $y < 0 || $x >= CANVAS_W || $y >= CANVAS_H || $c < 0 || $c >= count(CANVAS_PALETTE)) {
        throw new ApiError('validation', 'Неверная клетка или цвет');
    }
    q("INSERT IGNORE INTO settings (k, v, updated_at) VALUES ('canvas_lock', '0', ?)", [now_db()]);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        // постановки идут строго по очереди: id в журнале коммитятся по порядку, и опрос canvas/changes
        // никогда не «перепрыгнет» пиксель, который ещё не закоммичен (это же защищает кулдаун от двойного клика)
        q("SELECT k FROM settings WHERE k = 'canvas_lock' FOR UPDATE");
        $wait = canvas_wait($me);
        if ($wait > 0) {
            throw new ApiError('rate_limited', "Следующий пиксель — через " . pixel_wait_text($wait), ['wait' => (string) $wait]);
        }
        $t = now_db();
        q('INSERT INTO canvas_pixels (x, y, color, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color), updated_at = VALUES(updated_at)', [$x, $y, $c, $t]);
        q('INSERT INTO canvas_log (x, y, color, user_id, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)', [$x, $y, $c, $me['id'], canvas_epoch(), $t]);
        $version = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    return ['version' => $version, 'wait' => $me['role'] === 'admin' ? 0 : canvas_cooldown()];
}

function pixel_wait_text(int $s): string
{
    return $s >= 60 ? intdiv($s, 60) . ' мин ' . ($s % 60) . ' с' : "$s с";
}

/** POST canvas/clear (админ) — чистый холст и новый таймлапс (журнал остаётся: на нём держатся значки). */
function route_canvas_clear(): ?array
{
    require_admin();
    session_release();
    q('DELETE FROM canvas_pixels');
    setting_set('canvas_epoch', canvas_epoch() + 1);
    return null;
}

<?php
// Minecraft: ник в профиле, голова скина как аватарка (mc-heads.net), заявки в вайтлист серверов.
declare(strict_types=1);
defined('NDZE') || exit;

const MC_NICK_RE = '/^[A-Za-z0-9_]{3,16}$/';
const WL_SERVERS = ['penta' => 'Penta SMP'];
const WL_STATUSES = ['pending', 'approved', 'rejected'];

function mc_head_url(string $nick, int $size = 64): string
{
    return 'https://mc-heads.net/avatar/' . rawurlencode($nick) . '/' . $size;
}

function minecraft_of(string $userId): ?array
{
    $r = q_one('SELECT nick FROM user_minecraft WHERE user_id = ?', [$userId]);
    return $r ? ['nick' => $r['nick'], 'headUrl' => mc_head_url($r['nick'])] : null;
}

function whitelist_view(array $r): array
{
    return [
        'id' => $r['id'], 'server' => $r['server'], 'serverName' => WL_SERVERS[$r['server']] ?? $r['server'],
        'nick' => $r['nick'], 'status' => $r['status'], 'adminNote' => $r['admin_note'],
        'createdAt' => iso($r['created_at']), 'updatedAt' => iso($r['updated_at']),
    ];
}

function whitelist_of(string $userId): array
{
    return array_map('whitelist_view', q_all('SELECT * FROM whitelist_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [$userId]));
}

/** POST me/minecraft { nick: string | null } → { minecraft } */
function route_minecraft_set(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $nick = $b['nick'] ?? null;
    if ($nick === null || $nick === '') {
        q('DELETE FROM user_minecraft WHERE user_id = ?', [$me['id']]);
        return ['minecraft' => null];
    }
    $nick = clean_str($nick);
    if (!preg_match(MC_NICK_RE, $nick)) throw new ApiError('validation', 'Ник Minecraft: 3–16 символов, латиница, цифры и _', ['nick' => 'Ник Minecraft: 3–16 символов, латиница, цифры и _']);
    $taken = new ApiError('validation', 'Этот ник уже привязан к другому аккаунту', ['nick' => 'Этот ник уже привязан к другому аккаунту']);
    $owner = q_one('SELECT user_id FROM user_minecraft WHERE nick_key = ?', [strtolower($nick)]);
    if ($owner && $owner['user_id'] !== $me['id']) throw $taken;
    rate_limit_hit('minecraft', user_subject($me['id']));
    // не INSERT … ON DUPLICATE KEY: он сработал бы и на уникальном нике и перезаписал чужую строку
    try {
        $upd = q('UPDATE user_minecraft SET nick = ?, nick_key = ?, updated_at = ? WHERE user_id = ?', [$nick, strtolower($nick), now_db(), $me['id']]);
        if ($upd->rowCount() === 0 && !q_one('SELECT 1 AS x FROM user_minecraft WHERE user_id = ?', [$me['id']])) {
            q('INSERT INTO user_minecraft (user_id, nick, nick_key, updated_at) VALUES (?, ?, ?, ?)', [$me['id'], $nick, strtolower($nick), now_db()]);
        }
    } catch (PDOException $e) {
        if (!is_duplicate_key($e)) throw $e;
        throw $taken; // гонка: ник заняли одновременно
    }
    return ['minecraft' => minecraft_of($me['id'])];
}

/** POST me/avatar/minecraft → User (аватарка = голова скина). */
function route_avatar_minecraft(): array
{
    $me = require_user();
    session_release();
    $mc = minecraft_of($me['id']);
    if (!$mc) throw new ApiError('validation', 'Сначала укажи ник Minecraft');
    if (!function_exists('imagecreatefromstring')) throw new ApiError('unknown', 'На сервере нет обработки картинок (GD)');
    rate_limit_hit('avatar', user_subject($me['id']));
    $r = http_request('GET', mc_head_url($mc['nick'], 256), [], null, 8);
    $src = $r['status'] === 200 && strlen($r['body']) < LIM_FILE_BYTES ? @imagecreatefromstring($r['body']) : false;
    if (!$src) throw new ApiError('unknown', 'Не удалось скачать скин — попробуй позже');
    // голова пиксельная: увеличиваем без сглаживания
    $w = imagesx($src);
    $dst = imagecreatetruecolor(AVATAR_SIZE, AVATAR_SIZE);
    imagecopyresized($dst, $src, 0, 0, 0, 0, AVATAR_SIZE, AVATAR_SIZE, $w, imagesy($src));
    imagedestroy($src);
    $file = avatar_from_gd($dst);
    imagedestroy($dst);
    avatar_set($me['id'], $file, 'mc'); // avatar_source — VARCHAR(8)
    return public_user(current_user(true));
}

/** POST whitelist/request { server } → { whitelist } */
function route_whitelist_request(): array
{
    $me = require_user();
    session_release();
    $server = (string) (request_body()['server'] ?? 'penta');
    if (!isset(WL_SERVERS[$server])) throw new ApiError('validation', 'Неизвестный сервер');
    $mc = minecraft_of($me['id']);
    if (!$mc) throw new ApiError('validation', 'Сначала укажи ник Minecraft в кабинете');
    if (q_one("SELECT id FROM whitelist_requests WHERE user_id = ? AND server = ? AND status IN ('pending', 'approved')", [$me['id'], $server])) {
        throw new ApiError('validation', 'Заявка уже есть — дождись ответа');
    }
    rate_limit_hit('whitelist', user_subject($me['id']));
    $t = now_db();
    q('INSERT INTO whitelist_requests (id, user_id, server, nick, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        [uuid4(), $me['id'], $server, $mc['nick'], 'pending', $t, $t]);
    return ['whitelist' => whitelist_of($me['id'])];
}

/** GET whitelist (админ) → заявки: сначала ожидающие. */
function route_whitelist_list(): array
{
    require_admin();
    session_release();
    $rows = q_all("SELECT w.*, u.nick AS user_nick, p.avatar_file FROM whitelist_requests w JOIN users u ON u.id = w.user_id
                   LEFT JOIN user_profiles p ON p.user_id = w.user_id
                   ORDER BY FIELD(w.status, 'pending', 'approved', 'rejected'), w.created_at DESC LIMIT 100");
    return array_map(static fn($r) => whitelist_view($r) + [
        'user' => ['id' => $r['user_id'], 'nick' => $r['user_nick'], 'avatarUrl' => avatar_url($r['user_id'], $r['avatar_file'] ?? null)],
    ], $rows);
}

/** POST whitelist/update { id, status: approved | rejected, note? } (админ) */
function route_whitelist_update(): array
{
    require_admin();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    $status = (string) ($b['status'] ?? '');
    if (!in_array($status, ['approved', 'rejected', 'pending'], true)) throw new ApiError('validation', 'Неизвестный статус');
    $note = clean_str($b['note'] ?? '');
    if (str_len($note) > 300) throw new ApiError('validation', 'Комментарий — до 300 символов');
    $row = $id ? q_one('SELECT * FROM whitelist_requests WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Заявка не найдена');
    q('UPDATE whitelist_requests SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [$status, $note === '' ? null : $note, now_db(), $id]);
    if ($status !== $row['status'] && $status !== 'pending') {
        $server = WL_SERVERS[$row['server']] ?? $row['server'];
        notify($row['user_id'], 'whitelist', $status === 'approved' ? "Заявка в вайтлист $server одобрена — заходи! ⛏" : "Заявка в вайтлист $server отклонена" . ($note !== '' ? ": $note" : ''), 'profile.html#settings');
    }
    return whitelist_view(q_one('SELECT * FROM whitelist_requests WHERE id = ?', [$id]));
}

/* ---------- Мини-игра на странице 404 ---------- */
// Очки честно не проверить, но грубо отсекаем подделку: сервер помнит старт забега в сессии,
// а набрать больше GAME_RATE очков в секунду в игре нельзя.
const GAME_RATE = 80;

/** GET game/start → { startedAt } (нужен вход, иначе играй без рекордов) */
function route_game_start(): array
{
    require_user();
    $_SESSION['game_start'] = microtime(true);
    session_release();
    return ['startedAt' => iso(now_db())];
}

/** POST game/score { score } → { score, best, rank } */
function route_game_score(): array
{
    $me = require_user();
    $start = $_SESSION['game_start'] ?? null;
    unset($_SESSION['game_start']); // один результат на забег
    session_release();
    $score = request_body()['score'] ?? null;
    if (!is_int($score) || $score < 0 || $score > 10000000) throw new ApiError('validation', 'Неверный счёт');
    if (!is_float($start) && !is_int($start)) throw new ApiError('validation', 'Забег не начат — обнови страницу');
    $elapsed = microtime(true) - (float) $start;
    if ($score > $elapsed * GAME_RATE + 50) throw new ApiError('validation', 'Слишком быстро для честного забега 🕷');
    rate_limit_hit('game', user_subject($me['id']));
    q('INSERT INTO game_scores (user_id, score, created_at) VALUES (?, ?, ?)', [$me['id'], $score, now_db()]);
    $best = (int) q_one('SELECT MAX(score) AS b FROM game_scores WHERE user_id = ?', [$me['id']])['b'];
    $rank = 1 + (int) q_one('SELECT COUNT(*) AS n FROM (SELECT user_id, MAX(score) AS b FROM game_scores GROUP BY user_id) t WHERE t.b > ?', [$best])['n'];
    return ['score' => $score, 'best' => $best, 'rank' => $rank];
}

/** GET game/top → { all: топ-10 (лучший результат игрока), week: топ-5 за 7 дней } */
function route_game_top(): array
{
    session_release();
    $q = static fn(string $where, array $p, int $n) => array_map(static fn($r) => [
        'user' => ['id' => $r['user_id'], 'nick' => $r['nick'], 'avatarUrl' => avatar_url($r['user_id'], $r['avatar_file'] ?? null)],
        'score' => (int) $r['best'],
    ], q_all("SELECT g.user_id, MAX(g.score) AS best, u.nick, p.avatar_file FROM game_scores g JOIN users u ON u.id = g.user_id
              LEFT JOIN user_profiles p ON p.user_id = g.user_id $where GROUP BY g.user_id, u.nick, p.avatar_file ORDER BY best DESC LIMIT $n", $p));
    return [
        'all' => $q('', [], 10),
        'week' => $q('WHERE g.created_at >= ?', [gmdate('Y-m-d H:i:s', time() - 7 * 86400)], 5),
    ];
}

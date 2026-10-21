<?php
// Сообщество: клипы недели (Twitch), публичные профили, квест «Найди 5 пауков», карта Penta и постройки.
declare(strict_types=1);
defined('NDZE') || exit;

const CM_CLIP_SLUG_RE = '/^[A-Za-z0-9_-]{3,100}$/';
const CM_CLIP_TITLE_MAX = 120;
const CM_QUEST_EGGS = ['home', 'projects', 'forum', 'review', '404']; // id страниц из mountLayout(pageId)
const CM_QUEST_REWARD = 300;
const CM_BUILD_TITLE_MAX = 80;
const CM_BUILD_COORDS_MAX = 40;
const CM_BUILD_DESC_MAX = 500;
const CM_BUILD_STATUSES = ['visible', 'hidden'];
const CM_MAP_URL_MAX = 300;
const CM_TEAMS = ['lime' => 'Лаймовые', 'red' => 'Красные'];

rate_limit_define('clip', 5, 86400);        // новые клипы: 5 / сутки
rate_limit_define('build', 5, 86400);       // новые постройки: 5 / сутки
rate_limit_define('cm_vote', 300, 3600);    // голоса за клипы и постройки: 300 / час
rate_limit_define('quest_find', 30, 3600);  // попытки «поймать паука»: 30 / час

route_add([
    'GET clips' => 'route_cm_clips',
    'GET clips/week' => 'route_cm_clip_week',
    'POST clip' => 'route_cm_clip_create',
    'POST clip/vote' => 'route_cm_clip_vote',
    'POST clip/delete' => 'route_cm_clip_delete',
    'GET user' => 'route_cm_user',
    'GET quest' => 'route_cm_quest',
    'POST quest/find' => 'route_cm_quest_find',
    'GET quest/stats' => 'route_cm_quest_stats',
    'GET builds' => 'route_cm_builds',
    'POST build' => 'route_cm_build_create',
    'GET build/image' => 'route_cm_build_image',
    'POST build/vote' => 'route_cm_build_vote',
    'POST build/moderate' => 'route_cm_build_moderate',
    'POST build/delete' => 'route_cm_build_delete',
    'POST penta/map' => 'route_cm_map_set',
]);
route_raw('build/image');

/* ---------- Метрики, значки, опыт ---------- */

/** WHERE для метрики: пользователь + «с даты» + доп. условия. */
function cm_metric_where(string $uid, string $at, ?string $userId, ?string $since, array $extra = []): array
{
    $parts = $extra;
    $p = [];
    if ($userId !== null) { $parts[] = "$uid = ?"; $p[] = $userId; }
    if ($since !== null) { $parts[] = "$at >= ?"; $p[] = $since; }
    return [$parts ? ' WHERE ' . implode(' AND ', $parts) : '', $p];
}

metric_add('questSpiders', static function (?string $userId, ?string $since): array {
    [$w, $p] = cm_metric_where('user_id', 'created_at', $userId, $since, ['egg IN (' . placeholders(count(CM_QUEST_EGGS)) . ')']);
    $out = [];
    foreach (q_all("SELECT user_id, COUNT(*) AS n FROM quest_finds$w GROUP BY user_id", array_merge(CM_QUEST_EGGS, $p)) as $r) $out[$r['user_id']] = (int) $r['n'];
    return $out;
});
metric_add('builds', static function (?string $userId, ?string $since): array {
    [$w, $p] = cm_metric_where('user_id', 'created_at', $userId, $since, ["status = 'visible'"]);
    $out = [];
    foreach (q_all("SELECT user_id, COUNT(*) AS n FROM builds$w GROUP BY user_id", $p) as $r) $out[$r['user_id']] = (int) $r['n'];
    return $out;
});
badge_add('spider_sense', ['Паучье чутьё', 'Найти всех 5 пауков, спрятанных на сайте', '🕷', 'questSpiders', count(CM_QUEST_EGGS)]);
badge_add('architect', ['Архитектор', 'Показать 3 постройки с сервера Penta', '🏰', 'builds', 3]);
xp_add('questSpiders', 20, 100);
xp_add('builds', 15, 150);

/* ---------- Общее ---------- */

const CM_AUTHOR_COLS = 'u.nick AS a_nick, ap.avatar_file AS a_avatar';

function cm_author(array $r): array
{
    return ['id' => $r['user_id'], 'nick' => $r['a_nick'], 'avatarUrl' => avatar_url($r['user_id'], $r['a_avatar'] ?? null)];
}

/** Мои голоса из таблицы $table (clip_votes / build_votes) по списку id → [id => true]. */
function cm_my_votes(string $table, string $col, array $ids, ?array $me): array
{
    if (!$me || !$ids) return [];
    $mine = [];
    foreach (q_all("SELECT $col AS id FROM $table WHERE user_id = ? AND $col IN (" . placeholders(count($ids)) . ')', array_merge([$me['id']], $ids)) as $r) {
        $mine[$r['id']] = true;
    }
    return $mine;
}

/** Переключить голос: был — снять, не было — поставить. Возвращает [votes, myVote]. */
function cm_toggle_vote(string $table, string $col, string $id, string $userId): array
{
    $del = q("DELETE FROM $table WHERE $col = ? AND user_id = ?", [$id, $userId]);
    $mine = false;
    if ($del->rowCount() === 0) {
        q("INSERT IGNORE INTO $table ($col, user_id, created_at) VALUES (?, ?, ?)", [$id, $userId, now_db()]);
        $mine = true;
    }
    return [(int) q_one("SELECT COUNT(*) AS n FROM $table WHERE $col = ?", [$id])['n'], $mine];
}

function cm_is_admin(?array $me): bool
{
    return $me !== null && ($me['role'] ?? '') === 'admin';
}

/* ================= Клипы недели ================= */

/**
 * Ссылка на клип Twitch → slug или null.
 * Принимаем только https://clips.twitch.tv/<slug> и https://www.twitch.tv/<канал>/clip/<slug> (query/fragment игнорируем).
 */
function cm_clip_slug(string $url): ?string
{
    if (str_len($url) > 300 || preg_match('/[\s<>"\']/', $url)) return null;
    $p = parse_url($url);
    if (!is_array($p) || strtolower($p['scheme'] ?? '') !== 'https' || isset($p['user']) || isset($p['pass']) || isset($p['port'])) return null;
    $host = strtolower($p['host'] ?? '');
    $path = rtrim((string) ($p['path'] ?? ''), '/');
    $slug = null;
    if ($host === 'clips.twitch.tv' && preg_match('#^/([A-Za-z0-9_-]+)$#', $path, $m)) {
        $slug = $m[1];
        if (strtolower($slug) === 'embed') return null;
    } elseif (in_array($host, ['www.twitch.tv', 'twitch.tv'], true) && preg_match('#^/([A-Za-z0-9_]{3,25})/clip/([A-Za-z0-9_-]+)$#', $path, $m)) {
        // клипы только с канала ndze — чужие на главную не попадут
        if (strtolower($m[1]) !== strtolower(twitch_channel())) return null;
        $slug = $m[2];
    }
    return $slug !== null && preg_match(CM_CLIP_SLUG_RE, $slug) ? $slug : null;
}

const CM_CLIP_SELECT = 'SELECT c.*, ' . CM_AUTHOR_COLS . ', (SELECT COUNT(*) FROM clip_votes v WHERE v.clip_id = c.id) AS votes
  FROM clips c JOIN users u ON u.id = c.user_id LEFT JOIN user_profiles ap ON ap.user_id = c.user_id';

function cm_clips_view(array $rows, ?array $me): array
{
    $mine = cm_my_votes('clip_votes', 'clip_id', array_column($rows, 'id'), $me);
    $admin = cm_is_admin($me);
    return array_map(static fn($c) => [
        'id' => $c['id'], 'slug' => $c['slug'], 'title' => $c['title'],
        'url' => 'https://clips.twitch.tv/' . $c['slug'],
        'author' => cm_author($c),
        'votes' => (int) $c['votes'], 'myVote' => isset($mine[$c['id']]),
        'canDelete' => $me !== null && ($admin || $me['id'] === $c['user_id']),
        'createdAt' => iso($c['created_at']),
    ], $rows);
}

function cm_week_since(): string
{
    return gmdate('Y-m-d H:i:s', time() - 7 * 86400);
}

function cm_clip_find(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM clips WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Клип не найден');
    return $row;
}

/** GET clips&period=week|all&sort=top|new → { items, top (лучший клип недели | null), period, sort } */
function route_cm_clips(): array
{
    $me = current_user();
    session_release();
    $period = query_str('period') === 'all' ? 'all' : 'week';
    $sort = query_str('sort') === 'new' ? 'new' : 'top';
    $order = $sort === 'new' ? 'c.created_at DESC' : 'votes DESC, c.created_at DESC';
    $rows = $period === 'week'
        ? q_all(CM_CLIP_SELECT . " WHERE c.created_at >= ? ORDER BY $order LIMIT 60", [cm_week_since()])
        : q_all(CM_CLIP_SELECT . " ORDER BY $order LIMIT 60");
    $top = q_all(CM_CLIP_SELECT . ' WHERE c.created_at >= ? ORDER BY votes DESC, c.created_at DESC LIMIT 1', [cm_week_since()]);
    return ['items' => cm_clips_view($rows, $me), 'top' => cm_clips_view($top, $me)[0] ?? null, 'period' => $period, 'sort' => $sort];
}

/** GET clips/week → { clip, fallback } — клип недели для главной; за неделю пусто — лучший за всё время (fallback: true). */
function route_cm_clip_week(): array
{
    $me = current_user();
    session_release();
    $rows = q_all(CM_CLIP_SELECT . ' WHERE c.created_at >= ? ORDER BY votes DESC, c.created_at DESC LIMIT 1', [cm_week_since()]);
    $fallback = false;
    if (!$rows) {
        $rows = q_all(CM_CLIP_SELECT . ' ORDER BY votes DESC, c.created_at DESC LIMIT 1');
        $fallback = (bool) $rows;
    }
    return ['clip' => cm_clips_view($rows, $me)[0] ?? null, 'fallback' => $fallback];
}

/** POST clip { url, title } → Clip */
function route_cm_clip_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $url = clean_str($b['url'] ?? null);
    $title = clean_str($b['title'] ?? null);
    $slug = cm_clip_slug($url);
    $e = [];
    if ($slug === null) $e['url'] = 'Нужна ссылка на клип Twitch: https://clips.twitch.tv/… или https://www.twitch.tv/канал/clip/…';
    if (str_len($title) < 3 || str_len($title) > CM_CLIP_TITLE_MAX) $e['title'] = 'Название от 3 до ' . CM_CLIP_TITLE_MAX . ' символов';
    assert_valid($e);
    if (q_one('SELECT id FROM clips WHERE slug = ?', [$slug])) throw new ApiError('validation', 'Этот клип уже предложили', ['url' => 'Этот клип уже предложили']);
    rate_limit_hit('clip', user_subject($me['id']));
    $id = uuid4();
    try {
        q('INSERT INTO clips (id, user_id, slug, title, created_at) VALUES (?, ?, ?, ?, ?)', [$id, $me['id'], $slug, $title, now_db()]);
    } catch (PDOException $ex) {
        if (!is_duplicate_key($ex)) throw $ex;
        throw new ApiError('validation', 'Этот клип уже предложили', ['url' => 'Этот клип уже предложили']);
    }
    return cm_clips_view(q_all(CM_CLIP_SELECT . ' WHERE c.id = ?', [$id]), $me)[0];
}

/** POST clip/vote { id } → { votes, myVote } */
function route_cm_clip_vote(): array
{
    $me = require_user();
    session_release();
    $c = cm_clip_find(norm_uuid(request_body()['id'] ?? null));
    if ($c['user_id'] === $me['id']) throw new ApiError('validation', 'За свой клип голосовать нельзя');
    rate_limit_hit('cm_vote', user_subject($me['id']));
    [$votes, $mine] = cm_toggle_vote('clip_votes', 'clip_id', $c['id'], $me['id']);
    return ['votes' => $votes, 'myVote' => $mine];
}

/** POST clip/delete { id } — автор или админ. */
function route_cm_clip_delete(): ?array
{
    $me = require_user();
    session_release();
    $c = cm_clip_find(norm_uuid(request_body()['id'] ?? null));
    if (!cm_is_admin($me) && $c['user_id'] !== $me['id']) throw new ApiError('forbidden');
    q('DELETE FROM clips WHERE id = ?', [$c['id']]); // голоса — ON DELETE CASCADE
    return null;
}

/* ================= Публичный профиль ================= */

/** Первая картинка последней версии работы → URL или null. */
function cm_cover_sql(): string
{
    return '(SELECT i.id FROM submission_images i JOIN submission_versions sv ON sv.id = i.version_id
        WHERE i.submission_id = s.id ORDER BY sv.n DESC, i.position ASC LIMIT 1)';
}

/**
 * GET user&nick=<ник> → только публичные данные (без email, Discord и закрытых работ):
 * { user: {id,nick,avatarUrl,frame,role,createdAt}, progress: {level,title,xp,levelXp,nextLevelXp,badges(только полученные)},
 *   stats: {submissions,ideal,tasks,tasksDone,forumPosts,builds,clips}, gallery: [{id,title,imageUrl}],
 *   threads: [{id,title,section,replies,createdAt}], team: {id,label,season}|null, minecraft: {nick,headUrl}|null,
 *   quest: {found,total}, isMe }
 */
function route_cm_user(): array
{
    $me = current_user();
    session_release();
    $nick = clean_str(query_str('nick'));
    if (!preg_match(LIM_NICK_RE, $nick)) throw new ApiError('not_found', 'Такого пользователя нет');
    $u = q_one(USER_SELECT . ' WHERE u.nick_key = ?', [nick_key($nick)]);
    if (!$u) throw new ApiError('not_found', 'Такого пользователя нет');
    $uid = $u['id'];

    $pv = user_progress($uid);
    $badges = [];
    foreach ($pv['badges'] as $bd) {
        if ($bd['earned']) $badges[] = ['id' => $bd['id'], 'title' => $bd['title'], 'description' => $bd['description'], 'icon' => $bd['icon']];
    }
    $s = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'ideal'), 0) AS ideal FROM submissions WHERE user_id = ?", [$uid]);
    $t = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'done'), 0) AS done FROM tasks WHERE user_id = ?", [$uid]);
    $f = (int) q_one('SELECT (SELECT COUNT(*) FROM forum_threads WHERE user_id = ?) + (SELECT COUNT(*) FROM forum_posts WHERE user_id = ?) AS n', [$uid, $uid])['n'];
    $bl = (int) q_one("SELECT COUNT(*) AS n FROM builds WHERE user_id = ? AND status = 'visible'", [$uid])['n'];
    $cl = (int) q_one('SELECT COUNT(*) AS n FROM clips WHERE user_id = ?', [$uid])['n'];

    $gallery = array_map(static fn($r) => [
        'id' => $r['id'], 'title' => $r['title'], 'imageUrl' => $r['img'] ? image_url($r['img']) : null,
    ], q_all('SELECT s.id, s.title, ' . cm_cover_sql() . " AS img FROM submissions s
        WHERE s.user_id = ? AND s.status = 'ideal' ORDER BY s.updated_at DESC, s.id DESC LIMIT 24", [$uid]));

    $threads = array_map(static fn($r) => [
        'id' => $r['id'], 'title' => $r['title'], 'section' => $r['section'],
        'sectionLabel' => FORUM_SECTIONS[$r['section']][0] ?? $r['section'],
        'replies' => (int) $r['replies'], 'createdAt' => iso($r['created_at']),
    ], q_all('SELECT id, title, section, replies, created_at FROM forum_threads WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [$uid]));

    $season = season_id();
    $team = q_one('SELECT team FROM user_teams WHERE user_id = ? AND season = ?', [$uid, $season]);
    $quest = (int) q_one('SELECT COUNT(*) AS n FROM quest_finds WHERE user_id = ? AND egg IN (' . placeholders(count(CM_QUEST_EGGS)) . ')',
        array_merge([$uid], CM_QUEST_EGGS))['n'];
    $frame = is_string($u['frame'] ?? null) && preg_match('/^[a-z0-9_-]{1,16}$/', $u['frame']) ? $u['frame'] : null;

    return [
        'user' => [
            'id' => $uid, 'nick' => $u['nick'], 'avatarUrl' => avatar_url($uid, $u['avatar_file'] ?? null), 'frame' => $frame,
            'role' => is_admin_row($u['email'], $u['discord_id']) ? 'admin' : 'user', 'createdAt' => iso($u['created_at']),
        ],
        'progress' => [
            'level' => $pv['level'], 'title' => $pv['title'], 'xp' => $pv['xp'],
            'levelXp' => $pv['levelXp'], 'nextLevelXp' => $pv['nextLevelXp'],
            'badges' => $badges, 'badgesTotal' => count($pv['badges']),
        ],
        'stats' => [
            'submissions' => (int) $s['n'], 'ideal' => (int) $s['ideal'], 'tasks' => (int) $t['n'], 'tasksDone' => (int) $t['done'],
            'forumPosts' => $f, 'builds' => $bl, 'clips' => $cl,
        ],
        'gallery' => $gallery,
        'threads' => $threads,
        'team' => $team && isset(CM_TEAMS[$team['team']]) ? ['id' => $team['team'], 'label' => CM_TEAMS[$team['team']], 'season' => $season] : null,
        'minecraft' => minecraft_of($uid),
        'quest' => ['found' => $quest, 'total' => count(CM_QUEST_EGGS)],
        'isMe' => $me !== null && $me['id'] === $uid,
    ];
}

/* ================= Квест «Найди 5 пауков» ================= */

function cm_quest_found(string $userId): array
{
    $found = array_column(q_all('SELECT egg FROM quest_finds WHERE user_id = ? ORDER BY created_at ASC', [$userId]), 'egg');
    return array_values(array_intersect($found, CM_QUEST_EGGS));
}

/** GET quest → { found: string[], total, done } (нужен вход) */
function route_cm_quest(): array
{
    $me = require_user();
    session_release();
    $found = cm_quest_found($me['id']);
    return ['found' => $found, 'total' => count(CM_QUEST_EGGS), 'done' => count($found) >= count(CM_QUEST_EGGS)];
}

/** POST quest/find { egg } → { found, count, total, isNew, done, reward } — за всех пятерых один раз +300 баллов. */
function route_cm_quest_find(): array
{
    $me = require_user();
    session_release();
    $egg = request_body()['egg'] ?? null;
    if (!is_string($egg) || !in_array($egg, CM_QUEST_EGGS, true)) throw new ApiError('validation', 'Такого паука нет');
    rate_limit_hit('quest_find', user_subject($me['id']));
    $total = count(CM_QUEST_EGGS);
    $reward = 0;
    $pdo = db();
    $pdo->beginTransaction();
    try {
        q('SELECT id FROM users WHERE id = ? FOR UPDATE', [$me['id']]); // награда — ровно один раз, даже при параллельных кликах
        $isNew = q('INSERT IGNORE INTO quest_finds (user_id, egg, created_at) VALUES (?, ?, ?)', [$me['id'], $egg, now_db()])->rowCount() > 0;
        $found = cm_quest_found($me['id']);
        $done = count($found) >= $total;
        if ($done && !q_one("SELECT 1 AS x FROM points_ledger WHERE user_id = ? AND reason = 'quest' AND ref = 'spiders' LIMIT 1", [$me['id']])) {
            points_add($me['id'], CM_QUEST_REWARD, 'quest', 'spiders');
            $reward = CM_QUEST_REWARD;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    if ($reward) {
        notify($me['id'], 'quest', "Все $total пауков пойманы! +$reward баллов и значок «Паучье чутьё» 🕷", 'profile.html#badges');
        event_emit('quest.done', ['userId' => $me['id'], 'nick' => $me['nick']]);
    }
    return ['found' => $found, 'count' => count($found), 'total' => $total, 'isNew' => $isNew, 'done' => $done, 'reward' => $reward];
}

/** GET quest/stats (админ) → { eggs: [{egg, finds}], completed, recent: [{nick, at}] } */
function route_cm_quest_stats(): array
{
    require_admin();
    session_release();
    $counts = [];
    foreach (q_all('SELECT egg, COUNT(*) AS n FROM quest_finds GROUP BY egg') as $r) $counts[$r['egg']] = (int) $r['n'];
    $in = placeholders(count(CM_QUEST_EGGS));
    $done = q_all("SELECT f.user_id, u.nick, MAX(f.created_at) AS at FROM quest_finds f JOIN users u ON u.id = f.user_id
        WHERE f.egg IN ($in) GROUP BY f.user_id, u.nick HAVING COUNT(*) >= ? ORDER BY at DESC", array_merge(CM_QUEST_EGGS, [count(CM_QUEST_EGGS)]));
    return [
        'eggs' => array_map(static fn($e) => ['egg' => $e, 'finds' => $counts[$e] ?? 0], CM_QUEST_EGGS),
        'hunters' => (int) q_one('SELECT COUNT(DISTINCT user_id) AS n FROM quest_finds')['n'],
        'completed' => count($done),
        'recent' => array_map(static fn($r) => ['nick' => $r['nick'], 'at' => iso($r['at'])], array_slice($done, 0, 10)),
    ];
}

/* ================= Карта Penta и постройки ================= */

function cm_map_url(): string
{
    $u = setting_get('penta_map_url');
    return is_string($u) && cm_map_url_ok($u) ? $u : '';
}

function cm_map_url_ok(string $u): bool
{
    if ($u === '' || str_len($u) > CM_MAP_URL_MAX || preg_match('/[\s<>"\'`\\\\]/', $u)) return false;
    if (filter_var($u, FILTER_VALIDATE_URL) === false) return false;
    $p = parse_url($u);
    return is_array($p) && strtolower($p['scheme'] ?? '') === 'https' && !isset($p['user']) && !isset($p['pass'])
        && preg_match('/^[a-z0-9.-]+$/i', (string) ($p['host'] ?? '')) === 1;
}

/** POST penta/map { url } (админ; пустая строка — убрать карту) → { mapUrl } */
function route_cm_map_set(): array
{
    require_admin();
    session_release();
    $url = clean_str(request_body()['url'] ?? null);
    if ($url !== '' && !cm_map_url_ok($url)) {
        throw new ApiError('validation', 'Нужна https-ссылка на BlueMap/Dynmap (до ' . CM_MAP_URL_MAX . ' символов)', ['url' => 'Нужна https-ссылка']);
    }
    setting_set('penta_map_url', $url);
    return ['mapUrl' => $url];
}

const CM_BUILD_SELECT = 'SELECT b.*, ' . CM_AUTHOR_COLS . ', (SELECT COUNT(*) FROM build_votes v WHERE v.build_id = b.id) AS votes
  FROM builds b JOIN users u ON u.id = b.user_id LEFT JOIN user_profiles ap ON ap.user_id = b.user_id';

function cm_build_image_url(string $id): string
{
    return 'api/index.php?r=build/image&id=' . $id;
}

function cm_builds_view(array $rows, ?array $me): array
{
    $mine = cm_my_votes('build_votes', 'build_id', array_column($rows, 'id'), $me);
    $admin = cm_is_admin($me);
    return array_map(static fn($b) => [
        'id' => $b['id'], 'title' => $b['title'], 'coords' => $b['coords'], 'description' => $b['description'],
        'imageUrl' => cm_build_image_url($b['id']), 'width' => (int) $b['width'], 'height' => (int) $b['height'],
        'status' => $b['status'], 'author' => cm_author($b),
        'votes' => (int) $b['votes'], 'myVote' => isset($mine[$b['id']]),
        'canDelete' => $me !== null && ($admin || $me['id'] === $b['user_id']),
        'createdAt' => iso($b['created_at']),
    ], $rows);
}

function cm_build_find(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM builds WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Постройка не найдена');
    return $row;
}

/** GET builds&sort=top|new&scope=admin → { items, mapUrl, sort } (scope=admin — со скрытыми, только админ) */
function route_cm_builds(): array
{
    $me = current_user();
    session_release();
    $sort = query_str('sort') === 'new' ? 'new' : 'top';
    $order = $sort === 'new' ? 'b.created_at DESC' : 'votes DESC, b.created_at DESC';
    if (query_str('scope') === 'admin') {
        if (!$me) throw new ApiError('auth_required');
        if (!cm_is_admin($me)) throw new ApiError('forbidden');
        $rows = q_all(CM_BUILD_SELECT . " ORDER BY b.created_at DESC LIMIT 200");
    } else {
        $rows = q_all(CM_BUILD_SELECT . " WHERE b.status = 'visible' ORDER BY $order LIMIT 120");
    }
    return ['items' => cm_builds_view($rows, $me), 'mapUrl' => cm_map_url(), 'sort' => $sort];
}

/** POST build (multipart: title, coords?, description?, files[] — одна картинка) → Build */
function route_cm_build_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $coords = clean_str($b['coords'] ?? null);
    $desc = clean_str($b['description'] ?? null);
    $e = [];
    if (str_len($title) < 3 || str_len($title) > CM_BUILD_TITLE_MAX) $e['title'] = 'Название от 3 до ' . CM_BUILD_TITLE_MAX . ' символов';
    if ($coords !== '' && (str_len($coords) > CM_BUILD_COORDS_MAX || !preg_match('/^[\p{L}\p{N}\s,.:;\/=+-]+$/u', $coords))) {
        $e['coords'] = 'Координаты — до ' . CM_BUILD_COORDS_MAX . ' символов, например «120 64 -340»';
    }
    if (str_len($desc) > CM_BUILD_DESC_MAX) $e['description'] = 'Не больше ' . CM_BUILD_DESC_MAX . ' символов';
    $files = uploaded_files();
    $checked = [];
    if (count($files) > 1) $e['files'] = 'Нужен один скриншот';
    else {
        [$err, $checked] = files_check($files);
        if ($err !== '') $e['files'] = $err;
    }
    assert_valid($e);
    rate_limit_hit('build', user_subject($me['id']));

    $stored = files_store($checked);
    $img = $stored[0];
    $id = uuid4();
    with_files_tx($stored, static function () use ($id, $me, $title, $coords, $desc, $img) {
        q('INSERT INTO builds (id, user_id, title, coords, description, file_name, mime, width, height, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $me['id'], $title, $coords === '' ? null : $coords, $desc === '' ? null : $desc, $img['file'], $img['mime'], $img['w'], $img['h'], 'visible', now_db()]);
    });
    return cm_builds_view(q_all(CM_BUILD_SELECT . ' WHERE b.id = ?', [$id]), $me)[0];
}

/** GET build/image&id= — картинка постройки (видимые — всем, скрытые — только админу). */
function route_cm_build_image(): void
{
    $id = norm_uuid(query_str('id'));
    $row = $id ? q_one('SELECT file_name, mime, status FROM builds WHERE id = ?', [$id]) : null;
    $me = $row && $row['status'] !== 'visible' ? current_user() : null;
    session_release();
    if (!$row || ($row['status'] !== 'visible' && !cm_is_admin($me))
        || !preg_match('/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/', $row['file_name'])
        || !in_array($row['mime'], ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
        throw new ApiError('not_found', 'Картинка не найдена');
    }
    $dir = storage_dir('uploads');
    $path = $dir === null ? '' : $dir . '/' . $row['file_name'];
    if ($path === '' || !is_file($path)) {
        error_log('[ndze] нет файла постройки ' . $row['file_name']);
        throw new ApiError('not_found', 'Картинка не найдена');
    }
    while (ob_get_level() > 0) @ob_end_clean();
    $etag = '"b-' . $id . '"'; // файл по id никогда не меняется
    header('Content-Type: ' . $row['mime']);
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, max-age=3600');
    header('Content-Security-Policy: default-src \'none\'; sandbox');
    header('Content-Disposition: inline; filename="' . $row['file_name'] . '"');
    header('ETag: ' . $etag);
    if (trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
        http_response_code(304);
        return;
    }
    header('Content-Length: ' . filesize($path));
    if (request_method() !== 'HEAD') readfile($path);
}

/** POST build/vote { id } → { votes, myVote } */
function route_cm_build_vote(): array
{
    $me = require_user();
    session_release();
    $b = cm_build_find(norm_uuid(request_body()['id'] ?? null));
    if ($b['status'] !== 'visible') throw new ApiError('not_found', 'Постройка не найдена');
    if ($b['user_id'] === $me['id']) throw new ApiError('validation', 'За свою постройку голосовать нельзя');
    rate_limit_hit('cm_vote', user_subject($me['id']));
    [$votes, $mine] = cm_toggle_vote('build_votes', 'build_id', $b['id'], $me['id']);
    return ['votes' => $votes, 'myVote' => $mine];
}

/** POST build/moderate { id, status: visible|hidden } (админ) → Build */
function route_cm_build_moderate(): array
{
    $me = require_admin();
    session_release();
    $body = request_body();
    $status = $body['status'] ?? null;
    if (!is_string($status) || !in_array($status, CM_BUILD_STATUSES, true)) throw new ApiError('validation', 'Неизвестный статус');
    $b = cm_build_find(norm_uuid($body['id'] ?? null));
    q('UPDATE builds SET status = ? WHERE id = ?', [$status, $b['id']]);
    if ($status === 'hidden' && $b['status'] !== 'hidden') {
        notify($b['user_id'], 'build', "Постройку «{$b['title']}» скрыли из галереи", 'play.html#builds');
    }
    return cm_builds_view(q_all(CM_BUILD_SELECT . ' WHERE b.id = ?', [$b['id']]), $me)[0];
}

/** POST build/delete { id } — автор или админ; файл картинки удаляется. */
function route_cm_build_delete(): ?array
{
    $me = require_user();
    session_release();
    $b = cm_build_find(norm_uuid(request_body()['id'] ?? null));
    if (!cm_is_admin($me) && $b['user_id'] !== $me['id']) throw new ApiError('forbidden');
    q('DELETE FROM builds WHERE id = ?', [$b['id']]); // голоса — ON DELETE CASCADE
    files_delete([$b['file_name']]);
    return null;
}

<?php
// Форум: разделы, темы, ответы, лайки, модерация. Новости и правила проектов пишет только админ,
// обсуждать (отвечать) может любой вошедший, если тема не закрыта. Текст — Markdown, рендер на клиенте.
declare(strict_types=1);
defined('NDZE') || exit;

const FORUM_SECTIONS = [
    'news' => ['Новости', true],
    'rules' => ['Правила проектов', true],
    'ideas' => ['Идеи и предложения', false],
    'help' => ['Вопросы и помощь', false],
    'talk' => ['Общение', false],
];
const FORUM_PROJECT_RE = '/^[a-z0-9-]{2,32}$/';
const FORUM_THREADS_PER_PAGE = 20;
const FORUM_POSTS_PER_PAGE = 30;
const FORUM_TITLE_MAX = 120;
const FORUM_THREAD_MAX = 10000;
const FORUM_POST_MAX = 5000;

const FORUM_AUTHOR_COLS = 'u.nick AS a_nick, u.email AS a_email, u.discord_id AS a_discord, ap.avatar_file AS a_avatar';

function forum_author(array $r, string $uidCol = 'user_id'): array
{
    return [
        'id' => $r[$uidCol], 'nick' => $r['a_nick'],
        'avatarUrl' => avatar_url($r[$uidCol], $r['a_avatar'] ?? null),
        'isAdmin' => is_admin_row($r['a_email'], $r['a_discord']),
    ];
}

/** Лайки: [id => count] и [id => true] для текущего пользователя. */
function forum_likes(string $kind, array $ids, ?array $me): array
{
    if (!$ids) return [[], []];
    $in = placeholders(count($ids));
    $counts = [];
    foreach (q_all("SELECT target_id, COUNT(*) AS n FROM forum_likes WHERE kind = ? AND target_id IN ($in) GROUP BY target_id", array_merge([$kind], $ids)) as $r) {
        $counts[$r['target_id']] = (int) $r['n'];
    }
    $mine = [];
    if ($me) {
        foreach (q_all("SELECT target_id FROM forum_likes WHERE kind = ? AND user_id = ? AND target_id IN ($in)", array_merge([$kind, $me['id']], $ids)) as $r) {
            $mine[$r['target_id']] = true;
        }
    }
    return [$counts, $mine];
}

/** Строки тем (с a_* колонками автора) → краткий вид для списков. */
function forum_threads_view(array $rows, ?array $me): array
{
    [$likes] = forum_likes('t', array_column($rows, 'id'), null);
    $lastIds = array_values(array_unique(array_filter(array_column($rows, 'last_user_id'))));
    $last = [];
    if ($lastIds) foreach (q_all('SELECT id, nick FROM users WHERE id IN (' . placeholders(count($lastIds)) . ')', $lastIds) as $u) $last[$u['id']] = $u['nick'];
    return array_map(static fn($t) => [
        'id' => $t['id'], 'section' => $t['section'], 'project' => $t['project'], 'title' => $t['title'],
        'excerpt' => forum_excerpt($t['body']),
        'pinned' => (bool) $t['pinned'], 'locked' => (bool) $t['locked'],
        'replies' => (int) $t['replies'], 'views' => (int) $t['views'], 'likes' => $likes[$t['id']] ?? 0,
        'author' => forum_author($t),
        'lastPostAt' => iso($t['last_post_at']), 'lastNick' => $last[$t['last_user_id'] ?? ''] ?? null,
        'createdAt' => iso($t['created_at']),
    ], $rows);
}

/** Первые ~180 символов текста без Markdown-разметки. */
function forum_excerpt(string $md): string
{
    $t = preg_replace(['/```.*?```/su', '/!\[[^\]]*\]\([^)]*\)/u', '/\[([^\]]*)\]\([^)]*\)/u', '/[#>*_`~|-]+/u', '/\s+/u'], [' ', ' ', '$1', ' ', ' '], $md) ?? '';
    $t = trim($t);
    return mb_strlen($t) > 180 ? rtrim(mb_substr($t, 0, 177)) . '…' : $t;
}

function forum_thread_row(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT t.*, ' . FORUM_AUTHOR_COLS . ' FROM forum_threads t JOIN users u ON u.id = t.user_id
        LEFT JOIN user_profiles ap ON ap.user_id = t.user_id WHERE t.id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Тема не найдена');
    return $row;
}

function forum_check_text(string $body, int $max, string $field = 'body'): array
{
    $n = str_len($body);
    return $n < 1 || $n > $max ? [$field => $n < 1 ? 'Напиши текст' : "Не больше $max символов"] : [];
}

/* ---------- Чтение ---------- */

/** GET forum → { sections: [...], news: [...], latest: [...] } */
function route_forum(): array
{
    $me = current_user();
    session_release();
    $stats = [];
    foreach (q_all('SELECT section, COUNT(*) AS threads, COALESCE(SUM(replies), 0) AS posts, MAX(last_post_at) AS last FROM forum_threads GROUP BY section') as $r) {
        $stats[$r['section']] = $r;
    }
    $sections = [];
    foreach (FORUM_SECTIONS as $id => [$label, $adminOnly]) {
        $s = $stats[$id] ?? null;
        $sections[] = [
            'id' => $id, 'label' => $label, 'adminOnly' => $adminOnly,
            'canPost' => $me !== null && (!$adminOnly || $me['role'] === 'admin'),
            'threads' => (int) ($s['threads'] ?? 0), 'posts' => (int) ($s['threads'] ?? 0) + (int) ($s['posts'] ?? 0),
            'lastPostAt' => $s ? iso($s['last']) : null,
        ];
    }
    $sel = 'SELECT t.*, ' . FORUM_AUTHOR_COLS . ' FROM forum_threads t JOIN users u ON u.id = t.user_id LEFT JOIN user_profiles ap ON ap.user_id = t.user_id';
    return [
        'sections' => $sections,
        'news' => forum_threads_view(q_all("$sel WHERE t.section = 'news' ORDER BY t.pinned DESC, t.created_at DESC LIMIT 3"), $me),
        'latest' => forum_threads_view(q_all("$sel ORDER BY t.last_post_at DESC LIMIT 8"), $me),
    ];
}

/** GET forum/threads&section=&project=&q=&page= → { items, total, page, pages } */
function route_forum_threads(): array
{
    $me = current_user();
    session_release();
    $where = [];
    $p = [];
    $section = query_str('section');
    if ($section !== '') {
        if (!isset(FORUM_SECTIONS[$section])) throw new ApiError('not_found', 'Нет такого раздела');
        $where[] = 't.section = ?';
        $p[] = $section;
    }
    $project = query_str('project');
    if ($project !== '') {
        if (!preg_match(FORUM_PROJECT_RE, $project)) throw new ApiError('validation', 'Неверный проект');
        $where[] = 't.project = ?';
        $p[] = $project;
    }
    $q = clean_str(query_str('q'));
    if ($q !== '') {
        if (str_len($q) > 60) $q = mb_substr($q, 0, 60);
        $where[] = '(t.title LIKE ? OR t.body LIKE ?)';
        $like = '%' . addcslashes($q, '%_\\') . '%';
        array_push($p, $like, $like);
    }
    $w = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $total = (int) q_one("SELECT COUNT(*) AS n FROM forum_threads t$w", $p)['n'];
    $pages = max(1, (int) ceil($total / FORUM_THREADS_PER_PAGE));
    $page = min($pages, max(1, (int) query_str('page')));
    $rows = q_all('SELECT t.*, ' . FORUM_AUTHOR_COLS . " FROM forum_threads t JOIN users u ON u.id = t.user_id LEFT JOIN user_profiles ap ON ap.user_id = t.user_id
        $w ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT " . FORUM_THREADS_PER_PAGE . ' OFFSET ' . (($page - 1) * FORUM_THREADS_PER_PAGE), $p);
    return ['items' => forum_threads_view($rows, $me), 'total' => $total, 'page' => $page, 'pages' => $pages];
}

/** GET forum/thread&id=&page= → { thread, posts: { items, page, pages } } */
function route_forum_thread(): array
{
    $me = current_user();
    session_release();
    $t = forum_thread_row(norm_uuid(query_str('id')));
    q('UPDATE forum_threads SET views = views + 1 WHERE id = ?', [$t['id']]);
    $total = (int) $t['replies'];
    $pages = max(1, (int) ceil($total / FORUM_POSTS_PER_PAGE));
    $page = query_str('page') === 'last' ? $pages : min($pages, max(1, (int) query_str('page')));
    $rows = q_all('SELECT p.*, ' . FORUM_AUTHOR_COLS . ' FROM forum_posts p JOIN users u ON u.id = p.user_id LEFT JOIN user_profiles ap ON ap.user_id = p.user_id
        WHERE p.thread_id = ? ORDER BY p.created_at ASC, p.id ASC LIMIT ' . FORUM_POSTS_PER_PAGE . ' OFFSET ' . (($page - 1) * FORUM_POSTS_PER_PAGE), [$t['id']]);
    [$tl, $tm] = forum_likes('t', [$t['id']], $me);
    [$pl, $pm] = forum_likes('p', array_column($rows, 'id'), $me);
    $isAdmin = $me && $me['role'] === 'admin';
    $own = static fn($uid) => $me && ($isAdmin || $me['id'] === $uid);
    return [
        'thread' => [
            'id' => $t['id'], 'section' => $t['section'], 'project' => $t['project'], 'title' => $t['title'], 'body' => $t['body'],
            'pinned' => (bool) $t['pinned'], 'locked' => (bool) $t['locked'],
            'replies' => $total, 'views' => (int) $t['views'] + 1,
            'likes' => $tl[$t['id']] ?? 0, 'myLike' => isset($tm[$t['id']]),
            'author' => forum_author($t), 'createdAt' => iso($t['created_at']), 'updatedAt' => iso($t['updated_at']),
            'edited' => $t['updated_at'] !== $t['created_at'],
            'canEdit' => $own($t['user_id']), 'canReply' => $me !== null && (!$t['locked'] || $isAdmin), 'canModerate' => $isAdmin,
        ],
        'posts' => [
            'items' => array_map(static fn($r) => [
                'id' => $r['id'], 'body' => $r['body'], 'author' => forum_author($r),
                'likes' => $pl[$r['id']] ?? 0, 'myLike' => isset($pm[$r['id']]),
                'createdAt' => iso($r['created_at']), 'edited' => $r['updated_at'] !== $r['created_at'], 'canEdit' => $own($r['user_id']),
            ], $rows),
            'page' => $page, 'pages' => $pages,
        ],
    ];
}

/* ---------- Запись ---------- */

/** POST forum/thread { section, project?, title, body } → { id } */
function route_forum_thread_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $section = (string) ($b['section'] ?? '');
    $project = $b['project'] ?? null;
    $title = clean_str($b['title'] ?? null);
    $body = clean_str($b['body'] ?? null);
    $e = [];
    if (!isset(FORUM_SECTIONS[$section])) $e['section'] = 'Выбери раздел';
    elseif (FORUM_SECTIONS[$section][1] && $me['role'] !== 'admin') throw new ApiError('forbidden', 'В этом разделе пишет только ndze');
    if ($project !== null && $project !== '' && !(is_string($project) && preg_match(FORUM_PROJECT_RE, $project))) $e['project'] = 'Неверный проект';
    if (str_len($title) < 3 || str_len($title) > FORUM_TITLE_MAX) $e['title'] = 'Заголовок от 3 до ' . FORUM_TITLE_MAX . ' символов';
    $e += forum_check_text($body, FORUM_THREAD_MAX);
    assert_valid($e);
    rate_limit_hit('forum_thread', user_subject($me['id']));
    $id = uuid4();
    $t = now_db();
    q('INSERT INTO forum_threads (id, section, project, user_id, title, body, pinned, locked, replies, views, last_post_at, last_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)',
        [$id, $section, $project ?: null, $me['id'], $title, $body, $t, $me['id'], $t, $t]);
    event_emit('forum.thread', ['id' => $id, 'section' => $section, 'project' => $project ?: null, 'title' => $title,
        'excerpt' => forum_excerpt($body), 'author' => $me['nick'], 'url' => site_url("forum.html#/t/$id")]);
    return ['id' => $id];
}

/** POST forum/post { threadId, body } → { id, page } (страница, на которой оказался ответ) */
function route_forum_post_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $body = clean_str($b['body'] ?? null);
    assert_valid(forum_check_text($body, FORUM_POST_MAX));
    rate_limit_hit('forum_post', user_subject($me['id']));
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $th = forum_thread_row(norm_uuid($b['threadId'] ?? null), true);
        if ($th['locked'] && $me['role'] !== 'admin') throw new ApiError('forbidden', 'Тема закрыта для ответов');
        $id = uuid4();
        $t = now_db();
        q('INSERT INTO forum_posts (id, thread_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [$id, $th['id'], $me['id'], $body, $t, $t]);
        q('UPDATE forum_threads SET replies = replies + 1, last_post_at = ?, last_user_id = ? WHERE id = ?', [$t, $me['id'], $th['id']]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    $page = (int) ceil(((int) $th['replies'] + 1) / FORUM_POSTS_PER_PAGE);
    if ($th['user_id'] !== $me['id']) {
        notify($th['user_id'], 'forum', "{$me['nick']} ответил в теме «{$th['title']}»", "forum.html#/t/{$th['id']}/$page");
    }
    event_emit('forum.post', ['threadId' => $th['id'], 'title' => $th['title'], 'author' => $me['nick']]);
    return ['id' => $id, 'page' => $page];
}

/** POST forum/edit { kind: thread|post, id, title?, body } — автор или админ. */
function route_forum_edit(): ?array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $kind = (string) ($b['kind'] ?? '');
    $id = norm_uuid($b['id'] ?? null);
    $body = clean_str($b['body'] ?? null);
    if ($kind === 'thread') {
        $th = forum_thread_row($id);
        if ($me['role'] !== 'admin' && $th['user_id'] !== $me['id']) throw new ApiError('forbidden');
        $title = clean_str($b['title'] ?? $th['title']);
        $e = forum_check_text($body, FORUM_THREAD_MAX);
        if (str_len($title) < 3 || str_len($title) > FORUM_TITLE_MAX) $e['title'] = 'Заголовок от 3 до ' . FORUM_TITLE_MAX . ' символов';
        assert_valid($e);
        q('UPDATE forum_threads SET title = ?, body = ?, updated_at = ? WHERE id = ?', [$title, $body, now_db(), $th['id']]);
    } elseif ($kind === 'post') {
        $p = $id ? q_one('SELECT id, user_id FROM forum_posts WHERE id = ?', [$id]) : null;
        if (!$p) throw new ApiError('not_found', 'Сообщение не найдено');
        if ($me['role'] !== 'admin' && $p['user_id'] !== $me['id']) throw new ApiError('forbidden');
        assert_valid(forum_check_text($body, FORUM_POST_MAX));
        q('UPDATE forum_posts SET body = ?, updated_at = ? WHERE id = ?', [$body, now_db(), $p['id']]);
    } else {
        throw new ApiError('validation', 'Неизвестный тип');
    }
    return null;
}

/** POST forum/delete { kind: thread|post, id } — автор или админ. */
function route_forum_delete(): ?array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $kind = (string) ($b['kind'] ?? '');
    $id = norm_uuid($b['id'] ?? null);
    if ($kind === 'thread') {
        $th = forum_thread_row($id);
        if ($me['role'] !== 'admin' && $th['user_id'] !== $me['id']) throw new ApiError('forbidden');
        q("DELETE FROM forum_likes WHERE (kind = 't' AND target_id = ?) OR (kind = 'p' AND target_id IN (SELECT id FROM forum_posts WHERE thread_id = ?))", [$th['id'], $th['id']]);
        q('DELETE FROM forum_threads WHERE id = ?', [$th['id']]); // ответы — ON DELETE CASCADE
        return null;
    }
    if ($kind !== 'post') throw new ApiError('validation', 'Неизвестный тип');
    $p = $id ? q_one('SELECT id, user_id, thread_id FROM forum_posts WHERE id = ?', [$id]) : null;
    if (!$p) throw new ApiError('not_found', 'Сообщение не найдено');
    if ($me['role'] !== 'admin' && $p['user_id'] !== $me['id']) throw new ApiError('forbidden');
    $pdo = db();
    $pdo->beginTransaction();
    try {
        q("DELETE FROM forum_likes WHERE kind = 'p' AND target_id = ?", [$p['id']]);
        q('DELETE FROM forum_posts WHERE id = ?', [$p['id']]);
        $last = q_one('SELECT user_id, created_at FROM forum_posts WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', [$p['thread_id']]);
        $th = q_one('SELECT user_id, created_at FROM forum_threads WHERE id = ?', [$p['thread_id']]);
        q('UPDATE forum_threads SET replies = GREATEST(replies, 1) - 1, last_post_at = ?, last_user_id = ? WHERE id = ?',
            [$last['created_at'] ?? $th['created_at'], $last['user_id'] ?? $th['user_id'], $p['thread_id']]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    return null;
}

/** POST forum/like { kind: thread|post, id } → { likes, myLike } */
function route_forum_like(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $kind = ($b['kind'] ?? '') === 'thread' ? 't' : (($b['kind'] ?? '') === 'post' ? 'p' : null);
    $id = norm_uuid($b['id'] ?? null);
    if (!$kind || !$id) throw new ApiError('validation', 'Неверный лайк');
    $exists = $kind === 't' ? q_one('SELECT id FROM forum_threads WHERE id = ?', [$id]) : q_one('SELECT id FROM forum_posts WHERE id = ?', [$id]);
    if (!$exists) throw new ApiError('not_found', 'Не найдено');
    $del = q('DELETE FROM forum_likes WHERE kind = ? AND target_id = ? AND user_id = ?', [$kind, $id, $me['id']]);
    $mine = false;
    if ($del->rowCount() === 0) {
        q('INSERT IGNORE INTO forum_likes (kind, target_id, user_id, created_at) VALUES (?, ?, ?, ?)', [$kind, $id, $me['id'], now_db()]);
        $mine = true;
    }
    return ['likes' => (int) q_one('SELECT COUNT(*) AS n FROM forum_likes WHERE kind = ? AND target_id = ?', [$kind, $id])['n'], 'myLike' => $mine];
}

/** POST forum/moderate { id, pinned?, locked? } (админ) */
function route_forum_moderate(): ?array
{
    require_admin();
    session_release();
    $b = request_body();
    $th = forum_thread_row(norm_uuid($b['id'] ?? null));
    $sets = [];
    $p = [];
    foreach (['pinned', 'locked'] as $k) {
        if (array_key_exists($k, $b)) {
            $sets[] = "$k = ?";
            $p[] = $b[$k] ? 1 : 0;
        }
    }
    if (!$sets) throw new ApiError('validation', 'Нечего менять');
    $p[] = $th['id'];
    q('UPDATE forum_threads SET ' . implode(', ', $sets) . ' WHERE id = ?', $p);
    return null;
}

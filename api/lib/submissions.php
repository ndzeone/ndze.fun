<?php
// Работы на оценку: права как в local.js (canSee: ideal — все; иначе автор или админ).
declare(strict_types=1);
defined('NDZE') || exit;

function can_see_submission(?array $me, string $ownerId, string $status): bool
{
    return $status === 'ideal' || ($me && ($me['role'] === 'admin' || $me['id'] === $ownerId));
}

const SUB_SELECT = 'SELECT s.*, u.nick AS author_nick, ap.avatar_file AS author_avatar
  FROM submissions s JOIN users u ON u.id = s.user_id LEFT JOIN user_profiles ap ON ap.user_id = s.user_id';

/** Строка submissions (+ author_nick, author_avatar) по id или 404 «Работа не найдена». */
function find_submission(?string $id, bool $forUpdate = false): array
{
    // FOR UPDATE блокирует только строку работы: LEFT JOIN профиля в блокировку не берём
    $row = $id ? q_one(
        $forUpdate ? 'SELECT s.* FROM submissions s WHERE s.id = ? FOR UPDATE' : SUB_SELECT . ' WHERE s.id = ?',
        [$id]
    ) : null;
    if (!$row) throw new ApiError('not_found', 'Работа не найдена');
    return $row;
}

/** Строки submissions → Submission[] с versions (по n ↑) и comments (по createdAt ↑). */
function submissions_view(array $rows): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $in = placeholders(count($ids));

    $images = [];
    foreach (q_all("SELECT id, version_id FROM submission_images WHERE submission_id IN ($in) ORDER BY position ASC", $ids) as $img) {
        $images[$img['version_id']][] = image_url($img['id']);
    }
    $versions = [];
    foreach (q_all("SELECT id, submission_id, n, note, created_at FROM submission_versions WHERE submission_id IN ($in) ORDER BY n ASC", $ids) as $v) {
        $versions[$v['submission_id']][] = [
            'id' => $v['id'],
            'n' => (int) $v['n'],
            'imageUrls' => $images[$v['id']] ?? [],
            'note' => $v['note'],
            'createdAt' => iso($v['created_at']),
        ];
    }
    $comments = [];
    foreach (q_all(
        "SELECT c.id, c.submission_id, c.user_id, c.text, c.created_at, u.nick, u.email, u.discord_id, p.avatar_file
         FROM submission_comments c JOIN users u ON u.id = c.user_id LEFT JOIN user_profiles p ON p.user_id = c.user_id
         WHERE c.submission_id IN ($in) ORDER BY c.created_at ASC, c.id ASC",
        $ids
    ) as $c) {
        $comments[$c['submission_id']][] = comment_view($c);
    }
    $out = [];
    foreach ($rows as $s) {
        $out[] = [
            'id' => $s['id'],
            'userId' => $s['user_id'],
            'authorNick' => $s['author_nick'],
            'authorAvatar' => avatar_url($s['user_id'], $s['author_avatar'] ?? null),
            'title' => $s['title'],
            'description' => $s['description'],
            'category' => $s['category'],
            'status' => $s['status'],
            'rating' => $s['rating'] === null ? null : (int) $s['rating'],
            'createdAt' => iso($s['created_at']),
            'updatedAt' => iso($s['updated_at']),
            'versions' => $versions[$s['id']] ?? [],
            'comments' => $comments[$s['id']] ?? [],
        ];
    }
    return $out;
}

function comment_view(array $c): array
{
    return [
        'id' => $c['id'],
        'userId' => $c['user_id'],
        'authorNick' => $c['nick'],
        'authorAvatar' => avatar_url($c['user_id'], $c['avatar_file'] ?? null),
        'isAdmin' => is_admin_row($c['email'], $c['discord_id']),
        'text' => $c['text'],
        'createdAt' => iso($c['created_at']),
    ];
}

function submission_get_view(string $id): array
{
    return submissions_view([find_submission($id)])[0];
}

/* ---------- Маршруты ---------- */

function route_submissions_list(): array
{
    $scope = query_str('scope') ?: 'mine';
    $sql = SUB_SELECT;
    if ($scope === 'gallery') {
        session_release();
        $rows = q_all("$sql WHERE s.status = 'ideal' ORDER BY s.updated_at DESC, s.id DESC");
    } elseif ($scope === 'all') {
        require_admin();
        session_release();
        $rows = q_all("$sql ORDER BY s.updated_at DESC, s.id DESC");
    } else {
        $me = require_user();
        session_release();
        $rows = q_all("$sql WHERE s.user_id = ? ORDER BY s.updated_at DESC, s.id DESC", [$me['id']]);
    }
    return submissions_view($rows);
}

function route_submission_get(): array
{
    $me = current_user();
    session_release();
    $s = find_submission(norm_uuid(query_str('id')));
    if (!can_see_submission($me, $s['user_id'], $s['status'])) throw new ApiError($me ? 'forbidden' : 'auth_required');
    return submissions_view([$s])[0];
}

/** Вставить версию с картинками (внутри транзакции). */
function insert_version(string $subId, int $n, string $note, array $stored, string $t): void
{
    $vid = uuid4();
    q('INSERT INTO submission_versions (id, submission_id, n, note, created_at) VALUES (?, ?, ?, ?, ?)', [$vid, $subId, $n, $note, $t]);
    foreach ($stored as $pos => $img) {
        q('INSERT INTO submission_images (id, version_id, submission_id, position, file_name, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$img['id'], $vid, $subId, $pos, $img['file'], $img['mime'], $img['bytes'], $img['w'], $img['h'], $t]);
    }
}

/** Выполнить $fn в транзакции; при ошибке — откат и удаление уже записанных файлов. */
function with_files_tx(array $stored, callable $fn)
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $r = $fn();
        $pdo->commit();
        return $r;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        files_delete(array_column($stored, 'file'));
        throw $e;
    }
}

function route_submission_create(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $title = clean_str($b['title'] ?? null);
    $description = clean_str($b['description'] ?? null);
    $category = clean_str($b['category'] ?? null);
    $note = clean_str($b['note'] ?? null);
    $e = check_submission($title, $description, $category, $note);
    [$fileErr, $checked] = files_check(uploaded_files());
    if ($fileErr !== '') $e['files'] = $fileErr;
    assert_valid($e);

    rate_limit_hit('submission', user_subject($me['id']));

    $stored = files_store($checked);
    $id = uuid4();
    $t = now_db();
    with_files_tx($stored, static function () use ($id, $me, $title, $description, $category, $note, $stored, $t) {
        q('INSERT INTO submissions (id, user_id, title, description, category, status, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
            [$id, $me['id'], $title, $description, $category, 'pending', $t, $t]);
        insert_version($id, 1, $note, $stored, $t);
    });
    return submission_get_view($id);
}

function route_submission_version(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $note = clean_str($b['note'] ?? null);
    $e = [];
    [$fileErr, $checked] = files_check(uploaded_files());
    if ($fileErr !== '') $e['files'] = $fileErr;
    $e += check_note($note);
    assert_valid($e);

    $id = norm_uuid($b['id'] ?? query_str('id'));
    $s = find_submission($id);
    if ($s['user_id'] !== $me['id']) throw new ApiError('forbidden', 'Новую версию может загрузить только автор');

    rate_limit_hit('version', user_subject($me['id']));

    $stored = files_store($checked);
    $t = now_db();
    with_files_tx($stored, static function () use ($id, $note, $stored, $t) {
        find_submission($id, true); // блокировка строки: номера версий без гонок
        $n = (int) q_one('SELECT COALESCE(MAX(n), 0) AS n FROM submission_versions WHERE submission_id = ?', [$id])['n'] + 1;
        insert_version($id, $n, $note, $stored, $t);
        q("UPDATE submissions SET status = 'pending', updated_at = ? WHERE id = ?", [$t, $id]);
    });
    return submission_get_view($id);
}

function route_submission_comment(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $text = clean_str($b['text'] ?? null);
    assert_valid(check_comment($text));
    $s = find_submission(norm_uuid($b['id'] ?? null));
    if ($me['role'] !== 'admin' && $s['user_id'] !== $me['id']) throw new ApiError('forbidden');

    rate_limit_hit('comment', user_subject($me['id']));

    $cid = uuid4();
    $t = now_db();
    $pdo = db();
    $pdo->beginTransaction();
    try {
        q('INSERT INTO submission_comments (id, submission_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)', [$cid, $s['id'], $me['id'], $text, $t]);
        q('UPDATE submissions SET updated_at = ? WHERE id = ?', [$t, $s['id']]);
        $pdo->commit();
    } catch (Throwable $ex) {
        $pdo->rollBack();
        throw $ex;
    }
    if ($s['user_id'] !== $me['id']) {
        notify($s['user_id'], 'comment', "{$me['nick']} оставил совет к работе «{$s['title']}»", 'review.html#sub=' . $s['id']);
    }
    return comment_view([
        'id' => $cid, 'user_id' => $me['id'], 'nick' => $me['nick'], 'email' => $me['email'],
        'discord_id' => $me['discord_id'], 'avatar_file' => $me['avatar_file'] ?? null, 'text' => $text, 'created_at' => $t,
    ]);
}

function route_submission_review(): array
{
    require_admin();
    session_release();
    $b = request_body();
    assert_valid(check_review($b));
    $s = find_submission(norm_uuid($b['id'] ?? null));
    $sets = ['updated_at = ?'];
    $params = [now_db()];
    if (array_key_exists('rating', $b)) {
        $sets[] = 'rating = ?';
        $params[] = $b['rating'] === null ? null : (int) $b['rating'];
    }
    if (array_key_exists('status', $b)) {
        $sets[] = 'status = ?';
        $params[] = $b['status'];
    }
    $params[] = $s['id'];
    q('UPDATE submissions SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
    $view = submission_get_view($s['id']);
    $what = [];
    if (array_key_exists('rating', $b) && $b['rating'] !== null && (int) $b['rating'] !== (int) $s['rating']) $what[] = "оценка {$b['rating']}/10";
    if (array_key_exists('status', $b) && $b['status'] !== $s['status']) {
        $what[] = ['pending' => 'ждёт оценки', 'revision' => 'нужна доработка', 'ideal' => 'ИДЕАЛ 💎', 'rejected' => 'отклонено'][$b['status']] ?? $b['status'];
    }
    if ($what) {
        notify($s['user_id'], 'review', "Работа «{$s['title']}»: " . implode(', ', $what), 'review.html#sub=' . $s['id']);
        event_emit('submission.reviewed', ['submission' => $view]);
    }
    return $view;
}

function route_submission_delete(): ?array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $s = find_submission(norm_uuid($b['id'] ?? null));
    if ($me['role'] !== 'admin' && $s['user_id'] !== $me['id']) throw new ApiError('forbidden');
    $files = array_column(q_all('SELECT file_name FROM submission_images WHERE submission_id = ?', [$s['id']]), 'file_name');
    q('DELETE FROM submissions WHERE id = ?', [$s['id']]); // версии, картинки, комментарии — ON DELETE CASCADE
    files_delete($files);
    return null;
}

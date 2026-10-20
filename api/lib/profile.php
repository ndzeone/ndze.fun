<?php
// Личный кабинет: профиль со статистикой, аватарки, смена ника и пароля, отвязка Discord.
declare(strict_types=1);
defined('NDZE') || exit;

const AVATAR_SIZE = 256;
const AVATAR_FILE_RE = '/^[0-9a-f-]{36}\.(webp|png)$/';

/** URL аватарки или null. v= меняется с каждой новой картинкой — браузер кэширует навсегда. */
function avatar_url(string $userId, ?string $file): ?string
{
    if ($file === null || !preg_match(AVATAR_FILE_RE, $file)) return null;
    return 'api/index.php?r=avatar&id=' . $userId . '&v=' . substr($file, 0, 8);
}

function avatars_dir(): string
{
    $dir = storage_dir('avatars');
    if ($dir === null) throw new RuntimeException('Папка для аватарок недоступна для записи: ' . storage_root() . '/avatars');
    return $dir;
}

/** Картинка GD → квадрат AVATAR_SIZE (обрезка по центру) в хранилище. Возвращает имя файла. */
function avatar_from_gd($src): string
{
    $w = imagesx($src);
    $h = imagesy($src);
    $side = min($w, $h);
    $dst = imagecreatetruecolor(AVATAR_SIZE, AVATAR_SIZE);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
    imagecopyresampled($dst, $src, 0, 0, intdiv($w - $side, 2), intdiv($h - $side, 2), AVATAR_SIZE, AVATAR_SIZE, $side, $side);

    $webp = function_exists('imagewebp');
    $file = uuid4() . ($webp ? '.webp' : '.png');
    $path = avatars_dir() . '/' . $file;
    $tmp = $path . '.tmp';
    $ok = $webp ? imagewebp($dst, $tmp, 88) : imagepng($dst, $tmp, 6);
    imagedestroy($dst);
    if (!$ok || !@rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException("Не удалось записать $path");
    }
    @chmod($path, 0600);
    return $file;
}

function avatar_file_delete(?string $file): void
{
    if ($file === null || !preg_match(AVATAR_FILE_RE, $file)) return;
    $dir = storage_dir('avatars');
    if ($dir !== null) @unlink($dir . '/' . $file);
}

/** Строка профиля есть всегда (дальше её можно блокировать FOR UPDATE и обновлять). */
function profile_ensure(string $userId): void
{
    q('INSERT IGNORE INTO user_profiles (user_id, updated_at) VALUES (?, ?)', [$userId, now_db()]);
}

/**
 * Записать аватарку в профиль (старый файл удаляется). $file null — убрать.
 * $fromDiscord: не перезаписывать, если пользователь тем временем загрузил свою или удалил аватарку.
 * Возвращает false, если запись не сделана (тогда новый файл удалён).
 */
function avatar_set(string $userId, ?string $file, string $source, ?string $discordHash = null, bool $fromDiscord = false): bool
{
    profile_ensure($userId);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $old = q_one('SELECT avatar_file, avatar_source FROM user_profiles WHERE user_id = ? FOR UPDATE', [$userId]);
        if ($fromDiscord && in_array($old['avatar_source'] ?? null, ['upload', 'removed', 'mc'], true)) {
            $pdo->rollBack();
            avatar_file_delete($file);
            return false;
        }
        q('UPDATE user_profiles SET avatar_file = ?, avatar_source = ?, discord_avatar = COALESCE(?, discord_avatar), updated_at = ? WHERE user_id = ?',
            [$file, $source, $discordHash, now_db(), $userId]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        avatar_file_delete($file);
        throw $e;
    }
    if ($old && $old['avatar_file'] !== $file) avatar_file_delete($old['avatar_file']);
    return true;
}

/** Выкинуть все остальные сессии пользователя (текущую сразу перевыпускаем через session_login). */
function bump_auth_epoch(string $userId): void
{
    profile_ensure($userId);
    q('UPDATE user_profiles SET auth_epoch = auth_epoch + 1, updated_at = ? WHERE user_id = ?', [now_db(), $userId]);
}

/**
 * Аватарка из Discord при входе: только если своей загруженной нет и пользователь не удалял аватарку.
 * Никогда не бросает — вход важнее картинки.
 */
function discord_sync_avatar(string $userId, array $p): void
{
    try {
        $hash = $p['avatar'] ?? null;
        if (!is_string($hash) || !preg_match('/^(a_)?[0-9a-f]{32}$/', $hash) || !function_exists('imagecreatefromstring')) return;
        $row = q_one('SELECT avatar_source, discord_avatar FROM user_profiles WHERE user_id = ?', [$userId]);
        if ($row && in_array($row['avatar_source'], ['upload', 'removed', 'mc'], true)) return;
        // эту аватарку уже скачивали (или пробовали — CDN Discord с хостинга может быть недоступен): не ждём снова
        if ($row && $row['discord_avatar'] === $hash) return;
        profile_ensure($userId);
        q('UPDATE user_profiles SET discord_avatar = ? WHERE user_id = ?', [$hash, $userId]);
        $r = http_request('GET', 'https://cdn.discordapp.com/avatars/' . $p['id'] . '/' . $hash . '.png?size=256', [], null, 3);
        if ($r['status'] !== 200 || $r['body'] === '' || strlen($r['body']) > LIM_FILE_BYTES) {
            if ($r['status'] !== 200) error_log('[ndze] discord avatar: HTTP ' . $r['status'] . ' ' . $r['error']);
            return;
        }
        raise_memory_limit();
        $src = @imagecreatefromstring($r['body']);
        if (!$src) return;
        $file = avatar_from_gd($src);
        imagedestroy($src);
        avatar_set($userId, $file, 'discord', $hash, true);
    } catch (Throwable $e) {
        error_log('[ndze] discord avatar: ' . $e->getMessage());
    }
}

/* ---------- Маршруты ---------- */

/** GET avatar&id=<userId> — публично (аватарки видят все). */
function route_avatar(): void
{
    session_release();
    $id = norm_uuid(query_str('id'));
    $row = $id ? q_one('SELECT avatar_file FROM user_profiles WHERE user_id = ?', [$id]) : null;
    $file = $row['avatar_file'] ?? null;
    $dir = storage_dir('avatars');
    $path = is_string($file) && preg_match(AVATAR_FILE_RE, $file) && $dir !== null ? $dir . '/' . $file : '';
    if ($path === '' || !is_file($path)) throw new ApiError('not_found', 'Аватарки нет');
    while (ob_get_level() > 0) @ob_end_clean();
    $etag = '"' . $file . '"';
    header('Content-Type: ' . (str_ends_with($file, '.webp') ? 'image/webp' : 'image/png'));
    header('X-Content-Type-Options: nosniff');
    // в URL есть v=<начало имени файла>: новая аватарка — новый URL, старую можно кэшировать надолго
    header('Cache-Control: ' . (query_str('v') === substr($file, 0, 8) ? 'public, max-age=31536000, immutable' : 'no-cache'));
    header('Content-Security-Policy: default-src \'none\'; sandbox');
    header('ETag: ' . $etag);
    if (trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
        http_response_code(304);
        return;
    }
    header('Content-Length: ' . filesize($path));
    if (request_method() !== 'HEAD') readfile($path);
}

/** GET me/profile → { user, hasPassword, discordLinked, stats } */
function route_profile(): array
{
    $me = require_user();
    session_release();
    return profile_view($me);
}

function profile_view(array $me): array
{
    $s = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'ideal'), 0) AS ideal, AVG(rating) AS avg_rating FROM submissions WHERE user_id = ?", [$me['id']]);
    $t = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'done'), 0) AS done FROM tasks WHERE user_id = ?", [$me['id']]);
    $v = q_one('SELECT COUNT(*) AS n FROM task_votes v JOIN tasks t ON t.id = v.task_id WHERE t.user_id = ?', [$me['id']]);
    return [
        'user' => public_user($me),
        'hasPassword' => is_string($me['password_hash']) && $me['password_hash'] !== '',
        'discordLinked' => $me['discord_id'] !== null,
        'stats' => [
            'submissions' => (int) $s['n'],
            'ideal' => (int) $s['ideal'],
            'avgRating' => $s['avg_rating'] === null ? null : round((float) $s['avg_rating'], 1),
            'tasks' => (int) $t['n'],
            'tasksDone' => (int) $t['done'],
            'votesReceived' => (int) $v['n'],
        ],
        'progress' => user_progress($me['id']),
        'points' => points_balance($me['id']),
        'minecraft' => minecraft_of($me['id']),
        'whitelist' => whitelist_of($me['id']),
    ];
}

/** POST me/avatar (multipart files[] — одна картинка) → User */
function route_avatar_upload(): array
{
    $me = require_user();
    session_release();
    request_body(); // ловит «слишком большой запрос»
    $files = uploaded_files();
    if (count($files) > 1) throw new ApiError('validation', 'Нужна одна картинка', ['files' => 'Нужна одна картинка']);
    [$err, $checked] = files_check($files);
    if ($err !== '') throw new ApiError('validation', $err, ['files' => $err]);
    if (!function_exists('imagecreatetruecolor')) throw new ApiError('unknown', 'На сервере нет обработки картинок (GD)');

    rate_limit_hit('avatar', user_subject($me['id']));

    $f = $checked[0];
    raise_memory_limit();
    $src = null;
    if ($f['type'] === IMAGETYPE_JPEG) $src = @imagecreatefromjpeg($f['tmp']);
    elseif ($f['type'] === IMAGETYPE_PNG) $src = @imagecreatefrompng($f['tmp']);
    elseif ($f['type'] === IMAGETYPE_GIF) $src = @imagecreatefromgif($f['tmp']); // анимация → первый кадр
    elseif ($f['type'] === IMAGETYPE_WEBP && function_exists('imagecreatefromwebp')) $src = @imagecreatefromwebp($f['tmp']);
    if (!$src) {
        $msg = "«{$f['name']}»: не получилось прочитать картинку (анимированный WEBP не подходит)";
        throw new ApiError('validation', $msg, ['files' => $msg]);
    }
    if ($f['type'] === IMAGETYPE_JPEG) $src = apply_exif_orientation($src, $f['tmp']);
    $file = avatar_from_gd($src);
    imagedestroy($src);
    avatar_set($me['id'], $file, 'upload');
    return public_user(current_user(true));
}

/** POST me/avatar/delete → User */
function route_avatar_delete(): array
{
    $me = require_user();
    session_release();
    avatar_set($me['id'], null, 'removed');
    return public_user(current_user(true));
}

/** POST me/update { nick } → User */
function route_profile_update(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $nick = clean_str($b['nick'] ?? null);
    assert_valid(check_nick($nick));
    if ($nick === $me['nick']) return public_user($me);
    if (nick_taken($nick, $me['id'])) throw new ApiError('nick_taken', null, ['nick' => 'Этот ник уже занят']);

    rate_limit_hit('nick', user_subject($me['id']));

    try {
        q('UPDATE users SET nick = ?, nick_key = ?, updated_at = ? WHERE id = ?', [$nick, nick_key($nick), now_db(), $me['id']]);
    } catch (PDOException $e) {
        if (!is_duplicate_key($e)) throw $e;
        throw new ApiError('nick_taken', null, ['nick' => 'Этот ник уже занят']);
    }
    return public_user(current_user(true));
}

/**
 * POST me/password { currentPassword?, newPassword } → null.
 * Есть пароль — нужен текущий. Нет (вход только через Discord) — можно задать, если у аккаунта есть email.
 */
function route_password_change(): ?array
{
    $me = require_user();
    $b = request_body();
    $current = raw_str($b['currentPassword'] ?? null);
    $next = raw_str($b['newPassword'] ?? null);
    $hasPassword = is_string($me['password_hash']) && $me['password_hash'] !== '';
    $e = check_password_change($current, $next, $hasPassword);
    if (!$hasPassword && $me['email'] === null) {
        $e['newPassword'] = 'У аккаунта нет email — входи через Discord';
    }
    assert_valid($e);

    $subject = user_subject($me['id']);
    if ($hasPassword) {
        rate_limit_check('password', $subject);
        if (!password_verify($current, $me['password_hash'])) {
            rate_limit_add('password', $subject);
            throw new ApiError('validation', 'Неверный текущий пароль', ['currentPassword' => 'Неверный текущий пароль']);
        }
    }
    q('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [password_hash($next, PASSWORD_DEFAULT), now_db(), $me['id']]);
    bump_auth_epoch($me['id']); // остальные браузеры выходят из аккаунта
    session_login($me['id']);   // а этот получает новый id сессии и остаётся
    session_release();
    return null;
}

/**
 * POST me/discord/unlink → профиль. Только если можно войти по email и паролю.
 * Отвязанный Discord больше не входит в этот аккаунт (даже по совпадению email) и не держит открытые сессии.
 */
function route_discord_unlink(): array
{
    $me = require_user();
    if ($me['discord_id'] === null) {
        session_release();
        return profile_view($me);
    }
    if ($me['email'] === null || !is_string($me['password_hash']) || $me['password_hash'] === '') {
        throw new ApiError('validation', 'Сначала задай пароль — иначе не получится войти без Discord');
    }
    profile_ensure($me['id']);
    q('UPDATE user_profiles SET discord_unlinked = ? WHERE user_id = ?', [$me['discord_id'], $me['id']]);
    q('UPDATE users SET discord_id = NULL, updated_at = ? WHERE id = ?', [now_db(), $me['id']]);
    bump_auth_epoch($me['id']);
    session_login($me['id']);
    session_release();
    return profile_view(current_user(true));
}

<?php
// Загрузка картинок: проверка (getimagesize + finfo), пересохранение через GD, отдача с проверкой прав.
declare(strict_types=1);
defined('NDZE') || exit;

const IMAGE_TYPES = [
    IMAGETYPE_JPEG => ['image/jpeg', 'jpg'],
    IMAGETYPE_PNG => ['image/png', 'png'],
    IMAGETYPE_WEBP => ['image/webp', 'webp'],
    IMAGETYPE_GIF => ['image/gif', 'gif'],
];
const IMAGE_MAX_PIXELS = 50000000; // 50 Мп — больше GD не переварит на хостинге

function uploads_dir(): string
{
    $dir = storage_dir('uploads');
    if ($dir === null) throw new RuntimeException('Папка для картинок недоступна для записи: ' . storage_root() . '/uploads');
    return $dir;
}

/** $_FILES['files'] (files[] или один files) → список [name, tmp, size, error]. */
function uploaded_files(): array
{
    $f = $_FILES['files'] ?? null;
    if (!is_array($f) || !isset($f['name'])) return [];
    $out = [];
    if (is_array($f['name'])) {
        foreach ($f['name'] as $i => $name) {
            if (is_array($name)) continue; // files[a][b] — не поддерживаем
            $out[] = ['name' => (string) $name, 'tmp' => (string) ($f['tmp_name'][$i] ?? ''), 'size' => (int) ($f['size'][$i] ?? 0), 'error' => (int) ($f['error'][$i] ?? UPLOAD_ERR_NO_FILE)];
        }
    } else {
        $out[] = ['name' => (string) $f['name'], 'tmp' => (string) ($f['tmp_name'] ?? ''), 'size' => (int) ($f['size'] ?? 0), 'error' => (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE)];
    }
    return array_values(array_filter($out, static fn($x) => $x['error'] !== UPLOAD_ERR_NO_FILE));
}

/** Имя файла для текста ошибки (без пути и управляющих символов). */
function display_name(string $name): string
{
    $name = clean_str(basename(str_replace('\\', '/', raw_str($name))));
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?? '';
    if ($name === '') $name = 'файл';
    return mb_strlen($name) > 80 ? mb_substr($name, 0, 77) . '…' : $name;
}

/**
 * Проверка файлов (как checkFiles в validate.js + реальная проверка содержимого).
 * Возвращает [ошибка|'' , список проверенных файлов].
 */
function files_check(array $files): array
{
    if (!$files) return ['Добавь хотя бы одно изображение', []];
    if (count($files) > LIM_FILES_MAX) return ['Не больше ' . LIM_FILES_MAX . ' файлов', []];
    $finfo = class_exists('finfo') ? new finfo(FILEINFO_MIME_TYPE) : null;
    $ok = [];
    foreach ($files as $f) {
        $name = display_name($f['name']);
        if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) || $f['size'] > LIM_FILE_BYTES) {
            return ["«{$name}»: файл больше 10 МБ", []];
        }
        if ($f['error'] !== UPLOAD_ERR_OK || $f['tmp'] === '' || !is_uploaded_file($f['tmp'])) {
            if ($f['error'] !== UPLOAD_ERR_OK) error_log("[ndze] upload error {$f['error']} for {$name}");
            return ["«{$name}»: не удалось загрузить файл, попробуй ещё раз", []];
        }
        $size = filesize($f['tmp']);
        if ($size === false || $size > LIM_FILE_BYTES) return ["«{$name}»: файл больше 10 МБ", []];
        $bad = "«{$name}»: нужен JPG, PNG, WEBP или GIF";
        $info = @getimagesize($f['tmp']);
        if (!is_array($info) || !isset(IMAGE_TYPES[$info[2]]) || $info[0] < 1 || $info[1] < 1) return [$bad, []];
        [$mime, $ext] = IMAGE_TYPES[$info[2]];
        if ($finfo) {
            $real = (string) $finfo->file($f['tmp']);
            // старый libmagic не знает WEBP — тогда доверяем getimagesize
            $webpUnknown = $mime === 'image/webp' && $real === 'application/octet-stream';
            if ($real !== $mime && !$webpUnknown) return [$bad, []];
        }
        if ($info[0] * $info[1] > IMAGE_MAX_PIXELS) return ["«{$name}»: слишком большое разрешение (больше 50 Мп)", []];
        $ok[] = ['name' => $name, 'tmp' => $f['tmp'], 'mime' => $mime, 'ext' => $ext, 'w' => (int) $info[0], 'h' => (int) $info[1], 'type' => $info[2]];
    }
    return ['', $ok];
}

/**
 * Сохранить проверенные файлы в хранилище. Возвращает [{id, file, mime, bytes, w, h}].
 * При ошибке уже записанные файлы удаляются.
 */
function files_store(array $checked): array
{
    $dir = uploads_dir();
    $saved = [];
    try {
        foreach ($checked as $f) {
            $saved[] = store_one($f, $dir);
        }
    } catch (Throwable $e) {
        files_delete(array_column($saved, 'file'));
        throw $e;
    }
    return $saved;
}

function store_one(array $f, string $dir): array
{
    $id = uuid4();
    $gd = function_exists('imagecreatetruecolor');
    if ($f['type'] === IMAGETYPE_GIF || !$gd) {
        if (!$gd) error_log('[ndze] нет GD — картинка сохранена без пересохранения');
        return store_raw($f, $dir, $id);
    }
    raise_memory_limit();
    $src = null;
    if ($f['type'] === IMAGETYPE_JPEG) $src = @imagecreatefromjpeg($f['tmp']);
    elseif ($f['type'] === IMAGETYPE_PNG) $src = @imagecreatefrompng($f['tmp']);
    elseif ($f['type'] === IMAGETYPE_WEBP && function_exists('imagecreatefromwebp')) $src = @imagecreatefromwebp($f['tmp']);
    if (!$src) {
        // анимированный WEBP / GD без WEBP: тип уже проверен — сохраняем как есть
        if ($f['type'] === IMAGETYPE_WEBP) return store_raw($f, $dir, $id);
        throw new ApiError('validation', "«{$f['name']}»: не получилось прочитать картинку", ['files' => "«{$f['name']}»: не получилось прочитать картинку"]);
    }
    if ($f['type'] === IMAGETYPE_JPEG) $src = apply_exif_orientation($src, $f['tmp']);

    $w = imagesx($src);
    $h = imagesy($src);
    $scale = min(1, LIM_IMAGE_MAX_SIDE / max($w, $h));
    $nw = max(1, (int) round($w * $scale));
    $nh = max(1, (int) round($h * $scale));
    $alpha = $f['type'] !== IMAGETYPE_JPEG;
    $dst = imagecreatetruecolor($nw, $nh);
    if ($alpha) {
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
    }
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
    imagedestroy($src);

    $outType = $f['type'];
    if ($outType === IMAGETYPE_WEBP && !function_exists('imagewebp')) $outType = IMAGETYPE_PNG;
    [$mime, $ext] = IMAGE_TYPES[$outType];
    $file = $id . '.' . $ext;
    $path = $dir . '/' . $file;
    $tmp = $path . '.tmp';
    $ok = false;
    if ($outType === IMAGETYPE_JPEG) $ok = imagejpeg($dst, $tmp, 86);
    elseif ($outType === IMAGETYPE_PNG) $ok = imagepng($dst, $tmp, 6);
    elseif ($outType === IMAGETYPE_WEBP) $ok = imagewebp($dst, $tmp, 86);
    imagedestroy($dst);
    if (!$ok || !@rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException("Не удалось записать $path");
    }
    @chmod($path, 0600);
    return ['id' => $id, 'file' => $file, 'mime' => $mime, 'bytes' => (int) filesize($path), 'w' => $nw, 'h' => $nh];
}

function store_raw(array $f, string $dir, string $id): array
{
    $file = $id . '.' . $f['ext'];
    $path = $dir . '/' . $file;
    if (!@move_uploaded_file($f['tmp'], $path)) throw new RuntimeException("Не удалось сохранить $path");
    @chmod($path, 0600);
    return ['id' => $id, 'file' => $file, 'mime' => $f['mime'], 'bytes' => (int) filesize($path), 'w' => $f['w'], 'h' => $f['h']];
}

/** Фото с телефона: поворот по EXIF Orientation (браузер так же поворачивает при показе). */
function apply_exif_orientation($img, string $file)
{
    if (!function_exists('exif_read_data')) return $img;
    $exif = @exif_read_data($file);
    $o = is_array($exif) ? (int) ($exif['Orientation'] ?? 1) : 1;
    if ($o < 2 || $o > 8) return $img;
    // 2: зеркало ↔; 3: 180°; 4: зеркало ↕; 5: ↕ + 90° по часовой; 6: 90° по часовой; 7: ↔ + 90° по часовой; 8: 90° против
    $flip = [2 => IMG_FLIP_HORIZONTAL, 4 => IMG_FLIP_VERTICAL, 5 => IMG_FLIP_VERTICAL, 7 => IMG_FLIP_HORIZONTAL][$o] ?? null;
    if ($flip !== null) imageflip($img, $flip);
    $angle = [3 => 180, 5 => -90, 6 => -90, 7 => -90, 8 => 90][$o] ?? 0; // imagerotate — против часовой
    if ($angle) {
        $r = imagerotate($img, $angle, 0);
        if ($r) {
            imagedestroy($img);
            $img = $r;
        }
    }
    return $img;
}

/** Временно поднять memory_limit для GD (на больших фото нужно ~5 байт на пиксель). */
function raise_memory_limit(): void
{
    $cur = ini_bytes((string) ini_get('memory_limit'));
    if ($cur < 512 * 1048576) @ini_set('memory_limit', '512M');
}

function files_delete(array $fileNames): void
{
    if (!$fileNames) return;
    $dir = storage_dir('uploads');
    if ($dir === null) return;
    foreach ($fileNames as $name) {
        if (is_string($name) && preg_match('/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/', $name)) {
            @unlink($dir . '/' . $name);
        }
    }
}

/** URL картинки для фронтенда. */
function image_url(string $id): string
{
    return 'api/index.php?r=image&id=' . $id;
}

/** GET image&id=… — отдать файл, если пользователь видит работу; иначе 404. */
function route_image(): void
{
    $id = norm_uuid(query_str('id'));
    $row = $id ? q_one(
        'SELECT i.file_name, i.mime, s.id AS sub_id, s.user_id, s.status FROM submission_images i JOIN submissions s ON s.id = i.submission_id WHERE i.id = ?',
        [$id]
    ) : null;
    $me = current_user();
    session_release();
    // оверлей OBS (без входа) по ключу из пульта видит только картинку последней присланной работы — ту, что в оверлее
    $byKey = $row && query_str('key') !== '' && overlay_key_ok(query_str('key'))
        && ($row['sub_id'] === (q_one('SELECT id FROM submissions ORDER BY created_at DESC LIMIT 1')['id'] ?? null));
    if (!$row || (!$byKey && !can_see_submission($me, $row['user_id'], $row['status']))
        || !preg_match('/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/', $row['file_name'])) {
        throw new ApiError('not_found', 'Картинка не найдена');
    }
    $dir = storage_dir('uploads');
    $path = $dir === null ? '' : $dir . '/' . $row['file_name'];
    if ($path === '' || !is_file($path)) {
        error_log('[ndze] нет файла картинки ' . $row['file_name']);
        throw new ApiError('not_found', 'Картинка не найдена');
    }
    while (ob_get_level() > 0) @ob_end_clean();
    $size = filesize($path);
    $etag = '"' . $id . '"'; // файл по id никогда не меняется
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
    header('Content-Length: ' . $size);
    if (request_method() !== 'HEAD') readfile($path);
}

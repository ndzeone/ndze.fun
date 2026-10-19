<?php
// Проверка входных данных — копия assets/js/data/validate.js (те же правила и тексты).
declare(strict_types=1);
defined('NDZE') || exit;

const CATEGORIES = ['art', 'design', 'photo', 'code', 'other'];
const SUB_STATUSES = ['pending', 'revision', 'ideal', 'rejected'];
const GAMES = ['minecraft', 'cs2', 'gta5rp'];
const TASK_STATUSES = ['new', 'accepted', 'live', 'done', 'rejected'];
const DIFFICULTIES = [1, 2, 3];

const LIM_NICK_RE = '/^[\p{L}0-9_]{3,20}$/u'; // \d в JS (без флага v) — только 0-9
const LIM_PASSWORD_MIN = 8;
const LIM_TITLE_MIN = 3;
const LIM_TITLE_MAX = 80;
const LIM_DESCRIPTION_MAX = 1500;
const LIM_COMMENT_MIN = 1;
const LIM_COMMENT_MAX = 1000;
const LIM_NOTE_MAX = 500;
const LIM_FILES_MAX = 5;
const LIM_FILE_BYTES = 10 * 1024 * 1024;
const LIM_IMAGE_MAX_SIDE = 1600;
const LIM_EMAIL_MAX = 191;

const EMAIL_RE = '/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u';

/** Значение → строка, как String(v ?? "") в JS; битый UTF-8 чинится. */
function raw_str($v): string
{
    if ($v === null) return '';
    if (is_bool($v)) $s = $v ? 'true' : 'false';
    elseif (is_int($v) || is_float($v)) $s = (string) $v;
    elseif (is_string($v)) $s = $v;
    else return '';
    if (!mb_check_encoding($s, 'UTF-8')) $s = mb_convert_encoding($s, 'UTF-8', 'UTF-8');
    return str_replace("\0", '', $s);
}

/** String(v ?? "").trim() — trim как в JS (юникодные пробелы тоже). */
function clean_str($v): string
{
    $s = raw_str($v);
    $t = preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/u', '', $s);
    return $t === null ? trim($s) : $t;
}

/** Длина в символах (кодовых точках), как [...s].length. */
function str_len(string $s): int
{
    return mb_strlen($s, 'UTF-8');
}

function valid_email(string $email): bool
{
    return $email !== '' && str_len($email) <= LIM_EMAIL_MAX && preg_match(EMAIL_RE, $email) === 1;
}

function check_sign_up(string $nick, string $email, string $password): array
{
    $e = [];
    if (!preg_match(LIM_NICK_RE, $nick)) $e['nick'] = '3–20 символов: буквы, цифры и _';
    if (!valid_email($email)) $e['email'] = 'Похоже, email с ошибкой';
    // String(password).length в JS — длина в UTF-16
    if (strlen(mb_convert_encoding($password, 'UTF-16LE', 'UTF-8')) / 2 < LIM_PASSWORD_MIN) $e['password'] = 'Минимум ' . LIM_PASSWORD_MIN . ' символов';
    return $e;
}

function check_sign_in(string $email, string $password): array
{
    $e = [];
    if (!valid_email($email)) $e['email'] = 'Похоже, email с ошибкой';
    if ($password === '') $e['password'] = 'Введи пароль';
    return $e;
}

function check_title(string $title): ?string
{
    $n = str_len($title);
    return $n < LIM_TITLE_MIN || $n > LIM_TITLE_MAX ? 'От ' . LIM_TITLE_MIN . ' до ' . LIM_TITLE_MAX . ' символов' : null;
}

/** Поля работы без файлов (файлы проверяет images.php → files_check). */
function check_submission(string $title, string $description, string $category, string $note): array
{
    $e = [];
    if ($m = check_title($title)) $e['title'] = $m;
    if (str_len($description) > LIM_DESCRIPTION_MAX) $e['description'] = 'Не больше ' . LIM_DESCRIPTION_MAX . ' символов';
    if (!in_array($category, CATEGORIES, true)) $e['category'] = 'Выбери категорию';
    if (str_len($note) > LIM_NOTE_MAX) $e['note'] = 'Не больше ' . LIM_NOTE_MAX . ' символов';
    return $e;
}

function check_note(string $note): array
{
    return str_len($note) > LIM_NOTE_MAX ? ['note' => 'Не больше ' . LIM_NOTE_MAX . ' символов'] : [];
}

function check_comment(string $text): array
{
    $n = str_len($text);
    return $n < LIM_COMMENT_MIN || $n > LIM_COMMENT_MAX ? ['text' => 'От 1 до ' . LIM_COMMENT_MAX . ' символов'] : [];
}

/**
 * checkReview: rating — целое 1..10 или null (ключа нет — не меняем); status — из SUB_STATUSES.
 * $b — тело запроса; проверяем только присутствующие ключи.
 */
function check_review(array $b): array
{
    $e = [];
    if (array_key_exists('rating', $b) && $b['rating'] !== null) {
        $r = $b['rating'];
        $isInt = is_int($r) || (is_float($r) && floor($r) === $r && is_finite($r));
        if (!$isInt || $r < 1 || $r > 10) $e['rating'] = 'Оценка от 1 до 10';
    }
    if (array_key_exists('status', $b) && !(is_string($b['status']) && in_array($b['status'], SUB_STATUSES, true))) {
        $e['status'] = 'Неизвестный статус';
    }
    return $e;
}

/** Number(difficulty) как в JS: 2, 2.0, "2" → 2; иначе null. */
function to_difficulty($v): ?int
{
    if (is_int($v)) $n = $v;
    elseif (is_float($v) && floor($v) === $v) $n = (int) $v;
    elseif (is_string($v) && preg_match('/^\s*\d+(\.0*)?\s*$/', $v)) $n = (int) $v;
    else return null;
    return in_array($n, DIFFICULTIES, true) ? $n : null;
}

function check_task(string $game, string $title, string $description, $difficulty): array
{
    $e = [];
    if (!in_array($game, GAMES, true)) $e['game'] = 'Выбери игру';
    if ($m = check_title($title)) $e['title'] = $m;
    if (str_len($description) > LIM_DESCRIPTION_MAX) $e['description'] = 'Не больше ' . LIM_DESCRIPTION_MAX . ' символов';
    if (to_difficulty($difficulty) === null) $e['difficulty'] = 'Выбери сложность';
    return $e;
}

function check_task_update(array $b): array
{
    $e = [];
    if (array_key_exists('status', $b) && !(is_string($b['status']) && in_array($b['status'], TASK_STATUSES, true))) {
        $e['status'] = 'Неизвестный статус';
    }
    if (array_key_exists('adminNote', $b) && $b['adminNote'] !== null && str_len(clean_str($b['adminNote'])) > LIM_NOTE_MAX) {
        $e['adminNote'] = 'Не больше ' . LIM_NOTE_MAX . ' символов';
    }
    return $e;
}

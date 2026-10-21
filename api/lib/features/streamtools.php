<?php
// Стрим-инструменты: расписание с обратным отсчётом и .ics, архив эфиров с таймкодами,
// цели канала и «зритель дня». В базе всё время — UTC; админ вводит московское (поле формы «МСК»).
declare(strict_types=1);
defined('NDZE') || exit;

const STX_TZ = 'Europe/Moscow';
const STX_SCHEDULE_DAYS = 14;          // публичное расписание — на две недели вперёд
const STX_MARK_KINDS = ['moment', 'task', 'work'];
const STX_GOAL_STATUSES = ['active', 'done'];
const STX_ARCHIVE_PAGE = 10;
const STX_MARKS_MAX = 200;             // таймкодов на один эфир
const STX_AT_MAX = 48 * 3600;          // таймкод — не дальше 48 часов от начала
const STX_GOAL_LIMIT = 1000000000;
const STX_VIEWER_TTL = 60;             // кэш «зрителя дня», секунд
const STX_VIEWER_PIXELS_CAP = 20;      // пиксели холста дают не больше 20 очков
// «зритель дня»: вес каждого действия за сегодняшние (московские) сутки
const STX_VIEWER_WEIGHTS = [
    'submissions' => 10, 'tasks' => 5, 'taskVotes' => 1, 'battleVotes' => 1, 'bets' => 2,
    'pixels' => 1, 'forumThreads' => 4, 'forumPosts' => 2, 'comments' => 2,
];

// админские записи — с запасом, но не бесконечно (защита от зациклившегося скрипта/вкладки)
rate_limit_define('stx_admin', 600, 3600);

route_add([
    'GET schedule' => 'route_stx_schedule',
    'GET schedule/ics' => 'route_stx_schedule_ics',
    'GET schedule/all' => 'route_stx_schedule_all',
    'POST schedule/save' => 'route_stx_schedule_save',
    'POST schedule/delete' => 'route_stx_schedule_delete',
    'GET archive' => 'route_stx_archive',
    'GET archive/suggest' => 'route_stx_archive_suggest',
    'POST archive/save' => 'route_stx_archive_save',
    'POST archive/delete' => 'route_stx_archive_delete',
    'POST archive/mark' => 'route_stx_mark_save',
    'POST archive/mark/delete' => 'route_stx_mark_delete',
    'GET goals' => 'route_stx_goals',
    'POST goals/save' => 'route_stx_goal_save',
    'POST goals/delete' => 'route_stx_goal_delete',
    'POST goals/bump' => 'route_stx_goal_bump',
    'GET viewer/today' => 'route_stx_viewer_today',
]);
route_raw('schedule/ics');

// значок за «зрителя дня» (история победителей — в settings.viewer_history)
metric_add('viewerOfDay', 'stx_metric_viewer_days');
badge_add('viewer_of_day', ['Зритель дня', 'Стать самым активным зрителем за сутки', '⭐', 'viewerOfDay', 1]);

/* ============================== Время ============================== */

function stx_utc(): DateTimeZone
{
    static $tz = null;
    return $tz ??= new DateTimeZone('UTC');
}

function stx_msk(): DateTimeZone
{
    static $tz = null;
    return $tz ??= new DateTimeZone(STX_TZ);
}

/** DATETIME из базы (UTC) → unix-время. */
function stx_ts(string $db): int
{
    return (new DateTimeImmutable(substr($db, 0, 19), stx_utc()))->getTimestamp();
}

/** unix-время → DATETIME(3) для базы. */
function stx_db(int $ts): string
{
    return gmdate('Y-m-d H:i:s', $ts) . '.000';
}

/** unix-время → ISO 8601 UTC (как iso()). */
function stx_iso(int $ts): string
{
    return gmdate('Y-m-d\TH:i:s', $ts) . '.000Z';
}

/** DATETIME (UTC) → «2026-10-21T20:00» по Москве (значение для <input type="datetime-local">). */
function stx_msk_local(string $db): string
{
    return (new DateTimeImmutable(substr($db, 0, 19), stx_utc()))->setTimezone(stx_msk())->format('Y-m-d\TH:i');
}

/**
 * Московское «2026-10-21T20:00» (или «2026-10-21 20:00[:ss]») → unix-время; null — неверная дата.
 * Разумные пределы: от двух лет назад до года вперёд.
 */
function stx_parse_msk($v): ?int
{
    if (!is_string($v) || !preg_match('/^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*$/', $v, $m)) return null;
    [$y, $mo, $d, $h, $mi] = [(int) $m[1], (int) $m[2], (int) $m[3], (int) $m[4], (int) $m[5]];
    $s = (int) ($m[6] ?? 0);
    if (!checkdate($mo, $d, $y) || $h > 23 || $mi > 59 || $s > 59) return null;
    $ts = (new DateTimeImmutable('now', stx_msk()))->setDate($y, $mo, $d)->setTime($h, $mi, $s)->getTimestamp();
    if ($ts < time() - 2 * 365 * 86400 || $ts > time() + 366 * 86400) return null;
    return $ts;
}

/** Начало московских суток (дата 'Y-m-d') в unix-времени. */
function stx_msk_day_start(string $day): int
{
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $day, stx_msk());
    return $d ? $d->getTimestamp() : 0;
}

/** Таймкод: 3723, "3723", "1:02:03", "62:03" → секунды; null — неверно. */
function stx_parse_at($v): ?int
{
    $n = null;
    if (is_int($v)) $n = $v;
    elseif (is_string($v)) {
        $v = trim($v);
        if (preg_match('/^\d{1,6}$/', $v)) $n = (int) $v;
        elseif (preg_match('/^(\d{1,2}):(\d{2}):(\d{2})$/', $v, $m)) {
            if ((int) $m[2] > 59 || (int) $m[3] > 59) return null;
            $n = (int) $m[1] * 3600 + (int) $m[2] * 60 + (int) $m[3];
        } elseif (preg_match('/^(\d{1,4}):(\d{2})$/', $v, $m)) {
            if ((int) $m[2] > 59) return null;
            $n = (int) $m[1] * 60 + (int) $m[2];
        }
    }
    return $n !== null && $n >= 0 && $n <= STX_AT_MAX ? $n : null;
}

/** Секунды → «1:02:03». */
function stx_at_text(int $sec): string
{
    return sprintf('%d:%02d:%02d', intdiv($sec, 3600), intdiv($sec % 3600, 60), $sec % 60);
}

/** Целое из JSON (int или строка цифр с минусом); null — не целое. */
function stx_int($v): ?int
{
    if (is_int($v)) return $v;
    if (is_float($v) && floor($v) === $v && abs($v) < 1e15) return (int) $v;
    if (is_string($v) && preg_match('/^\s*-?\d{1,15}\s*$/', $v)) return (int) $v;
    return null;
}

/** Общая шапка админских записей: админ + лимит. */
function stx_admin(): array
{
    $me = require_admin();
    session_release();
    rate_limit_hit('stx_admin', user_subject($me['id']));
    return $me;
}

/** Необязательная строка: '' → null. */
function stx_opt(string $s): ?string
{
    return $s === '' ? null : $s;
}

/* ============================== Расписание ============================== */

function stx_event_view(array $r, ?int $now = null): array
{
    $now ??= time();
    $start = stx_ts($r['starts_at']);
    $end = $start + (int) $r['duration_min'] * 60;
    return [
        'id' => $r['id'],
        'title' => $r['title'],
        'game' => $r['game'],
        'note' => $r['note'],
        'durationMin' => (int) $r['duration_min'],
        'startsAt' => stx_iso($start),
        'endsAt' => stx_iso($end),
        'startsAtMsk' => stx_msk_local($r['starts_at']),
        'isNow' => $start <= $now && $now < $end,
        'isPast' => $end <= $now,
    ];
}

/** Предстоящие (и идущие сейчас) эфиры до $until. */
function stx_upcoming(int $until, int $limit = 50): array
{
    $now = time();
    return q_all('SELECT * FROM stream_events WHERE starts_at < ? AND DATE_ADD(starts_at, INTERVAL duration_min MINUTE) > ?
                  ORDER BY starts_at ASC LIMIT ' . max(1, min(200, $limit)), [stx_db($until), stx_db($now)]);
}

function stx_find_event(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM stream_events WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Стрим в расписании не найден');
    return $row;
}

/** GET schedule → { now, next: Event|null, items: Event[] } — эфиры на 14 дней вперёд (идущий сейчас — первым). */
function route_stx_schedule(): array
{
    session_release();
    $now = time();
    $items = array_map(static fn($r) => stx_event_view($r, $now), stx_upcoming($now + STX_SCHEDULE_DAYS * 86400));
    // ближайший: если на 14 дней ничего нет — всё равно ищем следующий запланированный
    $next = $items[0] ?? null;
    if (!$next) {
        $row = stx_upcoming($now + 366 * 86400, 1)[0] ?? null;
        $next = $row ? stx_event_view($row, $now) : null;
    }
    return ['now' => stx_iso($now), 'next' => $next, 'items' => $items, 'channel' => twitch_channel()];
}

/** GET schedule/all (админ) → { items } — за 60 дней назад и всё впереди. */
function route_stx_schedule_all(): array
{
    require_admin();
    session_release();
    $now = time();
    $rows = q_all('SELECT * FROM stream_events WHERE starts_at >= ? ORDER BY starts_at ASC LIMIT 300', [stx_db($now - 60 * 86400)]);
    return ['items' => array_map(static fn($r) => stx_event_view($r, $now), $rows)];
}

/** POST schedule/save { id?, title, game?, startsAt (МСК «YYYY-MM-DDTHH:MM»), durationMin, note? } (админ) */
function route_stx_schedule_save(): array
{
    stx_admin();
    $b = request_body();
    $id = array_key_exists('id', $b) && $b['id'] !== null && $b['id'] !== '' ? norm_uuid($b['id']) : null;
    if ($id === null && !empty($b['id'])) throw new ApiError('validation', 'Неверный id');
    $title = clean_str($b['title'] ?? null);
    $game = clean_str($b['game'] ?? null);
    $note = clean_str($b['note'] ?? null);
    $start = stx_parse_msk($b['startsAt'] ?? null);
    $dur = stx_int($b['durationMin'] ?? 180);
    $e = [];
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if (str_len($game) > 60) $e['game'] = 'Игра — не длиннее 60 символов';
    if (str_len($note) > 300) $e['note'] = 'Заметка — не длиннее 300 символов';
    if ($start === null) $e['startsAt'] = 'Укажи дату и время начала (МСК)';
    if ($dur === null || $dur < 15 || $dur > 1440) $e['durationMin'] = 'Длительность от 15 до 1440 минут';
    assert_valid($e);
    if ($id !== null) {
        stx_find_event($id);
        q('UPDATE stream_events SET title = ?, game = ?, starts_at = ?, duration_min = ?, note = ? WHERE id = ?',
            [$title, stx_opt($game), stx_db($start), $dur, stx_opt($note), $id]);
    } else {
        $id = uuid4();
        q('INSERT INTO stream_events (id, title, game, starts_at, duration_min, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$id, $title, stx_opt($game), stx_db($start), $dur, stx_opt($note), now_db()]);
    }
    return stx_event_view(stx_find_event($id));
}

/** POST schedule/delete { id } (админ) */
function route_stx_schedule_delete(): ?array
{
    stx_admin();
    $ev = stx_find_event(norm_uuid(request_body()['id'] ?? null));
    q('DELETE FROM stream_events WHERE id = ?', [$ev['id']]);
    return null;
}

/* ---------- .ics ---------- */

/** Экранирование текста iCalendar (RFC 5545, 3.3.11). */
function stx_ics_text(string $s): string
{
    $s = str_replace(["\r\n", "\r"], "\n", $s);
    $s = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]/', '', $s) ?? '';
    return str_replace(['\\', ';', ',', "\n"], ['\\\\', '\\;', '\\,', '\\n'], $s);
}

/** Перенос длинной строки: не больше 75 октетов, не разрывая символ UTF-8; продолжение — с пробела. */
function stx_ics_fold(string $line): string
{
    $out = [];
    $cur = '';
    $limit = 75;
    foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $ch) {
        if (strlen($cur) + strlen($ch) > $limit) {
            $out[] = $cur;
            $cur = ' ';
            $limit = 75;
        }
        $cur .= $ch;
    }
    $out[] = $cur;
    return implode("\r\n", $out);
}

function stx_ics_time(int $ts): string
{
    return gmdate('Ymd\THis\Z', $ts);
}

/** Текст календаря для списка строк stream_events. */
function stx_ics_build(array $rows): string
{
    $host = parse_url(site_url(), PHP_URL_HOST);
    $host = is_string($host) && preg_match('/^[a-z0-9.-]+$/i', $host) ? strtolower($host) : 'ndze.fun';
    $chan = twitch_channel();
    $watch = 'https://www.twitch.tv/' . $chan;
    $lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ndze.fun//Stream schedule//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'X-WR-CALNAME:' . stx_ics_text('Стримы ndze'), 'X-WR-TIMEZONE:' . STX_TZ,
    ];
    $stamp = stx_ics_time(time());
    foreach ($rows as $r) {
        $start = stx_ts($r['starts_at']);
        $end = $start + (int) $r['duration_min'] * 60;
        $desc = [];
        if ($r['game']) $desc[] = 'Игра: ' . $r['game'];
        if ($r['note']) $desc[] = $r['note'];
        $desc[] = 'Смотреть: ' . $watch;
        array_push($lines,
            'BEGIN:VEVENT',
            'UID:' . $r['id'] . '@' . $host,
            'DTSTAMP:' . $stamp,
            'DTSTART:' . stx_ics_time($start),
            'DTEND:' . stx_ics_time($end),
            'SUMMARY:' . stx_ics_text('ndze: ' . $r['title']),
            'DESCRIPTION:' . stx_ics_text(implode("\n", $desc)),
            'LOCATION:' . stx_ics_text($watch),
            'URL:' . $watch,
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' . stx_ics_text('Стрим через 10 минут'), 'TRIGGER:-PT10M', 'END:VALARM',
            'END:VEVENT');
    }
    $lines[] = 'END:VCALENDAR';
    return implode("\r\n", array_map('stx_ics_fold', $lines)) . "\r\n";
}

/** GET schedule/ics[&id=…] → text/calendar: все предстоящие эфиры (или один). */
function route_stx_schedule_ics(): void
{
    session_release();
    $id = query_str('id');
    if ($id !== '') {
        $rows = [stx_find_event(norm_uuid($id))];
    } else {
        $rows = stx_upcoming(time() + 366 * 86400, 100);
    }
    $body = stx_ics_build($rows);
    while (ob_get_level() > 0) @ob_end_clean();
    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: attachment; filename="ndze-streams.ics"');
    header('Cache-Control: no-cache');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . strlen($body));
    if (request_method() !== 'HEAD') echo $body;
}

/* ============================== Архив эфиров ============================== */

/**
 * Ссылка на запись: только https Twitch (/videos/ID) или YouTube (watch?v=, youtu.be/, /live/).
 * Возвращает каноническую ссылку или null.
 */
function stx_vod_norm(string $url): ?string
{
    if (str_len($url) > 300 || preg_match('/\s/', $url)) return null;
    $p = parse_url($url);
    if (!is_array($p) || strtolower($p['scheme'] ?? '') !== 'https' || isset($p['user']) || isset($p['pass']) || isset($p['port'])) return null;
    $host = strtolower($p['host'] ?? '');
    $path = $p['path'] ?? '';
    if (in_array($host, ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'], true)) {
        return preg_match('#^/videos/(\d{1,15})/?$#', $path, $m) ? 'https://www.twitch.tv/videos/' . $m[1] : null;
    }
    $yt = null;
    if (in_array($host, ['youtube.com', 'www.youtube.com', 'm.youtube.com'], true)) {
        if ($path === '/watch') {
            parse_str((string) ($p['query'] ?? ''), $qs);
            $yt = is_string($qs['v'] ?? null) ? $qs['v'] : null;
        } elseif (preg_match('#^/live/([A-Za-z0-9_-]{11})/?$#', $path, $m)) {
            $yt = $m[1];
        }
    } elseif ($host === 'youtu.be' && preg_match('#^/([A-Za-z0-9_-]{11})/?$#', $path, $m)) {
        $yt = $m[1];
    }
    return $yt !== null && preg_match('/^[A-Za-z0-9_-]{11}$/', $yt) ? 'https://www.youtube.com/watch?v=' . $yt : null;
}

function stx_vod_kind(?string $url): ?string
{
    if (!$url) return null;
    if (str_starts_with($url, 'https://www.twitch.tv/videos/')) return 'twitch';
    if (str_starts_with($url, 'https://www.youtube.com/watch?v=')) return 'youtube';
    return null;
}

function stx_find_stream(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM stream_archive WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Эфир в архиве не найден');
    return $row;
}

function stx_mark_view(array $m): array
{
    return ['id' => $m['id'], 'at' => (int) $m['at_seconds'], 'atText' => stx_at_text((int) $m['at_seconds']),
        'label' => $m['label'], 'kind' => $m['kind'], 'refId' => $m['ref_id']];
}

/** Строки stream_archive → вид для фронтенда (с таймкодами). */
function stx_streams_view(array $rows): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $marks = [];
    foreach (q_all('SELECT * FROM stream_marks WHERE stream_id IN (' . placeholders(count($ids)) . ') ORDER BY at_seconds ASC, label ASC', $ids) as $m) {
        $marks[$m['stream_id']][] = stx_mark_view($m);
    }
    return array_map(static fn($r) => [
        'id' => $r['id'], 'title' => $r['title'], 'game' => $r['game'],
        'startedAt' => iso($r['started_at']), 'startedAtMsk' => stx_msk_local($r['started_at']),
        'vodUrl' => $r['vod_url'], 'vodKind' => stx_vod_kind($r['vod_url']), 'summary' => $r['summary'],
        'marks' => $marks[$r['id']] ?? [],
    ], $rows);
}

/** GET archive[&page=N] → { items, page, pages, total } — новые эфиры сверху. */
function route_stx_archive(): array
{
    session_release();
    $total = (int) q_one('SELECT COUNT(*) AS n FROM stream_archive')['n'];
    $pages = max(1, (int) ceil($total / STX_ARCHIVE_PAGE));
    $page = ctype_digit(query_str('page')) ? max(1, min($pages, (int) query_str('page'))) : 1;
    $rows = q_all('SELECT * FROM stream_archive ORDER BY started_at DESC, id DESC LIMIT ' . STX_ARCHIVE_PAGE . ' OFFSET ' . (($page - 1) * STX_ARCHIVE_PAGE));
    return ['items' => stx_streams_view($rows), 'page' => $page, 'pages' => $pages, 'total' => $total];
}

/** POST archive/save { id?, title, game?, startedAt (МСК), vodUrl?, summary? } (админ) */
function route_stx_archive_save(): array
{
    stx_admin();
    $b = request_body();
    $id = !empty($b['id']) ? norm_uuid($b['id']) : null;
    if ($id === null && !empty($b['id'])) throw new ApiError('validation', 'Неверный id');
    $title = clean_str($b['title'] ?? null);
    $game = clean_str($b['game'] ?? null);
    $summary = clean_str($b['summary'] ?? null);
    $vodRaw = clean_str($b['vodUrl'] ?? null);
    $vod = $vodRaw === '' ? null : stx_vod_norm($vodRaw);
    $start = stx_parse_msk($b['startedAt'] ?? null);
    $e = [];
    if (str_len($title) < 3 || str_len($title) > 120) $e['title'] = 'Название от 3 до 120 символов';
    if (str_len($game) > 60) $e['game'] = 'Игра — не длиннее 60 символов';
    if (str_len($summary) > 3000) $e['summary'] = 'Описание — не длиннее 3000 символов';
    if ($vodRaw !== '' && $vod === null) $e['vodUrl'] = 'Только https-ссылка на запись Twitch (twitch.tv/videos/…) или YouTube';
    if ($start === null) $e['startedAt'] = 'Укажи дату и время начала эфира (МСК)';
    elseif ($start > time() + 86400) $e['startedAt'] = 'Эфир из будущего? Для планов есть расписание';
    assert_valid($e);
    if ($id !== null) {
        stx_find_stream($id);
        q('UPDATE stream_archive SET title = ?, game = ?, started_at = ?, vod_url = ?, summary = ? WHERE id = ?',
            [$title, stx_opt($game), stx_db($start), $vod, stx_opt($summary), $id]);
    } else {
        $id = uuid4();
        q('INSERT INTO stream_archive (id, title, game, started_at, vod_url, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$id, $title, stx_opt($game), stx_db($start), $vod, stx_opt($summary), now_db()]);
    }
    return stx_streams_view([stx_find_stream($id)])[0];
}

/** POST archive/delete { id } (админ) — таймкоды удаляются каскадом. */
function route_stx_archive_delete(): ?array
{
    stx_admin();
    $s = stx_find_stream(norm_uuid(request_body()['id'] ?? null));
    q('DELETE FROM stream_archive WHERE id = ?', [$s['id']]);
    return null;
}

/** POST archive/mark { streamId, id?, at ("1:02:03" | секунды), label, kind: moment|task|work, refId? } (админ) → эфир целиком */
function route_stx_mark_save(): array
{
    stx_admin();
    $b = request_body();
    $at = stx_parse_at($b['at'] ?? null);
    $label = clean_str($b['label'] ?? null);
    $kind = is_string($b['kind'] ?? null) ? $b['kind'] : 'moment';
    $ref = ($b['refId'] ?? null) === null || $b['refId'] === '' ? null : norm_uuid($b['refId']);
    $e = [];
    if ($at === null) $e['at'] = 'Таймкод вида 1:02:03 (не больше 48 часов)';
    if (str_len($label) < 1 || str_len($label) > 160) $e['label'] = 'Подпись от 1 до 160 символов';
    if (!in_array($kind, STX_MARK_KINDS, true)) $e['kind'] = 'Неизвестный тип отметки';
    if ($ref === null && !empty($b['refId'])) $e['refId'] = 'Неверная ссылка на задание/работу';
    assert_valid($e);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        // блокируем эфир: лимит таймкодов не обойти параллельными запросами
        $s = q_one('SELECT id FROM stream_archive WHERE id = ? FOR UPDATE', [norm_uuid($b['streamId'] ?? null) ?? '']);
        if (!$s) throw new ApiError('not_found', 'Эфир в архиве не найден');
        $id = !empty($b['id']) ? norm_uuid($b['id']) : null;
        if (!empty($b['id']) && $id === null) throw new ApiError('validation', 'Неверный id отметки');
        if ($id !== null) {
            $m = q_one('SELECT id FROM stream_marks WHERE id = ? AND stream_id = ?', [$id, $s['id']]);
            if (!$m) throw new ApiError('not_found', 'Отметка не найдена');
            q('UPDATE stream_marks SET at_seconds = ?, label = ?, kind = ?, ref_id = ? WHERE id = ?', [$at, $label, $kind, $ref, $id]);
        } else {
            $n = (int) q_one('SELECT COUNT(*) AS n FROM stream_marks WHERE stream_id = ?', [$s['id']])['n'];
            if ($n >= STX_MARKS_MAX) throw new ApiError('validation', 'У эфира уже ' . STX_MARKS_MAX . ' таймкодов — хватит');
            if ($ref !== null && q_one('SELECT 1 AS x FROM stream_marks WHERE stream_id = ? AND ref_id = ?', [$s['id'], $ref])) {
                throw new ApiError('validation', 'Эта отметка уже добавлена');
            }
            q('INSERT INTO stream_marks (id, stream_id, at_seconds, label, kind, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
                [uuid4(), $s['id'], $at, $label, $kind, $ref]);
        }
        $pdo->commit();
    } catch (Throwable $ex) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $ex;
    }
    return stx_streams_view([stx_find_stream($s['id'])])[0];
}

/** POST archive/mark/delete { id } (админ) → эфир целиком */
function route_stx_mark_delete(): array
{
    stx_admin();
    $id = norm_uuid(request_body()['id'] ?? null);
    $m = $id ? q_one('SELECT id, stream_id FROM stream_marks WHERE id = ?', [$id]) : null;
    if (!$m) throw new ApiError('not_found', 'Отметка не найдена');
    q('DELETE FROM stream_marks WHERE id = ?', [$m['id']]);
    return stx_streams_view([stx_find_stream($m['stream_id'])])[0];
}

/**
 * GET archive/suggest&id=<эфир> (админ) → { day, items: [{ kind, refId, label, at, atText, time, added }] }
 * Подсказки таймкодов: задания, ставшие «На стриме»/«Выполнено», и работы, оценённые в день эфира
 * (московские сутки; если эфир перевалил за полночь — до 12 часов от начала).
 */
function route_stx_archive_suggest(): array
{
    require_admin();
    session_release();
    $s = stx_find_stream(norm_uuid(query_str('id')));
    $start = stx_ts($s['started_at']);
    $day = (new DateTimeImmutable('@' . $start))->setTimezone(stx_msk())->format('Y-m-d');
    $from = stx_msk_day_start($day);
    $to = max($from + 86400, $start + 12 * 3600);
    $added = [];
    foreach (q_all('SELECT ref_id FROM stream_marks WHERE stream_id = ? AND ref_id IS NOT NULL', [$s['id']]) as $r) $added[$r['ref_id']] = true;
    $items = [];
    $put = static function (string $kind, string $ref, string $label, string $when) use (&$items, $start, $added): void {
        $ts = stx_ts($when);
        $at = max(0, min(STX_AT_MAX, $ts - $start));
        $items[] = ['kind' => $kind, 'refId' => $ref, 'label' => mb_substr($label, 0, 160), 'at' => $at, 'atText' => stx_at_text($at),
            'time' => stx_iso($ts), 'added' => isset($added[$ref])];
    };
    $tasks = q_all("SELECT t.id, t.title, t.status, t.updated_at, u.nick FROM tasks t JOIN users u ON u.id = t.user_id
                    WHERE t.status IN ('live', 'done') AND t.updated_at >= ? AND t.updated_at < ? ORDER BY t.updated_at ASC LIMIT 100",
        [stx_db($from), stx_db($to)]);
    foreach ($tasks as $t) {
        $put('task', $t['id'], ($t['status'] === 'done' ? 'Выполнено задание: ' : 'Задание на стриме: ') . $t['title'] . ' (от @' . $t['nick'] . ')', $t['updated_at']);
    }
    $subs = q_all("SELECT s.id, s.title, s.status, s.rating, s.updated_at, u.nick FROM submissions s JOIN users u ON u.id = s.user_id
                   WHERE s.updated_at >= ? AND s.updated_at < ? AND (s.status IN ('ideal', 'revision', 'rejected') OR s.rating IS NOT NULL)
                   ORDER BY s.updated_at ASC LIMIT 100", [stx_db($from), stx_db($to)]);
    $st = ['ideal' => 'идеал', 'revision' => 'на доработку', 'rejected' => 'отклонена', 'pending' => 'оценка'];
    foreach ($subs as $w) {
        $what = $st[$w['status']] ?? $w['status'];
        if ($w['rating'] !== null) $what .= ', ' . (int) $w['rating'] . '/10';
        $put('work', $w['id'], 'Разбор работы «' . $w['title'] . '» @' . $w['nick'] . ' — ' . $what, $w['updated_at']);
    }
    usort($items, static fn($a, $b) => $a['at'] <=> $b['at']);
    return ['day' => $day, 'items' => $items];
}

/* ============================== Цели канала ============================== */

function stx_goal_view(array $g): array
{
    $cur = (int) $g['current_value'];
    $target = (int) $g['target_value'];
    return [
        'id' => $g['id'], 'title' => $g['title'], 'current' => $cur, 'target' => $target, 'unit' => $g['unit'],
        'sort' => (int) $g['sort'], 'status' => $g['status'],
        'percent' => $target > 0 ? max(0, min(100, (int) floor($cur * 100 / $target))) : 0,
        'reached' => $target > 0 && $cur >= $target,
        'updatedAt' => iso($g['updated_at']),
    ];
}

function stx_find_goal(?string $id): array
{
    $row = $id ? q_one('SELECT * FROM channel_goals WHERE id = ?', [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Цель не найдена');
    return $row;
}

/** GET goals → { items } — активные (по sort), затем выполненные. */
function route_stx_goals(): array
{
    session_release();
    $rows = q_all("SELECT * FROM channel_goals ORDER BY FIELD(status, 'active', 'done'), sort ASC, updated_at DESC LIMIT 60");
    return ['items' => array_map('stx_goal_view', $rows)];
}

/** POST goals/save { id?, title, current, target, unit?, sort?, status } (админ) */
function route_stx_goal_save(): array
{
    stx_admin();
    $b = request_body();
    $id = !empty($b['id']) ? norm_uuid($b['id']) : null;
    if ($id === null && !empty($b['id'])) throw new ApiError('validation', 'Неверный id');
    $title = clean_str($b['title'] ?? null);
    $unit = clean_str($b['unit'] ?? null);
    $cur = stx_int($b['current'] ?? 0);
    $target = stx_int($b['target'] ?? null);
    $sort = stx_int($b['sort'] ?? 0);
    $status = is_string($b['status'] ?? null) ? $b['status'] : 'active';
    $e = [];
    if (str_len($title) < 2 || str_len($title) > 120) $e['title'] = 'Название от 2 до 120 символов';
    if (str_len($unit) > 24) $e['unit'] = 'Единица — не длиннее 24 символов';
    if ($cur === null || abs($cur) > STX_GOAL_LIMIT) $e['current'] = 'Текущее значение — целое число';
    if ($target === null || $target < 1 || $target > STX_GOAL_LIMIT) $e['target'] = 'Цель — целое число больше нуля';
    if ($sort === null || abs($sort) > 100000) $e['sort'] = 'Порядок — целое число';
    if (!in_array($status, STX_GOAL_STATUSES, true)) $e['status'] = 'Статус: active или done';
    assert_valid($e);
    if ($id !== null) {
        stx_find_goal($id);
        q('UPDATE channel_goals SET title = ?, current_value = ?, target_value = ?, unit = ?, sort = ?, status = ?, updated_at = ? WHERE id = ?',
            [$title, $cur, $target, stx_opt($unit), $sort, $status, now_db(), $id]);
    } else {
        $id = uuid4();
        q('INSERT INTO channel_goals (id, title, current_value, target_value, unit, sort, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $title, $cur, $target, stx_opt($unit), $sort, $status, now_db()]);
    }
    return stx_goal_view(stx_find_goal($id));
}

/** POST goals/bump { id, delta } (админ) — быстро прибавить прямо во время стрима (атомарно). */
function route_stx_goal_bump(): array
{
    stx_admin();
    $b = request_body();
    $g = stx_find_goal(norm_uuid($b['id'] ?? null));
    $d = stx_int($b['delta'] ?? null);
    if ($d === null || $d === 0 || abs($d) > 1000000) throw new ApiError('validation', 'Шаг — целое число от −1 000 000 до 1 000 000, не ноль', ['delta' => 'Неверный шаг']);
    q('UPDATE channel_goals SET current_value = LEAST(GREATEST(current_value + ?, ?), ?), updated_at = ? WHERE id = ?',
        [$d, -STX_GOAL_LIMIT, STX_GOAL_LIMIT, now_db(), $g['id']]);
    return stx_goal_view(stx_find_goal($g['id']));
}

/** POST goals/delete { id } (админ) */
function route_stx_goal_delete(): ?array
{
    stx_admin();
    $g = stx_find_goal(norm_uuid(request_body()['id'] ?? null));
    q('DELETE FROM channel_goals WHERE id = ?', [$g['id']]);
    return null;
}

/* ============================== Зритель дня ============================== */

/** Очки за сегодня (с московской полуночи): [uid => ['score' => n, 'breakdown' => [ключ => штук]]]. */
function stx_viewer_scores(string $since): array
{
    $src = [
        'submissions' => 'SELECT user_id AS uid, COUNT(*) AS n FROM submissions WHERE created_at >= ? GROUP BY user_id',
        'tasks' => 'SELECT user_id AS uid, COUNT(*) AS n FROM tasks WHERE created_at >= ? GROUP BY user_id',
        'taskVotes' => 'SELECT user_id AS uid, COUNT(*) AS n FROM task_votes WHERE created_at >= ? GROUP BY user_id',
        'battleVotes' => 'SELECT user_id AS uid, COUNT(*) AS n FROM battle_votes WHERE created_at >= ? GROUP BY user_id',
        'bets' => 'SELECT user_id AS uid, COUNT(*) AS n FROM prediction_bets WHERE created_at >= ? GROUP BY user_id',
        'pixels' => 'SELECT user_id AS uid, COUNT(*) AS n FROM canvas_log WHERE user_id IS NOT NULL AND created_at >= ? GROUP BY user_id',
        'forumThreads' => 'SELECT user_id AS uid, COUNT(*) AS n FROM forum_threads WHERE created_at >= ? GROUP BY user_id',
        'forumPosts' => 'SELECT user_id AS uid, COUNT(*) AS n FROM forum_posts WHERE created_at >= ? GROUP BY user_id',
        'comments' => 'SELECT user_id AS uid, COUNT(*) AS n FROM submission_comments WHERE created_at >= ? GROUP BY user_id',
    ];
    $out = [];
    foreach ($src as $key => $sql) {
        try {
            $rows = q_all($sql, [$since]);
        } catch (Throwable $e) {
            error_log("[ndze] viewer $key: " . $e->getMessage());
            continue;
        }
        foreach ($rows as $r) {
            $n = (int) $r['n'];
            if ($n <= 0) continue;
            $pts = $n * STX_VIEWER_WEIGHTS[$key];
            if ($key === 'pixels') $pts = min($pts, STX_VIEWER_PIXELS_CAP);
            $out[$r['uid']]['score'] = ($out[$r['uid']]['score'] ?? 0) + $pts;
            $out[$r['uid']]['breakdown'][$key] = $n;
        }
    }
    return $out;
}

function stx_viewer_build(): array
{
    $day = msk_now()->format('Y-m-d');
    $scores = stx_viewer_scores(msk_today_start_utc());
    uasort($scores, static fn($a, $b) => $b['score'] <=> $a['score']);
    $cand = array_slice($scores, 0, 30, true); // запас на случай, если в топе админ
    $users = [];
    if ($cand) {
        foreach (q_all(USER_SELECT . ' WHERE u.id IN (' . placeholders(count($cand)) . ')', array_keys($cand)) as $u) $users[$u['id']] = $u;
    }
    $list = [];
    foreach ($cand as $uid => $s) {
        $u = $users[$uid] ?? null;
        if (!$u || is_admin_row($u['email'], $u['discord_id'])) continue; // стример сам себе не зритель
        $list[] = [
            'user' => ['id' => $u['id'], 'nick' => $u['nick'], 'avatarUrl' => avatar_url($u['id'], $u['avatar_file'] ?? null), 'frame' => $u['frame'] ?? null],
            'score' => (int) $s['score'],
            'breakdown' => $s['breakdown'],
        ];
    }
    // при равных очках — по нику, чтобы порядок не прыгал
    usort($list, static fn($a, $b) => $b['score'] <=> $a['score'] ?: strcmp(mb_strtolower($a['user']['nick']), mb_strtolower($b['user']['nick'])));
    $list = array_slice($list, 0, 5);
    if ($list) stx_viewer_remember($day, $list[0]['user']['id']);
    return ['day' => $day, 'top' => $list[0] ?? null, 'list' => $list, 'weights' => STX_VIEWER_WEIGHTS + ['pixelsCap' => STX_VIEWER_PIXELS_CAP]];
}

/** Запомнить лидера дня (для значка). Последний пересчёт за сутки и есть итог. */
function stx_viewer_remember(string $day, string $uid): void
{
    $h = setting_get('viewer_history', []);
    if (!is_array($h)) $h = [];
    if (($h[$day] ?? null) === $uid) return;
    $h[$day] = $uid;
    ksort($h);
    if (count($h) > 400) $h = array_slice($h, -400, null, true);
    setting_set('viewer_history', $h);
}

/** Метрика viewerOfDay: сколько завершённых суток пользователь был зрителем дня. */
function stx_metric_viewer_days(?string $userId, ?string $since): array
{
    $h = setting_get('viewer_history', []);
    if (!is_array($h)) return [];
    $today = msk_now()->format('Y-m-d');
    $sinceTs = $since !== null ? stx_ts($since) : null;
    $out = [];
    foreach ($h as $day => $uid) {
        if (!is_string($uid) || !is_string($day) || $day >= $today) continue; // сегодняшний лидер ещё может смениться
        if ($userId !== null && $uid !== $userId) continue;
        if ($sinceTs !== null && stx_msk_day_start($day) < $sinceTs) continue;
        $out[$uid] = ($out[$uid] ?? 0) + 1;
    }
    return $out;
}

/** GET viewer/today → { day, top: { user, score, breakdown } | null, list: top-5, weights } (кэш 60 с). */
function route_stx_viewer_today(): array
{
    session_release();
    $day = msk_now()->format('Y-m-d');
    $c = setting_get('viewer_today');
    if (is_array($c) && ($c['day'] ?? '') === $day && time() - (int) ($c['at'] ?? 0) < STX_VIEWER_TTL && is_array($c['data'] ?? null)) return $c['data'];
    $data = stx_viewer_build();
    setting_set('viewer_today', ['at' => time(), 'day' => $day, 'data' => $data]);
    return $data;
}

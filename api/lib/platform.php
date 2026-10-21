<?php
// Платформа для модулей api/lib/features/*.php: свои маршруты, события, уведомления, баллы, значки и опыт.
// Модуль ничего не правит в общих файлах — только вызывает функции отсюда при подключении.
declare(strict_types=1);
defined('NDZE') || exit;

/* ---------- Маршруты ---------- */
$GLOBALS['NDZE_ROUTES'] = [];

/** route_add(['GET polls' => 'route_polls', 'POST poll/vote' => 'route_poll_vote']) */
function route_add(array $routes): void
{
    foreach ($routes as $k => $fn) {
        if (isset($GLOBALS['NDZE_ROUTES'][$k])) throw new LogicException("Маршрут $k уже занят");
        $GLOBALS['NDZE_ROUTES'][$k] = $fn;
    }
}

/** Все маршруты: встроенные (ROUTES в index.php) + из модулей. Встроенные важнее. */
function all_routes(array $builtin): array
{
    foreach (array_intersect_key($GLOBALS['NDZE_ROUTES'], $builtin) as $k => $_) error_log("[ndze] маршрут модуля $k перекрыт встроенным");
    return $builtin + $GLOBALS['NDZE_ROUTES'];
}

/** Маршруты, которые отдаются не JSON (картинки и т. п.). */
$GLOBALS['NDZE_RAW_ROUTES'] = ['image' => true, 'avatar' => true];
function route_raw(string $route): void
{
    $GLOBALS['NDZE_RAW_ROUTES'][$route] = true;
}

/* ---------- События ---------- */
// event_emit('task.created', [...]) — слушатели (Discord-вебхук, push) подписываются через event_on.
// Слушатель не может сломать запрос: исключения только пишутся в лог.
$GLOBALS['NDZE_EVENTS'] = [];

function event_on(string $kind, callable $fn): void
{
    $GLOBALS['NDZE_EVENTS'][$kind][] = $fn;
}

function event_emit(string $kind, array $data = []): void
{
    foreach (array_merge($GLOBALS['NDZE_EVENTS'][$kind] ?? [], $GLOBALS['NDZE_EVENTS']['*'] ?? []) as $fn) {
        try {
            $fn($data, $kind);
        } catch (Throwable $e) {
            error_log("[ndze] event $kind: " . $e->getMessage());
        }
    }
}

/* ---------- Уведомления (колокольчик) ---------- */
/** Уведомить пользователя. link — относительная ссылка на сайте (например, forum.html#/t/<id>). */
function notify(string $userId, string $kind, string $text, ?string $link = null): void
{
    try {
        q('INSERT INTO notifications (user_id, kind, text, link, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
            [$userId, substr($kind, 0, 24), mb_substr($text, 0, 300), $link === null ? null : substr($link, 0, 300), now_db()]);
        event_emit('notify', ['userId' => $userId, 'kind' => $kind, 'text' => $text, 'link' => $link]);
    } catch (Throwable $e) {
        error_log('[ndze] notify: ' . $e->getMessage());
    }
}

/* ---------- Баллы ---------- */
// Баланс = 1000 + выигрыши ставок − ставки + сумма points_ledger (бонусы, награды, покупки).
function points_add(string $userId, int $delta, string $reason, ?string $ref = null): void
{
    q('INSERT INTO points_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)',
        [$userId, $delta, substr($reason, 0, 32), $ref === null ? null : substr($ref, 0, 64), now_db()]);
}

/**
 * Списать баллы, если хватает. Вызывать ВНУТРИ транзакции: блокирует строку пользователя,
 * так что два параллельных списания не уведут баланс в минус. Возвращает новый баланс.
 */
function points_spend(string $userId, int $amount, string $reason, ?string $ref = null): int
{
    if ($amount <= 0) throw new ApiError('validation', 'Неверная сумма');
    q('SELECT id FROM users WHERE id = ? FOR UPDATE', [$userId]);
    $bal = points_balance($userId);
    if ($bal < $amount) throw new ApiError('validation', "Не хватает баллов: нужно $amount, у тебя $bal");
    points_add($userId, -$amount, $reason, $ref);
    return $bal - $amount;
}

/* ---------- Значки, метрики и опыт ---------- */
// metric_add('quizScore', fn(?string $userId, ?string $since): array) — вернуть [userId => число].
// badge_add('quiz_master', ['Знаток', 'Набрать 50 очков в квизах', '🧠', 'quizScore', 50]).
// xp_add('quizScore', 2, 200) — 2 XP за единицу метрики, не больше 200 XP.
$GLOBALS['NDZE_METRICS'] = [];
$GLOBALS['NDZE_BADGES'] = [];
$GLOBALS['NDZE_XP'] = [];

function metric_add(string $name, callable $fn): void { $GLOBALS['NDZE_METRICS'][$name] = $fn; }
function badge_add(string $id, array $def): void { $GLOBALS['NDZE_BADGES'][$id] = $def; }
function xp_add(string $metric, int $perUnit, ?int $cap = null): void { $GLOBALS['NDZE_XP'][$metric] = [$perUnit, $cap]; }

/* ---------- Время по Москве (сутки, сезоны) ---------- */
function msk_now(): DateTimeImmutable
{
    return new DateTimeImmutable('now', new DateTimeZone('Europe/Moscow'));
}

/** Текущий сезон 'YYYY-MM' (календарный месяц по Москве). */
function season_id(?DateTimeImmutable $at = null): string
{
    return ($at ?? msk_now())->format('Y-m');
}

/** Начало сезона в UTC (для сравнения с created_at). */
function season_start_utc(string $season): string
{
    $d = DateTimeImmutable::createFromFormat('!Y-m', $season, new DateTimeZone('Europe/Moscow'));
    return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
}

/** Начало сегодняшних суток по Москве в UTC. */
function msk_today_start_utc(): string
{
    return msk_now()->setTime(0, 0)->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
}

/** Безопасная внутренняя ссылка для уведомлений и вебхуков. */
function site_url(string $path = ''): string
{
    $base = rtrim((string) cfg('site_url', 'https://ndze.fun'), '/');
    return $base . '/' . ltrim($path, '/');
}

<?php
// Экономика баллов: магазин наград, ежедневный бонус с серией, сезоны (календарный месяц по Москве),
// война команд «Лаймовые» против «Красных» и рамки аватарок (user_cosmetics.frame → User.frame).
declare(strict_types=1);
defined('NDZE') || exit;

const PT_TEAMS = ['lime' => 'Лаймовые', 'red' => 'Красные'];
const PT_ORDER_STATUSES = ['pending', 'done', 'refunded'];
const PT_SEASON_PRIZES = [1 => 1000, 2 => 500, 3 => 250];
const PT_SEASON_TTL = 60; // кэш сезонной таблицы, секунд
const PT_NOTE_MAX = 300;
const PT_COST_MAX = 1000000;
const PT_STOCK_MAX = 100000;
// id => [название, как получить]
const PT_FRAMES = [
    'gold' => ['Золото сезона', 'Занять 1-е место по опыту за сезон'],
    'silver' => ['Серебро сезона', 'Занять 2-е место по опыту за сезон'],
    'bronze' => ['Бронза сезона', 'Занять 3-е место по опыту за сезон'],
    'web' => ['Паутина', 'Достичь 5-го уровня'],
    'neon' => ['Неон', 'Достичь 8-го уровня'],
    'lime' => ['Лайм', 'Забирать ежедневный бонус 7 дней подряд'],
];
const PT_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// примеры наград для пустого магазина (кнопка в пульте): [иконка, название, описание, цена]
const PT_SHOP_EXAMPLES = [
    ['🎵', 'Заказать трек', 'Трек прозвучит на стриме. Напиши исполнителя и название в комментарии к заказу.', 300],
    ['🎬', 'Ник в титрах стрима', 'Твой ник появится в титрах в конце эфира.', 500],
    ['⚡', 'Задание вне очереди', 'Твоё задание на стрим пройдёт без голосования. Укажи его в комментарии.', 800],
    ['🎮', 'Выбрать игру на стрим', 'Ты выбираешь, во что ndze играет на одном из ближайших стримов.', 1500],
];

rate_limit_define('shop_buy', 10, 3600);     // покупки: 10 / час
rate_limit_define('daily_claim', 20, 3600);  // попытки забрать бонус: 20 / час
rate_limit_define('team_join', 10, 3600);    // вступление в команду: 10 / час
rate_limit_define('frame_set', 30, 3600);    // смена рамки: 30 / час

route_add([
    'GET shop' => 'route_pt_shop',
    'POST shop/buy' => 'route_pt_shop_buy',
    'GET shop/admin' => 'route_pt_shop_admin',
    'GET shop/orders' => 'route_pt_shop_orders',
    'POST shop/order' => 'route_pt_shop_order',
    'POST shop/item' => 'route_pt_shop_item',
    'POST shop/item/delete' => 'route_pt_shop_item_delete',
    'POST shop/seed' => 'route_pt_shop_seed',
    'GET daily' => 'route_pt_daily',
    'POST daily/claim' => 'route_pt_daily_claim',
    'GET season' => 'route_pt_season',
    'GET teams' => 'route_pt_teams',
    'POST team/join' => 'route_pt_team_join',
    'GET me/frames' => 'route_pt_frames',
    'POST me/frame' => 'route_pt_frame_set',
]);

/* ---------- Метрики, значок и опыт за ежедневный бонус ---------- */
/** WHERE для daily_claims по пользователю и дате (как в progress_metrics). */
function pt_claims_where(?string $userId, ?string $since): array
{
    $parts = [];
    $params = [];
    if ($userId !== null) { $parts[] = 'user_id = ?'; $params[] = $userId; }
    if ($since !== null) { $parts[] = 'created_at >= ?'; $params[] = $since; }
    return [$parts ? ' WHERE ' . implode(' AND ', $parts) : '', $params];
}

metric_add('dailyClaims', static function (?string $userId, ?string $since): array {
    [$w, $p] = pt_claims_where($userId, $since);
    $out = [];
    foreach (q_all("SELECT user_id, COUNT(*) AS n FROM daily_claims$w GROUP BY user_id", $p) as $r) $out[$r['user_id']] = (int) $r['n'];
    return $out;
});
metric_add('dailyStreakMax', static function (?string $userId, ?string $since): array {
    [$w, $p] = pt_claims_where($userId, $since);
    $out = [];
    foreach (q_all("SELECT user_id, MAX(streak) AS n FROM daily_claims$w GROUP BY user_id", $p) as $r) $out[$r['user_id']] = (int) $r['n'];
    return $out;
});
xp_add('dailyClaims', 2, 200);
badge_add('streak7', ['Неделя подряд', 'Забрать ежедневный бонус 7 дней подряд', '🔥', 'dailyStreakMax', 7]);

/* ---------- Помощники ---------- */
/** Целое из JSON: 5, "5", 5.0 → 5; иначе null. */
function pt_int($v): ?int
{
    if (is_int($v)) return $v;
    if (is_float($v) && is_finite($v) && floor($v) === $v) return (int) $v;
    if (is_string($v) && preg_match('/^\s*-?\d{1,9}\s*$/', $v)) return (int) $v;
    return null;
}

/** Транзакция: fn выполняется целиком или откатывается. */
function pt_tx(callable $fn)
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $res = $fn();
        $pdo->commit();
        return $res;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/** Пользователи по id → [id => {id, nick, avatarUrl, frame}]. */
function pt_users(array $ids): array
{
    $ids = array_values(array_unique(array_filter($ids, 'is_string')));
    if (!$ids) return [];
    $out = [];
    foreach (q_all(USER_SELECT . ' WHERE u.id IN (' . placeholders(count($ids)) . ')', $ids) as $u) {
        $out[$u['id']] = ['id' => $u['id'], 'nick' => $u['nick'], 'avatarUrl' => avatar_url($u['id'], $u['avatar_file'] ?? null), 'frame' => $u['frame'] ?? null];
    }
    return $out;
}

/* ---------- Время: сутки и сезоны по Москве ---------- */
function pt_today(): string
{
    return msk_now()->format('Y-m-d');
}

function pt_yesterday(): string
{
    return msk_now()->modify('-1 day')->format('Y-m-d');
}

/** Начало завтрашних суток по Москве (ISO UTC) — когда снова можно забрать бонус. */
function pt_tomorrow_iso(): string
{
    return iso(msk_now()->modify('+1 day')->setTime(0, 0)->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s'));
}

function pt_prev_season(): string
{
    return msk_now()->modify('first day of last month')->format('Y-m');
}

/** Конец сезона (начало следующего месяца по Москве) в UTC. */
function pt_season_end_utc(string $season): string
{
    $d = DateTimeImmutable::createFromFormat('!Y-m', $season, new DateTimeZone('Europe/Moscow'));
    return $d->modify('+1 month')->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
}

/** '2026-10' → 'Октябрь 2026'. */
function pt_season_label(string $season): string
{
    [$y, $m] = array_map('intval', explode('-', $season) + [1 => 1]);
    return (PT_MONTHS[$m - 1] ?? $season) . ' ' . $y;
}

/* ================= Ежедневный бонус ================= */
/** Сумма бонуса для дня серии: 20, 25, 30 … 70 (с 11-го дня не растёт). */
function pt_daily_amount(int $streak): int
{
    return 20 + 5 * min(max($streak, 1) - 1, 10);
}

function pt_daily_state(string $userId): array
{
    $today = pt_today();
    $yday = pt_yesterday();
    $by = [];
    foreach (q_all('SELECT day, streak, amount FROM daily_claims WHERE user_id = ? AND day IN (?, ?)', [$userId, $today, $yday]) as $r) $by[(string) $r['day']] = $r;
    $claimed = isset($by[$today]);
    // серия жива, если бонус забран сегодня или вчера
    $streak = $claimed ? (int) $by[$today]['streak'] : (isset($by[$yday]) ? (int) $by[$yday]['streak'] : 0);
    $max = (int) (q_one('SELECT COALESCE(MAX(streak), 0) AS s FROM daily_claims WHERE user_id = ?', [$userId])['s'] ?? 0);
    return [
        'claimedToday' => $claimed,
        'streak' => $streak,
        'maxStreak' => $max,
        'todayAmount' => $claimed ? (int) $by[$today]['amount'] : null,
        'nextAmount' => pt_daily_amount($streak + 1), // следующий бонус: сегодня (если не забран) или завтра
        'resetsAt' => pt_tomorrow_iso(),
    ];
}

/** GET daily → { claimedToday, streak, maxStreak, todayAmount, nextAmount, resetsAt, balance } */
function route_pt_daily(): array
{
    $me = require_user();
    session_release();
    return pt_daily_state($me['id']) + ['balance' => points_balance($me['id'])];
}

/** POST daily/claim → { amount, …daily, balance } — раз в сутки по Москве. */
function route_pt_daily_claim(): array
{
    $me = require_user();
    session_release();
    rate_limit_hit('daily_claim', user_subject($me['id']));
    $already = 'Бонус за сегодня уже получен — приходи завтра';
    $today = pt_today();
    try {
        [$streak, $amount] = pt_tx(static function () use ($me, $today, $already): array {
            q('SELECT id FROM users WHERE id = ? FOR UPDATE', [$me['id']]); // два клика подряд — по очереди
            if (q_one('SELECT 1 AS x FROM daily_claims WHERE user_id = ? AND day = ?', [$me['id'], $today])) throw new ApiError('validation', $already);
            $prev = q_one('SELECT streak FROM daily_claims WHERE user_id = ? AND day = ?', [$me['id'], pt_yesterday()]);
            $streak = $prev ? (int) $prev['streak'] + 1 : 1;
            $amount = pt_daily_amount($streak);
            q('INSERT INTO daily_claims (user_id, day, streak, amount, created_at) VALUES (?, ?, ?, ?, ?)', [$me['id'], $today, $streak, $amount, now_db()]);
            points_add($me['id'], $amount, 'daily', $today);
            return [$streak, $amount];
        });
    } catch (PDOException $e) {
        if (is_duplicate_key($e)) throw new ApiError('validation', $already); // гонка: PK (user_id, day)
        throw $e;
    }
    if ($streak === 7) notify($me['id'], 'streak', 'Неделя подряд! 🔥 Открыты значок «Неделя подряд» и рамка аватарки «Лайм»', 'profile.html#settings');
    return ['amount' => $amount] + pt_daily_state($me['id']) + ['balance' => points_balance($me['id'])];
}

/* ================= Магазин ================= */
function pt_item_view(array $r, bool $admin = false): array
{
    $stock = $r['stock'] === null ? null : (int) $r['stock'];
    $v = [
        'id' => $r['id'], 'title' => $r['title'], 'description' => $r['description'], 'icon' => $r['icon'],
        'cost' => (int) $r['cost'], 'stock' => $stock, 'soldOut' => $stock !== null && $stock <= 0,
    ];
    if ($admin) {
        $v += [
            'active' => (bool) (int) $r['active'], 'sort' => (int) $r['sort'], 'createdAt' => iso($r['created_at']),
            'orders' => (int) ($r['orders'] ?? 0), 'pending' => (int) ($r['pending'] ?? 0),
        ];
    }
    return $v;
}

const PT_ORDER_SELECT = 'SELECT o.*, i.title AS item_title, i.icon AS item_icon, u.nick AS user_nick, p.avatar_file AS user_avatar, uc.frame AS user_frame
  FROM shop_orders o JOIN shop_items i ON i.id = o.item_id JOIN users u ON u.id = o.user_id
  LEFT JOIN user_profiles p ON p.user_id = o.user_id LEFT JOIN user_cosmetics uc ON uc.user_id = o.user_id';

function pt_order_view(array $r, bool $admin = false): array
{
    $v = [
        'id' => $r['id'], 'item' => ['id' => $r['item_id'], 'title' => $r['item_title'], 'icon' => $r['item_icon']],
        'cost' => (int) $r['cost'], 'note' => $r['note'], 'status' => $r['status'], 'adminNote' => $r['admin_note'],
        'createdAt' => iso($r['created_at']), 'updatedAt' => iso($r['updated_at']),
    ];
    if ($admin) $v['user'] = ['id' => $r['user_id'], 'nick' => $r['user_nick'], 'avatarUrl' => avatar_url($r['user_id'], $r['user_avatar'] ?? null), 'frame' => $r['user_frame'] ?? null];
    return $v;
}

function pt_find_order(string $id, bool $admin = false): array
{
    $r = q_one(PT_ORDER_SELECT . ' WHERE o.id = ?', [$id]);
    if (!$r) throw new ApiError('not_found', 'Заказ не найден');
    return pt_order_view($r, $admin);
}

function pt_my_orders(string $userId, int $limit = 20): array
{
    return array_map('pt_order_view', q_all(PT_ORDER_SELECT . ' WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT ' . max(1, min($limit, 50)), [$userId]));
}

function pt_pending_count(): int
{
    return (int) (q_one("SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'pending'")['n'] ?? 0);
}

/** GET shop → { items (в продаже), balance (null для гостя), orders (мои последние) } */
function route_pt_shop(): array
{
    $me = current_user();
    session_release();
    $items = q_all('SELECT * FROM shop_items WHERE active = 1 ORDER BY sort ASC, created_at ASC');
    return [
        'items' => array_map('pt_item_view', $items),
        'balance' => $me ? points_balance($me['id']) : null,
        'orders' => $me ? pt_my_orders($me['id']) : [],
    ];
}

/** POST shop/buy { itemId, note? } → { order, balance, item } */
function route_pt_shop_buy(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $itemId = norm_uuid($b['itemId'] ?? null);
    if (!$itemId) throw new ApiError('validation', 'Выбери награду', ['itemId' => 'Выбери награду']);
    $note = clean_str($b['note'] ?? null);
    if (str_len($note) > PT_NOTE_MAX) throw new ApiError('validation', 'Комментарий — не больше ' . PT_NOTE_MAX . ' символов', ['note' => 'Не больше ' . PT_NOTE_MAX . ' символов']);
    rate_limit_hit('shop_buy', user_subject($me['id']));
    $orderId = uuid4();
    // цена, которую видел покупатель: если админ её поменял, не списываем молча другую сумму
    $expected = isset($b['expectedCost']) && is_int($b['expectedCost']) ? $b['expectedCost'] : null;
    $balance = pt_tx(static function () use ($me, $itemId, $note, $orderId, $expected): int {
        // строка награды под замком: остаток не уйдёт в минус при одновременных покупках
        $item = q_one('SELECT * FROM shop_items WHERE id = ? FOR UPDATE', [$itemId]);
        if (!$item || !(int) $item['active']) throw new ApiError('not_found', 'Такой награды нет в магазине');
        if ($expected !== null && $expected !== (int) $item['cost']) throw new ApiError('validation', "Цена изменилась: теперь {$item['cost']} баллов — обнови магазин");
        if ($item['stock'] !== null && (int) $item['stock'] <= 0) throw new ApiError('validation', 'Эта награда закончилась');
        $balance = points_spend($me['id'], (int) $item['cost'], 'shop', $orderId);
        if ($item['stock'] !== null) q('UPDATE shop_items SET stock = stock - 1 WHERE id = ?', [$itemId]);
        $t = now_db();
        q("INSERT INTO shop_orders (id, item_id, user_id, cost, note, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)",
            [$orderId, $itemId, $me['id'], (int) $item['cost'], $note === '' ? null : $note, $t, $t]);
        return $balance;
    });
    $item = q_one('SELECT * FROM shop_items WHERE id = ?', [$itemId]);
    return ['order' => pt_find_order($orderId), 'balance' => $balance, 'item' => $item ? pt_item_view($item) : null];
}

function pt_admin_items(): array
{
    return array_map(static fn($r) => pt_item_view($r, true), q_all(
        "SELECT i.*, (SELECT COUNT(*) FROM shop_orders o WHERE o.item_id = i.id) AS orders,
                (SELECT COUNT(*) FROM shop_orders o WHERE o.item_id = i.id AND o.status = 'pending') AS pending
         FROM shop_items i ORDER BY i.sort ASC, i.created_at ASC"));
}

/** GET shop/orders&status=pending|done|refunded (админ) → { items, pendingCount } — ожидающие сверху, старые первыми. */
function route_pt_shop_orders(): array
{
    require_admin();
    session_release();
    $status = query_str('status');
    $where = in_array($status, PT_ORDER_STATUSES, true) ? ' WHERE o.status = ?' : '';
    $rows = q_all(PT_ORDER_SELECT . $where . " ORDER BY o.status = 'pending' DESC,
        CASE WHEN o.status = 'pending' THEN o.created_at END ASC, o.updated_at DESC LIMIT 200", $where ? [$status] : []);
    return ['items' => array_map(static fn($r) => pt_order_view($r, true), $rows), 'pendingCount' => pt_pending_count()];
}

/** POST shop/order { id, status: done|refunded, adminNote? } (админ). Возврат баллов — ровно один раз. */
function route_pt_shop_order(): array
{
    require_admin();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    if (!$id) throw new ApiError('not_found', 'Заказ не найден');
    $status = (string) ($b['status'] ?? '');
    if (!in_array($status, ['done', 'refunded'], true)) throw new ApiError('validation', 'Статус: выполнен или возврат', ['status' => 'Неизвестный статус']);
    $note = clean_str($b['adminNote'] ?? null);
    if (str_len($note) > PT_NOTE_MAX) throw new ApiError('validation', 'Ответ — не больше ' . PT_NOTE_MAX . ' символов', ['adminNote' => 'Не больше ' . PT_NOTE_MAX . ' символов']);

    [$order, $from] = pt_tx(static function () use ($id, $status, $note): array {
        $o = q_one('SELECT o.*, i.title AS item_title FROM shop_orders o JOIN shop_items i ON i.id = o.item_id WHERE o.id = ? FOR UPDATE', [$id]);
        if (!$o) throw new ApiError('not_found', 'Заказ не найден');
        $from = $o['status'];
        if ($from === 'refunded' && $status !== 'refunded') throw new ApiError('validation', 'Баллы за этот заказ уже вернули — статус больше не меняется');
        q('UPDATE shop_orders SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [$status, $note === '' ? null : $note, now_db(), $id]);
        $already = q_one("SELECT 1 AS x FROM points_ledger WHERE reason = 'shop_refund' AND ref = ?", [$id]);
        if ($status === 'refunded' && $from !== 'refunded' && !$already) {
            points_add($o['user_id'], (int) $o['cost'], 'shop_refund', $id);
            q('UPDATE shop_items SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL', [$o['item_id']]);
        }
        return [$o, $from];
    });
    if ($from !== $status) {
        $title = $order['item_title'];
        $text = $status === 'done'
            ? "Заказ «{$title}» выполнен ✅" . ($note !== '' ? " — $note" : '')
            : "Заказ «{$title}» отменён — {$order['cost']} баллов вернулись" . ($note !== '' ? ". $note" : '');
        notify($order['user_id'], 'shop', $text, 'play.html#shop');
    }
    return pt_find_order($id, true);
}

/** POST shop/item { id?, title, description?, icon?, cost, stock (null — без ограничений), active, sort } (админ) */
function route_pt_shop_item(): array
{
    require_admin();
    session_release();
    $b = request_body();
    $id = null;
    if (isset($b['id']) && $b['id'] !== '') {
        $id = norm_uuid($b['id']);
        if (!$id || !q_one('SELECT id FROM shop_items WHERE id = ?', [$id])) throw new ApiError('not_found', 'Награда не найдена');
    }
    $title = clean_str($b['title'] ?? null);
    $desc = clean_str($b['description'] ?? null);
    $icon = clean_str($b['icon'] ?? null);
    $cost = pt_int($b['cost'] ?? null);
    $stockRaw = $b['stock'] ?? null;
    $stock = ($stockRaw === null || $stockRaw === '') ? null : pt_int($stockRaw);
    $sort = array_key_exists('sort', $b) && $b['sort'] !== '' && $b['sort'] !== null ? pt_int($b['sort']) : 0;
    $active = !array_key_exists('active', $b) || filter_var($b['active'], FILTER_VALIDATE_BOOLEAN);
    $e = [];
    if (str_len($title) < 2 || str_len($title) > 80) $e['title'] = 'Название от 2 до 80 символов';
    if (str_len($desc) > PT_NOTE_MAX) $e['description'] = 'Описание — не больше ' . PT_NOTE_MAX . ' символов';
    if (str_len($icon) > 8 || preg_match('/[<>"\'&\s]/u', $icon)) $e['icon'] = 'Иконка — один эмодзи';
    if ($cost === null || $cost < 1 || $cost > PT_COST_MAX) $e['cost'] = 'Цена от 1 до ' . PT_COST_MAX . ' баллов';
    if ($stockRaw !== null && $stockRaw !== '' && ($stock === null || $stock < 0 || $stock > PT_STOCK_MAX)) $e['stock'] = 'Остаток от 0 до ' . PT_STOCK_MAX . ' или пусто — без ограничений';
    if ($sort === null || $sort < -10000 || $sort > 10000) $e['sort'] = 'Порядок — целое число от −10000 до 10000';
    assert_valid($e);
    $vals = [$title, $desc === '' ? null : $desc, $icon === '' ? null : $icon, $cost, $stock, $active ? 1 : 0, $sort];
    if ($id) {
        q('UPDATE shop_items SET title = ?, description = ?, icon = ?, cost = ?, stock = ?, active = ?, sort = ? WHERE id = ?', array_merge($vals, [$id]));
    } else {
        $id = uuid4();
        q('INSERT INTO shop_items (id, title, description, icon, cost, stock, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', array_merge([$id], $vals, [now_db()]));
    }
    foreach (pt_admin_items() as $it) if ($it['id'] === $id) return $it;
    throw new ApiError('not_found', 'Награда не найдена');
}

/** POST shop/item/delete { id } (админ) — только если по награде ещё нет заказов (иначе выключить). */
function route_pt_shop_item_delete(): array
{
    require_admin();
    session_release();
    $id = norm_uuid(request_body()['id'] ?? null);
    if (!$id) throw new ApiError('not_found', 'Награда не найдена');
    pt_tx(static function () use ($id): void {
        if (!q_one('SELECT id FROM shop_items WHERE id = ? FOR UPDATE', [$id])) throw new ApiError('not_found', 'Награда не найдена');
        // заказы удалились бы каскадом вместе с историей и без возврата баллов — не даём
        if (q_one('SELECT 1 AS x FROM shop_orders WHERE item_id = ? LIMIT 1', [$id])) {
            throw new ApiError('validation', 'По этой награде уже есть заказы — сними её с продажи вместо удаления');
        }
        q('DELETE FROM shop_items WHERE id = ?', [$id]);
    });
    return ['id' => $id];
}

/** POST shop/seed (админ) — четыре примера наград, только в пустой магазин. */
function route_pt_shop_seed(): array
{
    require_admin();
    session_release();
    pt_tx(static function (): void {
        if ((int) q_one('SELECT COUNT(*) AS n FROM shop_items FOR UPDATE')['n'] > 0) {
            throw new ApiError('validation', 'В магазине уже есть награды — примеры добавляются только в пустой');
        }
        $t = now_db();
        foreach (PT_SHOP_EXAMPLES as $i => [$icon, $title, $desc, $cost]) {
            q('INSERT INTO shop_items (id, title, description, icon, cost, stock, active, sort, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)',
                [uuid4(), $title, $desc, $icon, $cost, ($i + 1) * 10, $t]);
        }
    });
    return ['items' => pt_admin_items()];
}

/** GET shop/admin (админ) → { items (все), pendingCount, season: статистика, awards } */
function route_pt_shop_admin(): array
{
    require_admin();
    session_release();
    pt_season_awards_safe();
    $season = season_id();
    $start = season_start_utc($season);
    $xp = pt_season_xp();
    $teams = pt_teams_view(null, $xp);
    $shop = q_one("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status <> 'refunded' THEN cost ELSE 0 END), 0) AS spent FROM shop_orders WHERE created_at >= ?", [$start]);
    $daily = q_one('SELECT COALESCE(SUM(day = ?), 0) AS today, COUNT(*) AS season, COALESCE(SUM(amount), 0) AS paid FROM daily_claims WHERE day >= ?', [pt_today(), $season . '-01']);
    $awards = q_all('SELECT season, user_id, place, xp FROM season_awards ORDER BY season DESC, place ASC LIMIT 9');
    $users = pt_users(array_column($awards, 'user_id'));
    return [
        'items' => pt_admin_items(),
        'pendingCount' => pt_pending_count(),
        'season' => [
            'id' => $season, 'label' => pt_season_label($season), 'endsAt' => iso(pt_season_end_utc($season)),
            'participants' => count($xp), 'top' => pt_top($xp, 3),
            'teams' => ['lime' => $teams['lime'], 'red' => $teams['red']],
            'dailyToday' => (int) $daily['today'], 'dailySeason' => (int) $daily['season'], 'dailyPaid' => (int) $daily['paid'],
            'shopOrders' => (int) $shop['n'], 'shopSpent' => (int) $shop['spent'],
        ],
        'awards' => array_values(array_filter(array_map(static fn($a) => isset($users[$a['user_id']])
            ? ['season' => $a['season'], 'label' => pt_season_label($a['season']), 'place' => (int) $a['place'], 'xp' => (int) $a['xp'], 'prize' => PT_SEASON_PRIZES[(int) $a['place']] ?? 0, 'user' => $users[$a['user_id']]]
            : null, $awards))),
    ];
}

/* ================= Сезоны ================= */
/** Опыт за текущий сезон: [userId => xp] по убыванию (только xp > 0). Кэш в settings на минуту. */
function pt_season_xp(): array
{
    $season = season_id();
    $c = setting_get('pt_season_xp');
    if (is_array($c) && ($c['season'] ?? '') === $season && time() - (int) ($c['at'] ?? 0) < PT_SEASON_TTL && is_array($c['xp'] ?? null)) return $c['xp'];
    $xp = pt_rank(progress_metrics(null, season_start_utc($season)));
    setting_set('pt_season_xp', ['at' => time(), 'season' => $season, 'xp' => (object) $xp]);
    return $xp;
}

/** Метрики → [userId => xp] по убыванию опыта (при равенстве — по id, чтобы порядок был стабильным). */
function pt_rank(array $metrics): array
{
    $rows = [];
    foreach ($metrics as $uid => $m) {
        $v = xp_of($m);
        if ($v > 0) $rows[] = [(string) $uid, $v];
    }
    usort($rows, static fn($a, $b) => $b[1] <=> $a[1] ?: strcmp($a[0], $b[0]));
    $out = [];
    foreach ($rows as [$uid, $v]) $out[$uid] = $v;
    return $out;
}

/** Первые $n мест: [{ place, user, xp }]. */
function pt_top(array $xp, int $n): array
{
    $slice = array_slice($xp, 0, $n, true);
    $users = pt_users(array_map('strval', array_keys($slice)));
    $out = [];
    $place = 0;
    foreach ($slice as $uid => $v) {
        $place++;
        if (isset($users[$uid])) $out[] = ['place' => $place, 'user' => $users[$uid], 'xp' => (int) $v];
    }
    return $out;
}

/**
 * Награды прошлого сезона: первый запрос нового месяца считает топ-3 прошлого месяца
 * (опыт с начала прошлого сезона минус уже набранный в текущем), пишет season_awards,
 * начисляет 1000 / 500 / 250 баллов и уведомляет победителей. Ровно один раз (GET_LOCK + отметка).
 */
function pt_season_awards_check(): void
{
    $prev = pt_prev_season();
    if (setting_get('pt_season_awarded') === $prev) return;
    $pdo = db();
    if ((int) $pdo->query("SELECT GET_LOCK('ndze_season_awards', 5)")->fetchColumn() !== 1) return;
    try {
        if (setting_get('pt_season_awarded') === $prev) return;
        if (q_one('SELECT 1 AS x FROM season_awards WHERE season = ? LIMIT 1', [$prev])) {
            setting_set('pt_season_awarded', $prev);
            return;
        }
        $all = progress_metrics(null, season_start_utc($prev));
        $after = progress_metrics(null, season_start_utc(season_id()));
        foreach ($all as $uid => &$m) {
            foreach ($after[$uid] ?? [] as $k => $n) $m[$k] = max(0, (int) ($m[$k] ?? 0) - (int) $n);
        }
        unset($m);
        $winners = array_slice(pt_rank($all), 0, 3, true);
        pt_tx(static function () use ($winners, $prev): void {
            $place = 0;
            $t = now_db();
            foreach ($winners as $uid => $v) {
                $place++;
                q('INSERT INTO season_awards (season, user_id, place, xp, created_at) VALUES (?, ?, ?, ?, ?)', [$prev, (string) $uid, $place, $v, $t]);
                points_add((string) $uid, PT_SEASON_PRIZES[$place], 'season', $prev);
            }
            setting_set('pt_season_awarded', $prev);
        });
        $place = 0;
        $frames = [1 => 'Золото', 2 => 'Серебро', 3 => 'Бронза'];
        foreach ($winners as $uid => $v) {
            $place++;
            notify((string) $uid, 'season', 'Сезон «' . pt_season_label($prev) . "»: ты на $place-м месте! +" . PT_SEASON_PRIZES[$place]
                . " баллов и рамка аватарки «{$frames[$place]}» 🏆", 'profile.html#settings');
        }
        if ($winners) event_emit('season.awarded', ['season' => $prev, 'winners' => array_map('strval', array_keys($winners))]);
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('ndze_season_awards')");
    }
}

/** Проверка наград не должна ронять страницу — ошибки только в лог. */
function pt_season_awards_safe(): void
{
    try {
        pt_season_awards_check();
    } catch (Throwable $e) {
        error_log('[ndze] season awards: ' . $e->getMessage());
    }
}

/** Последний награждённый сезон: { season, label, podium: [{ place, xp, prize, user }] } или null. */
function pt_last_awards(): ?array
{
    $last = q_one('SELECT season FROM season_awards ORDER BY season DESC LIMIT 1');
    if (!$last) return null;
    $rows = q_all('SELECT user_id, place, xp FROM season_awards WHERE season = ? ORDER BY place ASC', [$last['season']]);
    $users = pt_users(array_column($rows, 'user_id'));
    $podium = [];
    foreach ($rows as $r) {
        if (isset($users[$r['user_id']])) $podium[] = ['place' => (int) $r['place'], 'xp' => (int) $r['xp'], 'prize' => PT_SEASON_PRIZES[(int) $r['place']] ?? 0, 'user' => $users[$r['user_id']]];
    }
    return ['season' => $last['season'], 'label' => pt_season_label($last['season']), 'podium' => $podium];
}

/** GET season → { season, label, startsAt, endsAt, top, me, teams, lastAwards, prizes } */
function route_pt_season(): array
{
    $me = current_user();
    session_release();
    pt_season_awards_safe();
    $season = season_id();
    $xp = pt_season_xp();
    $mine = null;
    if ($me) {
        $pos = array_search($me['id'], array_map('strval', array_keys($xp)), true);
        $mine = ['place' => $pos === false ? null : $pos + 1, 'xp' => (int) ($xp[$me['id']] ?? 0)];
    }
    return [
        'season' => $season, 'label' => pt_season_label($season),
        'startsAt' => iso(season_start_utc($season)), 'endsAt' => iso(pt_season_end_utc($season)),
        'participants' => count($xp),
        'top' => pt_top($xp, 10),
        'me' => $mine,
        'teams' => pt_teams_view($me, $xp),
        'lastAwards' => pt_last_awards(),
        'prizes' => PT_SEASON_PRIZES,
    ];
}

/* ================= Команды ================= */
function pt_teams_view(?array $me, ?array $xp = null): array
{
    $season = season_id();
    $xp ??= pt_season_xp();
    $teams = [];
    foreach (PT_TEAMS as $id => $name) $teams[$id] = ['id' => $id, 'name' => $name, 'members' => 0, 'score' => 0, 'list' => []];
    $mine = null;
    foreach (q_all('SELECT user_id, team FROM user_teams WHERE season = ?', [$season]) as $r) {
        if (!isset($teams[$r['team']])) continue;
        $v = (int) ($xp[$r['user_id']] ?? 0);
        $teams[$r['team']]['members']++;
        $teams[$r['team']]['score'] += $v;
        $teams[$r['team']]['list'][$r['user_id']] = $v;
        if ($me && $r['user_id'] === $me['id']) $mine = $r['team'];
    }
    $topIds = [];
    foreach ($teams as $id => $t) {
        arsort($t['list']);
        $teams[$id]['list'] = array_slice($t['list'], 0, 3, true);
        $topIds = array_merge($topIds, array_map('strval', array_keys($teams[$id]['list'])));
    }
    $users = pt_users($topIds);
    $out = ['season' => $season, 'label' => pt_season_label($season), 'endsAt' => iso(pt_season_end_utc($season))];
    foreach ($teams as $id => $t) {
        $top3 = [];
        foreach ($t['list'] as $uid => $v) if (isset($users[$uid])) $top3[] = ['user' => $users[$uid], 'xp' => $v];
        unset($t['list']);
        $out[$id] = $t + ['top3' => $top3];
    }
    $out['mine'] = $mine;
    return $out;
}

/** GET teams → { season, label, endsAt, lime: {id,name,members,score,top3}, red: {…}, mine } (публично — и для оверлея) */
function route_pt_teams(): array
{
    $me = current_user();
    session_release();
    return pt_teams_view($me);
}

/** POST team/join { team: lime|red } — один раз за сезон, без переходов. */
function route_pt_team_join(): array
{
    $me = require_user();
    session_release();
    $team = request_body()['team'] ?? null;
    if (!is_string($team) || !isset(PT_TEAMS[$team])) throw new ApiError('validation', 'Выбери команду', ['team' => 'Выбери команду']);
    rate_limit_hit('team_join', user_subject($me['id']));
    $season = season_id();
    $taken = static function () use ($me, $season): ApiError {
        $have = q_one('SELECT team FROM user_teams WHERE user_id = ? AND season = ?', [$me['id'], $season]);
        $name = PT_TEAMS[$have['team'] ?? ''] ?? '';
        return new ApiError('validation', "Ты уже в команде «{$name}» — сменить её можно только в следующем сезоне");
    };
    if (q_one('SELECT 1 AS x FROM user_teams WHERE user_id = ? AND season = ?', [$me['id'], $season])) throw $taken();
    try {
        q('INSERT INTO user_teams (user_id, season, team, joined_at) VALUES (?, ?, ?, ?)', [$me['id'], $season, $team, now_db()]);
    } catch (PDOException $e) {
        if (is_duplicate_key($e)) throw $taken();
        throw $e;
    }
    return pt_teams_view($me);
}

/* ================= Рамки аватарок ================= */
/** Какие рамки открыты: [frame => bool] + уровень и лучшая серия. */
function pt_frames_state(string $userId): array
{
    $places = array_map('intval', array_column(q_all('SELECT DISTINCT place FROM season_awards WHERE user_id = ?', [$userId]), 'place'));
    $level = (int) user_progress($userId)['level'];
    $streak = (int) (q_one('SELECT COALESCE(MAX(streak), 0) AS s FROM daily_claims WHERE user_id = ?', [$userId])['s'] ?? 0);
    return [
        'open' => [
            'gold' => in_array(1, $places, true), 'silver' => in_array(2, $places, true), 'bronze' => in_array(3, $places, true),
            'web' => $level >= 5, 'neon' => $level >= 8, 'lime' => $streak >= 7,
        ],
        'level' => $level, 'maxStreak' => $streak,
    ];
}

function pt_frames_view(string $userId): array
{
    $st = pt_frames_state($userId);
    $cur = q_one('SELECT frame FROM user_cosmetics WHERE user_id = ?', [$userId])['frame'] ?? null;
    $frames = [];
    foreach (PT_FRAMES as $id => [$title, $req]) $frames[] = ['id' => $id, 'title' => $title, 'requirement' => $req, 'available' => $st['open'][$id]];
    return ['current' => $cur, 'frames' => $frames, 'level' => $st['level'], 'maxStreak' => $st['maxStreak']];
}

/** GET me/frames → { current, frames: [{ id, title, requirement, available }], level, maxStreak } */
function route_pt_frames(): array
{
    $me = require_user();
    session_release();
    pt_season_awards_safe();
    return pt_frames_view($me['id']);
}

/** POST me/frame { frame: id | null } → { current, frames…, user } */
function route_pt_frame_set(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $frame = $b['frame'] ?? null;
    if ($frame === '') $frame = null;
    if ($frame !== null && (!is_string($frame) || !isset(PT_FRAMES[$frame]))) throw new ApiError('validation', 'Нет такой рамки', ['frame' => 'Нет такой рамки']);
    rate_limit_hit('frame_set', user_subject($me['id']));
    if ($frame !== null && !pt_frames_state($me['id'])['open'][$frame]) {
        throw new ApiError('forbidden', 'Эта рамка ещё не открыта: ' . mb_strtolower(PT_FRAMES[$frame][1]));
    }
    q('INSERT INTO user_cosmetics (user_id, frame, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE frame = VALUES(frame), updated_at = VALUES(updated_at)',
        [$me['id'], $frame, now_db()]);
    return pt_frames_view($me['id']) + ['user' => public_user(q_one(USER_SELECT . ' WHERE u.id = ?', [$me['id']]))];
}

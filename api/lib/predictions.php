<?php
// Ставки на стрим — только сайтовые баллы (не деньги). У каждого 1000 стартовых баллов;
// баланс = 1000 + выплаты − ставки. Выплата делит весь банк между угадавшими пропорционально ставке.
declare(strict_types=1);
defined('NDZE') || exit;

const POINTS_START = 1000;
const BET_MIN = 10;
const PRED_STATUSES = ['open', 'locked', 'resolved', 'cancelled'];

function points_balance(string $userId): int
{
    $r = q_one('SELECT COALESCE(SUM(COALESCE(payout, 0)), 0) AS won, COALESCE(SUM(amount), 0) AS spent FROM prediction_bets WHERE user_id = ?', [$userId]);
    $l = q_one('SELECT COALESCE(SUM(delta), 0) AS d FROM points_ledger WHERE user_id = ?', [$userId]);
    return POINTS_START + (int) $r['won'] - (int) $r['spent'] + (int) $l['d'];
}

function find_prediction(?string $id, bool $lock = false): array
{
    $row = $id ? q_one('SELECT * FROM predictions WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]) : null;
    if (!$row) throw new ApiError('not_found', 'Ставка не найдена');
    return $row;
}

/** Строки predictions → вид для фронтенда (пулы по вариантам, моя ставка). */
function predictions_view(array $rows, ?array $me): array
{
    if (!$rows) return [];
    $ids = array_column($rows, 'id');
    $in = placeholders(count($ids));
    $pools = [];
    foreach (q_all("SELECT prediction_id, option_idx, COUNT(*) AS n, SUM(amount) AS pool FROM prediction_bets WHERE prediction_id IN ($in) GROUP BY prediction_id, option_idx", $ids) as $r) {
        $pools[$r['prediction_id']][(int) $r['option_idx']] = ['pool' => (int) $r['pool'], 'bettors' => (int) $r['n']];
    }
    $mine = [];
    if ($me) {
        foreach (q_all("SELECT prediction_id, option_idx, amount, payout FROM prediction_bets WHERE user_id = ? AND prediction_id IN ($in)", array_merge([$me['id']], $ids)) as $r) {
            $mine[$r['prediction_id']] = ['option' => (int) $r['option_idx'], 'amount' => (int) $r['amount'], 'payout' => $r['payout'] === null ? null : (int) $r['payout']];
        }
    }
    $out = [];
    foreach ($rows as $p) {
        $opts = json_decode($p['options'], true) ?: [];
        $total = 0;
        $list = [];
        foreach ($opts as $i => $text) {
            $pl = $pools[$p['id']][$i] ?? ['pool' => 0, 'bettors' => 0];
            $total += $pl['pool'];
            $list[] = ['text' => $text] + $pl;
        }
        $out[] = [
            'id' => $p['id'], 'question' => $p['question'], 'options' => $list, 'status' => $p['status'],
            'result' => $p['result'] === null ? null : (int) $p['result'], 'totalPool' => $total,
            'createdAt' => iso($p['created_at']), 'updatedAt' => iso($p['updated_at']),
            'myBet' => $mine[$p['id']] ?? null,
        ];
    }
    return $out;
}

/** GET predictions → { items, balance (null для гостя) } — открытые сверху, затем последние завершённые. */
function route_predictions(): array
{
    $me = current_user();
    session_release();
    $rows = q_all("SELECT * FROM predictions ORDER BY FIELD(status, 'open', 'locked', 'resolved', 'cancelled'), created_at DESC LIMIT 20");
    return ['items' => predictions_view($rows, $me), 'balance' => $me ? points_balance($me['id']) : null, 'start' => POINTS_START];
}

/** POST prediction/bet { id, option, amount } */
function route_prediction_bet(): array
{
    $me = require_user();
    session_release();
    $b = request_body();
    $id = norm_uuid($b['id'] ?? null);
    $opt = $b['option'] ?? null;
    $amount = $b['amount'] ?? null;
    if (!is_int($opt) && !(is_string($opt) && ctype_digit($opt))) throw new ApiError('validation', 'Выбери вариант', ['option' => 'Выбери вариант']);
    if (!is_int($amount) && !(is_string($amount) && ctype_digit($amount))) throw new ApiError('validation', 'Укажи ставку', ['amount' => 'Укажи ставку']);
    $opt = (int) $opt;
    $amount = (int) $amount;

    $pdo = db();
    $pdo->beginTransaction();
    try {
        q('SELECT id FROM users WHERE id = ? FOR UPDATE', [$me['id']]); // одна ставка пользователя за раз — баланс не уйдёт в минус
        $p = find_prediction($id, true);
        if ($p['status'] !== 'open') throw new ApiError('validation', 'Ставки на этот вопрос уже закрыты');
        $opts = json_decode($p['options'], true) ?: [];
        if ($opt < 0 || $opt >= count($opts)) throw new ApiError('validation', 'Нет такого варианта', ['option' => 'Нет такого варианта']);
        if (q_one('SELECT 1 AS x FROM prediction_bets WHERE prediction_id = ? AND user_id = ?', [$p['id'], $me['id']])) {
            throw new ApiError('validation', 'Ты уже поставил на этот вопрос');
        }
        $balance = points_balance($me['id']);
        if ($amount < BET_MIN || $amount > $balance) {
            $msg = $balance < BET_MIN ? 'Баллы закончились — дождись итогов прошлых ставок' : 'Ставка от ' . BET_MIN . ' до ' . $balance . ' баллов';
            throw new ApiError('validation', $msg, ['amount' => $msg]);
        }
        q('INSERT INTO prediction_bets (prediction_id, user_id, option_idx, amount, payout, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
            [$p['id'], $me['id'], $opt, $amount, now_db()]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    return ['item' => predictions_view([find_prediction($id)], $me)[0], 'balance' => points_balance($me['id'])];
}

/** POST prediction/create { question, options: string[] } (админ) */
function route_prediction_create(): array
{
    $me = require_admin();
    session_release();
    $b = request_body();
    $q = clean_str($b['question'] ?? null);
    $opts = is_array($b['options'] ?? null) ? array_values(array_filter(array_map('clean_str', $b['options']), static fn($s) => $s !== '')) : [];
    $e = [];
    if (str_len($q) < 3 || str_len($q) > 160) $e['question'] = 'Вопрос от 3 до 160 символов';
    if (count($opts) < 2 || count($opts) > 4) $e['options'] = 'Нужно от 2 до 4 вариантов';
    foreach ($opts as $o) if (str_len($o) > 40) $e['options'] = 'Вариант — не длиннее 40 символов';
    assert_valid($e);
    $id = uuid4();
    $t = now_db();
    q('INSERT INTO predictions (id, question, options, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
        [$id, $q, json_encode_safe($opts), 'open', $t, $t]);
    $view = predictions_view([find_prediction($id)], $me)[0];
    event_emit('prediction.open', ['prediction' => $view]);
    return $view;
}

/** POST prediction/update { id, action: lock | open | resolve | cancel, option? } (админ) */
function route_prediction_update(): array
{
    $me = require_admin();
    session_release();
    $b = request_body();
    $action = (string) ($b['action'] ?? '');
    if (!in_array($action, ['lock', 'open', 'resolve', 'cancel'], true)) throw new ApiError('validation', 'Неизвестное действие');
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $p = find_prediction(norm_uuid($b['id'] ?? null), true);
        if (in_array($p['status'], ['resolved', 'cancelled'], true)) throw new ApiError('validation', 'Ставка уже завершена');
        $t = now_db();
        if ($action === 'lock' || $action === 'open') {
            q('UPDATE predictions SET status = ?, updated_at = ? WHERE id = ?', [$action === 'lock' ? 'locked' : 'open', $t, $p['id']]);
        } elseif ($action === 'cancel') {
            q('UPDATE prediction_bets SET payout = amount WHERE prediction_id = ?', [$p['id']]);
            q("UPDATE predictions SET status = 'cancelled', updated_at = ? WHERE id = ?", [$t, $p['id']]);
        } else {
            $opts = json_decode($p['options'], true) ?: [];
            $res = $b['option'] ?? null;
            if (!is_int($res) || $res < 0 || $res >= count($opts)) throw new ApiError('validation', 'Выбери, какой вариант сбылся');
            $bets = q_all('SELECT user_id, option_idx, amount FROM prediction_bets WHERE prediction_id = ?', [$p['id']]);
            $total = array_sum(array_map(static fn($x) => (int) $x['amount'], $bets));
            $winPool = array_sum(array_map(static fn($x) => (int) $x['option_idx'] === $res ? (int) $x['amount'] : 0, $bets));
            foreach ($bets as $x) {
                // никто не угадал — всем возвращаем ставки
                $pay = $winPool === 0 ? (int) $x['amount'] : ((int) $x['option_idx'] === $res ? intdiv((int) $x['amount'] * $total, $winPool) : 0);
                q('UPDATE prediction_bets SET payout = ? WHERE prediction_id = ? AND user_id = ?', [$pay, $p['id'], $x['user_id']]);
            }
            q("UPDATE predictions SET status = 'resolved', result = ?, updated_at = ? WHERE id = ?", [$res, $t, $p['id']]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    if ($action === 'resolve' || $action === 'cancel') {
        foreach (q_all('SELECT user_id, amount, payout FROM prediction_bets WHERE prediction_id = ?', [$p['id']]) as $bet) {
            $diff = (int) $bet['payout'] - (int) $bet['amount'];
            $text = $action === 'cancel' ? "Ставка «{$p['question']}» отменена — баллы вернулись"
                : ($diff > 0 ? "Ставка «{$p['question']}» сыграла: +$diff баллов 🔮" : "Ставка «{$p['question']}» не сыграла");
            notify($bet['user_id'], 'bet', $text, 'play.html#bets');
        }
    }
    $view = predictions_view([find_prediction($p['id'])], $me)[0];
    event_emit('prediction.' . $action, ['prediction' => $view]);
    return $view;
}

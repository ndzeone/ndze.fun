<?php
// Настройки сайта (таблица settings, значения — JSON) и статус «в эфире» на Twitch.
declare(strict_types=1);
defined('NDZE') || exit;

function setting_get(string $k, $default = null)
{
    $row = q_one('SELECT v FROM settings WHERE k = ?', [$k]);
    if (!$row) return $default;
    $v = json_decode($row['v'], true);
    return $v ?? $default;
}

function setting_set(string $k, $v): void
{
    q('INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)',
        [$k, json_encode_safe($v), now_db()]);
}

/* ---------- Twitch: идёт ли стрим ---------- */
// decapi.me — публичная обёртка над Twitch API без ключа. Ответ кэшируется в settings на минуту,
// так что сколько бы посетителей ни было, Twitch спрашиваем не чаще раза в минуту.
const LIVE_TTL = 60;

function twitch_channel(): string
{
    $c = (string) cfg('twitch_channel', 'ndze_one');
    return preg_match('/^[A-Za-z0-9_]{3,25}$/', $c) ? $c : 'ndze_one';
}

function live_fetch(): array
{
    $chan = twitch_channel();
    $up = http_request('GET', 'https://decapi.me/twitch/uptime/' . $chan, [], null, 4);
    $text = trim($up['body']);
    if ($up['status'] !== 200 || $text === '') return ['live' => false, 'ok' => false];
    // офлайн: «ndze_one is offline»; ошибки decapi начинаются с «Error» / «No user»
    $live = !preg_match('/\boffline\b|^error|^no user|not found/i', $text);
    $out = ['live' => $live, 'ok' => true, 'uptime' => $live ? mb_substr($text, 0, 80) : null, 'title' => null, 'game' => null];
    if ($live) {
        foreach (['title', 'game'] as $what) {
            $r = http_request('GET', "https://decapi.me/twitch/$what/$chan", [], null, 4);
            if ($r['status'] === 200 && trim($r['body']) !== '') $out[$what] = mb_substr(trim($r['body']), 0, 160);
        }
    }
    return $out;
}

/** Текущий статус (из кэша или свежий). */
function live_status(): array
{
    $c = setting_get('live');
    if (!is_array($c) || time() - (int) ($c['checkedAt'] ?? 0) >= LIVE_TTL) {
        // сначала «занимаем» проверку: остальные запросы в эту минуту отдадут кэш, а не пойдут в decapi сами
        $c = (is_array($c) ? $c : ['live' => false]);
        $c['checkedAt'] = time();
        setting_set('live', $c);
        $fresh = live_fetch();
        if ($fresh['ok']) {
            $c = $fresh + ['checkedAt' => time(), 'okAt' => time()];
        } elseif (time() - (int) ($c['okAt'] ?? 0) > 600) {
            $c['live'] = false; // decapi молчит больше 10 минут — не держим плашку «в эфире» вечно
        }
        $c['checkedAt'] = time();
        setting_set('live', $c);
    }
    return [
        'live' => (bool) ($c['live'] ?? false),
        'channel' => twitch_channel(),
        'title' => $c['title'] ?? null,
        'game' => $c['game'] ?? null,
        'uptime' => $c['uptime'] ?? null,
        'checkedAt' => gmdate('Y-m-d\TH:i:s.000\Z', (int) $c['checkedAt']),
    ];
}

/** GET live → { live, channel, title, game, uptime, checkedAt } */
function route_live(): array
{
    session_release();
    return live_status();
}

<?php
// JSON-ответы, ошибки API, разбор тела запроса, CSRF, HTTPS и IP клиента.
declare(strict_types=1);
defined('NDZE') || exit;

const ERROR_MESSAGES = [
    'auth_required' => 'Нужно войти в аккаунт',
    'forbidden' => 'Недостаточно прав',
    'not_found' => 'Не найдено',
    'validation' => 'Проверь заполнение полей',
    'invalid_credentials' => 'Неверный email или пароль',
    'email_taken' => 'Этот email уже зарегистрирован',
    'nick_taken' => 'Этот ник уже занят',
    'rate_limited' => 'Слишком много запросов, подожди немного',
    'unknown' => 'Что-то пошло не так',
];

const ERROR_STATUS = [
    'validation' => 400,
    'auth_required' => 401,
    'invalid_credentials' => 401,
    'forbidden' => 403,
    'not_found' => 404,
    'email_taken' => 409,
    'nick_taken' => 409,
    'rate_limited' => 429,
    'unknown' => 500,
];

/** Ошибка, которую видит клиент: { code, message, fields }. */
final class ApiError extends RuntimeException
{
    public string $apiCode;
    public ?array $fields;
    public int $status;

    public function __construct(string $code, ?string $message = null, ?array $fields = null, ?int $status = null)
    {
        $this->apiCode = isset(ERROR_STATUS[$code]) ? $code : 'unknown';
        $this->fields = $fields ?: null;
        $this->status = $status ?? ERROR_STATUS[$this->apiCode];
        parent::__construct($message ?: (ERROR_MESSAGES[$this->apiCode] ?? ERROR_MESSAGES['unknown']));
    }
}

/** Бросает validation с ошибками по полям (как assertValid в validate.js). */
function assert_valid(array $errors): void
{
    if ($errors) throw new ApiError('validation', (string) reset($errors), $errors);
}

function json_encode_safe($value): string
{
    $s = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($s === false) throw new RuntimeException('json_encode: ' . json_last_error_msg());
    return $s;
}

function send_json(int $status, array $payload): void
{
    while (ob_get_level() > 0) @ob_end_clean();
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    echo json_encode_safe($payload);
}

function respond_ok($data): void
{
    send_json(200, ['ok' => true, 'data' => $data]);
}

function respond_error(ApiError $e): void
{
    if ($e->status === 429) header('Retry-After: 60');
    send_json($e->status, ['ok' => false, 'error' => [
        'code' => $e->apiCode,
        'message' => $e->getMessage(),
        'fields' => $e->fields,
    ]]);
}

function request_method(): string
{
    return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
}

/** Тело POST: JSON или multipart/x-www-form-urlencoded (тогда $_POST). */
function request_body(): array
{
    static $body = null;
    if ($body !== null) return $body;
    $type = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    if (str_starts_with($type, 'multipart/form-data') || str_starts_with($type, 'application/x-www-form-urlencoded')) {
        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if (!$_POST && !$_FILES && $length > ini_bytes((string) ini_get('post_max_size'))) {
            $mb = (int) floor(ini_bytes((string) ini_get('post_max_size')) / 1048576);
            throw new ApiError('validation', "Слишком большой запрос: файлы вместе больше $mb МБ", ['files' => "Файлы вместе больше $mb МБ"]);
        }
        return $body = $_POST;
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, 1048577);
    if (strlen($raw) > 1048576) throw new ApiError('validation', 'Слишком большой запрос');
    if (trim($raw) === '') return $body = [];
    $data = json_decode($raw, true, 32);
    if (!is_array($data) || ($data && array_keys($data) === range(0, count($data) - 1))) {
        throw new ApiError('validation', 'Неверный формат запроса (нужен JSON-объект)');
    }
    return $body = $data;
}

/** '64M' → байты. */
function ini_bytes(string $v): int
{
    $v = trim($v);
    if ($v === '' || $v === '-1') return PHP_INT_MAX;
    $n = (int) $v;
    switch (strtolower(substr($v, -1))) {
        case 'g': $n *= 1024;
        // no break
        case 'm': $n *= 1024;
        // no break
        case 'k': $n *= 1024;
    }
    return $n;
}

/** HTTPS напрямую или через прокси хостинга (nginx → Apache). */
function is_https(): bool
{
    $https = strtolower((string) ($_SERVER['HTTPS'] ?? ''));
    if ($https !== '' && $https !== 'off' && $https !== '0') return true;
    if ((string) ($_SERVER['SERVER_PORT'] ?? '') === '443') return true;
    $proto = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    if ($proto === 'https') return true;
    if (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on') return true;
    return strtolower((string) ($_SERVER['REQUEST_SCHEME'] ?? '')) === 'https';
}

/**
 * IP клиента. Заголовкам X-Forwarded-For / X-Real-IP верим только если запрос пришёл
 * с локального/внутреннего адреса (прокси хостинга), иначе их может подделать кто угодно.
 */
function client_ip(): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $isPublic = filter_var($remote, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    if ($remote !== '' && !$isPublic) {
        $real = trim((string) ($_SERVER['HTTP_X_REAL_IP'] ?? ''));
        if (filter_var($real, FILTER_VALIDATE_IP)) return $real;
        $xff = array_filter(array_map('trim', explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))));
        $last = end($xff);
        if ($last !== false && filter_var($last, FILTER_VALIDATE_IP)) return $last;
    }
    return $remote !== '' ? $remote : '0.0.0.0';
}

/**
 * CSRF: каждый POST обязан иметь X-Requested-With: ndze (простая форма с чужого сайта
 * не может его поставить, а fetch с чужого origin упрётся в CORS preflight),
 * а Origin, если он есть, должен совпадать с хостом сайта.
 */
function check_csrf(): void
{
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'ndze') {
        throw new ApiError('forbidden', 'Запрос отклонён: нет заголовка X-Requested-With');
    }
    if (isset($_SERVER['HTTP_ORIGIN']) && !origin_matches_host((string) $_SERVER['HTTP_ORIGIN'])) {
        throw new ApiError('forbidden', 'Запрос отклонён: чужой Origin');
    }
}

function origin_matches_host(string $origin): bool
{
    $o = parse_url($origin);
    if (!is_array($o) || empty($o['host']) || !in_array(strtolower($o['scheme'] ?? ''), ['http', 'https'], true)) return false;
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? ''));
    if ($host === '') return false;
    // Host: «example.com», «example.com:8080», «[::1]:8080»
    $hostPort = null;
    if (preg_match('/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/', $host, $m)) {
        $hostName = $m[1];
        $hostPort = isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null;
    } else {
        return false;
    }
    $originHost = strtolower($o['host']);
    if (str_contains($originHost, ':') && $originHost[0] !== '[') $originHost = '[' . $originHost . ']';
    if ($originHost !== $hostName) return false;
    $defaultPort = strtolower($o['scheme']) === 'https' ? 443 : 80;
    $originPort = isset($o['port']) ? (int) $o['port'] : $defaultPort;
    if ($hostPort === null) return $originPort === 80 || $originPort === 443; // прокси мог отрезать порт
    return $originPort === $hostPort;
}

/** Строка из запроса (GET-параметр). */
function query_str(string $key): string
{
    $v = $_GET[$key] ?? '';
    return is_string($v) ? $v : '';
}

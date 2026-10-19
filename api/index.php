<?php
// Единая точка входа API: api/index.php?r=<маршрут>. Протокол — API.md.
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

const ROUTES = [
    'GET me' => 'route_me',
    'POST auth/register' => 'route_register',
    'POST auth/login' => 'route_login',
    'POST auth/logout' => 'route_logout',
    'GET submissions' => 'route_submissions_list',
    'GET submission' => 'route_submission_get',
    'POST submissions' => 'route_submission_create',
    'POST submission/version' => 'route_submission_version',
    'POST submission/comment' => 'route_submission_comment',
    'POST submission/review' => 'route_submission_review',
    'POST submission/delete' => 'route_submission_delete',
    'GET image' => 'route_image',
    'GET tasks' => 'route_tasks_list',
    'POST tasks' => 'route_task_create',
    'POST task/vote' => 'route_task_vote',
    'POST task/update' => 'route_task_update',
    'POST task/delete' => 'route_task_delete',
    'GET me/profile' => 'route_profile',
    'POST me/update' => 'route_profile_update',
    'POST me/password' => 'route_password_change',
    'POST me/avatar' => 'route_avatar_upload',
    'POST me/avatar/delete' => 'route_avatar_delete',
    'POST me/discord/unlink' => 'route_discord_unlink',
    'GET avatar' => 'route_avatar',
    'GET stats' => 'route_stats',
    'GET health' => 'route_health',
    'GET health/discord' => 'route_health_discord',
];

function route_me(): ?array
{
    $u = current_user();
    session_release();
    return public_user($u);
}

function route_register(): array
{
    return auth_register(request_body());
}

function route_login(): array
{
    return auth_login(request_body());
}

function route_logout(): ?array
{
    session_logout();
    return null;
}

try {
    $method = request_method();
    if ($method === 'HEAD') $method = 'GET';
    $route = trim(query_str('r'), "/ \t");
    $handler = ROUTES[$method . ' ' . $route] ?? null;
    if ($handler === null) {
        $exists = isset(ROUTES['GET ' . $route]) || isset(ROUTES['POST ' . $route]);
        throw new ApiError('not_found', $exists ? 'Метод не поддерживается для этого маршрута' : 'Неизвестный маршрут API');
    }
    if ($method === 'POST') check_csrf();
    if ($route !== 'health' && config() === null) {
        throw new ApiError('unknown', 'Сервер ещё не настроен (нет api/config.php)', null, 503);
    }
    $data = $handler();
    if ($route !== 'image' && $route !== 'avatar') respond_ok($data); // картинки отдаются сами
} catch (ApiError $e) {
    respond_error($e);
} catch (Throwable $e) {
    error_log('[ndze] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    $msg = cfg('debug') === true ? 'Ошибка сервера: ' . $e->getMessage() : null;
    respond_error(new ApiError('unknown', $msg));
}

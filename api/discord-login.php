<?php
// Старт входа через Discord: api/discord-login.php?return=/страница → 302 на discord.com.
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
$GLOBALS['NDZE_FATAL_MODE'] = 'redirect';

try {
    discord_login();
} catch (Throwable $e) {
    error_log('[ndze] discord login: ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    redirect(return_url(safe_return_path($_GET['return'] ?? '/'), ['auth' => 'discord_error', 'reason' => 'server']));
}

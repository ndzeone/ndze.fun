<?php
// Возврат с Discord: обмен code на токен, вход, 302 обратно на сайт с ?auth=discord | ?auth=discord_error&reason=…
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
$GLOBALS['NDZE_FATAL_MODE'] = 'redirect';

discord_callback(); // сам ловит все исключения и всегда отвечает редиректом

<?php
// Добавляет ?v=<версия> ко всем своим скриптам и стилям перед выкладкой (запускает GitHub Actions).
//
// Зачем: .js и .css кэшируются браузером на неделю. Без версии в адресе посетитель после деплоя
// получал бы новый HTML со старыми скриптами (так и было: на главной висели заглушки Discord).
// Меняются: <script src="assets/…js"> и <link href="assets/…css"> в *.html, а также относительные
// import / export … from / import() внутри assets/js — у модулей своя цепочка загрузки.
//
//   php tools/stamp-assets.php <версия> [корень сайта]
declare(strict_types=1);

$version = $argv[1] ?? '';
if (!preg_match('/^[0-9A-Za-z._-]{4,40}$/', $version)) {
    fwrite(STDERR, "usage: php tools/stamp-assets.php <version: 4-40 chars [0-9A-Za-z._-]> [root]\n");
    exit(2);
}
$root = rtrim($argv[2] ?? dirname(__DIR__), '/\\');
$suffix = '?v=' . $version;

// пути вида assets/…, /assets/… и ./assets/… (404.html работает на любом пути, поэтому там абсолютные)
$htmlRes = [
    '/(<script\b[^>]*\bsrc=")((?:\.?\/)?assets\/[^"?#]+\.js)(")/',
    '/(<link\b[^>]*\bhref=")((?:\.?\/)?assets\/[^"?#]+\.css)(")/',
    '/(\bfrom\s*")((?:\.?\/)?assets\/[^"?#]+\.js)(")/',              // встроенный <script type="module">
    '/(\bimport\s*\(\s*")((?:\.?\/)?assets\/[^"?#]+\.js)(")/',
];
$jsRes = [
    '/(\bfrom\s*")(\.{1,2}\/[^"?#]+\.js)(")/',        // import … from "./x.js", export … from "./x.js"
    '/(\bimport\s*\(\s*")(\.{1,2}\/[^"?#]+\.js)(")/', // import("./x.js")
    '/(\bimport\s*")(\.{1,2}\/[^"?#]+\.js)(")/',      // import "./x.js"
];

function stamp(string $file, array $patterns, string $suffix): int
{
    $text = (string) file_get_contents($file);
    $total = 0;
    foreach ($patterns as $rx) {
        $text = preg_replace_callback($rx, static fn($m) => $m[1] . $m[2] . $suffix . $m[3], $text, -1, $n);
        $total += $n;
    }
    if ($total) file_put_contents($file, $text);
    return $total;
}

$html = 0;
foreach (glob($root . '/*.html') ?: [] as $f) $html += stamp($f, $htmlRes, $suffix);
$js = 0;
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/assets/js', FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) if ($f->isFile() && str_ends_with($f->getFilename(), '.js')) $js += stamp($f->getPathname(), $jsRes, $suffix);

echo "stamped $html html refs, $js module imports with $suffix\n";
if ($html === 0 || $js === 0) {
    fwrite(STDERR, "nothing stamped — check the patterns\n");
    exit(1);
}

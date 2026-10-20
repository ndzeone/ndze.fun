<?php
// Генератор баннеров для карточек Discord-серверов и проектов → assets/img/banners/*.svg
//   php tools/make-banners.php        (рисует заново penta.svg и mythosmc.svg; случайность с фиксированным seed)
// Пиксельная сетка 60×20 клеток по 20px = 1200×400; анимация — SMIL (работает и в <img>).
declare(strict_types=1);
$out = $argv[1] ?? dirname(__DIR__) . '/assets/img/banners';
@mkdir($out, 0777, true);

$C = 60; $R = 20;
$px = static fn(int $x, int $y, string $c, int $w = 1, int $h = 1): string => '<rect x="' . ($x * 20) . '" y="' . ($y * 20) . '" width="' . ($w * 20) . '" height="' . ($h * 20) . '" fill="' . $c . '"/>';
$mix = static function (string $a, string $b, float $t): string {
    $ca = sscanf($a, '#%02x%02x%02x'); $cb = sscanf($b, '#%02x%02x%02x');
    return sprintf('#%02x%02x%02x', ...array_map(fn($i) => (int) round($ca[$i] + ($cb[$i] - $ca[$i]) * $t), [0, 1, 2]));
};
$walk = static function (int $min, int $max, int $start) use ($C): array {
    $h = []; $v = $start;
    for ($x = 0; $x < $C; $x++) { $v += mt_rand(-1, 1); if (mt_rand(0, 5) === 0) $v += mt_rand(-1, 1); $v = max($min, min($max, $v)); $h[$x] = $v; }
    return $h;
};
$head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">'
    . '<defs><filter id="blur" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>'
    . '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
$stars = static function (int $n, int $maxRow, string $col) use ($C): string {
    $s = '';
    for ($i = 0; $i < $n; $i++) {
        $size = mt_rand(0, 4) === 0 ? 8 : 4;
        $s .= '<rect x="' . (mt_rand(0, $C - 1) * 20 + mt_rand(0, 12)) . '" y="' . (mt_rand(0, $maxRow) * 20 + mt_rand(0, 12)) . '" width="' . $size . '" height="' . $size . '" fill="' . $col . '"><animate attributeName="opacity" values="1;.2;1" dur="' . (2 + mt_rand(0, 4)) . 's" begin="-' . mt_rand(0, 5) . 's" repeatCount="indefinite"/></rect>';
    }
    return $s;
};
$grass = ['#4caf50', '#3e9b41', '#5fc35f', '#43a447'];
$dirt = ['#5a3d24', '#6b4a2b', '#4a321d', '#634427'];
$stone = ['#3a3f3c', '#454b47', '#33383a', '#404643'];

/* ================= Penta SMP (Pentagrove): ночь, парящий замок, красные огни ================= */
mt_srand(5);
$s = [$head];
for ($y = 0; $y < $R; $y++) {
    $t = $y / ($R - 1);
    $s[] = $px(0, $y, $t < .6 ? $mix('#08061a', '#1d0c2c', $t / .6) : $mix('#1d0c2c', '#4a0f1f', ($t - .6) / .4), $C, 1);
}
// красный луч как полоса на иконке «P» и зарево за замком
$s[] = '<g filter="url(#blur)" shape-rendering="auto"><path d="M330 420 L 900 -40" stroke="#ff2d3f" stroke-width="46" opacity=".32"><animate attributeName="opacity" values=".18;.4;.18" dur="5s" repeatCount="indefinite"/></path>'
     . '<ellipse cx="600" cy="190" rx="240" ry="120" fill="#ff3b4a" opacity=".22"/></g>';
$s[] = $stars(52, 9, '#fff2f4');
// луны
$s[] = $px(7, 2, '#f3ecff', 3, 3) . $px(7, 2, '#ffffff') . $px(8, 3, '#d9d0ee') . $px(9, 4, '#e6def7');
$s[] = $px(52, 3, '#e9e2fb', 2, 2) . $px(53, 4, '#cfc6e6');
// падающая звезда
$s[] = '<g shape-rendering="auto"><path d="M0 0 L -90 30" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0"><animateTransform attributeName="transform" type="translate" values="1150 30;850 130" dur="7s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;.7;.75;.85;1" dur="7s" repeatCount="indefinite"/></path></g>';
// дальние холмы
$ground = 17;
$far = $walk(3, 7, 5);
foreach ($far as $x => $h) $s[] = $px($x, $ground - $h, '#1a0c1f', 1, $h) . $px($x, $ground - $h, '#2a1027');
// парящий остров с замком (качается)
$isl = '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -12;0 0" dur="5s" repeatCount="indefinite"/>';
$rows = [[24, 12, 'grass'], [25, 10, 'dirt'], [26, 8, 'dirt'], [27, 6, 'rock'], [28, 4, 'rock'], [29, 2, 'rock']];
foreach ($rows as $i => [$x0, $w, $kind]) {
    for ($x = $x0; $x < $x0 + $w; $x++) {
        $col = $kind === 'grass' ? $grass[mt_rand(0, 3)] : ($kind === 'dirt' ? $dirt[mt_rand(0, 3)] : ['#3a2b33', '#2f2229', '#45333d'][mt_rand(0, 2)]);
        $isl .= $px($x, 11 + $i, $col);
    }
}
// белый замок: стены, башни, зубцы, шпиль
$wall = ['#e6e1f0', '#d6d0e4', '#c9c2da'];
for ($y = 7; $y <= 10; $y++) for ($x = 26; $x <= 33; $x++) $isl .= $px($x, $y, $wall[mt_rand(0, 2)]);
foreach ([26, 33] as $tx) { for ($y = 5; $y <= 10; $y++) $isl .= $px($tx, $y, $wall[mt_rand(0, 2)]); $isl .= $px($tx, 4, '#b8b0cc'); }
for ($y = 3; $y <= 10; $y++) for ($x = 29; $x <= 30; $x++) $isl .= $px($x, $y, $wall[mt_rand(0, 2)]);
$isl .= $px(29, 2, '#b8b0cc', 2, 1) . '<rect x="590" y="10" width="20" height="30" fill="#ff3b4a"/>' . '<rect x="596" y="0" width="8" height="12" fill="#ff8a95"/>';
foreach ([27, 28, 31, 32] as $cx) $isl .= $px($cx, 6, '#b8b0cc');
$isl .= $px(29, 9, '#2a1027', 2, 2); // ворота
$isl .= '<g filter="url(#glow)">';
foreach ([[27, 8], [32, 8], [29, 5], [30, 5], [26, 6], [33, 6]] as $k => [$wx, $wy]) {
    $isl .= '<rect x="' . ($wx * 20 + 5) . '" y="' . ($wy * 20 + 4) . '" width="10" height="12" fill="#ff3b4a"><animate attributeName="fill" values="#ff3b4a;#ffb0b8;#ff3b4a" dur="' . (2 + $k % 3) . 's" begin="-' . $k . 's" repeatCount="indefinite"/></rect>';
}
$isl .= '</g></g>';
$s[] = $isl;
// роща: деревья по краям
foreach ([1, 4, 8, 12, 16, 43, 47, 51, 55, 58] as $x) {
    $h = mt_rand(3, 5); $top = $ground - $h - 3;
    $s[] = $px($x, $ground - $h, '#3a2618', 1, $h) . $px($x - 1, $top, '#123322', 3, 3) . $px($x, $top - 1, '#174a2e') . $px($x - 1, $top + 2, '#0e2a1b', 3, 1) . $px($x + 1, $top, '#1d5a37');
}
// земля
for ($x = 0; $x < $C; $x++) {
    $s[] = $px($x, $ground, $grass[mt_rand(0, 3)]);
    if (mt_rand(0, 2) === 0) $s[] = '<rect x="' . ($x * 20) . '" y="' . ($ground * 20 + 14) . '" width="20" height="6" fill="#3e9b41"/>';
    for ($y = $ground + 1; $y < $R; $y++) $s[] = $px($x, $y, $dirt[mt_rand(0, 3)]);
}
// красные светлячки поднимаются
$ff = '<g filter="url(#glow)">';
for ($i = 0; $i < 16; $i++) {
    $x = mt_rand(20, 1180); $y = mt_rand(250, 330); $d = 4 + mt_rand(0, 40) / 10;
    $ff .= '<rect x="' . $x . '" y="' . $y . '" width="6" height="6" fill="' . (mt_rand(0, 2) ? '#ff3b4a' : '#ffd0d5') . '"><animateTransform attributeName="transform" type="translate" values="0 0;' . mt_rand(-20, 20) . ' -' . mt_rand(80, 160) . '" dur="' . $d . 's" begin="-' . mt_rand(0, 40) / 10 . 's" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="' . $d . 's" begin="-' . mt_rand(0, 40) / 10 . 's" repeatCount="indefinite"/></rect>';
}
$s[] = $ff . '</g></svg>';
file_put_contents("$out/penta.svg", implode("\n", $s));

/* ================= MythosMC: пиксельный мир, изумруды ================= */
mt_srand(42);
$s = [$head];
for ($y = 0; $y < $R; $y++) $s[] = $px(0, $y, $mix('#030d08', '#0f3524', $y / ($R - 1)), $C, 1);
$s[] = '<g filter="url(#blur)" opacity=".5" shape-rendering="auto">'
     . '<path d="M-40 90 C 200 20, 420 150, 640 70 S 1020 30, 1260 110" stroke="#2fd673" stroke-width="34" fill="none"><animate attributeName="opacity" values=".55;1;.55" dur="6s" repeatCount="indefinite"/></path>'
     . '<path d="M-40 140 C 260 90, 520 190, 760 120 S 1080 90, 1260 150" stroke="#21b8a0" stroke-width="20" fill="none" opacity=".7"/></g>';
$s[] = $stars(46, 8, '#e8fff1');
$s[] = $px(50, 2, '#dff7e8', 3, 3) . $px(51, 3, '#b9dcc7') . $px(50, 2, '#f4fff8');
$ground = 15;
$far = $walk(5, 10, 8);
foreach ($far as $x => $h) { $s[] = $px($x, $ground - $h, '#0f2e20', 1, $h); $s[] = $px($x, $ground - $h, '#164030'); }
$near = $walk(1, 4, 2);
for ($x = 40; $x <= 50; $x++) $near[$x] = max($near[$x], 4 - (int) (abs($x - 45) / 2));
foreach ($near as $x => $h) $s[] = $px($x, $ground - $h, '#13402a', 1, $h);
$tx = 44; $top = $ground - $near[45] - 7;
$s[] = $px($tx, $top + 2, '#26332d', 3, 7) . $px($tx - 1, $top + 1, '#2f3f37', 5, 1);
foreach ([$tx - 1, $tx + 1, $tx + 3] as $bx) $s[] = $px($bx, $top, '#2f3f37');
$s[] = '<g filter="url(#glow)">' . $px($tx + 1, $top + 3, '#2fd673') . '<rect x="' . (($tx + 1) * 20) . '" y="' . (($top + 3) * 20) . '" width="20" height="20" fill="#8affc0"><animate attributeName="opacity" values="0;.9;0" dur="3s" repeatCount="indefinite"/></rect></g>';
$s[] = $px($tx + 1, $top + 6, '#0b1511', 1, 3);
foreach ([6, 13, 27, 34, 55] as $x) {
    $base = $ground - $near[$x];
    $s[] = $px($x, $base - 2, '#4a321d', 1, 2) . $px($x - 1, $base - 5, '#1f6b2e', 3, 3) . $px($x, $base - 6, '#2a8a3a') . $px($x - 1, $base - 4, '#2a8a3a');
}
for ($x = 0; $x < $C; $x++) {
    $s[] = $px($x, $ground, $grass[mt_rand(0, 3)]);
    if (mt_rand(0, 2) === 0) $s[] = '<rect x="' . ($x * 20) . '" y="' . ($ground * 20 + 14) . '" width="20" height="6" fill="#3e9b41"/>';
    for ($y = $ground + 1; $y <= $ground + 2; $y++) $s[] = $px($x, $y, $dirt[mt_rand(0, 3)]);
    for ($y = $ground + 3; $y < $R; $y++) $s[] = $px($x, $y, $stone[mt_rand(0, 3)]);
}
for ($i = 0; $i < 9; $i++) {
    $x = mt_rand(1, $C - 2); $y = mt_rand($ground + 3, $R - 1);
    $s[] = '<g filter="url(#glow)"><rect x="' . ($x * 20 + 4) . '" y="' . ($y * 20 + 4) . '" width="8" height="8" fill="#2fd673"/><rect x="' . ($x * 20 + 11) . '" y="' . ($y * 20 + 10) . '" width="6" height="6" fill="#8affc0"/></g>';
}
$gem = static function (int $cx, int $cy, int $u, float $dur, float $beg): string {
    $c = fn($dx, $dy, $col) => '<rect x="' . ($cx + $dx * $u) . '" y="' . ($cy + $dy * $u) . '" width="' . $u . '" height="' . $u . '" fill="' . $col . '"/>';
    $g = '<g filter="url(#glow)"><animateTransform attributeName="transform" type="translate" values="0 0;0 -14;0 0" dur="' . $dur . 's" begin="' . $beg . 's" repeatCount="indefinite"/>';
    foreach ([[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as [$dx, $dy]) {
        $g .= $c($dx, $dy, $dy < 0 && $dx <= 0 ? '#8affc0' : ($dy > 0 || $dx > 0 ? '#1aa257' : '#2fd673'));
    }
    return $g . '</g>';
};
$s[] = $gem(180, 120, 8, 3.2, 0) . $gem(330, 70, 6, 2.6, -1) . $gem(820, 110, 8, 3.6, -.6) . $gem(640, 50, 6, 2.9, -1.8);
$s[] = '</svg>';
file_put_contents("$out/mythosmc.svg", implode("\n", $s));

echo 'ok: penta ' . filesize("$out/penta.svg") . ' / mythosmc ' . filesize("$out/mythosmc.svg") . " bytes\n";

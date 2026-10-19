<?php
// Генератор баннеров для карточек Discord-серверов → assets/img/banners/*.svg
//   php tools/make-banners.php        (рисует заново ro-om.svg и mythosmc.svg; случайность с фиксированным seed)
declare(strict_types=1);
$out = $argv[1] ?? dirname(__DIR__) . '/assets/img/banners';
@mkdir($out, 0777, true);
$f = static fn(float $v): string => rtrim(rtrim(number_format($v, 1, '.', ''), '0'), '.');

/* ================= RO-OM: неон, звук, схемы ================= */
mt_srand(7);
$W = 1200; $H = 400;
$s = [];
$s[] = <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 $W $H" preserveAspectRatio="xMidYMid slice">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#170b33"/><stop offset=".55" stop-color="#0a0a18"/><stop offset="1" stop-color="#03141f"/></linearGradient>
  <radialGradient id="gp" cx=".22" cy=".3" r=".55"><stop offset="0" stop-color="#8b6cff" stop-opacity=".55"/><stop offset="1" stop-color="#8b6cff" stop-opacity="0"/></radialGradient>
  <radialGradient id="gc" cx=".82" cy=".7" r=".5"><stop offset="0" stop-color="#2fd0ff" stop-opacity=".45"/><stop offset="1" stop-color="#2fd0ff" stop-opacity="0"/></radialGradient>
  <linearGradient id="neon" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2fd0ff"/><stop offset=".5" stop-color="#8b6cff"/><stop offset="1" stop-color="#e05cff"/></linearGradient>
  <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b6cff" stop-opacity=".0"/><stop offset="1" stop-color="#8b6cff" stop-opacity=".55"/></linearGradient>
  <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#8b6cff" stroke-opacity=".09"/></pattern>
  <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="soft"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect width="$W" height="$H" fill="url(#bg)"/>
<rect width="$W" height="$H" fill="url(#gp)"/>
<rect width="$W" height="$H" fill="url(#gc)"/>
<rect width="$W" height="$H" fill="url(#grid)"/>
SVG;
// пол в перспективе
$hz = 262;
$g = '<g stroke="url(#floor)" stroke-width="1.5" fill="none">';
for ($i = -14; $i <= 14; $i++) $g .= '<path d="M600 ' . $hz . 'L' . (600 + $i * 95) . ' ' . $H . '"/>';
for ($k = 1; $k <= 7; $k++) { $y = $hz + ($H - $hz) * ($k / 7) ** 2; $g .= '<path d="M0 ' . $f($y) . 'H' . $W . '"/>'; }
$s[] = $g . '</g>';
// схемы по краям
$traces = [
  'M0 70H120L150 100H260', 'M0 120H90L130 160H210L230 140', 'M0 300H70L110 260H230', 'M40 0V40L80 80H170',
  'M1200 80H1080L1050 110H950', 'M1200 140H1110L1070 180H990L970 160', 'M1200 310H1120L1090 280H960', 'M1160 0V50L1120 90H1030',
];
$g = '<g fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)">';
foreach ($traces as $i => $d) {
  $c = $i < 4 ? '#2fd0ff' : '#c46bff';
  $g .= '<path d="' . $d . '" stroke="' . $c . '" stroke-opacity=".75"/>';
  preg_match('/(\d+) (\d+)$/', str_replace(['H', 'V', 'L'], ' ', $d), $m);
}
$pads = [[260, 100], [230, 140], [230, 260], [170, 80], [950, 110], [970, 160], [960, 280], [1030, 90]];
foreach ($pads as $i => [$x, $y]) $g .= '<circle cx="' . $x . '" cy="' . $y . '" r="6" fill="#0a0a18" stroke="' . ($i < 4 ? '#2fd0ff' : '#c46bff') . '"/>';
// бегущие импульсы по схемам
foreach ([0, 2, 4, 6] as $j) {
  $c = $j < 4 ? '#bff4ff' : '#f2ccff';
  $g .= '<circle r="4" fill="' . $c . '"><animateMotion dur="' . (2.6 + $j * .3) . 's" repeatCount="indefinite" path="' . $traces[$j] . '"/></circle>';
}
$s[] = $g . '</g>';
// рамка как у иконки
$s[] = '<rect x="452" y="58" width="296" height="296" rx="64" fill="none" stroke="url(#neon)" stroke-width="5" filter="url(#glow)" opacity=".9"/>';
$s[] = '<rect x="472" y="78" width="256" height="256" rx="50" fill="#0a0a18" fill-opacity=".55" stroke="#8b6cff" stroke-opacity=".35" stroke-width="2"/>';
// эквалайзер / звуковая волна
$g = '<g fill="url(#neon)" filter="url(#glow)">';
$n = 49; $bw = 10; $gap = 7; $x0 = (int) (600 - ($n * ($bw + $gap) - $gap) / 2); $cy = 206;
for ($i = 0; $i < $n; $i++) {
  $t = ($i - ($n - 1) / 2) / (($n - 1) / 2);              // -1..1
  $env = exp(-2.2 * $t * $t);                              // форма волны к центру выше
  $inside = abs($t) < 0.27;                                // внутри рамки — чуть ниже, чтобы не спорить с рамкой
  $base = 10 + 150 * $env * ($inside ? .75 : 1);
  $a = max(8, $base * (0.35 + mt_rand(0, 40) / 100)); $b = max(8, $base * (0.75 + mt_rand(0, 25) / 100)); $c = max(8, $base * (0.25 + mt_rand(0, 30) / 100));
  $vals = fn($q) => $f($q);
  $x = $x0 + $i * ($bw + $gap); $dur = $f(1.1 + mt_rand(0, 60) / 100); $beg = $f(-mt_rand(0, 100) / 100);
  $g .= '<rect x="' . $x . '" width="' . $bw . '" rx="5" y="' . $f($cy - $b / 2) . '" height="' . $f($b) . '" opacity="' . ($inside ? '1' : '.85') . '">'
      . '<animate attributeName="height" dur="' . $dur . 's" begin="' . $beg . 's" repeatCount="indefinite" values="' . $vals($a) . ';' . $vals($b) . ';' . $vals($c) . ';' . $vals($a) . '"/>'
      . '<animate attributeName="y" dur="' . $dur . 's" begin="' . $beg . 's" repeatCount="indefinite" values="' . $f($cy - $a / 2) . ';' . $f($cy - $b / 2) . ';' . $f($cy - $c / 2) . ';' . $f($cy - $a / 2) . '"/>'
      . '</rect>';
}
$s[] = $g . '</g>';
// тонкие волны
$wave = static function (float $amp, float $len, float $ph, int $y) use ($f, $W): string {
  $d = 'M0 ' . $y;
  for ($x = 0; $x <= $W; $x += 20) $d .= 'L' . $x . ' ' . $f($y + $amp * sin(($x / $len) * 2 * M_PI + $ph) * exp(-(($x - 600) / 520) ** 2));
  return $d;
};
$s[] = '<g fill="none" stroke-width="2" opacity=".55"><path d="' . $wave(26, 160, 0, 206) . '" stroke="#2fd0ff"/><path d="' . $wave(18, 110, 1.4, 206) . '" stroke="#e05cff"/></g>';
// искры
$g = '<g>';
for ($i = 0; $i < 40; $i++) {
  $x = mt_rand(0, $W); $y = mt_rand(0, 240); $r = mt_rand(10, 22) / 10;
  $g .= '<circle cx="' . $x . '" cy="' . $y . '" r="' . $r . '" fill="' . (mt_rand(0, 1) ? '#bff4ff' : '#f2ccff') . '" opacity=".6"><animate attributeName="opacity" values=".1;.9;.1" dur="' . $f(2 + mt_rand(0, 30) / 10) . 's" begin="-' . $f(mt_rand(0, 30) / 10) . 's" repeatCount="indefinite"/></circle>';
}
$s[] = $g . '</g></svg>';
file_put_contents("$out/ro-om.svg", implode("\n", $s));

/* ================= MythosMC: пиксельный мир ================= */
mt_srand(42);
$P = 20; $C = 60; $R = 20; // 60×20 «пикселей» по 20px
$px = static fn(int $x, int $y, string $c, int $w = 1, int $h = 1): string => '<rect x="' . ($x * 20) . '" y="' . ($y * 20) . '" width="' . ($w * 20) . '" height="' . ($h * 20) . '" fill="' . $c . '"/>';
$mix = static function (string $a, string $b, float $t): string {
  $ca = sscanf($a, '#%02x%02x%02x'); $cb = sscanf($b, '#%02x%02x%02x');
  return sprintf('#%02x%02x%02x', ...array_map(fn($i) => (int) round($ca[$i] + ($cb[$i] - $ca[$i]) * $t), [0, 1, 2]));
};
$s = [];
$s[] = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">';
$s[] = '<defs><filter id="blur" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>'
     . '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
// небо полосами
for ($y = 0; $y < $R; $y++) $s[] = $px(0, $y, $mix('#030d08', '#0f3524', $y / ($R - 1)), $C, 1);
// северное сияние
$s[] = '<g filter="url(#blur)" opacity=".5" shape-rendering="auto">'
     . '<path d="M-40 90 C 200 20, 420 150, 640 70 S 1020 30, 1260 110" stroke="#2fd673" stroke-width="34" fill="none"><animate attributeName="opacity" values=".55;1;.55" dur="6s" repeatCount="indefinite"/></path>'
     . '<path d="M-40 140 C 260 90, 520 190, 760 120 S 1080 90, 1260 150" stroke="#21b8a0" stroke-width="20" fill="none" opacity=".7"/></g>';
// звёзды
for ($i = 0; $i < 46; $i++) {
  $x = mt_rand(0, $C - 1); $y = mt_rand(0, 8);
  $size = mt_rand(0, 4) === 0 ? 8 : 4;
  $s[] = '<rect x="' . ($x * 20 + mt_rand(0, 12)) . '" y="' . ($y * 20 + mt_rand(0, 12)) . '" width="' . $size . '" height="' . $size . '" fill="#e8fff1"><animate attributeName="opacity" values="1;.2;1" dur="' . (2 + mt_rand(0, 4)) . 's" begin="-' . mt_rand(0, 5) . 's" repeatCount="indefinite"/></rect>';
}
// луна
$s[] = $px(50, 2, '#dff7e8', 3, 3) . $px(51, 3, '#b9dcc7') . $px(50, 2, '#f4fff8');
// дальние горы и ближние холмы (высота — сколько клеток над землёй)
$ground = 15;
$walk = static function (int $min, int $max, int $start) use ($C): array {
  $h = []; $v = $start;
  for ($x = 0; $x < $C; $x++) { $v += mt_rand(-1, 1); if (mt_rand(0, 5) === 0) $v += mt_rand(-1, 1); $v = max($min, min($max, $v)); $h[$x] = $v; }
  return $h;
};
$far = $walk(5, 10, 8);
foreach ($far as $x => $h) { $s[] = $px($x, $ground - $h, '#0f2e20', 1, $h); $s[] = $px($x, $ground - $h, '#164030'); }
$near = $walk(1, 4, 2);
for ($x = 40; $x <= 50; $x++) $near[$x] = max($near[$x], 4 - (int) (abs($x - 45) / 2)); // холм под башню
foreach ($near as $x => $h) $s[] = $px($x, $ground - $h, '#13402a', 1, $h);
// башня Мифоса на холме
$tx = 44; $top = $ground - $near[45] - 7;
$s[] = $px($tx, $top + 2, '#26332d', 3, 7) . $px($tx - 1, $top + 1, '#2f3f37', 5, 1);
foreach ([$tx - 1, $tx + 1, $tx + 3] as $bx) $s[] = $px($bx, $top, '#2f3f37');
$s[] = '<g filter="url(#glow)">' . $px($tx + 1, $top + 3, '#2fd673') . '<rect x="' . (($tx + 1) * 20) . '" y="' . (($top + 3) * 20) . '" width="20" height="20" fill="#8affc0"><animate attributeName="opacity" values="0;.9;0" dur="3s" repeatCount="indefinite"/></rect></g>';
$s[] = $px($tx + 1, $top + 6, '#0b1511', 1, 3);
// деревья
foreach ([6, 13, 27, 34, 55] as $x) {
  $base = $ground - $near[$x];
  $s[] = $px($x, $base - 2, '#4a321d', 1, 2) . $px($x - 1, $base - 5, '#1f6b2e', 3, 3) . $px($x, $base - 6, '#2a8a3a') . $px($x - 1, $base - 4, '#2a8a3a');
}
// земля: трава, земля, камень с изумрудами
$grass = ['#4caf50', '#3e9b41', '#5fc35f', '#43a447'];
$dirt = ['#5a3d24', '#6b4a2b', '#4a321d', '#634427'];
$stone = ['#3a3f3c', '#454b47', '#33383a', '#404643'];
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
// парящие изумруды
$gem = static function (int $cx, int $cy, int $u, float $dur, float $beg): string {
  $c = fn($dx, $dy, $col) => '<rect x="' . ($cx + $dx * $u) . '" y="' . ($cy + $dy * $u) . '" width="' . $u . '" height="' . $u . '" fill="' . $col . '"/>';
  $g = '<g filter="url(#glow)"><animateTransform attributeName="transform" type="translate" values="0 0;0 -14;0 0" dur="' . $dur . 's" begin="' . $beg . 's" repeatCount="indefinite"/>';
  foreach ([[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as [$dx, $dy]) {
    $col = $dy < 0 && $dx <= 0 ? '#8affc0' : ($dy > 0 || $dx > 0 ? '#1aa257' : '#2fd673');
    $g .= $c($dx, $dy, $col);
  }
  return $g . '</g>';
};
$s[] = $gem(180, 120, 8, 3.2, 0) . $gem(330, 70, 6, 2.6, -1) . $gem(820, 110, 8, 3.6, -.6) . $gem(640, 50, 6, 2.9, -1.8);
$s[] = '</svg>';
file_put_contents("$out/mythosmc.svg", implode("\n", $s));
echo 'ok: ' . filesize("$out/ro-om.svg") . ' / ' . filesize("$out/mythosmc.svg") . " bytes\n";

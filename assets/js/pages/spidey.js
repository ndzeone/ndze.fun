// Человек-паук на главной.
//  • Курсор мягко «растворяет» маску там, где проходит, — под ней лицо Питера Паркера.
//    След затягивается обратно через пару секунд, будто ткань возвращается на место.
//  • Клик / тап / Enter — маска целиком закатывается вверх (и обратно).
//  • Глаза Питера следят за курсором, линзы маски иногда моргают.
import { $, $$, lerp, clamp, motion, finePointer } from "../core/util.js";
import { mouse, onFrame } from "../core/fx.js";

const SVG = `
<svg class="spidey-svg" viewBox="0 0 400 500" aria-hidden="true">
  <defs>
    <radialGradient id="sp-aura" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#5dd62c" stop-opacity=".42"/>
      <stop offset=".55" stop-color="#337418" stop-opacity=".16"/>
      <stop offset="1" stop-color="#0f0f0f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sp-maskShade" cx="40%" cy="30%" r="80%">
      <stop offset="0" stop-color="#ff2a3d"/><stop offset=".55" stop-color="#c8091d"/><stop offset="1" stop-color="#6e0010"/>
    </radialGradient>
    <radialGradient id="sp-skin" cx="46%" cy="40%" r="70%">
      <stop offset="0" stop-color="#f7d2b2"/><stop offset=".7" stop-color="#e2ad88"/><stop offset="1" stop-color="#c98d68"/>
    </radialGradient>
    <linearGradient id="sp-hair" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3d2616"/><stop offset="1" stop-color="#1c110a"/>
    </linearGradient>
    <linearGradient id="sp-suitRed" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d50f24"/><stop offset="1" stop-color="#7d0512"/>
    </linearGradient>
    <linearGradient id="sp-suitBlue" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a4cb0"/><stop offset="1" stop-color="#132560"/>
    </linearGradient>
    <linearGradient id="sp-lens" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c3ced4"/>
    </linearGradient>
    <clipPath id="sp-headClip">
      <path transform="translate(200 225) scale(1.07) translate(-200 -225)"
            d="M200 90C265 90 300 140 300 210C300 290 260 355 200 360C140 355 100 290 100 210C100 140 135 90 200 90Z"/>
    </clipPath>
    <clipPath id="sp-eyeL"><ellipse cx="160" cy="224" rx="15" ry="8.5"/></clipPath>
    <clipPath id="sp-eyeR"><ellipse cx="240" cy="224" rx="15" ry="8.5"/></clipPath>
    <filter id="sp-soft" filterUnits="userSpaceOnUse" x="-60" y="-60" width="520" height="620">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
    <mask id="sp-peel" maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="500">
      <rect width="400" height="500" fill="#fff"/>
      <g class="peel-spots" fill="#000" filter="url(#sp-soft)"></g>
    </mask>
  </defs>

  <circle class="aura" cx="200" cy="250" r="215" fill="url(#sp-aura)"/>

  <g class="suit">
    <path d="M168 336L232 336L238 412L162 412Z" fill="#b5081a"/>
    <path d="M24 500C34 428 104 400 200 398C296 400 366 428 376 500Z" fill="url(#sp-suitRed)"/>
    <path d="M24 500C30 452 62 424 106 410L136 500Z" fill="url(#sp-suitBlue)"/>
    <path d="M376 500C370 452 338 424 294 410L264 500Z" fill="url(#sp-suitBlue)"/>
    <path d="M106 410C150 432 250 432 294 410M120 452C160 470 240 470 280 452M200 398V500M150 404L160 500M250 404L240 500" stroke="#3a0008" stroke-width="1.6" fill="none" opacity=".55"/>
    <g fill="#0f0f0f" stroke="#0f0f0f" stroke-linecap="round">
      <circle cx="200" cy="440" r="4.5"/>
      <ellipse cx="200" cy="454" rx="6" ry="10"/>
      <path d="M196 446L182 436L178 424M196 450L178 448L172 438M196 456L180 464L176 476M196 460L184 474L182 486M204 446L218 436L222 424M204 450L222 448L228 438M204 456L220 464L224 476M204 460L216 474L218 486" stroke-width="2.4" fill="none"/>
    </g>
  </g>

  <g class="head">
    <!-- Питер Паркер -->
    <g class="face">
      <ellipse cx="103" cy="232" rx="10" ry="19" fill="#dda07c"/>
      <ellipse cx="297" cy="232" rx="10" ry="19" fill="#dda07c"/>
      <path d="M200 90C265 90 300 140 300 210C300 290 260 355 200 360C140 355 100 290 100 210C100 140 135 90 200 90Z" fill="url(#sp-skin)"/>
      <path d="M108 250C112 300 150 350 200 356C250 350 288 300 292 250C282 300 246 340 200 345C154 340 118 300 108 250Z" fill="#b97a58" opacity=".3"/>
      <circle cx="146" cy="284" r="15" fill="#f29b8c" opacity=".28"/>
      <circle cx="254" cy="284" r="15" fill="#f29b8c" opacity=".28"/>
      <ellipse cx="150" cy="304" rx="13" ry="6" fill="#5a3a2a" opacity=".12"/>
      <path d="M250 278l14-6M254 286l9-4" stroke="#a14a3a" stroke-width="2" stroke-linecap="round" opacity=".55"/>

      <g class="hair">
        <path fill="url(#sp-hair)" d="M100 210C96 160 112 118 146 98C170 84 214 80 246 92C284 106 306 146 300 210C296 192 288 180 278 172C281 186 278 196 270 200C266 184 256 172 242 166C246 178 244 188 238 194C228 176 212 168 196 168C200 178 198 188 190 194C182 178 166 170 150 172C154 182 152 192 146 198C136 186 122 184 112 192C106 198 102 204 100 210Z"/>
        <path d="M128 132c4-14 18-20 30-12M152 112c8-12 24-14 34-4M188 100c10-10 28-10 36 2M226 102c12-6 26 0 30 12M256 120c10-4 22 4 22 16M140 152c6-10 20-12 28-2M182 138c8-10 22-10 30 0M224 140c8-8 22-6 28 4M262 152c6-4 14 2 14 10" stroke="#6a4428" stroke-width="4.5" stroke-linecap="round" fill="none" opacity=".9"/>
        <path d="M118 150c6-8 16-10 22-4M170 124c6-8 18-8 24 0M208 120c8-6 18-4 22 4M244 128c6-4 14 0 16 6" stroke="#160d07" stroke-width="3" stroke-linecap="round" fill="none"/>
        <path d="M162 170c-6 10-4 22 4 28M196 168c4 10 2 20-6 28M226 168c8 8 8 20 2 28" stroke="#24160c" stroke-width="6" stroke-linecap="round" fill="none"/>
      </g>

      <path class="brow" d="M136 202C148 192 168 192 182 199M218 199C232 192 252 192 264 202" stroke="#24160c" stroke-width="7" stroke-linecap="round" fill="none"/>
      <ellipse cx="160" cy="224" rx="15" ry="8.5" fill="#fbf7f2"/>
      <ellipse cx="240" cy="224" rx="15" ry="8.5" fill="#fbf7f2"/>
      <g clip-path="url(#sp-eyeL)"><g class="pupil" data-cx="160" data-cy="224">
        <circle cx="160" cy="224" r="7" fill="#5b3a1e"/><circle cx="160" cy="224" r="3.4" fill="#111"/><circle cx="162" cy="221" r="1.6" fill="#fff"/>
      </g></g>
      <g clip-path="url(#sp-eyeR)"><g class="pupil" data-cx="240" data-cy="224">
        <circle cx="240" cy="224" r="7" fill="#5b3a1e"/><circle cx="240" cy="224" r="3.4" fill="#111"/><circle cx="242" cy="221" r="1.6" fill="#fff"/>
      </g></g>
      <path d="M144 222C150 213 170 213 176 223M224 223C230 213 250 213 256 222" stroke="#3b2416" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path d="M147 231C155 235 167 235 174 230M226 230C233 235 245 235 253 231" stroke="#c98a70" stroke-width="1.5" fill="none" opacity=".6"/>
      <path d="M199 232C196 252 191 266 196 273C201 277 209 275 213 271" stroke="#b9785a" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M190 272c3 2 6 2 8 0" stroke="#a0644a" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path class="mouth" d="M176 312C190 319 210 319 226 308" stroke="#8e4a3c" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M186 322C196 326 208 326 216 321" stroke="#d98b78" stroke-width="3" stroke-linecap="round" fill="none" opacity=".55"/>
    </g>

    <!-- маска: растворяется под курсором (mask #sp-peel) и закатывается вверх по клику -->
    <g class="mask-layer" mask="url(#sp-peel)">
      <g clip-path="url(#sp-headClip)">
        <g class="mask-roll">
          <rect x="84" y="70" width="232" height="330" fill="url(#sp-maskShade)"/>
          <ellipse cx="165" cy="140" rx="52" ry="28" fill="#fff" opacity=".08"/>
          <path class="mask-web-hi" stroke="#ff6a78" stroke-width="1.2" fill="none" opacity=".22" transform="translate(1.2 1.2)"/>
          <path class="mask-web" stroke="#3a0008" stroke-width="1.7" fill="none" opacity=".8"/>
          <rect x="84" y="384" width="232" height="16" fill="#7a0010"/>
          <rect x="84" y="386" width="232" height="3" fill="#ff5a68" opacity=".45"/>
          <g class="lenses" stroke="#0f0f0f" stroke-width="10" stroke-linejoin="round" fill="url(#sp-lens)">
            <path class="lens" d="M118 198C150 186 182 208 188 244C170 258 130 250 118 198Z"/>
            <path class="lens" d="M282 198C250 186 218 208 212 244C230 258 270 250 282 198Z"/>
          </g>
          <path d="M132 206C150 200 168 210 174 224M268 206C250 200 232 210 226 224" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".7"/>
        </g>
      </g>
    </g>
  </g>
</svg>`;

/** Паутина на маске: радиальные нити + провисающие кольца. */
function webPath(cx, cy) {
  const spokes = 18;
  const rings = [24, 48, 76, 106, 140, 176];
  const pt = (a, r) => `${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`;
  let d = "";
  for (let i = 0; i < spokes; i++) d += `M${cx} ${cy}L${pt((i / spokes) * Math.PI * 2, 188)}`;
  for (const r of rings) {
    for (let i = 0; i < spokes; i++) {
      const a1 = (i / spokes) * Math.PI * 2;
      const a2 = ((i + 1) / spokes) * Math.PI * 2;
      d += `M${pt(a1, r)}Q${pt((a1 + a2) / 2, r * 0.86)} ${pt(a2, r)}`;
    }
  }
  return d;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const VB_W = 400;
const VB_H = 500;
const TRAIL_MAX = 42;
const TRAIL_STEP = 9;      // через сколько единиц пути оставлять новое пятно
const CURSOR_R = 44;       // радиус «окна» прямо под курсором
const TRAIL_R = 36;
const FADE_IN = 160;       // мс
const HOLD = 1100;         // мс держится открытым
const HEAL = 1400;         // мс затягивается обратно

export function mountSpidey(fig, { caption } = {}) {
  fig.insertAdjacentHTML("afterbegin", SVG);
  const svg = $("svg", fig);
  const d = webPath(200, 222);
  $(".mask-web", svg).setAttribute("d", d);
  $(".mask-web-hi", svg).setAttribute("d", d);

  /* ---------- Полное снятие маски (клик / тап / клавиатура) ---------- */
  let unmasked = false;
  let hovering = false;
  const setCaption = () => {
    if (!caption) return;
    caption.textContent = unmasked
      ? "Привет, я Питер Паркер 👋"
      : !finePointer ? "Нажми, чтобы снять маску"
      : hovering ? "Ещё немного… или кликни" : "Наведи курсор на маску";
  };
  const toggle = (v = !unmasked) => {
    unmasked = v;
    fig.classList.toggle("is-unmasked", v);
    fig.setAttribute("aria-pressed", String(v));
    setCaption();
  };
  fig.addEventListener("click", () => toggle());
  fig.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle();
  });

  fig.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { hovering = true; setCaption(); } });
  fig.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { hovering = false; setCaption(); } });
  setCaption();

  if (!motion) return { toggle };

  /* ---------- Растворение маски под курсором ---------- */
  const spotsGroup = $(".peel-spots", svg);
  const makeCircle = () => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("r", "0");
    spotsGroup.append(c);
    return c;
  };
  const cursorCircle = makeCircle();
  const pool = Array.from({ length: TRAIL_MAX }, makeCircle);
  const trail = []; // { x, y, born, el }
  const free = [...pool];
  const cur = { x: 200, y: 220, r: 0 };
  let last = null;

  const toSvg = (r) => ({
    x: ((mouse.x - r.left) / r.width) * VB_W,
    y: ((mouse.y - r.top) / r.height) * VB_H,
  });

  /* ---------- Зрачки ---------- */
  const pupils = $$(".pupil", svg).map((el) => ({ el, cx: +el.dataset.cx, cy: +el.dataset.cy, x: 0, y: 0 }));

  onFrame((now) => {
    const r = svg.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;

    // Пятно прямо под курсором — пока мышь над головой
    const inside = hovering && mouse.inside;
    const p = toSvg(r);
    const overHead = inside && p.x > 84 && p.x < 316 && p.y > 70 && p.y < 380;
    cur.x = lerp(cur.x, p.x, 0.35);
    cur.y = lerp(cur.y, p.y, 0.35);
    cur.r = lerp(cur.r, overHead ? CURSOR_R : 0, overHead ? 0.18 : 0.08);
    cursorCircle.setAttribute("cx", cur.x.toFixed(1));
    cursorCircle.setAttribute("cy", cur.y.toFixed(1));
    cursorCircle.setAttribute("r", cur.r.toFixed(1));

    // След: новое пятно каждые TRAIL_STEP единиц пути
    if (overHead && (!last || Math.hypot(p.x - last.x, p.y - last.y) > TRAIL_STEP)) {
      last = { x: p.x, y: p.y };
      let el = free.pop();
      if (!el) {
        const oldest = trail.shift();
        el = oldest.el;
      }
      trail.push({ x: p.x, y: p.y, born: now, el });
    }
    if (!overHead) last = null;

    for (let i = trail.length - 1; i >= 0; i--) {
      const s = trail[i];
      const age = now - s.born;
      let k;
      if (age < FADE_IN) k = Math.max(0.05, age / FADE_IN);
      else if (age < FADE_IN + HOLD) k = 1;
      else k = 1 - (age - FADE_IN - HOLD) / HEAL;
      if (age >= FADE_IN + HOLD + HEAL) {
        s.el.setAttribute("r", "0");
        free.push(s.el);
        trail.splice(i, 1);
        continue;
      }
      const eased = k * k * (3 - 2 * k); // smoothstep — края появляются и исчезают незаметно
      s.el.setAttribute("cx", s.x.toFixed(1));
      s.el.setAttribute("cy", s.y.toFixed(1));
      s.el.setAttribute("r", (TRAIL_R * (0.55 + 0.45 * eased)).toFixed(1));
      s.el.setAttribute("opacity", eased.toFixed(3));
    }

    // Глаза Питера смотрят на курсор
    const sx = r.width / VB_W;
    const sy = r.height / VB_H;
    for (const pu of pupils) {
      const dx = mouse.x - (r.left + pu.cx * sx);
      const dy = mouse.y - (r.top + pu.cy * sy);
      const dist = Math.hypot(dx, dy) || 1;
      const k = clamp(dist / 220, 0, 1);
      pu.x = lerp(pu.x, (dx / dist) * 6 * k, 0.15);
      pu.y = lerp(pu.y, (dy / dist) * 2.2 * k, 0.15);
      pu.el.setAttribute("transform", `translate(${pu.x.toFixed(2)} ${pu.y.toFixed(2)})`);
    }
  });

  return { toggle };
}

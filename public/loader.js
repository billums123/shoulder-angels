// Themed canvas loader shown while summoning: a gold (angel) and a red (devil)
// comet chase each other around a ring with glowing trails, over a pulsing core.
let rafId = null;

export function startLoader(canvas) {
  stopLoader();
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 184;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  ctx.scale(dpr, dpr);

  const w = size;
  const h = size;
  const cx = w / 2;
  const cy = h / 2;
  const R = w * 0.3;
  const GOLD = [255, 215, 107];
  const RED = [255, 92, 77];

  const dot = (x, y, r, c, a, blur) => {
    const col = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = blur;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const comet = (ang, c) => {
    const T = 20;
    for (let i = T; i >= 0; i--) {
      const a = ang - i * 0.1;
      const x = cx + Math.cos(a) * R;
      const y = cy + Math.sin(a) * R;
      const f = 1 - i / T; // head brightest
      dot(x, y, 1.4 + 4.2 * f, c, 0.9 * f, 16 * f);
    }
  };

  // Advance by a per-frame delta (clamped) rather than absolute elapsed time, so
  // a main-thread stall during summoning pauses the comets and resumes smoothly
  // instead of teleporting them forward.
  let ang = 0;
  let pulse = 0;
  let last = null;
  const frame = (ts) => {
    if (last === null) last = ts;
    let dt = ts - last;
    last = ts;
    if (dt > 60) dt = 16; // a stall shouldn't jump the rotation
    ang += dt * 0.0028;
    pulse += dt * 0.004;
    ctx.clearRect(0, 0, w, h);
    comet(ang, GOLD);
    comet(ang + Math.PI, RED);
    const p = 0.5 + 0.5 * Math.sin(pulse);
    dot(cx, cy, 5 + 4 * p, [255, 226, 170], 0.3 + 0.3 * p, 26);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

export function stopLoader() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

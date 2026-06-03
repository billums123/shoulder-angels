// Themed summoning loader: a gold (angel) and a red (devil) comet chase each
// other around a ring. Drawn in a Web Worker via OffscreenCanvas so it keeps
// rotating smoothly even while the main thread is busy connecting; falls back
// to a main-thread rAF loop where OffscreenCanvas isn't available.
const SIZE = 184;

let worker = null;
let transferred = false;
let rafId = null;

export function startLoader(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE}px`;

  if (typeof canvas.transferControlToOffscreen === "function") {
    if (!worker) worker = new Worker("loader-worker.js");
    if (!transferred) {
      const off = canvas.transferControlToOffscreen();
      transferred = true;
      worker.postMessage({ type: "init", canvas: off, size: SIZE, dpr }, [off]);
    }
    worker.postMessage({ type: "start" });
  } else {
    startMainLoop(canvas, dpr);
  }
}

export function stopLoader() {
  if (worker) worker.postMessage({ type: "stop" });
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ── Fallback: main-thread rAF loop ──────────────────────────────────────
function startMainLoop(canvas, dpr) {
  if (rafId) cancelAnimationFrame(rafId);
  const ctx = canvas.getContext("2d");
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  ctx.scale(dpr, dpr);
  const w = SIZE;
  const h = SIZE;
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
  const comet = (angle, c) => {
    const T = 20;
    for (let i = T; i >= 0; i--) {
      const a = angle - i * 0.1;
      const f = 1 - i / T;
      dot(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 1.4 + 4.2 * f, c, 0.9 * f, 16 * f);
    }
  };

  let ang = 0;
  let pulse = 0;
  let last = null;
  const frame = (ts) => {
    if (last === null) last = ts;
    let dt = ts - last;
    last = ts;
    if (dt > 60) dt = 16;
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

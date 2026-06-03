// Draws the summoning loader on an OffscreenCanvas in its own thread, so it
// keeps rotating smoothly even while the main thread is busy connecting.
let ctx, w, h, cx, cy, R;
let ang = 0;
let pulse = 0;
let last = null;
let running = false;
let timer = null;

const GOLD = [255, 215, 107];
const RED = [255, 92, 77];

function dot(x, y, r, c, a, blur) {
  const col = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  ctx.save();
  ctx.shadowColor = col;
  ctx.shadowBlur = blur;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function comet(angle, c) {
  const T = 20;
  for (let i = T; i >= 0; i--) {
    const a = angle - i * 0.1;
    const x = cx + Math.cos(a) * R;
    const y = cy + Math.sin(a) * R;
    const f = 1 - i / T;
    dot(x, y, 1.4 + 4.2 * f, c, 0.9 * f, 16 * f);
  }
}

function loop() {
  if (!running) return;
  const ts = performance.now();
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
  timer = setTimeout(loop, 16);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    const c = m.canvas;
    c.width = m.size * m.dpr;
    c.height = m.size * m.dpr;
    ctx = c.getContext("2d");
    ctx.scale(m.dpr, m.dpr);
    w = m.size;
    h = m.size;
    cx = w / 2;
    cy = h / 2;
    R = w * 0.3;
  } else if (m.type === "start") {
    if (running) return;
    running = true;
    last = null;
    loop();
  } else if (m.type === "stop") {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (ctx) ctx.clearRect(0, 0, w, h);
  }
};

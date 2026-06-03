// Bake a glowing ring onto a copy of the face, so it becomes part of the image
// D-ID animates — moving with the head, not floating on the circle. Angel gets
// a gold halo; the devil gets a red "anti-halo". A ring hugs the head, so it
// survives D-ID's tight face framing (unlike horns, which get cropped).
// Head position comes from MoveNet (tracking.detectHead).
import { detectHead } from "./tracking.js";

const PALETTE = {
  angel: { glow: "rgba(255,196,60,0.95)", outer: "rgba(255,222,120,0.97)", inner: "rgba(255,250,225,0.98)" },
  devil: { glow: "rgba(220,28,28,0.95)", outer: "rgba(255,70,60,0.97)", inner: "rgba(255,170,140,0.95)" },
};

export async function decorateFace(imgSource, type) {
  const w = imgSource.naturalWidth || imgSource.videoWidth || imgSource.width;
  const h = imgSource.naturalHeight || imgSource.videoHeight || imgSource.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgSource, 0, 0, w, h);

  let head = await detectHead(imgSource);
  if (!head) head = { cx: w / 2, cy: h * 0.42, width: w * 0.34, topY: h * 0.16 };

  drawRing(ctx, head, PALETTE[type] || PALETTE.angel);

  return canvas.toDataURL("image/jpeg", 0.92);
}

function drawRing(ctx, { cx, width, topY }, colors) {
  const rx = width * 0.62;
  const ry = width * 0.2;
  // Rest just above the crown, clamped so it stays inside the frame.
  const cy = Math.max(ry + width * 0.1, topY - width * 0.05);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = width * 0.28;
  ctx.lineWidth = Math.max(4, width * 0.07);
  ctx.strokeStyle = colors.outer;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  // bright inner pass
  ctx.shadowBlur = width * 0.14;
  ctx.lineWidth = Math.max(2, width * 0.03);
  ctx.strokeStyle = colors.inner;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

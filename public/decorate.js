// Bake a halo (angel) or horns (devil) onto a copy of the face, so they become
// part of the image D-ID animates — moving with the head, not floating on the
// circle. Head position comes from MoveNet (tracking.detectHead); falls back to
// sensible fractions if no face is found.
import { detectHead } from "./tracking.js";

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

  if (type === "angel") drawHalo(ctx, head);
  else drawHorns(ctx, head, h);

  return canvas.toDataURL("image/jpeg", 0.92);
}

function drawHalo(ctx, { cx, width, topY }) {
  const rx = width * 0.62;
  const ry = width * 0.2;
  // Rest just above the crown, clamped so it stays inside the frame.
  const cy = Math.max(ry + width * 0.1, topY - width * 0.05);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = "rgba(255,196,60,0.95)";
  ctx.shadowBlur = width * 0.28;
  ctx.lineWidth = Math.max(4, width * 0.07);
  ctx.strokeStyle = "rgba(255,222,120,0.97)";
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  // bright inner pass
  ctx.shadowBlur = width * 0.14;
  ctx.lineWidth = Math.max(2, width * 0.03);
  ctx.strokeStyle = "rgba(255,250,225,0.98)";
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawHorns(ctx, { cx, width, topY }) {
  const hornH = width * 0.5;
  const hornW = width * 0.22;
  // Rise from the hairline, angled up and outward. Gentle floor so they don't
  // fly entirely off the top of a tightly-framed head (tips may crop, which
  // still reads as horns; bases stay in the hair rather than over the eyes).
  const baseY = Math.max(topY + width * 0.16, hornH * 0.5);
  const off = width * 0.3;
  for (const dir of [-1, 1]) {
    const bx = cx + dir * off;
    const tipX = bx + dir * hornW * 0.8;
    const tipY = baseY - hornH;
    ctx.save();
    ctx.shadowColor = "rgba(150,12,12,0.8)";
    ctx.shadowBlur = width * 0.1;
    const grad = ctx.createLinearGradient(bx, baseY, tipX, tipY);
    grad.addColorStop(0, "#3a0707");
    grad.addColorStop(0.55, "#a01a1a");
    grad.addColorStop(1, "#ee5151");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(bx - hornW / 2, baseY);
    ctx.lineTo(tipX, tipY); // pointed tip, up & outward
    ctx.lineTo(bx + hornW / 2, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

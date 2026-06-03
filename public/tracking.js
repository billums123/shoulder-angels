// Pose detection (TensorFlow.js MoveNet) used for two things:
//   1) live shoulder tracking → position the avatars on the user's shoulders
//   2) head-location lookup → where to bake the halo / horns onto a face
//
// tf + poseDetection are loaded globally via CDN <script> tags in index.html.

let detector = null;
let detectorPromise = null;
let rafId = null;

export function initTracking() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    if (typeof poseDetection === "undefined") {
      throw new Error("pose-detection library not loaded");
    }
    await tf.setBackend("webgl");
    await tf.ready();
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING },
    );
    return detector;
  })();
  return detectorPromise;
}

const kp = (pose, name) => pose?.keypoints?.find((k) => k.name === name);

// Map a point in raw video pixels → stage display pixels, accounting for
// object-fit: cover and the mirrored (scaleX(-1)) display.
function mapToStage(px, py, video, stage) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const scale = Math.max(W / vw, H / vh);
  const offX = (W - vw * scale) / 2;
  const offY = (H - vh * scale) / 2;
  const x = W - (offX + px * scale); // mirror horizontally
  const y = offY + py * scale;
  return { x, y };
}

// ── Live shoulder tracking ──────────────────────────────────────────────
export function startTracking(video, stage, avatars) {
  const smooth = {};
  let lost = 0;

  const place = (el, point, key) => {
    const m = mapToStage(point.x, point.y, video, stage);
    const halfW = el.offsetWidth / 2;
    const halfH = el.offsetHeight / 2;
    // Clamp to the stage — shoulders are often near/below the bottom edge in
    // tight webcam framing, and we still want the avatar fully visible.
    const tx = Math.min(Math.max(m.x, halfW), stage.clientWidth - halfW);
    const ty = Math.min(Math.max(m.y - halfH * 0.3, halfH), stage.clientHeight - halfH);
    const s = smooth[key] || (smooth[key] = { x: tx, y: ty });
    s.x += (tx - s.x) * 0.25; // EMA smoothing
    s.y += (ty - s.y) * 0.25;
    el.classList.add("tracked");
    el.style.left = `${s.x - halfW}px`;
    el.style.top = `${s.y - halfH}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  };

  const tick = async () => {
    rafId = requestAnimationFrame(tick);
    if (!detector || video.readyState < 2 || !video.videoWidth) return;
    let poses;
    try {
      poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false });
    } catch {
      return;
    }
    const anchors = shoulderAnchors(poses[0]);
    if (anchors) {
      lost = 0;
      // Display is mirrored, so the person's right shoulder is on the viewer's
      // left. Put the angel on the viewer's left, devil on the right.
      place(avatars.angel, anchors.right, "angel");
      place(avatars.devil, anchors.left, "devil");
    } else if (++lost === 12) {
      resetToCorners(avatars); // pose lost → drift back to the corners
    }
  };
  tick();
}

// Confident shoulders if available; otherwise estimate the shoulder line from
// the head so the avatars still follow the user in tight head-and-shoulders
// framing (where the real shoulders sit at/below the frame edge).
function shoulderAnchors(pose) {
  if (!pose) return null;
  const ls = kp(pose, "left_shoulder");
  const rs = kp(pose, "right_shoulder");
  if (ls?.score > 0.35 && rs?.score > 0.35) return { left: ls, right: rs };

  const nose = kp(pose, "nose");
  if (!nose || nose.score < 0.3) return null;
  const le = kp(pose, "left_eye");
  const re = kp(pose, "right_eye");
  const lEar = kp(pose, "left_ear");
  const rEar = kp(pose, "right_ear");
  let hw;
  if (lEar?.score > 0.3 && rEar?.score > 0.3) hw = Math.abs(lEar.x - rEar.x) * 1.5;
  else if (le?.score > 0.3 && re?.score > 0.3) hw = Math.abs(le.x - re.x) * 3;
  else return null;
  const y = nose.y + hw * 1.15; // down toward the shoulder line
  return {
    left: { x: nose.x + hw * 1.05, y },
    right: { x: nose.x - hw * 1.05, y },
  };
}

export function stopTracking(avatars) {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  resetToCorners(avatars);
}

function resetToCorners(avatars) {
  for (const el of Object.values(avatars)) {
    el.classList.remove("tracked");
    el.style.left = el.style.top = el.style.right = el.style.bottom = "";
  }
}

// ── Head box lookup (for baking halo / horns) ───────────────────────────
// Returns { cx, cy, width, topY } in the source image's own pixel space, or
// null if no confident face is found.
export async function detectHead(source) {
  if (!detector) return null;
  let poses;
  try {
    poses = await detector.estimatePoses(source, { maxPoses: 1, flipHorizontal: false });
  } catch {
    return null;
  }
  const pose = poses[0];
  if (!pose) return null;
  const nose = kp(pose, "nose");
  const le = kp(pose, "left_eye");
  const re = kp(pose, "right_eye");
  const lEar = kp(pose, "left_ear");
  const rEar = kp(pose, "right_ear");
  if (!nose || nose.score < 0.3) return null;

  // Head width: prefer ear span, else eye span scaled up.
  let width;
  if (lEar?.score > 0.3 && rEar?.score > 0.3) {
    width = Math.abs(lEar.x - rEar.x) * 1.5;
  } else if (le?.score > 0.3 && re?.score > 0.3) {
    width = Math.abs(le.x - re.x) * 3.0;
  } else {
    return null;
  }
  const cx = nose.x;
  const topY = nose.y - width * 0.95; // approx crown of the head
  return { cx, cy: nose.y, width, topY };
}

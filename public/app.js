import { DidAvatar } from "./did.js";
import { initTracking, startTracking, stopTracking } from "./tracking.js";
import { decorateFace } from "./decorate.js";
import { startLoader, stopLoader } from "./loader.js";

// Start loading the pose model early so it's ready by the time we connect.
const trackingReady = initTracking().catch((e) => {
  console.warn("pose model failed to load — avatars will stay in corners:", e.message);
  return null;
});

const els = {
  stage: document.getElementById("stage"),
  userVideo: document.getElementById("user-video"),
  angelVideo: document.getElementById("angel-video"),
  devilVideo: document.getElementById("devil-video"),
  angelStill: document.getElementById("angel-still"),
  devilStill: document.getElementById("devil-still"),
  angelWrap: document.getElementById("angel"),
  devilWrap: document.getElementById("devil"),
  angelCaption: document.getElementById("angel-caption"),
  devilCaption: document.getElementById("devil-caption"),
  connectBtn: document.getElementById("connect"),
  disconnectBtn: document.getElementById("disconnect"),
  faceBtn: document.getElementById("face"),
  voiceBtn: document.getElementById("voice"),
  voiceFile: document.getElementById("voice-file"),
  talkBtn: document.getElementById("talk"),
  textInput: document.getElementById("text-input"),
  status: document.getElementById("status"),
  youSaid: document.getElementById("you-said"),
  captureOverlay: document.getElementById("capture-overlay"),
  voiceOverlay: document.getElementById("voice-overlay"),
  stageLoader: document.getElementById("stage-loader"),
  loaderCanvas: document.getElementById("loader-canvas"),
};

function showLoader(on) {
  els.stage.classList.toggle("connecting", on);
  els.stageLoader.hidden = !on;
  if (on) startLoader(els.loaderCanvas);
  else stopLoader();
}

const VOICE_PROMPT =
  "I am recording my voice so my shoulder angels can sound just like me. The quick brown fox jumps over the lazy dog.";
const VOICE_SECONDS = 12;

let angel, devil;
let connected = false;
let busy = false;
let angelFirst = true; // alternate who opens each turn
let usingMyFace = false;
let voiceOverride = null; // cloned "use my voice" voice_id (both avatars)
let presetImages = {}; // { angel, devil } URLs from /api/config
const history = [];

function setStatus(msg) {
  els.status.textContent = msg;
}

// Update a button's label (and optionally its duotone icon) without clobbering
// the <i> icon the way textContent would.
function setBtn(btn, label, iconClass) {
  const lbl = btn.querySelector(".lbl");
  if (lbl) lbl.textContent = label;
  const icon = btn.querySelector("i");
  if (icon && iconClass) icon.className = "ph-duotone " + iconClass;
}

// ── Camera ────────────────────────────────────────────────────────────
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false, // avatar audio comes from D-ID; mic is used only via STT
  });
  els.userVideo.srcObject = stream;
  await els.userVideo.play().catch(() => {});
}

function captureFrame(w = 512) {
  const v = els.userVideo;
  if (!v.videoWidth) return null;
  const h = Math.round((v.videoHeight / v.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(v, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.7);
}

// Grab a still frame (canvas) from the webcam — used as the face source so it
// doesn't smear if the user moves during upload.
function captureStill(w = 640) {
  const v = els.userVideo;
  const h = Math.round((v.videoHeight / v.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(v, 0, 0, w, h);
  return canvas;
}

// Show the alignment guide + 3-2-1 countdown, then capture a still at "0".
function runCaptureCountdown() {
  return new Promise((resolve) => {
    const ov = els.captureOverlay;
    const countEl = ov.querySelector(".capture-count");
    ov.hidden = false;
    let n = 3;
    countEl.textContent = n;
    countEl.style.animation = "none";
    void countEl.offsetWidth; // restart pop animation
    countEl.style.animation = "";

    const step = () => {
      n -= 1;
      if (n > 0) {
        countEl.textContent = n;
        countEl.style.animation = "none";
        void countEl.offsetWidth;
        countEl.style.animation = "";
        setTimeout(step, 800);
      } else {
        countEl.innerHTML = '<i class="ph-duotone ph-camera"></i>';
        const still = captureStill(640);
        setTimeout(() => {
          ov.hidden = true;
          countEl.textContent = "";
          resolve(still);
        }, 300);
      }
    };
    setTimeout(step, 800);
  });
}

// ── Use my voice (ElevenLabs instant voice cloning) ─────────────────────
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Record ~VOICE_SECONDS of mic audio while showing a read-prompt + timer.
async function recordVoiceSample() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();

  const ov = els.voiceOverlay;
  const promptEl = ov.querySelector(".voice-prompt");
  const countEl = ov.querySelector(".capture-count");
  promptEl.textContent = `“${VOICE_PROMPT}”`;
  ov.hidden = false;
  for (let s = VOICE_SECONDS; s > 0; s--) {
    countEl.innerHTML = `<i class="ph-duotone ph-circle" style="color:#ff5a4d"></i> ${s}s`;
    await new Promise((r) => setTimeout(r, 1000));
    if (!connected) break; // bail if disconnected mid-record
  }
  ov.hidden = true;
  countEl.textContent = "";
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: rec.mimeType || "audio/webm" });
}

async function cloneAndApply(blob) {
  setStatus("Cloning your voice with ElevenLabs…");
  const dataUrl = await blobToDataUrl(blob);
  const res = await fetch("/api/clone-voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: dataUrl }),
  });
  if (!res.ok) {
    const err = await res.text();
    setStatus(/instant_voice|can_not_use|subscription/i.test(err)
      ? "Voice cloning needs a paid ElevenLabs plan."
      : "Voice clone failed: " + err.slice(0, 120));
    return;
  }
  const { voice_id } = await res.json();
  voiceOverride = voice_id;
  setBtn(els.voiceBtn, "Your voice", "ph-check-circle");
  els.voiceBtn.classList.add("active");
  setStatus("Now they speak in your voice. Ask them something!");
}

// The voice button toggles: clone your voice when off, restore preset voices
// when already using yours.
function toggleMyVoice() {
  if (busy || !connected) return;
  if (voiceOverride) resetMyVoice();
  else useMyVoice();
}

function resetMyVoice() {
  voiceOverride = null; // speak() falls back to each presenter's preset voice
  setBtn(els.voiceBtn, "Use my voice", "ph-waveform");
  els.voiceBtn.classList.remove("active");
  setStatus("Back to their own voices.");
}

async function useMyVoice() {
  if (busy || !connected) return;
  busy = true;
  els.voiceBtn.disabled = true;
  els.talkBtn.disabled = true;
  try {
    const blob = await recordVoiceSample();
    await cloneAndApply(blob);
  } catch (e) {
    console.error(e);
    setStatus("Mic/record failed: " + e.message);
  }
  busy = false;
  els.voiceBtn.disabled = !connected;
  els.talkBtn.disabled = !connected;
}

// Voice upload temporarily disabled
// async function uploadVoice(file) {
//   if (busy || !connected || !file) return;
//   busy = true;
//   els.voiceBtn.disabled = true;
//   try {
//     await cloneAndApply(file);
//   } catch (e) {
//     console.error(e);
//     setStatus("Voice upload failed: " + e.message);
//   }
//   busy = false;
//   els.voiceBtn.disabled = !connected;
// }

// ── Source faces with baked-in halo / horns ─────────────────────────────
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    // Route remote images through our proxy so the canvas isn't tainted.
    img.src = url.startsWith(location.origin)
      ? url
      : `/api/proxy-image?url=${encodeURIComponent(url)}`;
  });
}

async function uploadDataUrl(dataUrl) {
  const res = await fetch("/api/did/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).url;
}

// Decorate one face; returns { url, dataUrl } — url is the D-ID source (null on
// failure → server falls back to the plain preset), dataUrl is the local still
// shown in the orb until the live stream renders.
async function decoratedSource(type, baseEl) {
  let dataUrl = null;
  try {
    dataUrl = await decorateFace(baseEl, type);
    const url = await uploadDataUrl(dataUrl);
    return { url, dataUrl };
  } catch (e) {
    console.warn(`decorate ${type} failed:`, e.message);
    return { url: null, dataUrl };
  }
}

// Build both avatars' source URLs (halo + horns baked in) for the current mode.
async function prepareSources(capturedFace) {
  await trackingReady; // need the pose model for head placement
  let angelBase, devilBase;
  if (usingMyFace) {
    angelBase = devilBase = capturedFace || els.userVideo; // your face, decorated two ways
  } else {
    [angelBase, devilBase] = await Promise.all([
      loadImage(presetImages.angel),
      loadImage(presetImages.devil),
    ]);
  }
  const [angel, devil] = await Promise.all([
    decoratedSource("angel", angelBase),
    decoratedSource("devil", devilBase),
  ]);
  return { angel, devil }; // each: { url, dataUrl }
}

// Drop the decorated stills into the orbs (visible until the live video shows
// a real face on first talk).
function applyStills(sources) {
  [["angel", els.angelStill], ["devil", els.devilStill]].forEach(([k, img]) => {
    const d = sources[k]?.dataUrl;
    if (d) {
      img.src = d;
      img.style.opacity = "1";
    } else {
      img.style.opacity = "0";
    }
  });
}
function revealLive(who) {
  const img = who === "angel" ? els.angelStill : els.devilStill;
  if (img) img.style.opacity = "0"; // fade still out → live video shows through
}

// ── Connect / disconnect ────────────────────────────────────────────────
async function connect() {
  els.connectBtn.disabled = true;
  setStatus("Starting camera…");
  try {
    await startCamera();
  } catch (e) {
    setStatus("Camera/mic permission needed. Allow access and retry.");
    showLoader(false);
    els.connectBtn.classList.remove("summoning");
    els.connectBtn.disabled = false;
    return;
  }

  // The loader is shown on the shrink's timeline by the click handler.
  let sources;
  try {
    sources = await prepareSources();
  } catch (e) {
    console.warn("source prep failed, using plain presets:", e.message);
    sources = { angel: {}, devil: {} };
  }

  applyStills(sources); // show the face stills so the orbs aren't blank
  angel = new DidAvatar("angel", els.angelVideo, sources.angel?.url);
  devil = new DidAvatar("devil", els.devilVideo, sources.devil?.url);
  try {
    await Promise.all([angel.connect(), devil.connect()]);
  } catch (e) {
    console.error(e);
    // Clean up whichever stream did open so it doesn't leak.
    await Promise.allSettled([angel?.disconnect(), devil?.disconnect()]);
    const msg = /Max user sessions/.test(e.message)
      ? "D-ID says too many open sessions. Close other tabs running this, wait ~1–2 min for old streams to expire, then retry."
      : "Couldn't connect avatars: " + e.message;
    showLoader(false);
    setStatus(msg);
    els.connectBtn.classList.remove("summoning");
    els.connectBtn.disabled = false;
    return;
  }

  connected = true;
  showLoader(false);
  els.stage.classList.add("connected");
  document.body.classList.add("live"); // reveal the now-usable controls
  els.connectBtn.disabled = false;
  els.talkBtn.disabled = false;
  els.faceBtn.disabled = false;
  els.voiceBtn.disabled = false;
  els.textInput.disabled = false;
  setStatus("Hold the button (or type) and ask them anything.");

  // Track the user's shoulders and perch the avatars there (once the model
  // is ready); falls back to the fixed corners if it never loads.
  trackingReady.then((ok) => {
    if (ok && connected) {
      startTracking(els.userVideo, els.stage, { angel: els.angelWrap, devil: els.devilWrap }, quip);
    }
  });

  // Opening bit so the demo starts with energy.
  ask("", { silentUser: true });
}

async function disconnect() {
  connected = false;
  stopTracking({ angel: els.angelWrap, devil: els.devilWrap });
  els.stage.classList.remove("connected");
  document.body.classList.remove("live"); // hide the controls again
  els.connectBtn.classList.remove("summoning"); // restore the Summon button
  els.connectBtn.disabled = false; // ready to summon again
  els.talkBtn.disabled = true;
  els.faceBtn.disabled = true;
  els.voiceBtn.disabled = true;
  els.textInput.disabled = true;
  els.angelStill.style.opacity = "0";
  els.devilStill.style.opacity = "0";
  setStatus("");
  await Promise.allSettled([angel?.disconnect(), devil?.disconnect()]);
  const s = els.userVideo.srcObject;
  if (s) s.getTracks().forEach((t) => t.stop());
}

// ── "Use my face": clone the webcam onto BOTH avatars (good-you vs evil-you),
//    each with its halo / horns baked in.
async function toggleMyFace() {
  if (!connected || busy) return;
  busy = true;
  els.faceBtn.disabled = true;
  els.talkBtn.disabled = true;
  const target = !usingMyFace;

  try {
    // Turning it on: guide the user to align + hold still, then grab a clean still.
    let captured = null;
    if (target) {
      captured = await runCaptureCountdown();
      setStatus("Cloning your face onto both of them…");
    } else {
      setStatus("Restoring their real faces…");
    }
    usingMyFace = target; // prepareSources reads this
    const sources = await prepareSources(captured);

    // Respawn both streams with the new faces.
    await Promise.allSettled([angel.disconnect(), devil.disconnect()]);
    applyStills(sources); // show new face stills during the respawn
    angel = new DidAvatar("angel", els.angelVideo, sources.angel?.url);
    devil = new DidAvatar("devil", els.devilVideo, sources.devil?.url);
    await Promise.all([angel.connect(), devil.connect()]);

    setBtn(els.faceBtn, usingMyFace ? "Reset faces" : "Use my face",
      usingMyFace ? "ph-arrow-counter-clockwise" : "ph-user-focus");
    setStatus(usingMyFace ? "Meet good-you and evil-you." : "");
  } catch (e) {
    console.error(e);
    usingMyFace = !target; // revert flag on failure
    setStatus("Face swap failed: " + e.message);
  }

  busy = false;
  els.faceBtn.disabled = !connected;
  els.talkBtn.disabled = !connected;
  // The new faces are already visible via the decorated stills shown during the
  // respawn, so we DON'T fire an opening line — they stay quiet until prompted.
}

// ── A turn: see → think → both speak ─────────────────────────────────────
async function ask(question, { silentUser = false } = {}) {
  if (!connected || busy) return;
  busy = true;
  els.talkBtn.disabled = true;
  if (!silentUser) els.youSaid.textContent = `“${question}”`;

  setStatus("They're looking at you…");
  const image = captureFrame();

  let reply;
  try {
    const res = await fetch("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, image, history }),
    });
    if (!res.ok) throw new Error(await res.text());
    reply = await res.json();
  } catch (e) {
    console.error(e);
    setStatus("Brain hiccup: " + e.message);
    busy = false;
    els.talkBtn.disabled = !connected;
    return;
  }

  history.push({ role: "user", content: question || "(reacting to the camera)" });
  history.push({ role: "assistant", content: `ANGEL: ${reply.angel}\nDEVIL: ${reply.devil}` });

  setStatus("");
  // Alternate who speaks first so it feels like a real back-and-forth.
  const order = angelFirst
    ? [["angel", reply.angel], ["devil", reply.devil]]
    : [["devil", reply.devil], ["angel", reply.angel]];
  angelFirst = !angelFirst;

  try {
    for (const [who, line] of order) {
      await speakAs(who, line);
    }
  } catch (e) {
    // A failed D-ID /talk (e.g. rate limit) must NOT wedge the app — always
    // fall through to reset `busy` below, or hold-to-talk/typing stops working.
    console.error("speak failed:", e);
    setStatus(/429|Too Many Requests/.test(e.message)
      ? "D-ID is rate-limiting — wait a few seconds, then try again."
      : "Avatar speech failed: " + e.message);
  } finally {
    busy = false;
    els.talkBtn.disabled = !connected;
  }
}

async function speakAs(who, line) {
  const wrap = who === "angel" ? els.angelWrap : els.devilWrap;
  const caption = who === "angel" ? els.angelCaption : els.devilCaption;
  const avatar = who === "angel" ? angel : devil;
  caption.textContent = line;
  wrap.classList.add("speaking");
  // Keep the decorated still in place until D-ID actually starts streaming
  // talking frames — fading it the instant we call speak() would flash a blank
  // orb during the render gap. Fallback timer in case the event is missed.
  let revealed = false;
  const reveal = () => { if (!revealed) { revealed = true; revealLive(who); } };
  avatar.onStreamStart = reveal;
  const revealFallback = setTimeout(reveal, 1500);
  try {
    await avatar.speak(line, voiceOverride);
  } finally {
    clearTimeout(revealFallback);
    avatar.onStreamStart = () => {};
    wrap.classList.remove("speaking");
  }
}

// ── Presence reactions (canned + gated) ─────────────────────────────────
// BOTH characters take turns reacting when you leave / come back. Canned lines
// (no brain call), fired on absence/return detected in tracking.js. Cooldown is
// per-event so a "welcome back" is never blocked by the "you left" line.
const QUIP_COOLDOWN = 6000; // ms before the SAME event can re-fire (anti-flicker)
const lastQuipAt = { left: 0, returned: 0 };
let pendingQuip = null; // a presence event that arrived mid-speech, fired after
const QUIPS = {
  left: {
    angel: ["Take your time — I'll be right here.", "Off to do something good, I hope?", "Hurry back!"],
    devil: ["Oh sure, just walk off mid-conversation.", "Wow. Rude. I was mid-genius.", "Running from your problems? Bold."],
  },
  returned: {
    angel: ["There you are — welcome back!", "Oh good, you came back to us!", "Knew you couldn't stay away."],
    devil: [
      "Oh look, the prodigal genius returns.",
      "Back already? I was enjoying the peace and quiet.",
      "Welcome back, superstar. We were on the edge of our halos.",
      "Took you long enough — get lost finding the chair?",
    ],
  },
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function quip(event) {
  if (!connected || !QUIPS[event]) return;
  // Mid-speech (a real turn or the other reaction)? Queue this one for after.
  if (busy) { pendingQuip = event; return; }
  const now = performance.now();
  if (now - lastQuipAt[event] < QUIP_COOLDOWN) return;
  lastQuipAt[event] = now;
  busy = true;
  els.talkBtn.disabled = true;

  // On return, angel welcomes first so the devil's sarcasm lands as the kicker;
  // on leaving, just alternate who opens.
  const order = event === "returned"
    ? ["angel", "devil"]
    : (angelFirst ? ["angel", "devil"] : ["devil", "angel"]);
  if (event !== "returned") angelFirst = !angelFirst;

  try {
    for (const who of order) await speakAs(who, pick(QUIPS[event][who]));
  } catch (e) {
    console.warn("quip failed:", e.message);
  } finally {
    busy = false;
    els.talkBtn.disabled = !connected;
    // Fire a queued reaction (e.g. you came back while they were still calling
    // you out) — different event, so its own cooldown won't block it.
    const next = pendingQuip;
    pendingQuip = null;
    if (next && next !== event) quip(next);
  }
}

// ── Speech-to-text (record → server transcribe) ──────────────────────────
// Browser SpeechRecognition is unreliable here (Chrome's Google backend is
// unreachable → "network" error). Instead we record the whole hold with
// MediaRecorder and POST it to /api/transcribe on release.
let recording = false; // true between start/stop — guards against double-starts
let mediaRecorder = null;
let micStream = null;
let recChunks = [];

async function startListening() {
  if (!connected || busy || recording) return;
  recording = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    recording = false;
    if (e.name === "NotAllowedError") {
      setStatus("Microphone blocked — allow mic access in the address bar, then retry.");
    } else {
      setStatus("Mic unavailable: " + e.message);
    }
    return;
  }
  recChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  mediaRecorder.start();
  els.talkBtn.classList.add("listening"); // turns the button orange
  els.youSaid.textContent = "Listening…";
}

function stopListening() {
  if (!recording || !mediaRecorder) return;
  // Wait for the recorder to flush, then handle the audio.
  const rec = mediaRecorder;
  rec.onstop = () => {
    const blob = new Blob(recChunks, { type: rec.mimeType || "audio/webm" });
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    mediaRecorder = null;
    els.talkBtn.classList.remove("listening");
    recording = false;
    finishRecording(blob);
  };
  rec.stop();
}

async function finishRecording(blob) {
  // Released too fast to capture anything — quietly reset.
  if (!blob.size) {
    els.youSaid.textContent = "";
    return;
  }
  els.youSaid.textContent = "Transcribing…";
  try {
    const dataUrl = await blobToDataUrl(blob);
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: dataUrl }),
    });
    if (!res.ok) {
      let reason = res.statusText;
      try {
        reason = (await res.json()).error || reason;
      } catch {
        /* non-JSON error body */
      }
      setStatus("Transcription failed: " + reason);
      els.youSaid.textContent = "";
      return;
    }
    const { text } = await res.json();
    const t = (text || "").trim();
    if (t) ask(t);
    else {
      els.youSaid.textContent = "";
      setStatus("Didn't catch that — hold and speak, or type.");
    }
  } catch (e) {
    setStatus("Transcription failed: " + e.message);
    els.youSaid.textContent = "";
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────
els.connectBtn.addEventListener("click", () => {
  if (connected || els.connectBtn.disabled) return;
  els.connectBtn.disabled = true;
  els.connectBtn.classList.add("summoning"); // shrink away…
  // …then, on the shrink's own timeline (not the network's), bloom the loader.
  setTimeout(() => {
    if (!connected && els.connectBtn.classList.contains("summoning")) {
      showLoader(true);
      setStatus("");
    }
  }, 360);
  connect();
});
els.disconnectBtn.addEventListener("click", () => {
  if (connected) disconnect();
});
els.faceBtn.addEventListener("click", toggleMyFace);
els.voiceBtn.addEventListener("click", toggleMyVoice);
// Voice upload temporarily disabled
// els.voiceFile.addEventListener("change", (e) => {
//   const f = e.target.files?.[0];
//   if (f) uploadVoice(f);
//   e.target.value = "";
// });

// Don't leak D-ID sessions on reload/close — tear streams down on the way out.
window.addEventListener("pagehide", () => {
  angel?.beaconClose();
  devil?.beaconClose();
});

// Hold-to-talk (pointer covers mouse + touch). Capture the pointer so a slight
// drift off the button doesn't cut the recording short — release is detected
// wherever the pointer ends up.
els.talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  try { els.talkBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  startListening();
});
els.talkBtn.addEventListener("pointerup", stopListening);
els.talkBtn.addEventListener("pointercancel", stopListening);

// Spacebar = hold-to-talk, mirroring the button. Ignore key auto-repeat and
// don't hijack the space key while the user is typing in the text box.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || document.activeElement === els.textInput) return;
  e.preventDefault();
  startListening();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || document.activeElement === els.textInput) return;
  e.preventDefault();
  stopListening();
});

els.textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && els.textInput.value.trim()) {
    ask(els.textInput.value.trim());
    els.textInput.value = "";
  }
});

// Config: preset face URLs + a health hint.
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    presetImages = { angel: c.angelImage, devil: c.devilImage };
    const missing = [];
    if (!c.ready?.did) missing.push("DID_API_KEY");
    if (!c.ready?.brain) missing.push("OPENAI_API_KEY");
    if (!c.ready?.voices) missing.push("voice IDs");
    if (missing.length) setStatus("⚠ Missing in .env: " + missing.join(", "));
  })
  .catch(() => {});

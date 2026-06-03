import { DidAvatar } from "./did.js";
import { initTracking, startTracking, stopTracking } from "./tracking.js";
import { decorateFace } from "./decorate.js";

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
  angelWrap: document.getElementById("angel"),
  devilWrap: document.getElementById("devil"),
  angelCaption: document.getElementById("angel-caption"),
  devilCaption: document.getElementById("devil-caption"),
  connectBtn: document.getElementById("connect"),
  faceBtn: document.getElementById("face"),
  voiceBtn: document.getElementById("voice"),
  voiceFile: document.getElementById("voice-file"),
  talkBtn: document.getElementById("talk"),
  textInput: document.getElementById("text-input"),
  status: document.getElementById("status"),
  youSaid: document.getElementById("you-said"),
  captureOverlay: document.getElementById("capture-overlay"),
  voiceOverlay: document.getElementById("voice-overlay"),
};

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
  if (icon && iconClass) icon.className = "fa-duotone " + iconClass;
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
        countEl.innerHTML = '<i class="fa-duotone fa-camera"></i>';
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
    countEl.innerHTML = `<i class="fa-duotone fa-circle" style="color:#ff5a4d"></i> ${s}s`;
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
  setBtn(els.voiceBtn, "Your voice", "fa-circle-check");
  els.voiceBtn.classList.add("active");
  setStatus("Now they speak in your voice. Ask them something!");
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

async function uploadVoice(file) {
  if (busy || !connected || !file) return;
  busy = true;
  els.voiceBtn.disabled = true;
  try {
    await cloneAndApply(file);
  } catch (e) {
    console.error(e);
    setStatus("Voice upload failed: " + e.message);
  }
  busy = false;
  els.voiceBtn.disabled = !connected;
}

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

// Decorate one face and upload it; returns a D-ID source URL, or null to let
// the server fall back to the plain preset.
async function decoratedSource(type, baseEl) {
  try {
    return await uploadDataUrl(await decorateFace(baseEl, type));
  } catch (e) {
    console.warn(`decorate ${type} failed:`, e.message);
    return null;
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
  const [angelUrl, devilUrl] = await Promise.all([
    decoratedSource("angel", angelBase),
    decoratedSource("devil", devilBase),
  ]);
  return { angel: angelUrl, devil: devilUrl };
}

// ── Connect / disconnect ────────────────────────────────────────────────
async function connect() {
  els.connectBtn.disabled = true;
  setStatus("Starting camera…");
  try {
    await startCamera();
  } catch (e) {
    setStatus("Camera/mic permission needed. Allow access and retry.");
    els.connectBtn.disabled = false;
    return;
  }

  setStatus("Giving them their halo and horns…");
  let sources;
  try {
    sources = await prepareSources();
  } catch (e) {
    console.warn("source prep failed, using plain presets:", e.message);
    sources = { angel: null, devil: null };
  }

  setStatus("Summoning your shoulder angels…");
  angel = new DidAvatar("angel", els.angelVideo, sources.angel);
  devil = new DidAvatar("devil", els.devilVideo, sources.devil);
  try {
    await Promise.all([angel.connect(), devil.connect()]);
  } catch (e) {
    console.error(e);
    // Clean up whichever stream did open so it doesn't leak.
    await Promise.allSettled([angel?.disconnect(), devil?.disconnect()]);
    const msg = /Max user sessions/.test(e.message)
      ? "D-ID says too many open sessions. Close other tabs running this, wait ~1–2 min for old streams to expire, then retry."
      : "Couldn't connect avatars: " + e.message;
    setStatus(msg);
    els.connectBtn.disabled = false;
    return;
  }

  connected = true;
  els.stage.classList.add("connected");
  setBtn(els.connectBtn, "Disconnect", "fa-link-slash");
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
      startTracking(els.userVideo, els.stage, { angel: els.angelWrap, devil: els.devilWrap });
    }
  });

  // Opening bit so the demo starts with energy.
  ask("", { silentUser: true });
}

async function disconnect() {
  connected = false;
  stopTracking({ angel: els.angelWrap, devil: els.devilWrap });
  els.stage.classList.remove("connected");
  els.talkBtn.disabled = true;
  els.faceBtn.disabled = true;
  els.voiceBtn.disabled = true;
  els.textInput.disabled = true;
  setStatus("Disconnected. Credits saved.");
  setBtn(els.connectBtn, "Summon them", "fa-wand-magic-sparkles");
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
  let swapped = false;
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
    angel = new DidAvatar("angel", els.angelVideo, sources.angel);
    devil = new DidAvatar("devil", els.devilVideo, sources.devil);
    await Promise.all([angel.connect(), devil.connect()]);

    setBtn(els.faceBtn, usingMyFace ? "Reset faces" : "Use my face",
      usingMyFace ? "fa-rotate-left" : "fa-face-viewfinder");
    setStatus(usingMyFace ? "Meet good-you and evil-you." : "");
    swapped = true;
  } catch (e) {
    console.error(e);
    usingMyFace = !target; // revert flag on failure
    setStatus("Face swap failed: " + e.message);
  }

  busy = false;
  els.faceBtn.disabled = !connected;
  els.talkBtn.disabled = !connected;

  // A freshly respawned D-ID stream renders blank until its first talk, so
  // kick off an opening line — this makes the new faces appear immediately
  // (and gives the demo a reaction beat right after the swap).
  if (swapped && connected) ask("", { silentUser: true });
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

  for (const [who, line] of order) {
    await speakAs(who, line);
  }

  busy = false;
  els.talkBtn.disabled = !connected;
}

async function speakAs(who, line) {
  const wrap = who === "angel" ? els.angelWrap : els.devilWrap;
  const caption = who === "angel" ? els.angelCaption : els.devilCaption;
  const avatar = who === "angel" ? angel : devil;
  caption.textContent = line;
  wrap.classList.add("speaking");
  try {
    await avatar.speak(line, voiceOverride);
  } finally {
    wrap.classList.remove("speaking");
  }
}

// ── Speech-to-text (browser, no key) ─────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SR) {
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if (transcript) ask(transcript);
  };
  recognition.onend = () => {
    listening = false;
    els.talkBtn.classList.remove("listening");
  };
  recognition.onerror = () => {
    listening = false;
    els.talkBtn.classList.remove("listening");
  };
}

function startListening() {
  if (!recognition || listening || busy || !connected) return;
  listening = true;
  els.talkBtn.classList.add("listening");
  els.youSaid.textContent = "Listening…";
  try {
    recognition.start();
  } catch {
    /* already started */
  }
}
function stopListening() {
  if (recognition && listening) recognition.stop();
}

// ── Wiring ───────────────────────────────────────────────────────────────
els.connectBtn.addEventListener("click", () =>
  connected ? disconnect() : connect(),
);
els.faceBtn.addEventListener("click", toggleMyFace);
els.voiceBtn.addEventListener("click", useMyVoice);
els.voiceFile.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) uploadVoice(f);
  e.target.value = "";
});

// Don't leak D-ID sessions on reload/close — tear streams down on the way out.
window.addEventListener("pagehide", () => {
  angel?.beaconClose();
  devil?.beaconClose();
});

// Hold-to-talk (pointer covers mouse + touch).
els.talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startListening();
});
els.talkBtn.addEventListener("pointerup", stopListening);
els.talkBtn.addEventListener("pointerleave", stopListening);

els.textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && els.textInput.value.trim()) {
    ask(els.textInput.value.trim());
    els.textInput.value = "";
  }
});

if (!SR) {
  els.talkBtn.title = "Speech recognition unsupported here — type your question instead.";
}

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

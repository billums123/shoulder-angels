import { DidAvatar } from "./did.js";

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
  talkBtn: document.getElementById("talk"),
  textInput: document.getElementById("text-input"),
  status: document.getElementById("status"),
  youSaid: document.getElementById("you-said"),
};

let angel, devil;
let connected = false;
let busy = false;
let angelFirst = true; // alternate who opens each turn
const history = [];

function setStatus(msg) {
  els.status.textContent = msg;
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

function captureFrame() {
  const v = els.userVideo;
  if (!v.videoWidth) return null;
  const w = 512;
  const h = Math.round((v.videoHeight / v.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(v, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.7);
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

  setStatus("Summoning your shoulder angels…");
  angel = new DidAvatar("angel", els.angelVideo);
  devil = new DidAvatar("devil", els.devilVideo);
  try {
    await Promise.all([angel.connect(), devil.connect()]);
  } catch (e) {
    console.error(e);
    setStatus("Couldn't connect avatars: " + e.message);
    els.connectBtn.disabled = false;
    return;
  }

  connected = true;
  els.stage.classList.add("connected");
  els.connectBtn.textContent = "Disconnect";
  els.connectBtn.disabled = false;
  els.talkBtn.disabled = false;
  els.textInput.disabled = false;
  setStatus("Hold the button (or type) and ask them anything.");

  // Opening bit so the demo starts with energy.
  ask("", { silentUser: true });
}

async function disconnect() {
  connected = false;
  els.stage.classList.remove("connected");
  els.talkBtn.disabled = true;
  els.textInput.disabled = true;
  setStatus("Disconnected. Credits saved 💸");
  els.connectBtn.textContent = "Connect";
  await Promise.allSettled([angel?.disconnect(), devil?.disconnect()]);
  const s = els.userVideo.srcObject;
  if (s) s.getTracks().forEach((t) => t.stop());
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
    await avatar.speak(line);
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

// Health hint on load.
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    const missing = [];
    if (!c.ready?.did) missing.push("DID_API_KEY");
    if (!c.ready?.brain) missing.push("ANTHROPIC_API_KEY");
    if (!c.ready?.voices) missing.push("voice IDs");
    if (missing.length) setStatus("⚠ Missing in .env: " + missing.join(", "));
  })
  .catch(() => {});

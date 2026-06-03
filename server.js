import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "10mb" })); // webcam frames ride along as base64

const {
  DID_API_KEY,
  DID_API_URL = "https://api.d-id.com",
  OPENAI_API_KEY,
  BRAIN_MODEL = "gpt-4o",
  ANGEL_IMAGE_URL,
  DEVIL_IMAGE_URL,
  ANGEL_VOICE_ID,
  DEVIL_VOICE_ID,
  ELEVENLABS_API_KEY,
  PORT = 3000,
} = process.env;

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

const PRESENTERS = {
  angel: { image: ANGEL_IMAGE_URL, voice: ANGEL_VOICE_ID },
  devil: { image: DEVIL_IMAGE_URL, voice: DEVIL_VOICE_ID },
};

// ── D-ID proxy ──────────────────────────────────────────────────────────
// The API key never leaves the server; the browser talks only to us.
async function didFetch(endpoint, { method = "POST", body } = {}) {
  try {
    const res = await fetch(`${DID_API_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${DID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) console.warn(`D-ID ${method} ${endpoint} → ${res.status}`, data);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // Never let a thrown error leave the HTTP request hanging "pending".
    console.error(`D-ID ${method} ${endpoint} threw:`, err.message);
    return { ok: false, status: 502, data: { error: err.message } };
  }
}

// Same-origin proxy for external images, so the browser can draw preset faces
// onto a canvas (to bake halo/horns) without tainting it via CORS.
app.get("/api/proxy-image", async (req, res) => {
  const url = req.query.url;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    return res.status(400).json({ error: "https url required" });
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Upload a still (e.g. a webcam frame) to D-ID → returns a hosted image URL
// that can be used as a stream's face. Powers the "evil twin" feature.
app.post("/api/did/images", async (req, res) => {
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(req.body?.image || "");
  if (!m) return res.status(400).json({ error: "bad image data" });
  const buf = Buffer.from(m[2], "base64");
  const form = new FormData();
  form.append("image", new Blob([buf], { type: m[1] }), "face.jpg");
  const r = await fetch(`${DID_API_URL}/images`, {
    method: "POST",
    headers: { Authorization: `Basic ${DID_API_KEY}` }, // let fetch set multipart boundary
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  res.status(r.ok ? 200 : r.status).json(data);
});

// Clone a voice from a recorded/uploaded audio sample via ElevenLabs Instant
// Voice Cloning → returns a voice_id usable by D-ID. The voice is created in
// the same ElevenLabs account connected to D-ID, so D-ID can speak it.
app.post("/api/clone-voice", async (req, res) => {
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set" });
  const m = /^data:(audio\/[\w.+-]+);base64,(.+)$/s.exec(req.body?.audio || "");
  if (!m) return res.status(400).json({ error: "bad audio data" });
  const buf = Buffer.from(m[2], "base64");
  const ext = m[1].includes("webm") ? "webm" : /mpeg|mp3/.test(m[1]) ? "mp3" : m[1].includes("wav") ? "wav" : "m4a";
  const headers = { "xi-api-key": ELEVENLABS_API_KEY };

  try {
    // Remove prior clones from this app so we don't pile up against the
    // account's custom-voice limit.
    const list = await fetch(`${ELEVENLABS_API}/voices`, { headers })
      .then((r) => r.json())
      .catch(() => ({ voices: [] }));
    for (const v of list.voices || []) {
      if (v.voice_id && typeof v.name === "string" && v.name.startsWith("shoulder-angels")) {
        await fetch(`${ELEVENLABS_API}/voices/${v.voice_id}`, { method: "DELETE", headers }).catch(() => {});
      }
    }

    const form = new FormData();
    form.append("name", `shoulder-angels-${Date.now()}`);
    form.append("files", new Blob([buf], { type: m[1] }), `voice.${ext}`);
    const r = await fetch(`${ELEVENLABS_API}/voices/add`, { method: "POST", headers, body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn("clone-voice failed:", r.status, data);
      return res.status(r.status).json(data);
    }
    res.json({ voice_id: data.voice_id });
  } catch (e) {
    console.error("clone-voice error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// Create a stream for one presenter (angel|devil) → SDP offer + ice servers.
// An optional source_url (e.g. a D-ID-hosted upload) overrides the preset face.
app.post("/api/did/streams", async (req, res) => {
  const presenter = PRESENTERS[req.body?.presenter];
  const override = req.body?.source_url;
  // D-ID's own image uploads come back as s3:// URIs (resolved internally by
  // D-ID), so accept those as well as plain https:// image URLs.
  const source_url =
    typeof override === "string" && /^(https|s3):\/\//.test(override)
      ? override
      : presenter?.image;
  if (!source_url) {
    return res.status(400).json({ error: "unknown or unconfigured presenter" });
  }
  const { ok, status, data } = await didFetch("/talks/streams", {
    body: { source_url, stream_warmup: true },
  });
  res.status(ok ? 200 : status).json(data);
});

// Browser's SDP answer → D-ID.
app.post("/api/did/streams/:id/sdp", async (req, res) => {
  const { ok, status, data } = await didFetch(
    `/talks/streams/${req.params.id}/sdp`,
    { body: req.body },
  );
  res.status(ok ? 200 : status).json(data);
});

// Trickle ICE candidates → D-ID.
app.post("/api/did/streams/:id/ice", async (req, res) => {
  const { ok, status, data } = await didFetch(
    `/talks/streams/${req.params.id}/ice`,
    { body: req.body },
  );
  res.status(ok ? 200 : status).json(data);
});

// Make a presenter speak a line in its ElevenLabs voice. An optional voice_id
// (e.g. a cloned "use my voice" voice) overrides the preset.
app.post("/api/did/streams/:id/talk", async (req, res) => {
  const { text, presenter, session_id, voice_id } = req.body || {};
  const voice = voice_id || PRESENTERS[presenter]?.voice;
  if (!text || !voice) {
    return res.status(400).json({ error: "missing text or voice" });
  }
  const { ok, status, data } = await didFetch(`/talks/streams/${req.params.id}`, {
    body: {
      session_id,
      script: {
        type: "text",
        input: text,
        provider: { type: "elevenlabs", voice_id: voice },
      },
      config: { fluent: true, pad_audio: 0 },
    },
  });
  res.status(ok ? 200 : status).json(data);
});

// Tear a stream down (stop billing!).
app.delete("/api/did/streams/:id", async (req, res) => {
  const { ok, status, data } = await didFetch(
    `/talks/streams/${req.params.id}`,
    { method: "DELETE", body: req.body },
  );
  res.status(ok ? 200 : status).json(data);
});

// ── The brain: OpenAI sees you + writes both characters' turn ───────────
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const SYSTEM_PROMPT = `You are the writers' room for "Shoulder Angels" — a comedic two-character bit.

There are two characters perched by the user's head, and you write BOTH of their lines for every turn:
- ANGEL 😇 — the good conscience. Wholesome, encouraging, a little smug about being right. Gives the responsible take.
- DEVIL 😈 — the bad conscience. Mischievous, indulgent, hilarious. Tempts the user toward the fun/lazy/over-the-top option. Always playful and harmless — never genuinely harmful, hateful, or dangerous; "bad" here means cheeky, not unsafe.

Rules for every turn:
- You are given the user's spoken question/comment AND a snapshot from their camera. USE what you see — react to their face, expression, outfit, room, what they're holding. Specific observations are funnier and prove you can see them.
- The two characters know about each other and bicker. The devil often pokes at the angel; the angel sighs at the devil. Make it feel like a real back-and-forth.
- Keep EACH line to 1-2 short sentences. This is spoken aloud by a TTS avatar, so be punchy and conversational. No stage directions, no emojis in the spoken text, no markdown.
- Stay in character. Be quick and witty over verbose.`;

const REPLY_TOOL = {
  type: "function",
  function: {
    name: "shoulder_reply",
    description: "Provide the angel's and devil's spoken lines for this turn.",
    parameters: {
      type: "object",
      properties: {
        angel: { type: "string", description: "The angel's spoken line (1-2 sentences)." },
        devil: { type: "string", description: "The devil's spoken line (1-2 sentences)." },
      },
      required: ["angel", "devil"],
    },
  },
};

app.post("/api/brain", async (req, res) => {
  if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

  const { question = "", image, history = [] } = req.body || {};

  const content = [
    {
      type: "text",
      text: question
        ? `The user just said: "${question}"\n\nWrite the angel's and devil's replies.`
        : `The user didn't say anything specific — react to what you see in the camera. Write the angel's and devil's replies.`,
    },
  ];
  if (image) {
    content.push({ type: "image_url", image_url: { url: image, detail: "low" } });
  }

  // Trim history to recent turns for context (keeps them responding to each other).
  const priorTurns = history.slice(-6).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  try {
    const completion = await openai.chat.completions.create({
      model: BRAIN_MODEL,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...priorTurns,
        { role: "user", content },
      ],
      tools: [REPLY_TOOL],
      tool_choice: { type: "function", function: { name: "shoulder_reply" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    if (!call) return res.status(502).json({ error: "no reply produced" });
    const { angel, devil } = JSON.parse(call.function.arguments);
    res.json({ angel, devil });
  } catch (err) {
    console.error("brain error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Config for the client (no secrets) ──────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    angelImage: ANGEL_IMAGE_URL,
    devilImage: DEVIL_IMAGE_URL,
    ready: {
      did: Boolean(DID_API_KEY),
      brain: Boolean(OPENAI_API_KEY),
      voices: Boolean(ANGEL_VOICE_ID && DEVIL_VOICE_ID),
      clone: Boolean(ELEVENLABS_API_KEY),
    },
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`😇 Shoulder Angels running → http://localhost:${PORT}`);
  if (!DID_API_KEY) console.warn("  ⚠  DID_API_KEY not set");
  if (!OPENAI_API_KEY) console.warn("  ⚠  OPENAI_API_KEY not set");
});

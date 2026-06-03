import express from "express";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "10mb" })); // webcam frames ride along as base64

const {
  DID_API_KEY,
  DID_API_URL = "https://api.d-id.com",
  ANTHROPIC_API_KEY,
  BRAIN_MODEL = "claude-sonnet-4-6",
  ANGEL_IMAGE_URL,
  DEVIL_IMAGE_URL,
  ANGEL_VOICE_ID,
  DEVIL_VOICE_ID,
  PORT = 3000,
} = process.env;

const PRESENTERS = {
  angel: { image: ANGEL_IMAGE_URL, voice: ANGEL_VOICE_ID },
  devil: { image: DEVIL_IMAGE_URL, voice: DEVIL_VOICE_ID },
};

// ── D-ID proxy ──────────────────────────────────────────────────────────
// The API key never leaves the server; the browser talks only to us.
async function didFetch(endpoint, { method = "POST", body } = {}) {
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
  return { ok: res.ok, status: res.status, data };
}

// Create a stream for one presenter (angel|devil) → SDP offer + ice servers.
app.post("/api/did/streams", async (req, res) => {
  const presenter = PRESENTERS[req.body?.presenter];
  if (!presenter?.image) {
    return res.status(400).json({ error: "unknown or unconfigured presenter" });
  }
  const { ok, status, data } = await didFetch("/talks/streams", {
    body: { source_url: presenter.image, stream_warmup: true },
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

// Make a presenter speak a line in its ElevenLabs voice.
app.post("/api/did/streams/:id/talk", async (req, res) => {
  const { text, presenter, session_id } = req.body || {};
  const voice = PRESENTERS[presenter]?.voice;
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

// ── The brain: Claude sees you + writes both characters' turn ───────────
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

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
  name: "shoulder_reply",
  description: "Provide the angel's and devil's spoken lines for this turn.",
  input_schema: {
    type: "object",
    properties: {
      angel: { type: "string", description: "The angel's spoken line (1-2 sentences)." },
      devil: { type: "string", description: "The devil's spoken line (1-2 sentences)." },
    },
    required: ["angel", "devil"],
  },
};

app.post("/api/brain", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { question = "", image, history = [] } = req.body || {};

  const content = [];
  if (image) {
    const m = /^data:(image\/\w+);base64,(.+)$/s.exec(image);
    if (m) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: m[1], data: m[2] },
      });
    }
  }
  content.push({
    type: "text",
    text: question
      ? `The user just said: "${question}"\n\nWrite the angel's and devil's replies.`
      : `The user didn't say anything specific — react to what you see in the camera. Write the angel's and devil's replies.`,
  });

  // Trim history to recent turns for context (keeps them responding to each other).
  const priorTurns = history.slice(-6).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  try {
    const msg = await anthropic.messages.create({
      model: BRAIN_MODEL,
      max_tokens: 400,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [REPLY_TOOL],
      tool_choice: { type: "tool", name: "shoulder_reply" },
      messages: [...priorTurns, { role: "user", content }],
    });
    const tool = msg.content.find((c) => c.type === "tool_use");
    if (!tool) return res.status(502).json({ error: "no reply produced" });
    res.json({ angel: tool.input.angel, devil: tool.input.devil });
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
      brain: Boolean(ANTHROPIC_API_KEY),
      voices: Boolean(ANGEL_VOICE_ID && DEVIL_VOICE_ID),
    },
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`😇 Shoulder Angels running → http://localhost:${PORT}`);
  if (!DID_API_KEY) console.warn("  ⚠  DID_API_KEY not set");
  if (!ANTHROPIC_API_KEY) console.warn("  ⚠  ANTHROPIC_API_KEY not set");
});

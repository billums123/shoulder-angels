# 😇 Shoulder Angels 😈

Two AI "shoulder angels" — a good one and a bad one — that perch on either side
of your head, **see you through your camera**, and **take turns** answering
whatever you ask out loud. The angel gives you the wholesome take; the devil
(sharp-tongued and gleefully sarcastic) tempts you. They riff off each other.

Built for the **D-ID × ElevenLabs hackathon** ("Build an AI agent where the
visual experience is essential, not optional").

- **D-ID** — two real-time streaming avatars (the faces on your shoulders).
- **ElevenLabs** — the distinct voices for each character (via D-ID's TTS
  provider), plus **instant voice cloning** so they can speak in *your* voice.
- **OpenAI** — the "brain": looks at a webcam frame so the angels react to
  *you* and writes both characters' turn-taking dialogue, **and** transcribes
  your speech (Whisper).
- **TensorFlow.js (MoveNet)** — tracks your shoulders so the avatars perch on
  them, and finds your head to bake a halo / red ring into each face.

## Extras

- **👤 Use my face** — alignment guide + countdown, then both avatars wear your
  face (good-you 😇 vs evil-you 😈), each with its ring baked in. Toggle off to
  restore the preset faces.
- **🎙️ Use my voice** — record a short sample → ElevenLabs clones it → both
  avatars speak in your voice. Toggle off to restore their preset voices.
  (Needs a paid ElevenLabs plan — Starter+.)
- **Hold to talk** — hold the mic button **or the spacebar** to ask a question;
  release to send. Or just type.
- **Shoulder tracking** — the avatars perch on your shoulders and follow you;
  they drift to the corners if no pose is found.
- **Presence reactions** — step out of frame and both characters call you out;
  come back and they welcome you (the devil, sarcastically).

## How it works

```
  🎤 hold to talk  ──►  record mic  ──►  /api/transcribe  ──►  OpenAI (Whisper)
                                                                     │  text
                              📸 webcam frame  +  ◄───────────────────┘
                                     │
                                     ▼
                                /api/brain  ──►  OpenAI (vision)
                                     │            └─► { angel: "...", devil: "..." }
                                     ▼
        ┌─────────────────────────────────────────┐
        │  angel line ─► D-ID stream A (angel face) │  speaks w/ ElevenLabs voice
        │       then                                │
        │  devil line ─► D-ID stream B (devil face) │  speaks w/ ElevenLabs voice
        └─────────────────────────────────────────┘
```

The backend is the orchestrator — it holds the API keys and the running
transcript, so the two avatars genuinely respond to each other and to you. All
D-ID / OpenAI / ElevenLabs calls are proxied through the server; the browser
never sees a key.

**Speech-to-text** is done server-side via OpenAI Whisper (record → upload →
transcribe), rather than the browser's Web Speech API, which is unreliable on
many networks.

**Using your own ElevenLabs voices:** D-ID can normally only speak its built-in
or public-library voices. To let it speak voices that live in *your* ElevenLabs
account (a voice you designed, or one cloned via "Use my voice"), the server
forwards your `ELEVENLABS_API_KEY` to D-ID on every call via the
`x-api-key-external` header. No D-ID Studio integration step required.

## Setup

1. **Install**
   ```bash
   npm install
   ```

2. **Keys** — copy `.env.example` to `.env` and fill in:
   - `DID_API_KEY` — from D-ID Studio (top-right → API keys).
   - `OPENAI_API_KEY` — from https://platform.openai.com/api-keys (vision-capable model).
   - `ELEVENLABS_API_KEY` — from https://elevenlabs.io → Profile → API key. The
     server forwards this to D-ID so it can speak your account's voices.
   - `ANGEL_VOICE_ID` / `DEVIL_VOICE_ID` — public library voices, or private
     designed/cloned voices from your ElevenLabs account.
   - Optionally swap `ANGEL_IMAGE_URL` / `DEVIL_IMAGE_URL` for your own angel /
     devil character art (any public image URL with a clear face).

3. **Run**
   ```bash
   npm start
   ```
   Open http://localhost:3000 (or your `PORT`), allow camera + microphone, hit
   **Summon**, then hold the mic button (or spacebar) and ask the angels anything.

## Cost notes

- **D-ID** — Talks Streams bills per streaming-second, and this runs **two**
  streams. Click **Disconnect** when you're done so you don't burn credits idling.
- **OpenAI** — each turn makes a vision call (brain) and a Whisper call (STT).
  `gpt-4o-mini` is the default for speed and cost; set `BRAIN_MODEL=gpt-4o` for
  more wit.
- **ElevenLabs** — instant voice cloning and private voices require a paid plan
  (Starter+).

## Files

- `server.js` — Express: D-ID proxy (with the ElevenLabs key header), OpenAI
  brain + Whisper transcription, voice cloning, config, static hosting.
- `public/did.js` — D-ID Talks Streams WebRTC client (one instance per avatar).
- `public/app.js` — camera, hold-to-talk recording, orchestration, turn-taking,
  presence reactions.
- `public/tracking.js` — MoveNet pose tracking (shoulders + head box).
- `public/decorate.js` — bakes the halo / red ring onto each face.
- `public/loader.js` / `public/loader-worker.js` — the themed summon loader.
- `public/index.html` / `public/styles.css` — the shoulder-angel stage.

# 😇 Shoulder Angels 😈

Two AI "shoulder angels" — a good one and a bad one — that sit on either side of
your head, **see you through your camera**, and **take turns** answering whatever
you ask out loud. The angel gives you the wholesome take; the devil tempts you.
They riff off each other.

Built for the **D-ID × ElevenLabs hackathon** ("Build an AI agent where the
visual experience is essential, not optional").

- **D-ID** — two real-time streaming avatars (the faces on your shoulders).
- **ElevenLabs** — the distinct voices for each character (via D-ID's TTS
  provider), plus **instant voice cloning** so they can speak in *your* voice.
- **OpenAI (vision)** — the "brain": looks at a webcam frame so the angels can
  react to *you*, and writes both characters' turn-taking dialogue.
- **TensorFlow.js (MoveNet)** — tracks your shoulders so the avatars perch on
  them, and finds your head to bake a halo / red ring into each face.
- **Browser** — camera + speech-to-text (free, no key).

## Extras

- **👤 Use my face** — alignment guide + countdown, then both avatars wear your
  face (good-you 😇 vs evil-you 😈), each with its ring baked in.
- **🎙️ Use my voice** — record a short sample (or upload a clip) → ElevenLabs
  clones it → both avatars speak in your voice. (Needs a paid ElevenLabs plan.)
- **Shoulder tracking** — the avatars follow your shoulders; they drift to the
  corners if no pose is found.

## How it works

```
  🎤 you speak  ──►  Web Speech API (browser STT)
                          │  + 📸 webcam frame
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
transcript, so the two avatars genuinely respond to each other and to you
without any audio-feedback loops.

**Use my face:** hit the **👤 Use my face** button and it snaps a webcam still,
uploads it to D-ID, and respawns *both* avatars wearing your face — a
good-you 😇 and an evil-you 😈 arguing with each other. Hit it again to reset.

## Setup

1. **Install**
   ```bash
   npm install
   ```

2. **Keys** — copy `.env.example` to `.env` and fill in:
   - `DID_API_KEY` — from D-ID Studio (top-right → API keys).
   - `OPENAI_API_KEY` — from https://platform.openai.com/api-keys.
   - In **D-ID Studio → Settings → Integrations**, connect your **ElevenLabs**
     API key. That's what lets D-ID speak in ElevenLabs voices. Then put the
     two `*_VOICE_ID`s you want in `.env`.
   - Optionally swap `ANGEL_IMAGE_URL` / `DEVIL_IMAGE_URL` for your own angel /
     devil character art (any public image URL with a clear face).

3. **Run**
   ```bash
   npm start
   ```
   Open http://localhost:3000, allow camera + microphone, hit **Connect**, then
   **Hold to talk** and ask the angels anything.

## Cost notes (D-ID credits)

Talks Streams bills per streaming-second, and this runs **two** streams. Click
**Disconnect** when you're done filming so you don't burn credits idling. With
1000 credits you have plenty for building + recording the demo clip; just don't
leave it connected.

## Files

- `server.js` — Express: D-ID proxy + OpenAI brain + config + static.
- `public/did.js` — D-ID Talks Streams WebRTC client (one instance per avatar).
- `public/app.js` — camera, speech-to-text, orchestration, turn-taking.
- `public/index.html` / `public/styles.css` — the shoulder-angel stage.

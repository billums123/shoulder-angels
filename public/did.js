// One real-time D-ID streaming avatar. Create two of these (angel + devil).
// All D-ID calls go through our own backend so the API key stays server-side.

export class DidAvatar {
  /**
   * @param {"angel"|"devil"} presenter
   * @param {HTMLVideoElement} videoEl
   */
  constructor(presenter, videoEl, sourceUrl = null) {
    this.presenter = presenter;
    this.video = videoEl;
    this.sourceUrl = sourceUrl; // optional custom face; falls back to preset
    this.pc = null;
    this.streamId = null;
    this.sessionId = null;
    this.onState = () => {};
    this.onStreamStart = () => {}; // fires when D-ID begins streaming talk frames
    this._doneWaiters = [];
  }

  async connect() {
    // 1. Ask D-ID (via our backend) for an SDP offer + ICE servers.
    //    Retry on "Max user sessions" — when respawning (e.g. face swap), the
    //    just-deleted streams can take a moment to free their session slots.
    const session = await this._createStream();
    this.streamId = session.id;
    this.sessionId = session.session_id;

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;

    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
      this._post(`/api/did/streams/${this.streamId}/ice`, {
        candidate,
        sdpMid,
        sdpMLineIndex,
        session_id: this.sessionId,
      }).catch(() => {});
    });

    pc.addEventListener("track", (e) => {
      if (e.streams && e.streams[0]) this.video.srcObject = e.streams[0];
    });

    pc.addEventListener("connectionstatechange", () => {
      this.onState(pc.connectionState);
    });

    // D-ID streams status events ("stream/started", "stream/done", ...) over
    // a data channel. Use them to know exactly when a line finishes speaking.
    const handleMessage = (msg) => {
      const text = typeof msg === "string" ? msg : "";
      if (text.includes("stream/started")) this.onStreamStart();
      if (text.includes("stream/done")) this._resolveDone();
    };
    pc.addEventListener("datachannel", (e) => {
      e.channel.onmessage = (ev) => handleMessage(ev.data);
    });
    try {
      const dc = pc.createDataChannel("JanusDataChannel");
      dc.onmessage = (ev) => handleMessage(ev.data);
    } catch {
      /* server-created channel will arrive via ondatachannel */
    }

    // 2. SDP handshake — D-ID offered, we answer.
    await pc.setRemoteDescription(session.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._post(`/api/did/streams/${this.streamId}/sdp`, {
      answer,
      session_id: this.sessionId,
    });

    await this._waitForConnected();
  }

  /** Speak a line; resolves when the avatar finishes (data-channel signal or
   *  a length-based fallback so turn-taking never stalls). */
  async speak(text, voiceId) {
    if (!text || !this.streamId) return;
    await this._post(`/api/did/streams/${this.streamId}/talk`, {
      text,
      presenter: this.presenter,
      session_id: this.sessionId,
      voice_id: voiceId || undefined,
    });
    await this._waitForDone(text);
  }

  async disconnect() {
    try {
      if (this.streamId) {
        await this._post(`/api/did/streams/${this.streamId}`, {
          session_id: this.sessionId,
        }, "DELETE");
      }
    } catch {
      /* ignore */
    }
    if (this.pc) this.pc.close();
    this.pc = null;
    this.streamId = null;
  }

  // Best-effort teardown during page unload (reload/close). Uses keepalive so
  // the DELETE survives navigation — prevents leaking D-ID sessions, which
  // would otherwise pile up and trigger "Max user sessions reached".
  beaconClose() {
    if (!this.streamId) return;
    const body = JSON.stringify({ session_id: this.sessionId });
    // sendBeacon is the most reliable transport during tab close/unload (the
    // browser guarantees delivery), but it's POST-only — hit the POST teardown
    // route. Fall back to a keepalive DELETE if sendBeacon is unavailable.
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon &&
          navigator.sendBeacon(`/api/did/streams/${this.streamId}/close`, blob)) {
        return;
      }
    } catch {
      /* fall through to keepalive fetch */
    }
    try {
      fetch(`/api/did/streams/${this.streamId}`, {
        method: "DELETE",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      /* ignore */
    }
  }

  // ── internals ──
  async _createStream(tries = 6) {
    for (let i = 0; i < tries; i++) {
      try {
        return await this._post("/api/did/streams", {
          presenter: this.presenter,
          source_url: this.sourceUrl || undefined,
        });
      } catch (e) {
        if (/Max user sessions/.test(e.message) && i < tries - 1) {
          // A just-closed session frees its slot ~10-30s later (D-ID side).
          // Back off and keep trying so connect auto-heals instead of hard-
          // failing: ~2s, 3s, 4s, 5s, 6s ≈ 20s total before giving up.
          await new Promise((r) => setTimeout(r, 2000 + i * 1000));
          continue;
        }
        throw e;
      }
    }
  }

  _resolveDone() {
    const waiters = this._doneWaiters;
    this._doneWaiters = [];
    waiters.forEach((fn) => fn());
  }

  _waitForDone(text) {
    // Fallback duration estimate in case the data-channel "done" event doesn't
    // arrive (it normally does, and resolves the moment audio ends). Kept just
    // above real speech length so turn-taking isn't padded with dead air.
    const fallbackMs = Math.max(1300, (text.length / 15) * 1000) + 700;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, fallbackMs);
      this._doneWaiters.push(done);
    });
  }

  _waitForConnected(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.pc.connectionState === "connected") return resolve();
      const t = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
      const check = () => {
        if (this.pc.connectionState === "connected") {
          clearTimeout(t);
          this.pc.removeEventListener("connectionstatechange", check);
          resolve();
        }
      };
      this.pc.addEventListener("connectionstatechange", check);
    });
  }

  async _post(url, body, method = "POST") {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${url} → ${res.status} ${detail}`);
    }
    return res.json().catch(() => ({}));
  }
}

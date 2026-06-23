/**
 * Camera Grid Card - a Home Assistant Lovelace card showing a responsive
 * grid of camera feeds. Works with any camera entity. Cameras that expose a
 * go2rtc stream-id attribute connect directly to go2rtc's own WebRTC
 * signaling for low-latency video; everything else falls back to plain
 * MJPEG via HA's built-in camera_proxy_stream, which works for any camera
 * entity natively. Connections only ever open on an explicit tap.
 *
 * Built on go2rtc (AlexxIT) - talks directly to its WebRTC signaling.
 *
 * Config:
 *   type: custom:camera-grid-card
 *   go2rtc_url: http://your-go2rtc-host:1984   (optional - enables WebRTC for cameras that have a stream-id attribute)
 *   stream_id_attribute: serial_no              (optional, default "serial_no")
 *   entities: [camera.foo, camera.bar]          (optional, explicit list instead of auto-discovery)
 *   columns_min_width: 600                      (optional, px breakpoint for 2-column layout)
 *   max_stream_minutes: 5                       (optional, default 5. 0 disables - auto-stops a camera left running unattended)
 */

const CARD_VERSION = "2.2.0-dev10";
const FAIL_THRESHOLD = 2;
const FAIL_STORAGE_PREFIX = "camera-grid-card-fails:";

function getFailCount(entity) {
  return Number(localStorage.getItem(FAIL_STORAGE_PREFIX + entity) || 0);
}
function bumpFailCount(entity) {
  const n = getFailCount(entity) + 1;
  localStorage.setItem(FAIL_STORAGE_PREFIX + entity, String(n));
  return n;
}
function resetFailCount(entity) {
  localStorage.removeItem(FAIL_STORAGE_PREFIX + entity);
}

const BROKEN_POSTER_PREFIX = "camera-grid-card-broken-poster:";
const BROKEN_POSTER_RECHECK_MS = 60 * 60 * 1000; // re-verify hourly in case it recovers

function isPosterKnownBroken(entity) {
  const markedAt = Number(localStorage.getItem(BROKEN_POSTER_PREFIX + entity) || 0);
  return markedAt > 0 && Date.now() - markedAt < BROKEN_POSTER_RECHECK_MS;
}
function markPosterBroken(entity) {
  localStorage.setItem(BROKEN_POSTER_PREFIX + entity, String(Date.now()));
}
function clearPosterBroken(entity) {
  localStorage.removeItem(BROKEN_POSTER_PREFIX + entity);
}

function checkPosterLoads(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = url;
  });
}
console.info(`%c camera-grid-card %c ${CARD_VERSION} `, "color: white; background: #03a9f4; font-weight: 700;", "color: #03a9f4; background: white; font-weight: 700;");

class CameraGridCard extends HTMLElement {
  setConfig(config) {
    this.config = {
      stream_id_attribute: "serial_no",
      columns_min_width: 600,
      max_stream_minutes: 5,
      ...config,
    };
    this._built = false;
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this._build();
    }
    this._syncTiles();
  }

  _build() {
    this.innerHTML = `
      <style>
        .grid { display: grid; grid-template-columns: 1fr; gap: 12px; padding: 12px; padding-top: 72px; }
        @media (min-width: ${this.config.columns_min_width}px) { .grid { grid-template-columns: 1fr 1fr; } }
        .tile { position: relative; background: #000; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; aspect-ratio: 16/9; }
        .tile video, .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .tile .label { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.55); padding: 3px 9px; border-radius: 6px; font-size: 13px; color: #eee; }
        .tile .status { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.55); padding: 3px 9px; border-radius: 6px; font-size: 12px; color: #aaa; }
        .tile button.play { position: absolute; inset: 0; width: 100%; height: 100%; background: transparent; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .tile button.play svg { width: 56px; height: 56px; filter: drop-shadow(0 1px 4px rgba(0,0,0,0.8)); }
        .tile button.play.hidden { display: none; }
        .tile .controls { position: absolute; bottom: 8px; left: 8px; right: 8px; display: flex; gap: 6px; justify-content: flex-end; }
        .tile .controls button { background: rgba(0,0,0,0.6); border: none; color: #eee; padding: 6px; border-radius: 6px; display: flex; align-items: center; cursor: pointer; }
        .tile .controls button svg { width: 18px; height: 18px; }
        .tile .controls button.stop { padding: 6px 10px; font-size: 12px; }
        .tile button.retry, .tile button.unavailable { position: absolute; inset: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.3); border: none; color: #eee; font-size: 14px; cursor: pointer; }
        .tile:fullscreen { aspect-ratio: unset; display: flex; align-items: center; }
        .tile:fullscreen video, .tile:fullscreen img { object-fit: contain; }
        .toolbar { position: fixed; top: var(--header-height, 56px); z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-radius: var(--ha-card-border-radius, 12px); background: var(--card-background-color, rgba(127,127,127,0.08)); box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.3)); font-size: 13px; color: var(--secondary-text-color, #888); box-sizing: border-box; }
        .toolbar .summary { margin-right: auto; font-weight: 500; }
        .toolbar .filters { display: flex; gap: 6px; flex-wrap: wrap; }
        .toolbar .filters button { background: var(--secondary-background-color, rgba(127,127,127,0.15)); border: none; color: var(--primary-text-color, #eee); padding: 5px 12px; border-radius: 14px; font-size: 12px; font-weight: 500; cursor: pointer; }
        .toolbar .filters button.active { background: var(--primary-color, #03a9f4); color: #fff; }
        .toolbar .actions { display: flex; gap: 8px; }
        .toolbar .actions button { display: flex; align-items: center; gap: 5px; background: var(--secondary-background-color, rgba(127,127,127,0.15)); border: none; color: var(--primary-text-color, #eee); cursor: pointer; font-size: 12px; font-weight: 500; padding: 5px 12px; border-radius: 14px; }
        .toolbar .actions button svg { width: 14px; height: 14px; }
        .toolbar .actions button.retry-failed svg { fill: var(--warning-color, #ff9800); }
        .toolbar .actions button.stop-all svg { fill: var(--error-color, #db4437); }
      </style>
      <div class="toolbar">
        <div class="summary"></div>
        <div class="filters"></div>
        <div class="actions">
          <button class="retry-failed" style="display:none">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            <span></span>
          </button>
          <button class="stop-all" style="display:none">
            <svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            Stop All
          </button>
        </div>
      </div>
      <div class="grid"></div>
    `;
    this._grid = this.querySelector(".grid");
    this._tiles = new Map();
    this._toolbarEl = this.querySelector(".toolbar");
    this._summaryEl = this.querySelector(".summary");
    this._filtersEl = this.querySelector(".filters");
    this._retryFailedBtn = this.querySelector(".retry-failed");
    this._retryFailedLabel = this._retryFailedBtn.querySelector("span");
    this._stopAllBtn = this.querySelector(".stop-all");
    this._activeFilter = "all";

    this._retryFailedBtn.onclick = () => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(BROKEN_POSTER_PREFIX))
        .forEach((k) => localStorage.removeItem(k));
      this._syncTiles();
    };
    this._stopAllBtn.onclick = () => {
      this._tiles.forEach((t) => {
        if (t.connected) t.stop();
      });
    };

    // position: fixed is anchored to the viewport, which doesn't account
    // for HA's sidebar - measure the card's own rect (which already
    // correctly excludes the sidebar) instead of a hardcoded left value.
    this._positionToolbar = () => {
      const rect = this.getBoundingClientRect();
      this._toolbarEl.style.left = `${rect.left + 12}px`;
      this._toolbarEl.style.width = `${rect.width - 24}px`;
    };
    this._positionToolbar();
    window.addEventListener("resize", this._positionToolbar);
    setTimeout(this._positionToolbar, 300); // re-measure once layout settles
  }

  _discoverCameras() {
    const states = this._hass.states;
    const attr = this.config.stream_id_attribute;
    const ids = this.config.entities
      ? this.config.entities.filter((id) => states[id])
      : Object.keys(states).filter((id) => id.startsWith("camera."));

    const entities = this._hass.entities || {};
    const cameras = ids.map((id) => {
      const stream = states[id].attributes[attr];
      return {
        entity: id,
        stream,
        useWebrtc: Boolean(stream && this.config.go2rtc_url),
        title: states[id].attributes.friendly_name || id,
        platform: (entities[id] && entities[id].platform) || "unknown",
        failed:
          /error/i.test(states[id].attributes.stream_debug || "") ||
          getFailCount(id) >= FAIL_THRESHOLD,
      };
    });

    cameras.sort((a, b) => Number(a.failed) - Number(b.failed));
    return cameras;
  }

  _syncTiles() {
    if (!this._pendingChecks) this._pendingChecks = new Set();
    const cameras = this._discoverCameras();
    const platforms = [...new Set(cameras.map((c) => c.platform))];
    this._renderFilters(platforms);

    let hiddenCount = 0;
    for (const cfg of cameras) {
      if (this._tiles.has(cfg.entity)) {
        const tile = this._tiles.get(cfg.entity);
        tile.updateHass(this._hass);
        tile.el.style.display =
          this._activeFilter === "all" || cfg.platform === this._activeFilter ? "" : "none";
        continue;
      }
      if (isPosterKnownBroken(cfg.entity)) {
        hiddenCount++;
        continue;
      }
      if (this._pendingChecks.has(cfg.entity)) {
        continue;
      }

      this._pendingChecks.add(cfg.entity);
      const pic = this._hass.states[cfg.entity].attributes.entity_picture;
      const url = pic && this._hass.hassUrl ? this._hass.hassUrl(pic) : pic;
      checkPosterLoads(url).then((ok) => {
        this._pendingChecks.delete(cfg.entity);
        if (!ok) {
          markPosterBroken(cfg.entity);
          this._syncTiles();
          return;
        }
        clearPosterBroken(cfg.entity);
        if (this._tiles.has(cfg.entity)) return;
        const tile = new CamTile(cfg, this._hass, this.config.go2rtc_url, () => this._tiles.delete(cfg.entity), this.config.max_stream_minutes);
        if (this._activeFilter !== "all" && cfg.platform !== this._activeFilter) {
          tile.el.style.display = "none";
        }
        this._tiles.set(cfg.entity, tile);
        this._grid.appendChild(tile.el);
      });
    }

    const playingCount = [...this._tiles.values()].filter((t) => t.connected).length;
    this._summaryEl.textContent = `${cameras.length} camera${cameras.length === 1 ? "" : "s"}${hiddenCount ? ` · ${hiddenCount} hidden` : ""}${playingCount ? ` · ${playingCount} playing` : ""}`;

    if (hiddenCount > 0) {
      this._retryFailedLabel.textContent = `Retry Failed (${hiddenCount})`;
      this._retryFailedBtn.style.display = "flex";
    } else {
      this._retryFailedBtn.style.display = "none";
    }
    this._stopAllBtn.style.display = playingCount > 0 ? "flex" : "none";
  }

  _renderFilters(platforms) {
    if (platforms.length <= 1) {
      this._filtersEl.innerHTML = "";
      this._activeFilter = "all";
      return;
    }
    if (this._filtersEl.dataset.rendered === platforms.join(",")) return;
    this._filtersEl.dataset.rendered = platforms.join(",");
    this._filtersEl.innerHTML = ["all", ...platforms]
      .map((p) => `<button data-platform="${p}" class="${p === this._activeFilter ? "active" : ""}">${p === "all" ? "All" : p}</button>`)
      .join("");
    this._filtersEl.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        this._activeFilter = btn.dataset.platform;
        this._filtersEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        this._syncTiles();
      };
    });
  }

  disconnectedCallback() {
    if (this._tiles) this._tiles.forEach((t) => t.destroy());
    if (this._positionToolbar) window.removeEventListener("resize", this._positionToolbar);
  }
}

class CamTile {
  constructor(cfg, hass, go2rtcUrl, onRemove, maxStreamMinutes) {
    this.cfg = cfg;
    this.hass = hass;
    this.go2rtcUrl = go2rtcUrl;
    this.onRemove = onRemove;
    this.maxStreamMinutes = maxStreamMinutes;
    this.pc = null;
    this.ws = null;
    this.connected = false;

    this.el = document.createElement("div");
    this.el.className = "tile";
    this.el.innerHTML = `
      <img class="poster">
      <video playsinline muted autoplay style="display:none"></video>
      <div class="label">${cfg.title}</div>
      <div class="status"></div>
      <button class="play"><svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="unavailable" style="display:none">Unavailable - Try Anyway</button>
      <button class="retry" style="display:none">Retry</button>
      <div class="controls" style="display:none">
        <button class="snapshot" aria-label="Save snapshot">
          <svg viewBox="0 0 24 24" fill="white"><path d="M9 16c0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3-3 1.34-3 3zm6-11l-1.83-2H10.83L9 5H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2h-4zm-3 13c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
        </button>
        <button class="fullscreen" aria-label="Fullscreen">
          <svg viewBox="0 0 24 24" fill="white"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
        </button>
        <button class="stop">Stop</button>
      </div>
    `;
    this.video = this.el.querySelector("video");
    this.poster = this.el.querySelector(".poster");
    this.statusEl = this.el.querySelector(".status");
    this.playBtn = this.el.querySelector(".play");
    this.unavailableBtn = this.el.querySelector(".unavailable");
    this.retryBtn = this.el.querySelector(".retry");
    this.controls = this.el.querySelector(".controls");
    this.stopBtn = this.el.querySelector(".stop");
    this.fullscreenBtn = this.el.querySelector(".fullscreen");
    this.snapshotBtn = this.el.querySelector(".snapshot");

    this._loadPoster();
    this._posterInterval = setInterval(() => {
      if (!this.connected) this._loadPoster();
    }, 30000);

    if (cfg.failed) {
      this.playBtn.classList.add("hidden");
      this.unavailableBtn.style.display = "block";
    }

    this.playBtn.onclick = () => this.play();
    this.unavailableBtn.onclick = () => {
      this.unavailableBtn.style.display = "none";
      this.play();
    };
    this.retryBtn.onclick = () => this.play();
    this.stopBtn.onclick = () => this.stop();
    this.fullscreenBtn.onclick = () => this.toggleFullscreen();
    this.snapshotBtn.onclick = () => this.saveSnapshot();
  }

  toggleFullscreen() {
    // Entering only - browsers provide their own exit affordance (Escape,
    // hover-to-reveal, swipe-down on touch), so we don't need our own.
    const fsTarget = this.cfg.useWebrtc ? this.video : this.poster;
    if (!this.el.requestFullscreen && fsTarget.webkitEnterFullscreen) {
      // True iOS Safari: the standard Fullscreen API doesn't exist on
      // arbitrary containers there at all, only on <video> via this legacy
      // method. Checked second (and gated on the standard API being
      // missing) since some Chromium builds expose this property too
      // without actually needing it.
      fsTarget.webkitEnterFullscreen();
      return;
    }
    if (this.el.requestFullscreen) {
      this.el.requestFullscreen().catch((e) => console.warn("camera-grid-card: requestFullscreen failed", e));
    }
  }

  saveSnapshot() {
    const source = this.cfg.useWebrtc ? this.video : this.poster;
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth || source.naturalWidth;
    canvas.height = source.videoHeight || source.naturalHeight;
    canvas.getContext("2d").drawImage(source, 0, 0);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${this.cfg.entity}-${Date.now()}.png`;
    a.click();
  }

  updateHass(hass) {
    this.hass = hass;
  }

  _loadPoster() {
    const state = this.hass.states[this.cfg.entity];
    const pic = state && state.attributes.entity_picture;
    if (pic) {
      this.poster.onload = () => {
        this._posterFailCount = 0;
      };
      this.poster.onerror = () => {
        this._posterFailCount = (this._posterFailCount || 0) + 1;
        if (this._posterFailCount >= FAIL_THRESHOLD) {
          this.destroy();
          this.el.remove();
          if (this.onRemove) this.onRemove();
          return;
        }
        this.poster.removeAttribute("src");
        this.poster.style.display = "none";
      };
      const url = this.hass.hassUrl ? this.hass.hassUrl(pic) : pic;
      this.poster.src = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
      this.poster.style.display = "block";
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  _scheduleAutoStop() {
    this._clearAutoStop();
    if (this.maxStreamMinutes > 0) {
      this._autoStopTimer = setTimeout(() => this.stop(), this.maxStreamMinutes * 60000);
    }
  }

  _clearAutoStop() {
    if (this._autoStopTimer) {
      clearTimeout(this._autoStopTimer);
      this._autoStopTimer = null;
    }
  }

  async play() {
    if (this.cfg.useWebrtc) {
      await this.playWebrtc();
    } else {
      this.playMjpeg();
    }
  }

  playMjpeg() {
    this.playBtn.classList.add("hidden");
    this.connected = true;
    this.setStatus("live");
    const state = this.hass.states[this.cfg.entity];
    const token = state.attributes.access_token;
    const path = `/api/camera_proxy_stream/${this.cfg.entity}?token=${token}`;
    this.poster.src = this.hass.hassUrl ? this.hass.hassUrl(path) : path;
    this.controls.style.display = "flex";
    this._scheduleAutoStop();
  }

  async playWebrtc() {
    this.playBtn.classList.add("hidden");
    this.retryBtn.style.display = "none";
    this.setStatus("starting…");
    await this.hass.callService("camera", "turn_on", { entity_id: this.cfg.entity });
    const ok = await this.waitForProducer();
    if (!ok) {
      bumpFailCount(this.cfg.entity);
      this.setStatus("error");
      this.retryBtn.style.display = "block";
      return;
    }
    this.connectWebrtc();
  }

  async waitForProducer(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await fetch(`${this.go2rtcUrl}/api/streams`);
        const data = await r.json();
        const entry = data[this.cfg.stream];
        const ok = entry && (entry.producers || []).some((p) => p.format_name === "flv" && p.bytes_recv > 0);
        if (ok) return true;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  connectWebrtc() {
    this.teardown();
    this.setStatus("connecting…");
    this.video.style.display = "block";

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    });
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      if (!this.video.srcObject) this.video.srcObject = new MediaStream();
      this.video.srcObject.addTrack(ev.track);
    };

    const markConnected = () => {
      if (this.connected) return;
      this.connected = true;
      resetFailCount(this.cfg.entity);
      this.setStatus("live");
      this.controls.style.display = "flex";
      this.poster.style.display = "none";
      this._scheduleAutoStop();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        markConnected();
      } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.connected = false;
      }
    };

    // Safari's RTCPeerConnection.connectionState support has historically
    // been unreliable - iceConnectionState is the older, more universally
    // supported signal, used here as a backup trigger.
    pc.oniceconnectionstatechange = () => {
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        markConnected();
      }
    };

    const wsUrl = this.go2rtcUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/api/ws?src=${this.cfg.stream}`);
    this.ws = ws;

    ws.onopen = () => {
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        ws.send(JSON.stringify({ type: "webrtc/candidate", value: ev.candidate.candidate }));
      };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
        ws.send(JSON.stringify({ type: "webrtc/offer", value: pc.localDescription.sdp }));
      });
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "webrtc/candidate") {
        pc.addIceCandidate({ candidate: msg.value, sdpMid: "0" }).catch(() => {});
      } else if (msg.type === "webrtc/answer") {
        pc.setRemoteDescription({ type: "answer", sdp: msg.value }).catch(() => {});
      }
    };

    ws.onerror = () => this.setStatus("error");
    ws.onclose = () => {
      if (!this.connected) this.setStatus("error");
    };
  }

  teardown() {
    this._clearAutoStop();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
    }
    this.connected = false;
  }

  destroy() {
    this.teardown();
    clearInterval(this._posterInterval);
  }

  async stop() {
    this.teardown();
    this.video.style.display = "none";
    if (this.cfg.useWebrtc) {
      await this.hass.callService("camera", "turn_off", { entity_id: this.cfg.entity });
    } else {
      this.poster.removeAttribute("src");
    }
    this.setStatus("");
    this.controls.style.display = "none";
    this.retryBtn.style.display = "none";
    this.playBtn.classList.remove("hidden");
    this._loadPoster();
  }
}

customElements.define("camera-grid-card", CameraGridCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "camera-grid-card",
  name: "Camera Grid Card",
  description: "Responsive camera grid - WebRTC via go2rtc when available, MJPEG fallback for any camera, no token entry.",
});

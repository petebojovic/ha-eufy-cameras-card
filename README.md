# Camera Grid Card

A Home Assistant Lovelace card showing a responsive grid of camera feeds.
Works with **any** camera entity - no third-party card dependency, no token
entry, receives `hass` like any native card.

Cameras that expose a [go2rtc](https://github.com/AlexxIT/go2rtc) stream-id
attribute connect directly to go2rtc's own WebRTC signaling for low-latency
video - this card talks to go2rtc directly, no other card or dependency
involved. Everything else automatically falls back to plain MJPEG via HA's
built-in `camera_proxy_stream`, which works for any camera entity natively -
no go2rtc setup required at all if you don't want it.

## Features

- Works with any camera entity out of the box, no config required
- WebRTC (via go2rtc) for cameras that support it, MJPEG fallback for
  everything else - mixed in the same grid
- Play / Stop, snapshot download, and fullscreen per camera
- Connects only on an explicit tap - never auto-connects on scroll/load
- Failing cameras are pre-checked and skipped before rendering, with
  hourly automatic recovery checks
- Cameras with persistent failures sort to the end of the list, with a
  "Try Anyway" state instead of a normal Play button
- Idle posters are periodically re-checked (whether this actually shows new
  content depends on whether the camera integration itself updates its
  cached image outside of active streaming - not guaranteed for every
  integration)
- A toolbar above the grid: live camera count, filter pills by integration
  (only shown if you have more than one), "Retry Failed", and "Stop All"
- Configurable auto-stop after N minutes (default 5) for any stream left
  running unattended

## Installation

### HACS (custom repository)

1. HACS → ⋮ (top right) → Custom repositories → add this repo's URL.
2. Install "Camera Grid Card" from HACS like any other frontend item.
3. Add the resource if HACS doesn't do it automatically: Settings →
   Dashboards → ⋮ → Resources → `/hacsfiles/ha-camera-grid-card/camera-grid-card.js`,
   type: JavaScript Module.

### Manual

1. Copy `camera-grid-card.js` to `<config>/www/camera-grid-card.js`.
2. Settings → Dashboards → ⋮ → Resources → Add resource:
   - URL: `/local/camera-grid-card.js`
   - Resource type: JavaScript Module

## Card configuration

Simplest version - just shows every camera entity you have, using MJPEG:

```yaml
type: custom:camera-grid-card
```

With go2rtc for low-latency WebRTC on cameras that support it:

```yaml
type: custom:camera-grid-card
go2rtc_url: http://192.168.1.10:1984    # optional - enables WebRTC where available
stream_id_attribute: serial_no           # optional, default shown
columns_min_width: 600                   # optional, px breakpoint for 2-column layout
max_stream_minutes: 5                    # optional, default shown. 0 disables auto-stop
```

To show a specific subset of cameras instead of auto-discovering all of them:

```yaml
type: custom:camera-grid-card
entities:
  - camera.front_door
  - camera.garage
```

## Using go2rtc for WebRTC

By default, with no `go2rtc_url` set, every camera uses plain MJPEG - no
setup beyond installing the card. To get WebRTC's lower latency for cameras
that support it:

1. Have a reachable go2rtc instance with WebRTC enabled, reachable directly
   from whatever device/browser will load the dashboard (not just from the
   HA host).
2. Each camera entity that should use WebRTC needs an attribute holding the
   name go2rtc has that camera's stream registered under (check go2rtc's
   own web UI, usually `http://<go2rtc-host>:1984`, for the exact stream
   names in your setup). Point `stream_id_attribute` at it - default is
   `serial_no`. Cameras without this attribute automatically use the MJPEG
   fallback instead.

### A note on Home Assistant's bundled go2rtc

HA can manage its own go2rtc instance (`go2rtc: debug_ui: true` in
`configuration.yaml`), which is reachable externally on offset ports
(`11984` API / `18555` WebRTC instead of the usual `1984`/`8555`) once
`debug_ui` and credentials are set - by default it's `localhost`-only
([home-assistant/core#130144](https://github.com/home-assistant/core/issues/130144)).
Two things to know if you go this route instead of a standalone instance:

- It doesn't expose a config option for `candidates`/`ice_servers`, which
  some local networks need for WebRTC to actually negotiate a connection.
- Some integrations that *push* video into go2rtc (rather than go2rtc
  pulling from RTSP) may find HA's bundled build doesn't expose every route
  a standalone go2rtc does - confirmed for at least one such integration via
  direct testing, even with the relevant HA-side allowlist patched.

A standalone go2rtc instance avoids both, at the cost of running one more
container.

## How it works

**WebRTC path**: on Play, calls `camera.turn_on`, then polls go2rtc's
`/api/streams` until a real producer with `bytes_recv > 0` shows up (confirms
video is actually flowing, not just that the backend thinks it started)
before opening a WebRTC connection straight to go2rtc (`/api/ws?src=<stream>`
- the same offer/answer/candidate signaling go2rtc's own bundled
`webrtc.html` demo uses).

**MJPEG path**: on Play, points an `<img>` at the camera entity's own
`camera_proxy_stream` endpoint (browsers natively render multipart MJPEG in
`<img>` tags) - no go2rtc involved at all.

Snapshots use each entity's `entity_picture` attribute either way.

## License

MIT

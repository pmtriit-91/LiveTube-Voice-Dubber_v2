# LiveTube Voice Dubber V3

Realtime Vietnamese translation and voice dubbing for YouTube videos.

V3 is a rebuild around text-only persistence, in-memory scheduling, RAM audio cache, and HTTP chunked MP3 streaming. It does not write generated playback audio to disk and does not use polling to wait for audio files.

## Architecture

### Backend

The backend is a Node.js and TypeScript service using Express and SQLite.

- `src/server.ts`: V3 HTTP API.
- `src/db.ts`: text-only SQLite schema in `livetube_v3.db`.
- `src/utils/yt-dlp.ts`: subtitle download, VTT parsing, sentence reconstruction.
- `src/utils/translator.ts`: batch translation with glossary fallback.
- `src/runtime/tts-stream.ts`: Edge-TTS stdout streaming via `--write-media -`.
- `src/runtime/audio-cache.ts`: in-memory chunk cache with subscriber fan-out.
- `src/runtime/tts-queue.ts`: event-driven in-memory TTS queue with seek cancellation and graceful degradation.
- `src/runtime/rate-estimator.ts`: server-side rate estimation for long Vietnamese segments.

### Chrome Extension

The extension is bundled from `extension/src/content.ts`.

- FSM states: `IDLE`, `INITIALIZING`, `BUFFERING`, `PLAYING`, `SEEK_BUFFERING`.
- Audio playback uses `/api/stream/:sessionId/:segmentIndex` directly as an `<audio>` source.
- UI Display Pagination splits long translated text into pages without using ellipsis clipping.
- Soft fallback restores original YouTube audio if the dub stream errors, stalls, or times out.

## V3 Guarantees

- No SQLite `jobs` table.
- No `audio_status`, `audio_path`, or static audio URL in segment records.
- No generated MP3 playback files in `audio/cache`.
- No `express.static('/audio/cache')`.
- No audio polling loop.
- No per-sentence video pause during normal playback.

## API

### `GET /status`

Returns service health plus queue/cache metrics.

### `POST /api/sessions`

Creates or updates a session, downloads subtitles, translates timeline text, and returns text-only segments.

Required JSON fields:

```json
{
  "sessionId": "client-session-id",
  "url": "https://www.youtube.com/watch?v=...",
  "voice": "vi-VN-NamMinhNeural",
  "rate": "+0%",
  "volume": "+0%"
}
```

### `POST /api/sessions/:id/prepare`

Prepares a sliding window of TTS segments around an anchor index.

```json
{
  "anchorIndex": 1,
  "mode": "INITIAL",
  "lookAhead": 5
}
```

For `SEEK`, the backend cancels pending jobs outside the new smart seek window.

### `GET /api/stream/:sessionId/:segmentIndex`

Streams MP3 bytes with `Transfer-Encoding: chunked`.

The endpoint subscribes the HTTP response to the in-memory audio cache entry. If the entry is pending, it enqueues TTS generation.

## Requirements

- Node.js 18+
- npm
- Python environment with `edge-tts` CLI, or system `edge-tts`
- `yt-dlp` CLI for real YouTube subtitle download

The backend checks these default CLI paths first:

- Edge-TTS: `/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/edge-tts`
- yt-dlp: `/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/yt-dlp`

Both can fall back to binaries available on `PATH`.

## Install

```bash
npm install
cd extension
npm install
```

## Run

Backend:

```bash
npm run dev
```

The backend listens on `http://localhost:8765`.

Extension:

```bash
cd extension
npm run build
```

Then load the `extension` folder in Chrome via `chrome://extensions` with Developer mode enabled.

## Build

Backend:

```bash
npm run build
```

Extension:

```bash
cd extension
npm run build
```

## Integration Smoke Test

Start the backend first:

```bash
npm run dev
```

In another terminal:

```bash
npx ts-node src/test_integration.ts
```

The smoke test calls V3 HTTP endpoints:

- `/status`
- `/api/sessions`
- `/api/sessions/:id/prepare`

It intentionally does not test `/api/stream` by default because that endpoint can invoke real Edge-TTS generation.

## Cleanup

```bash
npm run clean
```

This removes `dist` and local V3 SQLite database files.

Generated subtitles and local DB files are ignored by Git.

## Development Notes

- `RATE_ESTIMATOR_ENABLED=false` disables server-side TTS rate estimation.
- `TTS_MAX_CONCURRENT`, `TTS_MAX_SESSION_CONCURRENT`, `TTS_THROTTLE_FAILURE_THRESHOLD`, `TTS_THROTTLE_FAILURE_WINDOW_MS`, and `TTS_THROTTLE_RECOVERY_MS` tune queue behavior.
- `AUDIO_CACHE_MAX_ENTRIES` and `AUDIO_CACHE_MAX_BYTES` tune in-memory audio cache limits.

## License

Personal and educational use.

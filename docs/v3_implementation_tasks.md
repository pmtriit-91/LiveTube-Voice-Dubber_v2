# V3 Implementation Tasks

Nguồn triển khai chính: `docs/implementation_plan.md`.

Chiến lược được chọn: **vertical slice**. Mỗi phase phải tạo ra một lát hệ thống có thể build/test được, thay vì xây rời từng module quá lâu rồi mới tích hợp.

## 0. Guardrails Bắt Buộc

Các task bên dưới không được vi phạm các điều kiện này:

- Không ghi MP3 xuống disk cho audio playback.
- Không dùng SQLite `jobs` để quản lý hàng đợi TTS.
- Không polling HTTP theo interval.
- Không gọi `video.pause()` mỗi câu thoại.
- Không enqueue toàn bộ video khi tạo session.
- Không dùng `decodeAudioData()` cho partial streaming.
- Không dùng WebSocket làm kênh chính.
- Không dùng `express.static('/audio/cache')` cho audio.

## 1. Kiểm Tra Kiến Trúc Trước Khi Làm

Kết quả rà theo Architecture Challenge Framework:

| Vector | Đánh giá | Task kiểm soát |
|---|---|---|
| Product | Đúng nhu cầu: dubbing realtime cho cold cache và seek | T2, T10, T21 |
| UX | Initial buffer và seek buffer có giới hạn, không giật từng câu | T17, T18, T19 |
| Architecture | Phù hợp stack Node/Express + Chrome extension, bỏ V2 file/polling | T4-T16 |
| Scale | RAM cache + LRU + concurrency limit | T8, T9, T23 |
| Operations | Cần metrics queue/cache/stream/TTS | T24, T28 |
| Financial | Giảm translate API nhờ segment keyed theo `video_id` | T5, T6 |
| Compliance | Edge-TTS unofficial cần graceful degradation | T23, T25 |
| Black swan | TTS stdout/Chrome chunked stream có thể không ổn | T7, T13, T27 |

## 2. Phase 0 - Dọn Nền Và Baseline

Mục tiêu: tạo nền an toàn để rewrite V3, giữ rollback V2 nếu cần.

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T0 | Chạy baseline backend build và ghi nhận lỗi hiện tại nếu có | `package.json`, `tsconfig.json` | - | `npm run build` đã chạy, lỗi nếu có được ghi lại |
| T1 | Chạy baseline extension build và ghi nhận lỗi hiện tại nếu có | `extension/package.json` | - | `npm run build` trong `extension/` đã chạy |
| T2 | Cập nhật metadata V3 alpha | `package.json`, `extension/package.json` | T0, T1 | version là `3.0.0-alpha`, mô tả không còn ghi V2 |
| T3 | Quyết định DB V3 tách biệt | `src/db.ts` | T0 | code dùng `livetube_v3.db`, không load `livetube_v2.db` |

Verification:

```bash
npm run build
(cd extension && npm run build)
```

## 3. Phase 1 - Backend Streaming Core

Mục tiêu: backend V3 có DB text-only, TTS stdout stream, RAM queue/cache, endpoint `/prepare` và `/api/stream`.

### 3.1. DB Text-Only

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T4 | Viết lại schema sessions/segments text-only | `src/db.ts` | T3 | không còn bảng `jobs`; không còn `audio_status`, `cache_key`, `audio_path` |
| T5 | Dùng `video_id` làm key tái sử dụng bản dịch cross-session | `src/db.ts` | T4 | `segments` primary key là `(video_id, segment_index)` |
| T6 | Tạo prepared statements V3 | `src/db.ts` | T4 | có statements cho session, upsert/get segments, không có job statements |

Acceptance:

```bash
sqlite3 livetube_v3.db ".schema"
```

Schema không được chứa `jobs`, `audio_status`, `cache_key`, `audio_path`.

### 3.2. TTS Streaming

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T7 | Tạo service Edge-TTS stdout stream bằng `spawn` | `src/runtime/tts-stream.ts` | T4 | dùng arg array, `--write-media -`, không dùng `exec(commandString)` |
| T8 | Propagate stderr/error/timeout từ child process | `src/runtime/tts-stream.ts` | T7 | stream fail trả lỗi rõ, không treo request |

Acceptance:

- Có thể gọi service nội bộ và nhận MP3 bytes từ stdout.
- Không tạo file trong `audio/cache/`.

### 3.3. Runtime Cache Và Queue

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T9 | Tạo `AudioCache` RAM với entry PENDING/GENERATING/READY/FAILED | `src/runtime/audio-cache.ts` | T7 | cache lưu chunks, buffer READY, subscribers |
| T10 | Thêm LRU eviction không xóa entry đang có subscriber | `src/runtime/audio-cache.ts` | T9 | giới hạn entry/bytes cấu hình được |
| T11 | Tạo event-driven `TTSQueueV3` | `src/runtime/tts-queue.ts` | T9 | queue dùng Array/Map + EventEmitter, không SQLite, không interval scan |
| T12 | Implement priority, dedupe, promote, cancel outside window | `src/runtime/tts-queue.ts` | T11 | seek tới segment xa không chờ job cũ |
| T13 | Thêm queue execution nối TTS stream vào cache subscribers | `src/runtime/tts-queue.ts`, `src/runtime/audio-cache.ts` | T11 | chunk từ TTS được broadcast tới response đang chờ |

Acceptance:

- Enqueue duplicate segment không tạo nhiều job trùng.
- `cancelOutsideWindow(sessionId, anchorIndex, lookAhead)` xóa pending jobs ngoài cửa sổ.
- Queue không import `statements.getPendingJobsByPriority`.

### 3.4. Server API V3

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T14 | Viết lại `POST /api/sessions` trả timeline text-only | `src/server.ts`, `src/db.ts` | T6 | response không có `audioStatus`, `audioUrl`, `cacheKey` |
| T15 | Tạo `POST /api/sessions/:id/prepare` | `src/server.ts`, `src/runtime/tts-queue.ts` | T12 | mode `INITIAL`, `PLAYBACK`, `SEEK`; seek cancel window cũ |
| T16 | Tạo `GET /api/stream/:sessionId/:segmentIndex` chunked MP3 | `src/server.ts`, `src/runtime/audio-cache.ts`, `src/runtime/tts-queue.ts` | T13 | READY stream từ RAM, MISS enqueue urgent, GENERATING attach subscriber |
| T17 | Cập nhật `/status` trả metrics queue/cache | `src/server.ts` | T11 | status ghi service V3, pending/running/cache bytes |
| T18 | Xóa route V2 audio static và polling/request-audio endpoint | `src/server.ts` | T16 | không còn `/audio/cache`, `/request-audio`, `/segments/:index` polling |

Acceptance:

```bash
npm run build
curl http://localhost:8765/status
curl -X POST http://localhost:8765/api/sessions
curl -I http://localhost:8765/api/stream/<sessionId>/1
```

Expected:

- Build TypeScript pass.
- `/status` trả V3 metrics.
- Session response text-only.
- Stream response có `Content-Type: audio/mpeg`.
- Không có MP3 mới trong `audio/cache/`.

## 4. Phase 2 - Extension Client Rewrite

Mục tiêu: extension dùng `/prepare` + `/api/stream`, bỏ polling và smart pause mỗi câu.

### 4.1. Content FSM V3

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T19 | Viết lại type `VideoSegment` text-only | `extension/src/content.ts` | T14 | không còn `audioStatus`, `audioUrl`, `cacheKey` |
| T20 | Tạo FSM `IDLE/INITIALIZING/BUFFERING/PLAYING/SEEK_BUFFERING` | `extension/src/content.ts` | T19 | state rõ, không còn `POLLING_AUDIO` |
| T21 | Implement enable dubbing flow với initial buffer một lần | `extension/src/content.ts` | T15, T20 | pause một lần, `POST /prepare mode=INITIAL`, resume sau ready/timeout |
| T22 | Implement playback theo segment bằng stream URL | `extension/src/content.ts` | T16, T20 | vào segment mới thì phát `/api/stream/:sessionId/:index` |
| T23 | Implement fire-and-forget prepare khi PLAYING | `extension/src/content.ts` | T22 | duy trì sliding window, không spam interval |
| T24 | Implement Smart Seek Buffer tối đa 8 giây | `extension/src/content.ts` | T15, T22 | seek dừng audio, pause tối đa 8s, prepare mode SEEK, luôn resume |
| T25 | Xóa polling và smart pause V2 | `extension/src/content.ts` | T21-T24 | không còn `pollInterval`, `pollTimeout`, `startPolling`, `requestUrgentAudio`, `isWaitingForAudio` |

Acceptance:

- Search code không còn `POLLING_AUDIO`, `startPolling`, `requestUrgentAudio`.
- `video.pause()` chỉ xuất hiện trong initial buffering và seek buffering.

### 4.2. Player V3

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T26 | Đổi player sang nhận stream URL | `extension/src/player.ts` | T22 | không build URL `/audio/cache/*.mp3` |
| T27 | Thêm event handling cho stream `waiting/error/canplay/playing` | `extension/src/player.ts` | T26 | waiting không pause video; error restore volume/fallback |
| T28 | Giữ ducking, restore, dynamic rate, drift adjust phù hợp stream | `extension/src/player.ts` | T27 | volume chỉ duck khi audio thật sự playing |

Acceptance:

```bash
(cd extension && npm run build)
```

Manual E2E sau Phase 2:

- Cold cache: bật dubbing, chỉ pause initial một lần.
- Seek xa: pause tối đa 8s rồi tự resume.
- Network tab: không có polling, có `/api/stream/...`.

## 5. Phase 3 - Polish Và Smart Buffering

Mục tiêu: tối ưu chất lượng nghe, graceful degradation và UI feedback.

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T29 | Tạo `rate-estimator` theo công thức 4.5 syllables/s, 1.5 syllables/word | `src/runtime/rate-estimator.ts` | T16 | rate clamp tối đa `+40%` |
| T30 | Áp dụng estimated rate khi enqueue/generate TTS | `src/runtime/tts-queue.ts`, `src/server.ts` | T29 | câu dài dùng rate tăng trước khi sinh TTS |
| T31 | Thêm graceful degradation khi TTS fail 3 lần/30s | `src/runtime/tts-queue.ts` | T13 | giảm concurrency, tự hồi phục sau thời gian ổn định |
| T32 | Cải thiện UI state feedback | `extension/src/ui.ts`, `extension/src/content.ts` | T21, T24 | hiển thị initializing, buffering progress, seek buffering, fallback |
| T33 | Thêm soft fallback rõ ràng ở client | `extension/src/content.ts`, `extension/src/player.ts` | T27 | audio lỗi/chậm không khóa video, subtitle Việt vẫn hiện |

Acceptance:

- Câu dịch dài được tăng tốc nhưng không vượt `+40%`.
- Simulated TTS failures làm log throttle và giảm concurrency.
- UI thể hiện được trạng thái buffering/fallback.

## 6. Phase 4 - Hardening, Cleanup Và Test

Mục tiêu: xóa tàn dư V2, thêm logging, kiểm thử các kịch bản chính.

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T34 | Xóa legacy V2 queue và TTS file-cache helpers | `src/queue.ts`, `src/utils/tts.ts` | T16, T31 | không còn `generateTTSWithCache`, `generateCacheKey`, `getCacheFilePath` |
| T35 | Xóa hoặc thay test V2 cũ | `src/test_integration.ts` | T16 | không còn test phụ thuộc file MP3 cache |
| T36 | Xóa dependency không dùng như `ws` nếu không còn import | `package.json`, `package-lock.json` | T18 | `npm run build` vẫn pass |
| T37 | Thêm structured logging stream/queue/cache/throttle | `src/server.ts`, `src/runtime/*` | T17, T31 | log có session, segment, cache hit/miss, ttfb, bytes |
| T38 | Cập nhật README sang V3 | `README.md` | T34-T37 | README mô tả `/prepare`, `/api/stream`, V3 DB, cách chạy |
| T39 | Chạy test checklist manual/curl/fs/db | project | T34-T38 | các kịch bản T1-T10 trong plan được ghi kết quả |

Acceptance V3 MVP:

- Cold cache không pause từng câu.
- Seek không chờ queue tuyến tính.
- Network có `/api/stream`, không có polling.
- Disk không sinh MP3 playback.
- DB không có audio metadata/job queue.
- Fallback mềm không làm video giật.
- Logs đủ để hiểu TTS/Queue/Cache đang hoạt động.

## 7. Thứ Tự Thực Hiện Đề Xuất

Không nhảy qua Phase 1 trước khi Phase 0 build xong. Không rewrite extension trước khi backend stream endpoint chạy được bằng curl.

1. T0-T3: baseline và nền V3.
2. T4-T18: backend streaming core.
3. T19-T28: extension E2E rewrite.
4. T29-T33: polish buffering/rate/fallback.
5. T34-T39: cleanup/test/docs.

## 8. Current Next Task

Task tiếp theo khi bắt đầu code:

```txt
T0 - Chạy baseline backend build và ghi nhận lỗi hiện tại nếu có.
```

Lý do: trước khi rewrite lớn, cần biết codebase hiện tại có pass build hay đang có lỗi sẵn để không trộn lỗi baseline với lỗi V3.

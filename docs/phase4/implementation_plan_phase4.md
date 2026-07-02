# Phase 4 - Hardening, Cleanup & Test

Phase 4 là bước đóng gói V3 sau khi Phase 0-3 đã pass E2E. Mục tiêu là xóa tàn dư V2, đảm bảo backend build sạch, cập nhật tài liệu bàn giao và thêm smoke test đúng kiến trúc V3.

## 1. Scope Đã Chốt

- Xóa legacy SQLite job queue và file-cache MP3 của V2.
- Gỡ dependency không còn dùng sau khi xóa legacy.
- Thay integration test V2 bằng HTTP API smoke test cho V3.
- Rewrite README theo kiến trúc V3: text-only DB, in-memory queue, RAM audio cache, HTTP chunked streaming, không polling.
- Verify backend/extension build và rà legacy markers.

## 2. Baseline Trước Phase 4

Backend `npm run build` đang fail vì:

- `src/queue.ts` còn gọi prepared statements V2 đã bị xóa khỏi `src/db.ts`.
- `src/test_integration.ts` vẫn import `queueManager` và kiểm tra `audio_status`, `audio_path`.

Extension build vẫn pass.

## 3. Task Breakdown

| ID | Task | Files | Done when |
|---|---|---|---|
| T34 | Xóa legacy queue/file-cache TTS | `src/queue.ts`, `src/utils/tts.ts` | Không còn `generateTTSWithCache`, `generateCacheKey`, `queueManager` trong source runtime |
| T35 | Thay integration test V2 bằng V3 HTTP smoke test | `src/test_integration.ts` | Test `/status`, `/api/sessions`, `/prepare`; không import DB/queue trực tiếp |
| T36 | Gỡ dependency dư | `package.json`, `package-lock.json` | Xóa `ws`, `@types/ws`, `uuid`, `@types/uuid` nếu không còn import |
| T38 | Rewrite README sang V3 | `README.md` | README mô tả đúng streaming V3, không còn polling/file MP3 cache |
| T39 | Verification checklist | project | Backend build pass, extension build pass, legacy marker scan pass |

## 4. Integration Test Guardrails

`src/test_integration.ts` phải test qua HTTP API, không gọi module nội bộ V2.

Luồng tối thiểu:

1. `GET /status`
2. `POST /api/sessions` với `mock_test_url`
3. Validate response có `segments[]` text-only.
4. `POST /api/sessions/:id/prepare`
5. Validate response có các mảng `ready`, `queued`, `generating`, `failed`, `missing`.

Không bắt buộc test `/api/stream` trong smoke test mặc định vì endpoint này có thể gọi Edge-TTS thật. Nếu cần test stream, nên thêm flag riêng sau.

## 5. Dependency Guardrails

Sau khi xóa `src/queue.ts`, `uuid` và `@types/uuid` cũng không còn dùng. Phase 4 gỡ cả:

- `ws`
- `@types/ws`
- `uuid`
- `@types/uuid`

Không gỡ các dependency đang được import bởi V3:

- `better-sqlite3`
- `cors`
- `dotenv`
- `express`

## 6. Documentation Guardrails

README phải nói rõ:

- DB V3 là text-only, không có bảng `jobs`.
- Không còn `audio_status`, `audio_path`, `cache_key` trong schema.
- Audio không ghi ra disk.
- Playback dùng `/api/stream/:sessionId/:segmentIndex`.
- Extension dùng `/api/sessions` + `/prepare` + stream URL, không polling audio.
- Phase 2.5d UI Display Pagination và Phase 3 fallback/rate/throttle là hành vi hiện tại.

## 7. Verification Plan

Automated:

- `npm run build`
- `cd extension && npm run build`
- `npx tsc --noEmit` qua script build backend
- `rg` kiểm tra legacy markers:
  - `generateTTSWithCache`
  - `generateCacheKey`
  - `getCacheFilePath`
  - `queueManager`
  - `audio_status`
  - `audio_path`
  - `express.static('/audio/cache')`

Manual:

- Chạy backend và extension như các phase trước.
- Xác nhận YouTube playback vẫn có stream/fallback.
- Xác nhận không sinh file `.mp3` mới trong project.

## 8. Definition Of Done

- Backend build sạch.
- Extension build sạch.
- Không còn file source V2 queue/file-cache.
- Dependency lock sạch package dư.
- README đúng V3.
- Integration smoke test không còn phụ thuộc DB V2/audio file cache.

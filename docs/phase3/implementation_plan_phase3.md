# Phase 3 - Polish & Smart Buffering

Nguồn tham chiếu ban đầu: `/Users/phamminhtri/.gemini/antigravity-ide/brain/a51526bb-e82b-4f95-a87a-947c416d0f02/implementation_plan_phase3.md`

Tài liệu này là bản Phase 3 đã được phản biện sau Phase 2.5d. Khi triển khai Phase 3, ưu tiên tài liệu này hơn các snippet Phase 3 cũ trong `docs/implementation_plan.md`.

## 1. Purpose

Phase 3 tối ưu chất lượng nghe và sức chịu đựng của runtime sau khi backend streaming, extension FSM/player và UI Display Pagination đã ổn định.

Trọng tâm:

- Smart rate cho câu dịch Việt dài hơn thời lượng segment gốc.
- Graceful degradation khi Edge-TTS lỗi/throttle.
- Structured logging đủ để debug queue/cache/rate.
- Soft fallback client khi stream lỗi nhưng không dừng video và không phá UI Pagination.

## 2. Business Context

Người dùng cần video tiếp tục chạy mượt dù TTS chậm, lỗi hoặc bị giới hạn từ Edge-TTS. Phase 3 không được quay lại mô hình pause từng câu, polling audio hay file-cache MP3.

Phase 2.5d đã tách audio segment và display page. Vì vậy Phase 3 không xử lý vấn đề text dài bằng cách chia lại audio segment. Audio segment vẫn phục vụ giọng đọc tự nhiên; UI Pagination vẫn chịu trách nhiệm hiển thị phụ đề tối đa 2 dòng.

## 3. Current Behavior Before Phase 3

- `src/server.ts` dùng `session.rate` cố định khi build cache key và enqueue TTS.
- `src/runtime/audio-cache.ts` đã đưa `rate` vào cache key.
- `src/runtime/tts-queue.ts` có `readonly maxConcurrent`, chưa có throttle/recovery state.
- `extension/src/player.ts` đã restore volume khi stream error, nhưng chưa phát fallback signal rõ ràng về `content.ts`.
- `extension/src/content.ts` đã có UI Display Pagination; không được đập lại phần này trong Phase 3 backend.

## 4. Scope Split

### Phase 3A - Backend First

Thực hiện trước:

- T29: `src/runtime/rate-estimator.ts`
- T30: áp dụng estimated rate trong `src/server.ts`
- T31: graceful degradation trong `src/runtime/tts-queue.ts`
- T37 backend logging tối thiểu cho rate/queue/throttle/cache key

Không sửa extension trong Phase 3A, trừ khi có lỗi build trực tiếp.

### Phase 3B - Client Soft Fallback

Thực hiện sau khi Phase 3A được duyệt:

- T32/T33: fallback signal từ `player.ts` sang `content.ts`
- UI feedback fallback rõ ràng nhưng không phá UI Pagination

## 5. Data Model / API Contract

Không đổi DB schema và không đổi public API.

`sessions.rate` vẫn là base rate/user config, không phải per-segment estimated rate.

Per-segment rate phải được tính runtime khi build audio parts:

- Input: session, segment text, segment start/end.
- Output: `AudioCacheKeyParts` có `rate` đã estimate.

Quan trọng: `/api/sessions/:id/prepare` và `/api/stream/:sessionId/:segmentIndex` phải dùng cùng một helper build audio parts. Nếu không, cache key sẽ lệch và server có thể sinh trùng audio.

## 6. Guardrails

- Không sửa `extension/src/ui.ts` và UI Display Pagination trong Phase 3A.
- Không thay đổi endpoint contract.
- Không ghi MP3 ra disk.
- Không quay lại polling.
- Không dùng static audio URL.
- Không mutate `session.rate` trong DB để lưu estimated rate.
- Không bỏ `rate` khỏi audio cache key.
- Không tăng Edge-TTS concurrency vô điều kiện.
- Không để backend rate estimator và client dynamic playback cùng tăng tốc quá mức mà không có giới hạn.

## 7. Key Risks And Decisions

### Cache Key Mismatch

Rủi ro: `/prepare` enqueue với estimated rate nhưng `/stream` subscribe bằng base `session.rate`.

Hậu quả:

- cache miss
- sinh audio trùng
- subscriber chờ entry khác với job đang generate

Quyết định:

- Tạo helper duy nhất, ví dụ `buildAudioPartsForSegment(session, segment)`.
- Helper này phải được dùng ở cả `/prepare` và `/stream`.

### readonly `maxConcurrent`

Rủi ro: plan cũ yêu cầu set `this.maxConcurrent = 1`, nhưng hiện field này là `readonly`.

Quyết định:

- Giữ `baseMaxConcurrent` readonly.
- Thêm `currentMaxConcurrent` mutable.
- `triggerProcessing()` dùng `currentMaxConcurrent`.
- `stats()` trả cả `baseMaxConcurrent`, `currentMaxConcurrent`, `isThrottled`.

### Double Speedup

Rủi ro: Edge-TTS đã sinh audio với `+40%`, client `applyDynamicRate()` lại tăng playbackRate thêm.

Quyết định:

- Phase 3A chỉ làm server-side estimator.
- Khi sang Phase 3B, cần giới hạn client dynamic rate thành micro-adjust hoặc bỏ hard speedup nếu backend rate đã khác `+0%`.
- Không sửa vội `player.ts` trong Phase 3A.

### Estimator Accuracy

Rủi ro: công thức `wordCount * 1.5` có thể overestimate với tiếng Việt, vì token cách khoảng trắng thường đã gần với tiếng/âm tiết.

Quyết định:

- Dùng estimator bảo thủ.
- Clamp tối đa `+40%`.
- Không tăng rate nếu segment duration quá ngắn hoặc text rỗng.
- Log rate decisions để test thực tế rồi chỉnh hệ số sau.

### Timeout Static 15s

Rủi ro: `tts-stream.ts` có default timeout 15s. Câu dài có thể fail dù Edge-TTS vẫn hoạt động.

Quyết định:

- Phase 3A nên truyền `timeoutMs` từ server/queue dựa trên text length hoặc estimated duration.
- Timeout cũng cần clamp để không treo vô hạn.

## 8. Implementation Plan

### T29 - Rate Estimator

File mới: `src/runtime/rate-estimator.ts`

Yêu cầu:

- Pure function, dễ unit/smoke test.
- Input tối thiểu: translated text, segment duration.
- Output: rate string dạng `+0%`, `+15%`, tối đa `+40%`.
- Có helper trả metadata nếu cần structured log: estimated duration, token count, speedup percent.

### T30 - Server Integration

File: `src/server.ts`

Yêu cầu:

- Tạo helper build audio parts có segment context.
- Dùng helper đó ở cả `/prepare` và `/stream`.
- Không dùng `buildAudioParts(session, segmentIndex)` kiểu cũ nếu helper đó không biết segment duration/text.
- Structured log khi rate khác `+0%`.

### T31 - Queue Graceful Degradation

File: `src/runtime/tts-queue.ts`

Yêu cầu:

- Không mutate readonly `maxConcurrent`.
- Theo dõi failure window 30s.
- 3 failures trong window kích hoạt throttle.
- Khi throttle, `currentMaxConcurrent = 1`.
- Recovery chỉ diễn ra sau 120s không có lỗi mới và đã có ít nhất 1 job completed.
- `stats()` expose throttle state.

### T37 - Backend Structured Logging

Files: `src/server.ts`, `src/runtime/tts-queue.ts`, tùy cần `src/runtime/audio-cache.ts`.

Yêu cầu tối thiểu:

- Log rate decision: session, segment, baseRate, estimatedRate, duration, text length.
- Log queue throttle/recovery.
- Log job failure với cache key context vừa đủ, không dump full text dài.
- Log cache hit/miss/generating ở `/prepare` và `/stream` nếu cần debug.

### T32/T33 - Client Soft Fallback

Phase 3B:

- `player.ts` phát callback/event khi `error`, `stalled` hoặc playback promise reject.
- `content.ts` nhận fallback signal, restore tiếng gốc, giữ UI Pagination chạy.
- Không pause video.
- Không reset timeline/subtitle page cache.
- UI dùng badge `fallback` riêng thay vì `offline`, vì `offline` sẽ disable toggle và làm người dùng tưởng dubbing đã bị tắt.

## 9. Verification Plan

Phase 3A:

- Type-check scoped các file backend mới/sửa.
- Smoke test rate estimator với text ngắn, text dài, duration nhỏ, duration invalid.
- Test `/prepare` và `/stream` dùng cùng cache key rate bằng log.
- Simulate TTS failure để thấy throttle bật sau 3 failures trong 30s.
- Simulate recovery để thấy concurrency phục hồi sau 120s ổn định.

Phase 3B:

- Block `/api/stream/*` trong DevTools.
- Video không pause.
- Tiếng gốc được restore.
- UI Pagination vẫn lật page theo timeline.
- Badge/status báo fallback nhưng không disable toàn bộ dubbing.

Implementation note sau Phase 3B:

- Fallback được phát từ `extension/src/player.ts` cho `error`, `stalled`, startup timeout, playback promise reject và resume reject.
- `extension/src/content.ts` chỉ chuyển trạng thái UI sang `fallback`, không clear active segment và không clear subtitle pagination cache.
- `extension/src/ui.ts` giữ toggle enabled/checked ở trạng thái fallback.

## 10. Rollback Notes

Nếu rate estimator gây giọng đọc quá nhanh:

- Tắt estimator bằng feature flag/env hoặc trả `+0%`.
- Giữ queue graceful degradation vì độc lập với rate.

Nếu throttle quá nhạy:

- Tăng failure threshold hoặc window.
- Không tăng concurrency vượt base config.

Nếu client fallback phá UI Pagination:

- Rollback Phase 3B riêng, không rollback Phase 3A.

## 11. Current Next Step

Khi CTO duyệt triển khai, bắt đầu bằng Phase 3A:

1. Tạo `src/runtime/rate-estimator.ts`.
2. Refactor `src/server.ts` để build audio parts theo segment.
3. Thêm throttle state vào `src/runtime/tts-queue.ts`.
4. Chạy type-check/scoped verification.

Không triển khai Phase 3B cho tới khi Phase 3A được duyệt.

# Implementation Plan V3 — Phiên Bản Claude (Antigravity)

> [!NOTE]
> Đây là bản Implementation Plan **độc lập** của Claude, viết song song với bản GPT (`V3_IMPLEMENTATION_PLAN.md`) để bạn đọc so sánh và chọn phương án tối ưu nhất.

---

## Triết Lý Thiết Kế

Bản GPT chia thành 10 Phase (Phase 0-9), tách rất nhỏ từng module. Bản này mình chọn hướng **ít Phase hơn, mỗi Phase tạo ra 1 hệ thống chạy được (runnable)** — tức là sau mỗi Phase bạn có thể test end-to-end ngay, không phải chờ đến Phase cuối mới test được.

| Tiêu chí | Bản GPT (10 Phase) | Bản Claude (5 Phase) |
|---|---|---|
| Số Phase | 10 (Phase 0-9) | 5 (Phase 0-4) |
| Khi nào test E2E được? | Sau Phase 5+ (khi Extension FSM xong) | Sau **Phase 2** (Backend + Extension đều mới) |
| Chiến lược | Bottom-up (xây từng viên gạch riêng biệt) | **Vertical slice** (mỗi Phase cắt 1 lát dọc từ Server→Client) |
| Rủi ro | Chờ 5 Phase mới biết tích hợp có hoạt động không | Phát hiện lỗi tích hợp sớm ngay Phase 2 |
| Mỗi Phase mất bao lâu? | ~1-2 giờ/Phase × 10 = ~10-20 giờ | ~2-4 giờ/Phase × 5 = ~10-20 giờ |

---

## Guardrails (Điều Cấm — Áp Dụng Mọi Phase)

Mình giữ nguyên các guardrails đã thống nhất từ Walkthrough. Bất kỳ lúc nào trong quá trình code mà phát hiện vi phạm, phải dừng lại và báo cáo.

```
❌ KHÔNG ghi file MP3 xuống ổ đĩa cho audio playback.
❌ KHÔNG dùng SQLite bảng `jobs` để quản lý hàng đợi TTS.
❌ KHÔNG polling HTTP theo interval (400ms, 3s, hay bất kỳ interval nào).
❌ KHÔNG gọi video.pause() mỗi câu thoại.
❌ KHÔNG enqueue toàn bộ 200 câu khi tạo session.
❌ KHÔNG dùng decodeAudioData() cho streaming partial.
❌ KHÔNG dùng WebSocket (CSP risk trên YouTube).
❌ KHÔNG dùng express.static('/audio/cache') cho audio.
```

---

## Phase 0: Dọn Nền & Chuẩn Bị (Estimated: 1 giờ)

### Mục tiêu
Chuẩn bị codebase sạch, đóng băng V2, đảm bảo V3 không xung đột.

### Việc cần làm

| # | Task | File |
|---|---|---|
| 0.1 | Tạo DB file mới `livetube_v3.db`, không đụng đến `livetube_v2.db` | `src/db.ts` |
| 0.2 | Xóa thư mục `audio/cache/` khỏi gitignore và runtime | project root |
| 0.3 | Xóa file `src/test_integration.ts` (test V2 cũ) | `src/test_integration.ts` |
| 0.4 | Cập nhật `package.json` version → `3.0.0-alpha` | `package.json` |

### Tiêu chí xong
- `livetube_v3.db` được tạo khi server khởi động.
- Server build thành công (`npm run build`), không lỗi TypeScript.
- Không có thay đổi runtime — V2 vẫn chạy được nếu cần rollback.

---

## Phase 1: Backend Streaming Core (Estimated: 4 giờ)

### Mục tiêu
Xây dựng toàn bộ backend mới: DB text-only, TTS streaming (stdout), In-Memory Queue, HTTP Chunked Endpoint. Sau Phase này, dùng `curl` có thể stream được MP3 từ server.

### 1.1. Database V3 — Text-Only Schema

#### [MODIFY] [db.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/db.ts)

Viết lại hoàn toàn. Schema mới:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  url TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'vi',
  voice TEXT NOT NULL,
  rate TEXT NOT NULL DEFAULT '+0%',
  volume TEXT NOT NULL DEFAULT '+0%',
  status TEXT NOT NULL,          -- INIT | FETCHING | TRANSLATING | READY | FAILED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bảng segments: CHỈ lưu text, KHÔNG lưu audio metadata
CREATE TABLE segments (
  video_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT,
  source_hash TEXT,              -- SHA256 để detect text thay đổi
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, segment_index)
);
```

**Điểm khác V2:** Không có cột `audio_status`, `cache_key`, `audio_path`. Không có bảng `jobs`.
**Điểm khác GPT:** Mình dùng `video_id` làm Primary Key cho segments (thay vì `session_id`) → cho phép nhiều session cùng 1 video tái sử dụng bản dịch mà không cần dịch lại.

---

### 1.2. TTS Streaming Service

#### [NEW] [src/runtime/tts-stream.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/runtime/tts-stream.ts)

```typescript
// Thay exec() + --write-media <file> bằng spawn() + --write-media - (stdout)
import { spawn } from 'child_process';

interface TTSStreamOptions {
  text: string;
  voice: string;
  rate: string;     // e.g. "+20%"
  volume: string;
  timeoutMs?: number; // mặc định 15000ms
}

function createTTSStream(opts: TTSStreamOptions): NodeJS.ReadableStream {
  const args = [
    '--voice', opts.voice,
    '--rate', opts.rate,
    '--volume', opts.volume,
    '--text', opts.text,       // Truyền qua arg, KHÔNG dùng shell interpolation
    '--write-media', '-'       // Xuất MP3 ra stdout
  ];
  const child = spawn(CLI_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Trả về child.stdout — đây là ReadableStream chứa MP3 bytes
  return child.stdout;
}
```

**Điểm khác V2:** Không ghi file. Không dùng `exec` (shell injection risk). Dùng `spawn` + arg array.

---

### 1.3. In-Memory Audio Cache + Event-Driven Queue

#### [NEW] [src/runtime/audio-cache.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/runtime/audio-cache.ts)

```typescript
// Cache entry lưu trong RAM
interface CacheEntry {
  status: 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';
  buffer: Buffer | null;           // Toàn bộ MP3 bytes khi READY
  chunks: Buffer[];                // Chunks đang nhận từ TTS stream
  subscribers: Set<http.ServerResponse>; // Các HTTP response đang chờ stream
  createdAt: number;
  lastAccessAt: number;
}

// Key = `${videoId}:${segmentIndex}:${voice}:${rate}`
const cache = new Map<string, CacheEntry>();

// LRU Eviction: giữ tối đa 60 entry, evict entry cũ nhất (không có subscriber)
```

#### [NEW] [src/runtime/tts-queue.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/runtime/tts-queue.ts)

```typescript
import { EventEmitter } from 'events';

// Queue hoàn toàn trên RAM, event-driven
class TTSQueueV3 extends EventEmitter {
  private jobs: QueueJob[] = [];          // Array trên RAM, không DB
  private activeWorkers = 0;
  private MAX_CONCURRENT = 3;

  enqueue(job: QueueJob) {
    this.jobs.push(job);
    this.jobs.sort((a, b) => a.priority - b.priority); // Priority sort
    this.emit('job:added');                              // Event-driven trigger
  }

  cancelOutsideWindow(sessionId: string, anchorIndex: number, windowSize: number) {
    // Xóa pending jobs ngoài cửa sổ [anchor - 1, anchor + windowSize]
    this.jobs = this.jobs.filter(j =>
      j.sessionId !== sessionId ||
      (j.segmentIndex >= anchorIndex - 1 && j.segmentIndex <= anchorIndex + windowSize)
    );
  }
}
```

**Điểm khác V2:** Không query SQLite. Không `setInterval(3000)`. Event-driven thuần túy.
**Điểm khác GPT:** Mình gộp Queue + Cache vào cùng Phase thay vì tách riêng, vì chúng phụ thuộc nhau chặt chẽ — không thể test Queue mà không có Cache.

---

### 1.4. Server API V3

#### [MODIFY] [server.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/server.ts)

Viết lại hoàn toàn. Chỉ giữ 4 endpoint:

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/status` | Health check + runtime metrics (queue, cache) |
| `POST` | `/api/sessions` | Tạo session, tải sub, dịch, trả timeline text-only |
| `POST` | `/api/sessions/:id/prepare` | Yêu cầu server chuẩn bị audio theo cửa sổ trượt |
| `GET` | `/api/stream/:sessionId/:segmentIndex` | **HTTP Chunked Stream** trả MP3 realtime |

**Flow của `GET /api/stream`:**

```
Client gọi: GET /api/stream/abc123/42
  ↓
Server check cache:
  ├── READY → Pipe buffer từ RAM ra response (cache hit, nhanh nhất)
  ├── GENERATING → Attach response vào subscribers[], chờ chunks
  └── PENDING → Enqueue urgent job → Attach response → Sinh + stream cùng lúc
  ↓
Response headers: Content-Type: audio/mpeg, Transfer-Encoding: chunked
  ↓
Chrome <audio> nhận từng chunk → bắt đầu phát khi đủ header MP3
```

**Flow của `POST /api/sessions/:id/prepare`:**

```
Client gọi: POST /prepare { anchorIndex: 42, mode: "SEEK", lookAhead: 5 }
  ↓
Server:
  1. Cancel pending jobs ngoài cửa sổ mới
  2. Enqueue jobs cho [42, 43, 44, 45, 46, 47] nếu chưa có
  3. Nếu mode=SEEK hoặc INITIAL: Long-poll chờ tối đa 8s cho anchorIndex READY
  4. Trả về: { ready: [42, 43], pending: [44, 45, 46, 47], timedOut: false }
```

**Điểm khác GPT:** Mình đặt tên endpoint là `/prepare` thay vì `/buffer-window` (ngắn gọn hơn, rõ ý hơn). Cùng semantic, khác naming.

### Tiêu chí xong Phase 1
- `curl http://localhost:8765/api/stream/test-session/1` trả về binary MP3 stream.
- `curl -X POST http://localhost:8765/api/sessions` trả về timeline text-only, KHÔNG có `audioStatus`, `audioUrl`, `cacheKey`.
- Thư mục `audio/cache/` KHÔNG có file mới.
- `npm run build` thành công, 0 lỗi TypeScript.

---

## Phase 2: Extension Client Rewrite (Estimated: 4 giờ)

### Mục tiêu
Viết lại Extension để dùng stream endpoint thay vì file polling. Sau Phase này, bật dubbing trên YouTube phải hoạt động end-to-end.

### 2.1. FSM V3 (Finite State Machine)

#### [MODIFY] [content.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/content.ts)

Viết lại hoàn toàn. FSM mới chỉ có 5 trạng thái (V2 cũ có 5 nhưng logic rối):

```typescript
type PlaybackStateV3 =
  | 'IDLE'              // Chưa bật dubbing
  | 'INITIALIZING'      // Đang tạo session + dịch
  | 'BUFFERING'         // Pause 1 lần duy nhất, chờ 3-5 câu đầu READY
  | 'PLAYING'           // Đang phát lồng tiếng bình thường
  | 'SEEK_BUFFERING';   // Pause tối đa 8s sau khi tua
```

**Logic cốt lõi:**

```
User bật dubbing:
  IDLE → INITIALIZING
    └→ POST /api/sessions → nhận timeline
    └→ POST /prepare { mode: 'INITIAL', lookAhead: 5 }
    └→ video.pause() (LẦN DUY NHẤT)
    └→ BUFFERING: Chờ tối đa 10s cho 3 câu đầu
    └→ video.play() → PLAYING

timeupdate → Vào câu mới:
  PLAYING:
    └→ Set <audio>.src = /api/stream/:sessionId/:segmentIndex
    └→ <audio>.play()
    └→ Nếu audio error/timeout → Soft Fallback (restore volume, hiển thị sub)
    └→ Fire-and-forget: POST /prepare { mode: 'PLAYBACK' }

User tua (seeked):
  PLAYING → SEEK_BUFFERING
    └→ player.stopAll()
    └→ video.pause()
    └→ POST /prepare { mode: 'SEEK', anchorIndex: newSegment }
    └→ Chờ tối đa 8s
    └→ video.play() → PLAYING (dù audio chưa sẵn sàng)
```

**Những gì BỊ XÓA so với V2:**

| Bỏ | Lý do |
|---|---|
| `pollInterval`, `pollTimeout` | Không polling nữa |
| `startPolling()`, `requestUrgentAudio()` | Thay bằng `/prepare` endpoint |
| `isWaitingForAudio` flag | Không cần — chỉ có 2 điểm pause (BUFFERING, SEEK_BUFFERING) |
| `audioStatus` trong `VideoSegment` | Audio state không lưu ở client |
| `audioUrl`, `cacheKey` trong `VideoSegment` | Thay bằng stream URL template |
| `video.pause()` trong `executeSegmentPlay()` | TUYỆT ĐỐI không pause mỗi câu |

---

### 2.2. Player V3

#### [MODIFY] [player.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/player.ts)

Giữ nguyên cấu trúc `DoubleBufferedAudioPlayer` (thiết kế tốt), nhưng sửa:

```typescript
// V2: src trỏ vào file tĩnh
active.src = `http://localhost:8765/audio/cache/abc123.mp3`;

// V3: src trỏ vào streaming endpoint
active.src = `http://localhost:8765/api/stream/${sessionId}/${segmentIndex}`;
```

Thêm xử lý event cho streaming:

```typescript
audio.addEventListener('waiting', () => {
  // Stream chậm → KHÔNG pause video, chỉ log
  console.log('[Player] Audio stream đang buffer...');
});

audio.addEventListener('error', () => {
  // TTS fail → Soft Fallback, restore video volume
  this.restoreVideoVolume();
});

audio.addEventListener('canplay', () => {
  // Stream đủ data → phát ngay
  audio.play();
});
```

**Giữ nguyên từ V2:** `duckVideoVolume()`, `restoreVideoVolume()`, `applyDynamicRate()`, `checkDriftAndMicroAdjust()`. Những hàm này đã hoạt động đúng.

### Tiêu chí xong Phase 2
- Mở YouTube video **mới chưa có cache** → Bật dubbing → Video pause 1 lần (tối đa 10s) → Sau đó phát tiếng Việt mượt mà không giật.
- Tua đến phút 5 → Video pause tối đa 8s → Tự resume, tiếng Việt bắt nhịp.
- Network tab: KHÔNG có request polling 400ms. CÓ request `/api/stream/...` dạng audio.
- Console: KHÔNG có log `video.pause()` ngoài 2 điểm BUFFERING/SEEK_BUFFERING.

---

## Phase 3: Polish & Smart Buffering (Estimated: 3 giờ)

> Superseded note: Phase 3 đã được phản biện lại sau Phase 2.5d. Không triển khai trực tiếp theo snippet cũ trong mục này, đặc biệt phần mutate `MAX_CONCURRENT` và rate estimator chưa xét cache key. Bản chốt hiện tại nằm ở `docs/phase3/implementation_plan_phase3.md`.

### Mục tiêu
Tinh chỉnh trải nghiệm sau khi hệ thống đã chạy E2E. Tối ưu sliding window, dynamic rate, và edge case.

### 3.1. Dynamic Rate Estimation trên Server

#### [NEW] [src/runtime/rate-estimator.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/runtime/rate-estimator.ts)

```typescript
/**
 * Ước lượng TTS rate dựa trên độ dài text tiếng Việt vs duration segment gốc.
 *
 * Tiếng Việt: ~4.5 âm tiết/giây ở tốc độ bình thường
 * Mỗi từ tiếng Việt ≈ 1-2 âm tiết (trung bình 1.5)
 */
function estimateRate(translatedText: string, segmentDuration: number): string {
  const wordCount = translatedText.split(/\s+/).length;
  const estimatedSyllables = wordCount * 1.5;
  const estimatedDuration = estimatedSyllables / 4.5; // giây

  if (estimatedDuration <= segmentDuration) return '+0%';

  const speedupRatio = estimatedDuration / segmentDuration;
  const ratePercent = Math.min(Math.round((speedupRatio - 1) * 100), 40); // Clamp ≤ 40%
  return `+${ratePercent}%`;
}
```

**Điểm khác GPT:** Mình đưa ra công thức cụ thể (4.5 syllables/s, 1.5 syllable/word) thay vì chỉ nói "ước lượng". Agent thực thi có thể code trực tiếp từ đây.

### 3.2. Graceful Degradation

Thêm vào `tts-queue.ts`:

```typescript
// Khi phát hiện TTS lỗi liên tiếp 3 lần trong 30s → giảm concurrency
private consecutiveFailures = 0;
private lastFailureTime = 0;

private onJobFailed() {
  const now = Date.now();
  if (now - this.lastFailureTime < 30_000) {
    this.consecutiveFailures++;
  } else {
    this.consecutiveFailures = 1;
  }
  this.lastFailureTime = now;

  if (this.consecutiveFailures >= 3) {
    this.MAX_CONCURRENT = Math.max(1, this.MAX_CONCURRENT - 1);
    console.warn(`[Queue] Throttle detected! Reducing concurrency to ${this.MAX_CONCURRENT}`);
  }
}

// Tự hồi phục sau 2 phút ổn định
private onJobSuccess() {
  this.consecutiveFailures = 0;
  if (this.MAX_CONCURRENT < 3) {
    setTimeout(() => {
      this.MAX_CONCURRENT = Math.min(3, this.MAX_CONCURRENT + 1);
    }, 120_000);
  }
}
```

### 3.3. UI Feedback Cải Thiện

#### [MODIFY] [ui.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/ui.ts)

Thêm trạng thái UI cho từng phase:

| State | Hiển thị trên UI |
|---|---|
| INITIALIZING | `⏳ Đang dịch phụ đề...` |
| BUFFERING | `⏳ Đang chuẩn bị giọng đọc (X/5)...` + progress |
| PLAYING | `🔊 Active` + subtitle + visualizer |
| SEEK_BUFFERING | `⏳ Đang tải giọng đọc...` (overlay nhẹ trên video) |
| Soft Fallback | `⚠️ Tiếng gốc` (subtitle Việt vẫn hiển thị) |

### Tiêu chí xong Phase 3
- Câu tiếng Việt dài 6s trong segment 3s → nghe nhanh hơn nhưng vẫn tự nhiên (rate ≤ +40%).
- TTS bị throttle 3 lần liên tiếp → log `Throttle detected`, giảm concurrency.
- UI hiển thị tiến độ buffering (2/5, 3/5...) khi khởi động.

---

## Phase 4: Hardening, Cleanup & Test (Estimated: 2 giờ)

### Mục tiêu
Xóa tàn dư V2, thêm logging, dọn memory leak, viết test plan.

### 4.1. Xóa Legacy V2

| File/Thư mục | Hành động |
|---|---|
| `audio/cache/` | Xóa toàn bộ thư mục |
| `livetube_v2.db` | Giữ lại làm backup, không load |
| `src/queue.ts` (V2) | Xóa hoàn toàn (đã thay bằng `runtime/tts-queue.ts`) |
| Bảng `jobs` trong DB | Không tồn tại trong schema V3 |
| `generateCacheKey()`, `getCacheFilePath()` trong `tts.ts` | Xóa |
| `express.static('/audio/cache')` trong `server.ts` | Xóa |
| Endpoints V2: `/request-audio`, polling `/segments/:index` | Xóa |

### 4.2. Logging & Metrics

Thêm structured logging vào server:

```
[Stream] sessionId=abc seg=42 cache=HIT latency=12ms bytes=45200
[Stream] sessionId=abc seg=43 cache=MISS ttfb=340ms total=4200ms bytes=67800
[Queue] pending=3 running=2 cancelled=0 session=abc
[Throttle] Edge-TTS failures=3/30s → concurrency reduced to 2
```

### 4.3. Test Plan

| # | Kịch bản | Kỳ vọng | Loại |
|---|---|---|---|
| T1 | Video mới cold cache, xem tuần tự | Initial buffer 1 lần, sau đó mượt | Manual E2E |
| T2 | Video mới, tua đến phút 5 | Seek buffer ≤ 8s, tiếng Việt bắt nhịp | Manual E2E |
| T3 | Video đã có cache text (dịch rồi) | Không cần gọi translate API lại | Manual E2E |
| T4 | Tắt/bật dubbing nhiều lần | Không memory leak, không dangling stream | Manual E2E |
| T5 | 2 tab cùng lúc | Fair scheduling, không tab nào bị starve | Manual E2E |
| T6 | TTS bị throttle | Graceful degradation, fallback mềm | Simulated |
| T7 | `curl /api/stream/.../999` (segment không tồn tại) | 404 JSON error, không crash | curl test |
| T8 | Network tab kiểm tra | 0 request polling, có `/api/stream` | Dev Tools |
| T9 | Filesystem kiểm tra | 0 file MP3 mới trong `audio/cache/` | `ls` |
| T10 | DB kiểm tra | 0 cột `audio_status`, `cache_key`, `audio_path` | `.schema` |

### Tiêu chí xong Phase 4 (= Definition of Done V3 MVP)
- ✅ Cold cache không pause từng câu.
- ✅ Seek không chờ queue tuyến tính.
- ✅ Network: 0 polling, có streaming.
- ✅ Disk: 0 file MP3.
- ✅ DB: 0 audio metadata.
- ✅ `<audio>` phát từ `/api/stream/`.
- ✅ Fallback mềm không giật video.
- ✅ Log cho biết TTS/Queue/Cache đang hoạt động thế nào.

---

## So Sánh Trực Tiếp: Bản GPT vs Bản Claude

| Khía cạnh | GPT | Claude |
|---|---|---|
| **Tổng Phase** | 10 (Phase 0-9) | 5 (Phase 0-4) |
| **Test E2E đầu tiên** | Sau Phase 5 | Sau **Phase 2** |
| **DB Key cho segments** | `session_id` | `video_id` (tái sử dụng bản dịch cross-session) |
| **Endpoint naming** | `/buffer-window` | `/prepare` |
| **Dynamic Rate** | Mô tả nguyên lý | Đưa ra **công thức cụ thể** (4.5 syll/s) |
| **Graceful Degradation** | Mô tả nguyên lý | Đưa ra **code pseudocode** (3 fails/30s → giảm concurrency) |
| **Player architecture** | Giữ double buffer, bỏ ngỏ chi tiết | Giữ double buffer + **thêm event handlers** cụ thể (`waiting`, `error`, `canplay`) |
| **File structure** | 7 module backend mới | 4 module backend mới (gọn hơn) |
| **Mỗi Phase tự chạy được?** | Không (phải đợi tích hợp) | **Có** (vertical slice) |
| **Test Plan** | 6 manual + network/fs verify | **10 test cases** cụ thể với bảng kỳ vọng |

> [!TIP]
> **Khuyến nghị của mình:** Hai bản đều cùng mục tiêu và cùng guardrails. Sự khác biệt chính là **chiến lược triển khai**: GPT đi bottom-up (xây từng viên gạch), Claude đi vertical-slice (cắt lát dọc). Bạn chọn chiến lược phù hợp với phong cách làm việc của mình.

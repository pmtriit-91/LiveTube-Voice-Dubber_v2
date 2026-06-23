# Báo cáo đánh giá kiến trúc LiveTube Voice Dubber V2

## Kết luận điều hành

V2 có kiến trúc phù hợp rõ ràng với mục tiêu sản phẩm: ưu tiên video học tập, hình ảnh không giật, hỗ trợ nhiều tab và phục hồi được khi dịch/TTS gặp lỗi.

Hệ thống hiện là một nền tảng local-first tốt, nhưng chưa nên coi là đã sẵn sàng cho tải lớn hoặc triển khai nhiều người dùng. Điểm cần nâng cấp nhất không phải thay SQLite hay viết lại playback engine, mà là:

1. Chuyển từ xử lý toàn bộ video sang pipeline tăng dần theo cửa sổ phát.
2. Sửa mô hình queue để có fairness thực sự và bảo đảm idempotency.
3. Đồng bộ trạng thái SQLite với vòng đời file cache.
4. Kiểm soát các tác vụ bất đồng bộ phía extension khi seek, đổi video hoặc tắt tính năng.
5. Trừu tượng hóa Translation/TTS provider và bổ sung observability.

V3 nên là một bước “harden và progressive hóa” V2, không phải rewrite.

---

## 1. Các điểm mạnh của V2

### 1.1 Kiến trúc playback-stateless là quyết định đúng

Backend không giữ `currentTime`, active audio hoặc trạng thái play/pause. Extension sở hữu toàn bộ quyết định playback tại [content.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/content.ts:19), còn backend chỉ cung cấp subtitle, translation và audio assets.

Lợi ích:

- Hai tab không thể vô tình điều khiển playback của nhau.
- Seek và pause có độ trễ thấp vì không cần round-trip tới server.
- Backend restart không làm mất timeline playback hiện tại.
- Loại bỏ một lớp race condition lớn từng tồn tại ở V1.

Cần gọi chính xác đây là “playback-stateless”, không phải hoàn toàn stateless: queue counters vẫn ở RAM, còn sessions/jobs/cache nằm trên SQLite và local filesystem.

### 1.2 SQLite là lựa chọn hợp lý cho mô hình local-first

Các quyết định trong [db.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/db.ts:16) đều đúng cho phạm vi hiện tại:

- WAL cho phép đọc trong khi ghi.
- `busy_timeout` giúp chống lỗi khóa tức thời.
- Foreign keys và cascade giúp giữ tính toàn vẹn dữ liệu.
- Transaction khi insert hàng loạt segments.
- Prepared statements giảm overhead và tránh SQL injection ở tầng database.
- Job persistence và orphan recovery giúp phục hồi sau restart.

Không có lý do kỹ thuật đủ mạnh để chuyển sang PostgreSQL hoặc Redis nếu sản phẩm vẫn chạy local, một process, một người dùng.

### 1.3 Sentence Reconstructor phục vụ đúng Persona #1

Việc gom raw captions thành câu có ý nghĩa cải thiện đồng thời:

- Ngữ cảnh dịch.
- Nhịp đọc TTS.
- Số lượng request dịch/TTS.
- Khả năng nghe liên tục khi học.

Các cơ chế lọc non-speech và giới hạn câu quá dài trong [yt-dlp.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/yt-dlp.ts:193) cũng trực tiếp ngăn lỗi Edge-TTS đã được ghi nhận trong post-mortem.

Có một sai lệch tài liệu cần thống nhất: tài liệu ghi giới hạn 150 ký tự/12 giây, code hiện dùng 220 ký tự/14 giây.

### 1.4 Double buffering và encapsulation được thiết kế tốt

[Player](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/player.ts:1) sở hữu toàn bộ hai audio elements, swap, preload, pause/resume và cleanup. Đây là cải tiến quan trọng so với V1:

- Chỉ giữ hai `Audio` objects, tránh tăng RAM theo số segment.
- Preload giảm khoảng trống giữa câu.
- `removeAttribute('src')` và `load()` giải phóng buffer cũ.
- Chỉ đồng bộ sau sự kiện `playing`, tránh nuốt chữ đầu câu.
- Volume ducking có fade, phù hợp “voice-over mode” cho video học tập.

Không nên chuyển ngay sang Web Audio API. Double-buffered HTMLAudioElement hiện đơn giản và đủ tốt; chỉ nên thay khi metrics chứng minh transition latency vẫn không đạt yêu cầu.

### 1.5 Chiến lược giữ video mượt là đúng

Việc không pause video chỉ vì audio dài hơn segment là quyết định phù hợp với [PROJECT_GUARDRAILS.md](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/docs/constitution/PROJECT_GUARDRAILS.md).

Các cơ chế tốt gồm:

- Pipeline chờ sự kiện `ended`.
- Tính tốc độ dựa trên thời lượng segment còn lại.
- Neo drift tại thời điểm phát thực tế.
- Chỉ force-seek khi lệch nghiêm trọng.
- Smart Pause chỉ còn dùng khi audio chưa tồn tại.

Đây là trade-off đúng cho học tập: đôi lúc giọng có thể đọc gối nhẹ, nhưng hình ảnh không bị giật liên tục.

### 1.6 Cache đang tạo ra giá trị thực

Snapshot database hiện có 222 segment READY nhưng chỉ 111 audio paths khác nhau cho hai session, cho thấy hai tab/session cùng video đang tái sử dụng audio cache hiệu quả.

---

## 2. Điểm nghẽn và rủi ro kỹ thuật

### Mức nghiêm trọng cao

#### 2.1 Khởi tạo session vẫn là pipeline nguyên khối

`POST /api/sessions` hiện chờ:

1. yt-dlp tải phụ đề.
2. Parse toàn bộ.
3. Dịch toàn bộ video.
4. Ghi toàn bộ segment.
5. Tạo tất cả jobs.

Sau đó mới trả timeline tại [server.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/server.ts:130). Extension đồng thời pause video trong toàn bộ thời gian này.

Điều này không lặp lại chính xác lỗi “HTTP chờ TTS” của V1, nhưng vẫn tạo cùng dạng UX: video dài hoặc Google Translate chậm sẽ khiến người dùng chờ lâu trước khi nghe được.

#### 2.2 Fair Queue chưa thực sự round-robin

[queue.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/queue.ts:87) lấy tất cả job theo `created_at`, sau đó chọn job đầu tiên thuộc session chưa có worker.

Đây là per-session concurrency limiting, không phải round-robin có con trỏ luân phiên.

Với hơn ba session:

- Ba session cũ có thể liên tục lấy lại worker khi hoàn thành.
- Session thứ tư có nguy cơ chờ lâu dù có job ON_DEMAND.
- Toàn bộ bảng PENDING bị đọc và filter lại mỗi lần chọn job.

#### 2.3 `addJob()` có thể tạo duplicate generation

`addJob()` xóa job hiện tại rồi tạo UUID mới tại [queue.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/queue.ts:34).

Nếu job cũ đang RUNNING:

- Row của job đang chạy bị xóa.
- Worker vẫn tiếp tục sinh file.
- Job mới được tạo ở trạng thái PENDING.
- Sau khi worker cũ kết thúc, job mới có thể sinh lại cùng audio.

Hai session cùng video còn có thể cùng ghi một cache key. TTS hiện ghi trực tiếp vào file đích, chưa dùng temporary file + atomic rename. Đây là race condition có khả năng làm hỏng file hoặc sinh thừa.

#### 2.4 Cache eviction làm SQLite và filesystem mất đồng bộ

Eviction xóa MP3 nhưng không cập nhật các segment đang có `audio_status='READY'` tại [server.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/server.ts:43).

Hậu quả:

- API tiếp tục trả URL READY.
- File thực tế có thể đã bị xóa.
- `/request-audio` không kiểm tra lại file khi segment READY.
- Client nhận 404 nhưng không tạo lại audio.

Ngoài ra, LRU dựa vào filesystem `atime`, vốn không đáng tin cậy trên mọi cấu hình OS. Workspace hiện có 174 MP3 trong khi DB active chỉ tham chiếu 111 paths, cho thấy chưa có asset catalog quản lý orphan files.

#### 2.5 Race condition vòng đời extension

Các tác vụ fetch, polling và timer chưa gắn với một navigation/config generation cụ thể.

Các tình huống nguy hiểm:

- Tắt dubbing khi `/api/sessions` còn chạy: response cũ vẫn có thể cập nhật UI và phát video.
- Đổi voice liên tục: nhiều request dùng cùng session ID có thể hoàn thành sai thứ tự.
- Seek/navigation trong khi polling fetch đang in-flight: response cũ có thể phát segment trên timeline mới.
- Chỉ xử lý `yt-navigate-finish`, chưa cleanup ngay tại `yt-navigate-start`.
- `isWaitingForAudio` không được reset rõ ràng khi disable/seek.

Đây là nhóm rủi ro lớn nhất phía client vì thường chỉ xuất hiện khi thao tác nhanh, khó tái hiện bằng happy-path test.

#### 2.6 Session reaper có thể xóa session đang xem

Session bị xóa sau 30 phút dựa trên `sessions.updated_at`, nhưng timestamp này không được cập nhật khi client polling hoặc đang phát tại [server.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/server.ts:104).

Persona mục tiêu xem video 15–40 phút. Một session hoàn toàn hợp lệ có thể bị cascade-delete ở phút 30.

### Mức nghiêm trọng trung bình

#### 2.7 Preload toàn bộ video gây lãng phí

Sau init, backend tạo job cho toàn bộ video tại [server.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/server.ts:222).

Hệ quả:

- Người dùng xem 5 phút nhưng hệ thống có thể sinh audio cho 40 phút.
- Queue phình lớn với video dài.
- Tăng nguy cơ Edge-TTS giới hạn IP.
- Job LOOK_AHEAD không còn phản ánh nhu cầu thật.

#### 2.8 Provider failure có thể giữ worker quá lâu

TTS có retry ba lần bên trong, sau đó queue retry job thêm ba vòng. Một segment có thể gọi Edge-TTS tới chín lần.

`exec()` không có timeout hoặc kill policy tại [tts.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/tts.ts:47). Nếu CLI treo, một worker có thể bị chiếm vô thời hạn.

Translation request cũng chưa hủy socket rõ ràng khi timeout.

#### 2.9 Glossary được áp dụng sai tầng

IT glossary hiện chạy sau khi Google đã dịch sang tiếng Việt tại [translator.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/translator.ts:82). Phần lớn term tiếng Anh như `thread pool` hoặc `gradient descent` lúc đó có thể không còn tồn tại để match.

Ngoài ra, newline không phải protocol ổn định để giữ mapping 25 segment. Khi số dòng thay đổi, hệ thống phải dịch tuần tự lại toàn batch, làm startup latency tăng mạnh.

#### 2.10 Pipeline chỉ giữ một pending segment

`pendingSegment` là một giá trị duy nhất. Nếu audio cũ kéo dài qua nhiều segment, segment chờ trước có thể bị segment mới hơn ghi đè. Nội dung trung gian sẽ bị bỏ qua.

Đặc biệt, nếu segment mới chưa READY trong khi audio cũ đang phát, code đi thẳng vào Smart Pause thay vì pipeline chờ audio cũ kết thúc. Khi polling hoàn tất, `player.play()` có thể cắt audio cũ.

#### 2.11 Playback rate có thể mất dynamic rate

Khi người dùng đổi tốc độ YouTube, `syncPlaybackRate()` gán audio rate bằng đúng video rate, làm mất tốc độ co giãn đã tính để audio Việt vừa segment. Một drift check 5% sau đó không đủ khôi phục rate cần thiết.

#### 2.12 Tích hợp CLI chưa portable và chưa an toàn

Đường dẫn tuyệt đối tới virtualenv V1 làm hệ thống phụ thuộc máy phát triển.

Cả yt-dlp và Edge-TTS được gọi bằng chuỗi shell. URL, session ID và một số text đầu vào chưa được bảo vệ đủ mạnh. Với CORS `*`, nếu backend bị mở ra ngoài localhost thì rủi ro tăng đáng kể.

Nên dùng `spawn`/`execFile` với argument array, validate UUID, YouTube URL và voice allowlist.

---

## 3. Kiến trúc đề xuất cho V3

### 3.1 Tách dữ liệu dùng chung khỏi session

Mô hình nên có bốn thực thể:

- `VideoArtifact`: video ID, caption fingerprint, source segments.
- `TranslationArtifact`: source artifact + language + glossary/provider/version.
- `AudioAsset`: text hash + voice + provider/model + prosody + codec.
- `ClientSession`: trạng thái tạm thời, tham chiếu các artifact trên.

Lợi ích:

- Nhiều tab vẫn có session playback độc lập.
- Subtitle và translation không bị làm lại.
- Audio được deduplicate giữa cả những video có cùng câu.
- Xóa session không cascade-delete asset đang dùng chung.
- Cache lifecycle không còn phụ thuộc segment row.

### 3.2 Progressive initialization

Thay vì dịch toàn video:

1. Ingest subtitle và tạo timeline.
2. Dịch block đầu hoặc cửa sổ quanh `currentTime`.
3. Sinh 2–3 audio đầu.
4. Trả dữ liệu đủ để phát.
5. Xử lý các block sau ở background.

Video dài có thể chia block 5–10 phút. Khi seek, client gửi demand cho block mới.

Backend vẫn không cần giữ playback state. Demand chỉ là hint có TTL, không phải trạng thái dùng để kill worker.

### 3.3 Sliding-window preload

Chỉ đảm bảo:

- Segment hiện tại.
- Khoảng 3–5 segment kế tiếp.
- Có thể thêm một segment phía sau để xử lý seek ngược nhẹ.

Khi playback tiến lên, extension gọi `ensure-window`. Điều này giảm mạnh queue depth, disk usage và tải provider.

### 3.4 Scheduler dựa trên deadline và fairness thực sự

Đề xuất:

- Hai lane: ON_DEMAND và PRELOAD.
- Weighted/Deficit Round Robin giữa các session.
- Per-session token bucket để chống seek spam.
- Global provider rate limiter.
- Aging để PRELOAD không bị starvation vô hạn.
- Unique constraint theo audio asset/job identity.
- Priority promotion bằng UPDATE, tuyệt đối không xóa job RUNNING.
- Job lease, heartbeat và execution timeout.
- Atomic claim job trong transaction.

Với local single-process, SQLite vẫn xử lý tốt mô hình này.

### 3.5 Cache Asset Registry

Thêm bảng asset quản lý:

- `cache_key`
- provider/model/version
- path, size
- `last_accessed_at`
- `CREATING | READY | FAILED | EVICTED`
- lease hoặc active-reader count

Quy trình sinh file:

1. Ghi vào file tạm có UUID.
2. Validate dung lượng và định dạng cơ bản.
3. Atomic rename sang path đích.
4. Chuyển asset sang READY.

Khi eviction:

1. Chuyển trạng thái sang EVICTED.
2. Xóa file.
3. Request tiếp theo tự động regenerate.

Không sử dụng filesystem `atime` làm nguồn sự thật.

### 3.6 Event channel thay polling

Có thể dùng SSE cho sự kiện một chiều:

- `segment.ready`
- `segment.failed`
- `session.progress`
- `provider.degraded`

SSE đơn giản hơn WebSocket cho use case này. Polling vẫn có thể giữ làm fallback.

### 3.7 Lifecycle generation phía extension

Mỗi navigation hoặc lần enable nên có một `generationId` và `AbortController`.

Mọi callback bất đồng bộ phải kiểm tra generation trước khi:

- Ghi `segments`.
- Chuyển FSM.
- Phát audio.
- Resume video.
- Cập nhật UI.

Tại `yt-navigate-start` cần:

- Abort request.
- Hủy polling/timer.
- Detach listeners khỏi video cũ.
- Reset tất cả flags.
- Stop audio.
- Tăng generation.

### 3.8 Cải thiện dịch thuật theo mục tiêu học công nghệ

Ưu tiên cao:

- Protect thuật ngữ bằng placeholder trước khi dịch, restore sau khi dịch.
- Context window 3–5 câu, nhưng trả kết quả dạng JSON có segment ID thay vì newline.
- Translation provider adapters và circuit breaker.
- Cache translation theo source hash, target language, glossary version và provider version.
- Tách `displayText` và `ttsText`.
- `ttsText` có thể rút gọn từ đệm để đáp ứng duration mà không mất ý chính.
- Pronunciation dictionary cho React, Python, Kubernetes, API, SQL...

Đây có giá trị cao hơn emotion engine hoặc cinematic dubbing đối với Persona #1.

---

## 4. Lộ trình ưu tiên

### P0 — Correctness và chống race

- Sửa lifecycle cancellation phía extension.
- Không xóa job RUNNING khi promote priority.
- Atomic cache writes.
- Kiểm tra file tồn tại trước khi trả READY.
- Sửa session TTL/heartbeat.
- Timeout và kill subprocess.
- Reset đầy đủ `isWaitingForAudio` và pending state.

### P1 — Latency và đa tab

- Progressive session initialization.
- Sliding-window preload.
- Fair scheduler thực sự.
- SSE thay polling chính.
- Translation/subtitle cache dùng chung giữa session.

### P2 — Chất lượng học tập

- Context-aware translation.
- Glossary placeholders.
- Duration-aware TTS text.
- Pronunciation profiles.
- Manual subtitle/audio offset.
- Graceful messaging cho video không có caption hoặc livestream.

### P3 — Chỉ khi triển khai cloud/multi-user

- Authentication và quota.
- Object storage/CDN.
- PostgreSQL/Redis-backed queue.
- Horizontal workers.
- Provider billing và tenant isolation.

Không nên thực hiện P3 khi sản phẩm vẫn local-first.

---

## 5. Observability và kiểm thử cần bổ sung

Các metrics nên có:

- Toggle-to-first-dub latency.
- Translation/TTS latency p50/p95.
- Queue age theo priority và session.
- Cache hit ratio.
- Tỷ lệ segment fallback/skipped.
- Số lần Smart Pause.
- Drift và force-seek count.
- Provider error/circuit-breaker state.

Bộ integration test hiện tại chưa đủ làm safety net. Đáng chú ý, test bắt lỗi nhưng cuối cùng luôn `process.exit(0)` tại [test_integration.ts](/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/test_integration.ts:109), nên CI có thể báo thành công dù test thất bại.

Cần có deterministic fake Translation/TTS providers và test riêng cho:

- Bốn tab cạnh tranh worker.
- Seek spam.
- Hai session cùng sinh một cache key.
- Restart giữa job.
- Navigation khi request đang chạy.
- Disable trong lúc initializing.
- Audio kéo dài qua nhiều segment.
- Eviction rồi request lại asset.

## Đánh giá cuối cùng

V2 đã giải quyết tốt các lỗi nền tảng của V1 và có kiến trúc playback đúng hướng. Điểm yếu hiện tại chủ yếu nằm ở lifecycle bất đồng bộ, queue/cache consistency và chiến lược “xử lý toàn video”.

Hướng V3 hợp lý nhất là:

> Giữ nguyên client-owned playback và SQLite, nhưng chuyển backend thành progressive artifact pipeline với demand-driven scheduling, cache có catalog, provider adapters và observability đầy đủ.

Không có file hoặc commit nào được thay đổi; worktree vẫn sạch.

# LiveTube Voice Dubber V2 - Architecture Threat Review

Tài liệu này thực hiện đánh giá hiểm họa kiến trúc (Architecture Threat Review) đối với thiết kế của phiên bản V2. Mục tiêu là phân tích, kiểm thử và tìm cách "phá hủy" hệ thống trên giấy trước khi viết bất kỳ dòng code nào, từ đó đưa ra các thay đổi kiến trúc cần thiết để đảm bảo sản phẩm hoạt động bền vững.

---

## 1. Nhóm 1: YouTube & Player DOM Integration (Tích hợp Trình phát & DOM)

### Threat 1: YouTube thay đổi cấu trúc DOM (Control Bar hoặc CSS classes)
- **Mô tả**: YouTube cập nhật giao diện web, đổi tên class `.ytp-right-controls` hoặc thay đổi cấu trúc trình phát. Extension không tìm thấy phần tử để chèn nút Headphones hoặc Shadow DOM.
- **Mức độ nghiêm trọng**: Cao (Chặn đứng hoạt động)
- **Xác suất xảy ra**: Trung bình (YouTube cập nhật lớn 3-6 tháng/lần)
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa triệt để (Chỉ bắt MutationObserver chung).
- **Đề xuất thay đổi kiến trúc**: 
  - Extension không hardcode CSS class. Sử dụng cơ chế tìm kiếm fallback dựa trên các thuộc tính HTML chuẩn của trình điều khiển YouTube (ví dụ: nút có `role="button"` nằm trong thanh điều khiển hoặc gần nút cài đặt `.ytp-settings-button`).
  - Thiết kế cấu trúc **Dynamic Selectors**: Đẩy danh sách selectors lên một file JSON cấu hình trên CDN. Extension khi khởi động sẽ fetch file này về để cấu hình runtime. Nếu YouTube đổi class, ta chỉ cần sửa file JSON trên CDN mà không cần submit lại Extension lên Chrome Web Store.

### Threat 2: YouTube SPA chuyển trang không reload trang (ytd-watch-flexy Redraws)
- **Mô tả**: Người dùng click sang video khác, YouTube thay đổi URL qua History API. Thẻ video cũ bị hủy và tạo mới, nhưng extension không cập nhật kịp dẫn đến binding sai sự kiện hoặc rò rỉ bộ nhớ (leak listeners).
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao (Hành vi chuyển trang bình thường trên YT)
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý một phần (dùng check URL mỗi 1000ms).
- **Đề xuất thay đổi kiến trúc**:
  - Không dùng polling check URL. Đăng ký lắng nghe các sự kiện nội bộ của YouTube trên đối tượng `document`: `yt-navigate-start` và `yt-navigate-finish`.
  - Khi `yt-navigate-start` kích hoạt, lập tức hủy toàn bộ Listeners cũ, chuyển Playback State Machine về `IDLE`, gọi hàm `destroy()` trên thực thể Player cũ để dọn dẹp bộ nhớ trước khi trang mới kịp load.

---

## 2. Nhóm 2: Third-party Provider & Network (Dịch vụ bên thứ ba)

### Threat 3: Google Translate chặn IP do dịch lượng lớn câu thoại
- **Mô tả**: Gửi batch dịch gồm 200 câu của một video dài 1 tiếng lên Google Translate API miễn phí (`client=gtx`). Google phát hiện dấu hiệu spam/crawl và block IP của server trong 24 giờ.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý (Batch translation có backoff).
- **Đề xuất thay đổi kiến trúc**:
  - Triển khai **Translation Abstraction Layer** (Bộ điều hợp dịch thuật):
    - Mặc định sử dụng Google Translate miễn phí với kích thước batch tối đa 30 câu/lần, thêm delay ngẫu nhiên (jitter) 500ms - 1000ms giữa các batch.
    - Hỗ trợ Driver phụ: Cho phép cấu hình điền API Key chính thức của Google Cloud Translation hoặc DeepL API.
    - Hỗ trợ Driver Local: Gọi dịch qua mô hình LLM cục bộ (ví dụ: Ollama chạy `qwen2.5:1.5b` hoặc `marian-local` offline) để đảm bảo không bao giờ bị chặn.

### Threat 4: Edge-TTS API thay đổi giao thức bảo mật hoặc sập diện rộng
- **Mô tả**: Microsoft Edge TTS (vốn là API không chính thức phục vụ trình duyệt Edge) thay đổi tham số kết nối WebSocket hoặc chặn các request từ server không phải Edge. CLI `edge-tts` bị lỗi.
- **Mức độ nghiêm trọng**: Cao (Mất hoàn toàn tiếng lồng Việt)
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa (Mặc định dùng Edge-TTS).
- **Đề xuất thay đổi kiến trúc**:
  - Triển khai **TTS Service Adapters** (Adapter cho dịch vụ TTS):
    - Đóng gói logic sinh audio thành Interface `ITTSProvider`.
    - Viết các adapter thay thế: `EdgeTTSProvider` (mặc định), `GoogleCloudTTSProvider`, `OpenAITTSProvider`, `FptTTSProvider`.
    - Nếu `EdgeTTSProvider` trả về lỗi liên tục (ví dụ: HTTP 403 hoặc Connection Refused), backend tự động fallback sang các provider khác (nếu người dùng đã cấu hình API key trong file `.env`).

### Threat 5: Microsoft chặn IP do sinh âm thanh dồn dập (Preload Surge)
- **Mô tả**: Khi người dùng mở nhiều tab cùng lúc, scheduler đẩy hàng loạt job `LOOK_AHEAD` (ví dụ: 50 câu) lên Edge-TTS trong thời gian ngắn, khiến IP server bị Microsoft đưa vào danh sách đen.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý (Giới hạn workers toàn cục và theo session).
- **Đề xuất thay đổi kiến trúc**:
  - Bổ sung **Rate-Limiter Middleware** ở tầng giao tiếp với Edge-TTS: Ép buộc khoảng cách tối thiểu giữa 2 lần khởi chạy tiến trình sinh TTS từ cùng một server là 500ms (cho dù có nhiều worker rảnh rỗi).
  - Không cho phép sinh âm thanh dồn dập toàn bộ video. Khống chế khoảng cách preload tối đa: Chỉ sinh âm thanh cho tối đa 5 câu thoại tiếp theo câu thoại hiện tại. Khi video chạy tiếp thì mới sinh tiếp (Sliding Window Preload).

---

## 3. Nhóm 3: Playback, Seek & Syncing (Phát nhạc & Đồng bộ)

### Threat 6: User tua liên tục (Seek-Spamming) gây quá tải I/O và SQL
- **Mô tả**: Người dùng kéo chuột liên tục trên thanh tua của YouTube. Extension bắt hàng trăm sự kiện `seeked` và `timeupdate`, liên tục bắn request `/request-audio` lên backend làm SQLite nghẽn và CPU server quá tải do liên tục cập nhật priority job.
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Áp dụng kỹ thuật **Debounce / Throttle** ở phía Client Extension:
    - Khi có sự kiện `seeked`, extension đợi 300ms. Nếu trong khoảng thời gian đó không có sự kiện seek mới, extension mới gửi duy nhất 1 request `/request-audio` cho segment hiện tại lên backend.
    - Loại bỏ việc gửi request cho các segment trung gian khi người dùng đang kéo chuột tua.

### Threat 7: Lệch pha âm thanh (Audio/Video Drift) trên máy cấu hình yếu
- **Mô tả**: Trên các máy tính cũ, trình duyệt bị rớt khung hình (frame drop) video YouTube làm hình ảnh bị chậm lại, trong khi thẻ Audio lồng tiếng vẫn phát đúng tốc độ, dẫn đến lệch pha lớn giữa tiếng Việt và khẩu hình tiếng Anh.
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý (Lệch > 0.4s thì force-seek).
- **Đề xuất thay đổi kiến trúc**:
  - Triển khai thuật toán **Micro-adjustments** (Vi điều chỉnh tốc độ phát):
    - Định kỳ mỗi 1 giây, client so sánh `Math.abs(video.currentTime - (segment.start + audio.currentTime))`.
    - Nếu độ lệch nằm trong khoảng an toàn `0.1s - 0.3s`: Tự động tăng hoặc giảm `audio.playbackRate` thêm 2% - 5% (trong khoảng ngắn) để kéo audio đồng bộ khít lại với video mà tai người nghe không nhận ra sự thay đổi tốc độ đột ngột.
    - Chỉ thực hiện force-seek audio (gây khựng tiếng nhẹ) khi độ lệch vượt quá ngưỡng nghiêm trọng `0.5s`.

### Threat 8: Smart Pause gây vòng lặp dừng vô tận (Infinite Pause Loop)
- **Mô tả**: Khi audio lồng tiếng dài hơn segment, extension pause video gốc để chờ audio đọc nốt (Smart Pause). Sự kiện pause của video YouTube lại kích hoạt listener `onVideoPause` của extension, làm pause luôn cả audio lồng tiếng. Audio lồng tiếng bị pause nên không bao giờ kết thúc để kích hoạt chạy lại video gốc, gây đơ hoàn toàn trình phát.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Extension duy trì một trạng thái nội bộ `isSmartPausing: boolean` (mặc định `false`).
  - Khi bắt đầu thực hiện Smart Pause, set `isSmartPausing = true` trước khi gọi `video.pause()`.
  - Trong sự kiện lắng nghe `video.on('pause')`: Nếu `isSmartPausing === true`, bỏ qua không gọi `audio.pause()`.
  - Khi audio kết thúc, set `isSmartPausing = false` trước khi gọi `video.play()`.

---

## 4. Nhóm 4: Hàng đợi, Đồng thời & Khả năng mở rộng

### Threat 9: SQLite bị khóa (Database is locked) khi ghi ghi song song từ nhiều Worker
- **Mô tả**: Nhiều workers ghi trạng thái hoàn thành job cùng lúc với luồng Express API nhận session mới, gây lỗi `SQLITE_BUSY` làm treo các API response.
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý ( better-sqlite3 + WAL mode).
- **Đề xuất thay đổi kiến trúc**:
  - Cấu hình SQLite busy timeout lên 5000ms: `db.pragma('busy_timeout = 5000')`.
  - Sử dụng Express/Fastify middleware để tập trung hóa các transaction ghi. Tránh mở transaction lồng nhau. Sử dụng `IMMEDIATE` transaction cho các tác vụ ghi queue jobs để SQLite lock bảng ghi một cách an toàn và xếp hàng các luồng ghi khác.

### Threat 10: Server sập/restart làm mất trạng thái công việc của Workers
- **Mô tả**: Node.js bị crash hoặc hệ điều hành restart giữa chừng. Thông tin về các job đang chạy ngầm bị mất khỏi bộ nhớ RAM, khiến các segment bị kẹt ở trạng thái `GENERATING` vô hạn.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Thấp
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý (Jobs lưu SQLite).
- **Đề xuất thay đổi kiến trúc**:
  - Khởi động cơ chế **Orphaned Jobs Recovery** (Phục hồi job mồ côi) khi backend start:
    - Quét bảng `jobs`: Chuyển tất cả job có `status = 'RUNNING'` quay lại thành `PENDING`.
    - Quét bảng `segments`: Chuyển các segment có `audio_status = 'GENERATING'` quay lại `PENDING` để scheduler nạp lại vào hàng đợi xử lý.

---

## 5. Nhóm 5: Edge Cases (Livestream, Không có phụ đề, Video dài)

### Threat 11: Video dạng YouTube Livestream (Phát trực tiếp)
- **Mô tả**: Livestream không có file phụ đề tĩnh `.vtt` cố định từ đầu, timeline liên tục tăng tiến. V2 thiết kế timeline-driven dựa trên subtitle tĩnh sẽ thất bại hoàn toàn.
- **Mức độ nghiêm trọng**: Cao (Nếu user cố tình bật lồng tiếng trên livestream)
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - **Graceful Degradation (Hạ cấp tính năng)**:
    - Extension kiểm tra xem video có phải là Livestream không (qua DOM selector của nút "LIVE" hoặc kiểm tra thuộc tính `duration` của video là `Infinity`).
    - Nếu là Livestream, vô hiệu hóa nút Headphones, hiển thị thông báo "Livestream không được hỗ trợ trong phiên bản này" và dừng hoàn toàn luồng xử lý.

### Threat 12: Video cực dài (Podcast từ 5 đến 10 tiếng)
- **Mô tả**: Video dài chứa hàng nghìn câu thoại. Việc tải sub và dịch toàn bộ 100% video ở bước `/init` sẽ mất 30s - 1 phút, làm tăng TTFP quá cao và gây tràn bộ nhớ.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Triển khai **Chunk-based Subtitle Ingestion** (Xử lý phụ đề theo phân đoạn):
    - Chia toàn bộ phụ đề thành các block thời gian 10 phút (ví dụ: Block 1: 0-10m, Block 2: 10-20m...).
    - Bước khởi tạo `/init` chỉ tải và dịch duy nhất Block 1 và lưu vào DB. Trả dữ liệu ngay để user xem.
    - Backend tự động chạy job dịch ngầm (Priority 2) cho các block tiếp theo. Khi user tua (seek) qua block mới chưa dịch, backend ưu tiên dịch block đó ngay lập tức trước khi sinh audio.

### Threat 13: Phụ đề của YouTube bị lệch timeline nặng so với tiếng nói gốc
- **Mô tả**: Phụ đề tự động tạo của YouTube bị lệch pha so với tiếng nói thực tế trong video (do lỗi thuật toán của YouTube). Giọng đọc lồng tiếng chạy theo timeline phụ đề cũng sẽ bị lệch theo.
- **Mức độ nghiêm trọng**: Trung bình (Ảnh hưởng trải nghiệm UX)
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Cung cấp tính năng **Audio/Subtitle Offset Calibration** (Hiệu chuẩn độ lệch timeline) trong UI Popover của Extension.
  - Cho phép người dùng tăng/giảm độ trễ timeline thủ công (ví dụ: từ `-2.0s` đến `+2.0s` với bước nhảy 0.2s). Giá trị offset này sẽ được cộng vào `video.currentTime` when extension thực hiện tìm kiếm segment tương ứng.

---

## 6. Nhóm 6: Storage, Cache & File System (Bộ nhớ & Tệp tin)

### Threat 14: Ổ cứng đầy (Disk Out of Space) làm hỏng file audio
- **Mô tả**: Ổ cứng máy chủ/máy trạm bị đầy đột ngột. File `.mp3` sinh ra có kích thước 0 bytes, write operation ném ra ngoại lệ làm treo worker.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Thấp
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý một phần (LRU eviction định kỳ).
- **Đề xuất thay đổi kiến trúc**:
  - Bổ sung bước kiểm tra dung lượng ổ đĩa khả dụng (Disk space check) trong worker trước khi bắt đầu sinh file TTS.
  - Nếu dung lượng trống dưới 100MB, lập tức kích hoạt dọn dẹp cache khẩn cấp (Evict) thay vì đợi cron job 24h.
  - Nếu vẫn không đủ chỗ ghi, đánh dấu segment là `FAILED` để extension tự động fallback về tiếng gốc YouTube, tránh làm hỏng tiến trình ghi đè file.

### Threat 15: Race condition khi hai tab ghi/đọc cùng một file cache
- **Mô tả**: Hai sessions chạy hai video khác nhau nhưng chứa câu thoại giống hệt nhau (ví dụ: "Hello", "Thank you"). Cả hai workers cùng tính ra một `cacheKey`, cùng gọi Edge-TTS ghi đè lên file `{cacheKey}.mp3` song song, làm hỏng định dạng file mp3 (file corruption).
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Áp dụng cơ chế **Atomic File Writes** (Ghi tệp nguyên tử):
    - Worker sinh file audio tạm thời vào `/audio/cache/temp_{uuid}.mp3`.
    - Sau khi file tạm đã được ghi thành công và có kích thước > 0, sử dụng lệnh đổi tên/di chuyển file nguyên tử của hệ điều hành (`fs.rename` trong Node.js) để đè lên file đích `{cacheKey}.mp3`. Lệnh rename nguyên tử được OS đảm bảo không bao giờ bị xung đột ghi đè dữ liệu.

### Threat 16: Lỗi phân quyền khi xóa file cache đang được stream (File Busy)
- **Mô tả**: Tiến trình serve file tĩnh của Express đang stream file `{cacheKey}.mp3` cho client A, cùng lúc tiến trình dọn dẹp cache (Eviction) cố gắng xóa file đó do hết hạn. Trên hệ điều hành Windows/macOS có thể gây lỗi `EPERM` hoặc `EBUSY` làm crash backend.
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Bọc toàn bộ các lệnh xóa file (`fs.unlink`) trong khối lệnh `try-catch`.
  - Nếu ném ra lỗi `EBUSY` hoặc `EPERM`, backend bỏ qua file đó, đưa vào một danh sách tạm `pending_deletions` để thử xóa lại ở chu kỳ dọn dẹp tiếp theo thay vì crash server.

---

## 7. Nhóm 7: Security & Multi-User Constraints (Bảo mật & Đa người dùng)

### Threat 17: Giả mạo Session ID để đọc trộm phụ đề dịch hoặc kích hoạt tts rác
- **Mô tả**: Sử dụng Session ID dạng tuần tự (như `1, 2, 3...`) cho phép hacker đoán được Session ID của người khác, gửi các request `/request-audio` rác làm cạn kiệt tài nguyên server.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao (Nếu thiết kế kém)
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý (Dùng UUID v4).
- **Đề xuất thay đổi kiến trúc**:
  - Tiếp tục duy trì việc sử dụng UUID v4 ngẫu nhiên cho `sessionId`.
  - Bổ sung Token bảo mật đơn giản: Khi `/init` session, backend trả về một `sessionToken` ngẫu nhiên. Mọi request API tiếp theo liên quan đến session đó bắt buộc phải đính kèm token này trong HTTP Header để xác thực quyền sở hữu.

### Threat 18: Tải trọng CPU quá cao do chạy nhiều Subprocess Edge-TTS
- **Mô tả**: Việc gọi liên tục subprocess Python CLI của `edge-tts` ngốn lượng lớn RAM và CPU của máy chạy server (đặc biệt nếu server là máy cá nhân của người dùng).
- **Mức độ nghiêm trọng**: Trung bình
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa (Mặc định dùng python subprocess).
- **Đề xuất thay đổi kiến trúc**:
  - **Loại bỏ Python Subprocess cho TTS**:
    - Port logic Edge-TTS sang thư viện Node.js thuần (sử dụng WebSocket của Node.js kết hợp luồng ghi trực tiếp như thư viện npm `edge-tts` hoặc tự viết WebSocket handler gọn nhẹ).
    - Điều này giúp việc sinh audio hoàn toàn chạy trong Node.js event-loop, loại bỏ overhead cực lớn khi hệ điều hành khởi tạo và thu hồi tiến trình Python liên tục.

### Threat 19: Tràn bộ nhớ RAM (Memory Leak) do quản lý cache in-memory thẻ Audio
- **Mô tả**: Client extension liên tục tạo các thực thể `new Audio()` khi tua hoặc chuyển segment mà không giải phóng bộ nhớ, làm trình duyệt Chrome ngốn RAM và cuối cùng bị sập tab (Out of Memory).
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Cao
- **Kiến trúc hiện tại đã xử lý chưa**: Đã xử lý một phần (Hàm destroyAudio).
- **Đề xuất thay đổi kiến trúc**:
  - Triển khai **Audio Element Pool**:
    - Thay vì tạo vô tội vạ đối tượng Audio mới, extension chỉ tạo duy nhất 2 thực thể `HTMLAudioElement` cố định từ đầu và tái sử dụng chúng (reuse) bằng cách thay đổi thuộc tính `src`.
    - Khi muốn dừng phát một audio, thực hiện:
      `audio.pause(); audio.removeAttribute('src'); audio.load();` để trình duyệt giải phóng hoàn toàn buffer mạng của file cũ.

### Threat 20: Starvation của một Tab khi Tab khác bị treo vòng lặp request
- **Mô tả**: Tab A bị lỗi script dẫn tới việc gọi liên tục API `/request-audio` hàng trăm lần. Dù có Fair Scheduler ở mức priority 2, các request priority 1 (`ON_DEMAND`) của Tab A vẫn chiếm dụng toàn bộ workers, làm Tab B bị mất tiếng hoàn toàn.
- **Mức độ nghiêm trọng**: Cao
- **Xác suất xảy ra**: Trung bình
- **Kiến trúc hiện tại đã xử lý chưa**: Chưa.
- **Đề xuất thay đổi kiến trúc**:
  - Áp dụng **Fairness trên cả Priority 1 (ON_DEMAND)**:
    - Kể cả đối với các job khẩn cấp, scheduler vẫn nhóm theo `session_id` và xử lý Round-Robin thay vì FIFO thuần túy.
    - Giới hạn tốc độ yêu cầu (Rate Limit per Session): Backend từ chối nhận request `/request-audio` từ một `sessionId` nếu tần suất vượt quá 5 request/giây, trả về mã lỗi HTTP 429.

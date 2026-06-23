# LiveTube Voice Dubber V2 - Các Giải thuật & Thuật toán Cốt lõi

Tài liệu này ghi nhận các thuật toán đặc thù được thiết kế riêng cho dự án LiveTube V2 để giải quyết các bài toán đồng bộ thời gian thực và quản lý tài nguyên.

---

## 1. Gom cụm Phụ đề (Sentence Reconstructor)

*   **Vấn đề**: File phụ đề `.vtt` tải từ YouTube bị phân tách thành các dòng thô rất ngắn dựa trên ranh giới xuống dòng của màn hình, không theo cấu trúc ngữ pháp ngữ nghĩa (Semantic Sentences). Nếu gửi từng dòng thô này lên dịch thuật và TTS, âm thanh đọc sẽ bị ngắt quãng, thiếu tự nhiên và dịch sai ngữ cảnh.
*   **Giải pháp**: Thiết kế thuật toán gom cụm tại [yt-dlp.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/yt-dlp.ts):
    1.  Duyệt qua từng dòng phụ đề thô. Lọc bỏ các ký hiệu không phải tiếng nói (non-speech) như `[Music]`, `[♪♪♪]`.
    2.  Gom các dòng phụ đề liên tiếp vào một câu thoại tạm thời.
    3.  **Điều kiện ngắt câu**: Câu thoại sẽ được ngắt và đóng gói thành một `Segment` hoàn chỉnh khi gặp một trong hai điều kiện:
        *   Dòng phụ đề kết thúc bằng một dấu ngắt câu ngữ pháp: Dấu chấm `.`, chấm hỏi `?`, hoặc chấm than `!`.
        *   Có một khoảng lặng (Silence Gap) giữa dòng hiện tại và dòng tiếp theo lớn hơn hoặc bằng **1.0 giây** (tính bằng `next.start - current.end`).
    4.  **Giới hạn an toàn chống câu quá dài**: Nếu người nói nói liên tục không ngắt và không có dấu câu, thuật toán sẽ chủ động ngắt câu khi độ dài chuỗi tạm thời vượt quá **150 ký tự** hoặc độ dài thời gian vượt quá **12 giây** để tránh câu thoại bị gom quá dài làm hỏng tiến trình dịch thuật.

---

## 2. Hàng đợi Công bằng (Fair Queue Scheduler)

*   **Vấn đề**: Khi nhiều tab YouTube được mở đồng thời, các tab sẽ gửi hàng loạt yêu cầu sinh audio (LOOK_AHEAD). Nếu dùng hàng đợi FIFO đơn giản, một tab tải trước có thể chiếm dụng toàn bộ worker threads, làm các tab mở sau bị nghẽn (starvation) và không có tiếng.
*   **Giải pháp**: Triển khai scheduler Round-Robin trong [queue.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/queue.ts):
    1.  **Phân cấp độ ưu tiên (Priority)**:
        *   **Priority 1 (ON_DEMAND)**: Yêu cầu gấp từ tab đang phát trực tiếp. Các job này được ưu tiên nhảy lên đầu hàng đợi và xử lý ngay lập tức.
        *   **Priority 2 (LOOK_AHEAD)**: Yêu cầu sinh trước để preload.
    2.  **Lập lịch luân phiên (Round-Robin)**:
        *   Khi lấy job Priority 2 từ SQLite, scheduler gom nhóm các job theo `session_id`.
        *   Nó sẽ chọn tuần tự 1 job từ Session A, rồi 1 job từ Session B, rồi 1 job từ Session C, thay vì lấy hết job của Session A rồi mới sang Session B.
    3.  **Giới hạn luồng (Concurrency Limits)**:
        *   `MAX_TOTAL_CONCURRENT_WORKERS = 3`: Giới hạn tối đa 3 tiến trình Edge-TTS chạy đồng thời trên CPU để tránh quá tải.
        *   `MAX_SESSION_CONCURRENT_WORKERS = 1`: Tối đa chỉ có 1 job của 1 session được xử lý tại 1 thời điểm, đảm bảo tài nguyên được chia đều 100% cho các tab.

---

## 3. Double-Buffering Audio Engine

*   **Vấn đề**: Việc nạp tệp audio mới vào thẻ Audio duy nhất liên tục trên trình duyệt gây ra độ trễ nạp mạng (50ms - 200ms) tạo ra khoảng lặng giữa các câu thoại. Ngoài ra, việc khởi tạo liên tiếp hàng trăm đối tượng `new Audio()` sẽ gây rò rỉ bộ nhớ (OOM) của Chrome.
*   **Giải pháp**: Thiết kế Pool 2 thực thể Audio Element cố định trong [player.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/player.ts):
    1.  Khởi tạo đúng hai thực thể `audioA` và `audioB` cố định trong constructor.
    2.  **Cơ chế hoán đổi (Buffer Swap)**:
        *   Khi `audioA` đang phát (Active Buffer), `audioB` sẽ được nạp sẵn URL của câu thoại tiếp theo (Preload Buffer) thông qua lệnh `audioB.load()`.
        *   Khi video chạy đến câu tiếp theo, nếu phát hiện tệp tin cần phát trùng khớp với tệp đã được preload trong `audioB` (Cache Hit), hệ thống lập tức gọi `swapBuffers()` đổi vai trò của hai thẻ, gọi `audioB.play()` tức thì. Khoảng lặng chuyển tiếp được giảm về **0ms**.
    3.  **Dọn dẹp triệt để (Garbage Eviction)**: Khi nạp tệp mới, gọi `audio.removeAttribute('src')` and `audio.load()` để bắt trình duyệt giải phóng bộ nhớ đệm cũ ngay lập tức.

---

## 4. Tăng tốc phát động (Dynamic Audio Speedup)

*   **Vấn đề**: Bản dịch tiếng Việt thường dài hơn từ 20% - 40% so với câu thoại tiếng Anh gốc. Nếu giữ nguyên tốc độ, audio lồng tiếng sẽ đọc lấn sang câu sau làm lệch pha timeline.
*   **Giải pháp**: Tự động co giãn tốc độ trong hàm `applyDynamicRate` của player:
    1.  Nếu thời lượng audio lồng tiếng (`audio.duration`) dài hơn thời lượng segment gốc trên video (`segmentDuration`):
        *   Tính toán tốc độ cần thiết:
            $$\text{requiredRate} = \frac{\text{audio.duration}}{\text{segmentDuration}} \times \text{video.playbackRate}$$
        *   **Giới hạn an toàn**: Để đảm bảo giọng nói nghe rõ chữ và không bị méo tiếng, ta giới hạn tốc độ tăng tốc tối đa là **1.35x** so với tốc độ phát của video:
            $$\text{playbackRate} = \min(\text{requiredRate}, \text{video.playbackRate} \times 1.35)$$

---

## 5. Đồng bộ Tự nhiên theo Sự kiện (Event-driven Natural Play)

*   **Vấn đề**: Cơ chế Smart Pause cũ tạm dừng video làm hình ảnh bị giật cục. Cơ chế check drift liên tục mỗi 200ms làm méo giọng nói do đổi rate liên tục và gây nuốt chữ đầu câu khi phát gối đầu do đo sai mốc start.
*   **Giải pháp**: Thiết kế hệ thống đồng bộ hướng sự kiện triệt để:
    1.  **Phát gối đầu (Smart Pipeline)**: 
        *   Nếu câu trước đọc chưa xong, câu sau sẽ hoãn phát và đưa vào hàng đợi `pendingSegment`, chờ sự kiện `ended` của câu cũ kích hoạt mới phát câu mới.
        *   Hệ thống tính toán lại thời lượng thực tế còn lại của segment mới dựa trên vị trí hiện tại của video: `remainingDuration = seg.end - video.currentTime` để tự động tăng tốc phát cho câu mới đuổi kịp video.
    2.  **Đồng bộ neo điểm đầu câu (Anchor Reset)**:
        *   Lưu lại thời điểm video thực tế bắt đầu phát audio lồng tiếng là `audioPlayVideoTime`.
        *   **Tắt hoàn toàn hàm check drift liên tục** trong suốt quá trình phát câu thoại. Audio được chạy tự nhiên 100% để giữ chất lượng âm thanh cao nhất.
    3.  **Đồng bộ quy đổi theo Tốc độ phát (SpeedRatio Sync)**:
        *   Hệ thống chỉ chạy check drift **đúng 1 lần duy nhất** (300ms sau khi đổi tốc độ hoặc resume) để bù đắp sai số nạp của trình duyệt.
        *   Công thức tính drift quy đổi:
            $$\text{speedRatio} = \frac{\text{audio.playbackRate}}{\text{video.playbackRate}}$$
            $$\text{drift} = (\text{video.currentTime} - \text{audioPlayVideoTime}) - \frac{\text{audio.currentTime}}{\text{speedRatio}}$$
        *   **Ý nghĩa của giá trị drift**:
            *   $\text{drift} > 0.15s$: Audio lồng tiếng đang bị **chậm** hơn video $\rightarrow$ Tăng tốc audio lên $5\%$ (`audio.playbackRate = audio.playbackRate * 1.05`).
            *   $\text{drift} < -0.15s$: Audio lồng tiếng đang chạy **nhanh** hơn video $\rightarrow$ Giảm tốc audio đi $5\%$ (`audio.playbackRate = audio.playbackRate * 0.95`).
            *   $|\text{drift}| > 0.4s$: Lệch pha nghiêm trọng $\rightarrow$ Đồng bộ cứng (force-seek):
                $$\text{audio.currentTime} = \text{elapsedVideo} \times \text{speedRatio}$$
    4.  **Đồng bộ theo trạng thái video**:
        *   Lắng nghe sự kiện `waiting` (video bị buffering do lag mạng) để dừng audio tương ứng (`audio.pause()`).
        *   Lắng nghe sự kiện `playing` (video hết lag và chạy tiếp) để phát lại audio (`audio.resume()`).

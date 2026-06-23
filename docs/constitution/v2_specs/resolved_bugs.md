# LiveTube Voice Dubber V2 - Lịch sử Sửa lỗi & Bài học Xương máu

Tài liệu này ghi lại lịch sử khắc phục các lỗi nghiêm trọng (post-mortem) trong quá trình phát triển V2, đóng vai trò làm cẩm nang hướng dẫn (guardrails) phòng ngừa lỗi cho các phiên bản tiếp theo.

---

## 1. Lỗi sập CLI của Edge-TTS do ký tự lạ trong phụ đề

*   **Hiện tượng**: Khi video chứa các dòng phụ đề mô tả âm thanh nền dạng `[♪♪♪]`, `[Music]`, `(applause)`, tiến trình Edge-TTS CLI bị sập và trả về lỗi `edge_tts.exceptions.NoAudioReceived: No audio was received` do không tìm thấy từ ngữ nào để phát âm. Lỗi này làm kẹt hàng đợi (job ở trạng thái `GENERATING` mãi mãi) và toàn bộ các câu thoại phía sau không được sinh âm thanh.
*   **Giải pháp khắc phục**: Nâng cấp hàm `cleanText` trong [yt-dlp.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/yt-dlp.ts) để lọc bỏ triệt để các ký hiệu trong ngoặc vuông `[...]`, ngoặc tròn `(...)`, dấu sao `*...*` và ký hiệu âm nhạc. Thêm điều kiện: Nếu sau khi làm sạch, chuỗi không chứa bất kỳ chữ cái hay chữ số nào (`!/[\p{L}\p{N}]/u.test(cleaned)`), câu thoại đó sẽ bị loại bỏ ngay tại tầng phân tích cú pháp để không gửi lên TTS.
*   **Bài học xương máu**: Luôn thực hiện làm sạch dữ liệu đầu vào (data sanitization) triệt để trước khi chuyển giao dữ liệu cho bất kỳ thư viện hoặc CLI bên thứ ba nào.

---

## 2. Lỗi chồng âm thanh (Multi-audio overlap) khi tạm dừng/phát lại video

*   **Hiện tượng**: Khi người dùng nhấn nút Pause video trên YouTube, giọng lồng tiếng vẫn tiếp tục nói một lúc rồi mới dừng. Khi nhấn Play tiếp, xuất hiện 3 âm thanh phát chồng chéo: âm thanh gốc đúng, và 2 đoạn âm thanh lồng tiếng không khớp nhau chạy song song.
*   **Nguyên nhân**:
    *   Do extension sử dụng cấu trúc `Double-Buffering` nhưng logic hoán đổi buffer (`swapBuffers()`) lại nằm ở file điều phối chung `content.ts`. Khi video pause, hệ thống gọi `.pause()` nhầm thẻ audio đang ở trạng thái chờ (preload) thay vì thẻ đang phát thực tế (active), khiến audio lồng tiếng cũ tiếp tục phát ngầm.
    *   Khi resume, hệ thống lại kích hoạt nạp file mới tạo ra hai âm thanh chạy đè lên nhau.
*   **Giải pháp khắc phục**: Đẩy toàn bộ logic quản lý thẻ Audio và hoán đổi buffer vào bên trong lớp `DoubleBufferedAudioPlayer` của file [player.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/player.ts). Extension chỉ gọi `.play()`, `.pause()`, `.resume()`, còn Player tự động nhận diện chính xác thẻ nào đang phát để thực hiện lệnh dừng/phát mượt mà.
*   **Bài học xương máu**: Áp dụng triệt để nguyên lý đóng gói (Encapsulation) trong thiết kế hướng đối tượng. Tầng điều khiển (content script) không nên can tiệp sâu vào trạng thái nội bộ của tầng động cơ phát (player).

---

## 3. Lỗi giật khựng hình ảnh video do cơ chế Smart Pause cũ

*   **Hiện tượng**: Khi giọng nói tiếng Việt dài hơn tiếng Anh, video YouTube thỉnh thoảng bị đứng hình/khựng giật nhẹ một khoảng cực ngắn (50ms - 200ms) trước khi chuyển sang câu tiếp theo, tạo cảm giác rất khó chịu về mặt thị giác.
*   **Nguyên nhân**: Cơ chế Smart Pause cũ liên tục tính toán thời lượng còn lại của video và audio mỗi 200ms. Chỉ cần audio chậm hơn video quá 50ms, hệ thống lập tức gọi `video.pause()` để dừng hình ảnh chờ tiếng. Việc gọi dừng/phát liên tục trong tích tắc làm bộ giải mã video của trình duyệt bị giật cục.
*   **Giải pháp khắc phục**:
    *   Loại bỏ hoàn toàn cơ chế dừng video khi đang đọc dở câu thoại cũ.
    *   Triển khai **Stutter-free Audio Pipeline**: Cho phép câu cũ phát lấn sang câu sau hoặc khoảng lặng một cách tự nhiên. Câu thoại tiếp theo sẽ tự động hoãn phát (gối đầu) thông qua sự kiện `ended` của câu cũ.
    *   Khi câu mới phát trễ, hệ thống tự động tính toán lại thời lượng thực tế còn lại của segment mới (`seg.end - video.currentTime`) để tăng tốc phát của câu mới lên, giúp nó tự động đuổi kịp video mà video hoàn toàn không phải dừng một mili-giây nào.
*   **Bài học xương máu**: Trải nghiệm thị giác của video (Smooth Playback) luôn phải được ưu tiên hàng đầu. Việc tạm dừng video chỉ được phép sử dụng làm phương án cuối cùng khi không có file âm thanh sẵn sàng từ server, tuyệt đối không được lạm dụng để đồng bộ thời lượng câu.

---

## 4. Lỗi nạp âm thanh trễ (Startup Latency) gây nuốt chữ đầu câu

*   **Hiện tượng**: Khi video bắt đầu một phân đoạn (segment) mới, hoặc sau khi người dùng bấm Resume video, chữ đầu tiên của câu thoại lồng tiếng thỉnh thoảng bị nuốt hoặc mất hẳn âm tiết đầu.
*   **Nguyên nhân**:
    *   Mặc dù lệnh `.play()` đã được gọi, trình duyệt vẫn mất từ `100ms - 250ms` để tải đệm (buffer) và giải mã âm thanh trước khi thực sự phát tiếng ra loa. Trong thời gian này, video gốc vẫn tiếp tục chạy bình thường, làm gia tăng khoảng cách thời gian (drift).
    *   Hàm kiểm tra drift liên tục chạy và nhận thấy audio đứng im ở mốc `0s` trong khi video đã chạy trước `0.2s`. Nó tính toán drift $> 0.15s$ (hoặc $> 0.4s$ nếu lag mạng nặng) và lập tức thực hiện force-seek/micro-adjust, đẩy `audio.currentTime` nhảy cóc vượt qua phần âm thanh đầu câu khi nó còn chưa kịp phát ra tiếng.
*   **Giải pháp khắc phục (Safe Sync)**:
    *   Sử dụng cờ trạng thái an toàn `isAudioReadyForSync = false`.
    *   Lắng nghe sự kiện `'playing'` của thẻ audio (sự kiện này chỉ kích hoạt khi âm thanh thực sự bắt đầu phát ra loa). Khi sự kiện này bắn ra, ta mới gán `isAudioReadyForSync = true`.
    *   Chặn toàn bộ các phép đo drift và can thiệp điều chỉnh tốc độ khi cờ này chưa được dựng:
        ```typescript
        if (!this.isAudioReadyForSync || audio.currentTime === 0) return;
        ```
*   **Bài học xương máu**: Tuyệt đối không được phép thực hiện đo đạc đồng bộ hay gán vị trí (`currentTime`) khi thiết bị phần cứng của trình duyệt chưa thực sự sẵn sàng phát tiếng (chưa kích hoạt sự kiện `playing`).

---

## 5. Lỗi nuốt chữ khi phát gối đầu (Pipeline Play)

*   **Hiện tượng**: Khi áp dụng cơ chế phát gối đầu (Pipeline), câu tiếp theo bắt đầu trễ hơn mốc start của nó một khoảng thời gian (ví dụ phát trễ 0.5s để chờ câu trước nói xong), dẫn đến việc bị nuốt chữ đầu câu của câu mới.
*   **Nguyên nhân**: Bộ đồng bộ cũ tính toán độ lệch pha dựa trên **gốc thời gian lý thuyết cố định (`seg.start`)**. Khi video đã ở `8.5s` còn segment mới bắt đầu ở `8.0s`, bộ đồng bộ tính ra drift = 0.5s và gọi force-seek gán `audio.currentTime = 0.5s` ngay lập tức, bỏ qua 0.5s đầu câu của audio mới.
*   **Giải pháp khắc phục**:
    *   Lưu lại thời điểm video thực tế bắt đầu phát audio lồng tiếng là `audioPlayVideoTime`.
    *   Tính toán drift dựa trên sự quy đổi tỷ lệ tốc độ `speedRatio` và gốc thời gian thực tế `audioPlayVideoTime`, thay vì sử dụng mốc lý thuyết `seg.start`.
*   **Bài học xương máu**: Mọi phép tính đồng bộ thời gian thực luôn phải dựa trên **thời điểm thực tế phát sinh hành động** (`audioPlayVideoTime`).

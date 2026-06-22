# LiveTube Voice Dubber V2 - Project Guardrails

## Mission

LiveTube Voice Dubber V2 tồn tại để giúp người Việt tiếp cận tri thức toàn cầu bằng tiếng mẹ đẻ mà không phải hy sinh sự tập trung.

Sản phẩm không cố trở thành công cụ lồng tiếng điện ảnh, MV, phim, vlog nghệ thuật hay giải trí cảm xúc cao.

Sản phẩm ưu tiên video học tập, công nghệ, bài giảng, tutorial, tri thức và nội dung chuyên môn.

## Persona #1

Người học công nghệ / Junior Developer / sinh viên CNTT tại Việt Nam.

Họ xem video tiếng Anh dài 15-40 phút để học, code-along, ghi chú hoặc cập nhật kiến thức.

Nỗi đau chính: phải vừa nhìn màn hình/code/slide vừa đọc phụ đề, gây mất tập trung và mỏi mắt.

## Success Criteria

Một thay đổi chỉ có giá trị nếu giúp ít nhất một trong các mục tiêu sau:

- Bật lên là nghe được.
- Tua tới đâu subtitle/audio trỏ đúng tới đó.
- Nhiều tab không làm mất tiếng.
- Người dùng học được nội dung mà không phải nhìn phụ đề liên tục.
- Dịch thuật/thuật ngữ phục vụ tốt video học tập và công nghệ.
- Hệ thống fail gracefully khi thiếu subtitle, lỗi dịch, lỗi TTS, lỗi network.

## Non-goals

Không ưu tiên:

- Cinema dubbing.
- Emotion engine cho video giải trí.
- MV / phim / vlog nghệ thuật.
- Tối ưu trải nghiệm giải trí hơn trải nghiệm học tập.
- Feature chỉ để “ngầu” nhưng không phục vụ Persona #1.

## V1 Lessons That Must Never Repeat

Không được:

- Block HTTP request để chờ TTS.
- Generate audio đúng lúc người dùng cần nghe rồi hy vọng kịp.
- Dùng trạng thái playback ở backend để kill job.
- Để preload của câu sau hủy audio của câu hiện tại.
- Thiết kế quanh bug cục bộ thay vì bài toán product tổng thể.
- Tối ưu queue/scheduler mà quên mission.

## Mandatory Review Before Any Plan or Code

Trước khi lập plan hoặc implement, agent phải trả lời ngắn gọn:

1. Task này phục vụ Mission nào?
2. Task này phục vụ Persona #1 ra sao?
3. Có vi phạm Product Strategy không?
4. Có tái tạo lỗi V1 không?
5. Có threat nào trong Architecture/Product Threat Review liên quan không?
6. Nếu có trade-off, vì sao lựa chọn này tốt hơn cho use case học tập?

Nếu chưa trả lời được, không được code.

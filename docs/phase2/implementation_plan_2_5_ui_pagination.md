# Phase 2.5d - UI Display Pagination

## 1. Purpose

Tài liệu này ghi lại quyết định tách audio segment và display page trong extension V3.

Mục tiêu là loại bỏ tình trạng phụ đề Việt bị cắt bằng `...` nhưng vẫn giữ luồng TTS mượt của Phase 2.5b/2.5c.

## 2. Business Context

Người dùng xem YouTube cần vừa nghe lồng tiếng Việt realtime vừa đọc được bản dịch đầy đủ. Sau Phase 2.5c, TTS đã bớt ngắt câu vô duyên, nhưng câu dịch dài vẫn có thể chiếm nhiều diện tích hoặc bị CSS ellipsis che mất phần cuối.

Yêu cầu mới:

- Tối đa 2 dòng hiển thị cho một trang phụ đề.
- Không dùng `...` để xén chữ.
- Không chia nhỏ backend audio segment nếu việc đó làm TTS đọc lắt nhắt.

## 3. Current Behavior

Backend vẫn trả timeline theo segment TTS như cũ. Frontend tự chia text của một segment thành nhiều display pages:

- `content.ts` chọn page hiện tại theo tiến trình thời gian của segment.
- Thời lượng mỗi page dùng weighted timing theo độ dài text, không chia đều máy móc.
- `ui.ts` đo text trong Shadow DOM với style thực tế để page vừa tối đa 2 dòng.
- DOM chỉ được cập nhật khi page hiển thị thay đổi.

## 4. Data Model / API Contract

Không đổi API.

`POST /api/sessions` vẫn trả:

- `index`
- `start`
- `end`
- `sourceText`
- `translatedText`

Không thêm field mới cho audio status, stream URL, hay display page. Display pagination là state nội bộ của extension.

## 5. Source Structure

- `extension/src/content.ts`: quản lý cache display pages, chọn page theo thời gian phát, đồng bộ bilingual mode.
- `extension/src/ui.ts`: đo text thực tế trong Shadow DOM, chia text thành pages vừa 2 dòng, hiển thị text không ellipsis.
- `src/utils/yt-dlp.ts`: vẫn chịu trách nhiệm sentence reconstruction trước dịch/TTS; không bị Phase 2.5d thay đổi.

## 6. Latest Update

Phase 2.5d thay đổi:

- Thêm `SubtitlePageBundle` cache theo segment, subtitle mode và layout signature.
- Thêm weighted page selection để page dài giữ màn hình lâu hơn page ngắn.
- Bilingual mode dùng cùng số page cho tiếng Anh và tiếng Việt để giảm lệch nội dung.
- Bỏ `line-clamp`, `text-overflow: ellipsis`, và overflow clipping khỏi subtitle text.
- Thêm đo thực tế bằng hidden measurement element trong Shadow DOM.

Tác động kỹ thuật:

- Không tăng tải server.
- Không tăng số TTS jobs.
- Không đổi DB.
- Không đổi queue/cache/runtime backend.

## 7. Historical Changelog

- Phase 2.5: thêm overlay loading, clamp phụ đề và dọn CSS display conflict.
- Phase 2.5b: harden sentence boundary bằng smart hard-cap, punctuation look-ahead và orphan merge.
- Phase 2.5c: thêm clause-boundary soft split và giảm phụ đề Việt về 2 dòng.
- Phase 2.5d: chuyển từ CSS clipping sang UI display pagination.

## 8. Edge Cases / Known Limitations

- Timing page chỉ là ước lượng theo độ dài text, không phải word-level timestamp từ TTS.
- Nếu một từ đơn quá dài vượt 2 dòng, UI vẫn phải hiển thị nguyên từ vì không được xén bằng `...`.
- Nếu player đổi kích thước/fullscreen, layout signature đổi và cache page sẽ được tính lại khi render segment.
- Bilingual sync là đồng bộ theo số page, không phải căn chỉnh song song từng cụm dịch.

## 9. Future Notes

- Không đưa display pagination xuống backend nếu không cần thiết; tầng này thuộc UI.
- Không quay lại dùng `line-clamp`/ellipsis làm giải pháp chính vì sẽ làm mất bản dịch.
- Nếu cần chính xác hơn, hướng nâng cấp nên là word-level timing từ TTS hoặc transcript alignment, không phải ép chia nhỏ audio segment.

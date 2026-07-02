# Phase 2.5b — Sentence Boundary Addendum

Nguồn bổ sung: `/Users/phamminhtri/.gemini/antigravity-ide/brain/a51526bb-e82b-4f95-a87a-947c416d0f02/implementation_plan.md`

Tài liệu này bổ sung cho `docs/implementation_plan_2_5.md`. Đây là tiến trình phụ để xử lý lỗi còn sót trong thuật toán gom câu sau khi Phase 2.5 đã cải thiện UI loading, clamp phụ đề và thêm kiểm tra fragment cơ bản.

## 1. Bối Cảnh

Phase 2.5 đã thêm `isCompleteSentenceFragment()` và giảm hard-cap gom câu từ `220 ký tự / 14s` xuống `160 ký tự / 10s`.

Test thực tế sau đó vẫn phát hiện TTS đọc ngắt câu vô duyên trong các câu dài. Ví dụ nội dung bị tách thành hai segment riêng, làm TTS nghỉ sai nhịp:

- Segment trước kết thúc bằng một mệnh đề chưa thật sự dứt ý.
- Segment sau bắt đầu bằng một cụm nối ý như "And if...".

Điểm quan trọng: lỗi xảy ra trước bước dịch. Nếu tiếng Anh bị chia sai, Google Translate nhận input sai và TTS tiếng Việt cũng đọc sai nhịp.

## 2. Nhận Định Kỹ Thuật

Plan bổ sung là hợp lý và nên thực hiện trước Phase 3. Nó không thay đổi kiến trúc V3, không đụng server streaming, không đụng FSM extension, và không vi phạm guardrails.

Hai nguyên nhân gốc còn lại là đúng:

| Vector | Vấn đề | Tác động |
|---|---|---|
| Hard-cap 160/10s | Đang ép ngắt ngay khi vượt giới hạn, kể cả khi fragment chưa hoàn chỉnh | Dễ cắt ngang câu dài tự nhiên |
| Punctuation check | Chỉ nhìn dấu câu của chunk hiện tại, không nhìn chunk tiếp theo | Dễ ngắt sai tại dấu chấm giữa một ý đang tiếp diễn |

Đề xuất 3 lớp bảo vệ là cần thiết:

1. Smart Hard-Cap: 160 ký tự / 10s là soft-cap, 250 ký tự / 15s là hard-cap tuyệt đối.
2. Context-Aware Punctuation: nhìn trước chunk tiếp theo trước khi ngắt tại dấu câu.
3. Post-Reconstruction Merge Pass: gom lại các orphan fragment quá ngắn sau khi reconstruction xong.

## 3. Quan Điểm Thực Thi

Nên xem đây là Phase 2.5b, không phải Phase 3.

Lý do:

- Bug nằm ở chất lượng input trước dịch và trước TTS.
- Nếu không sửa, các test Phase 3 về dynamic rate hoặc graceful degradation sẽ bị nhiễu do segment đã sai từ đầu.
- Thay đổi chỉ tập trung ở `src/utils/yt-dlp.ts`, phạm vi nhỏ hơn Phase 3.
- CSS clamp đã giảm rủi ro câu dài che video, nên có thể cho phép câu hoàn chỉnh dài hơn trong một số trường hợp.

## 4. Task Bổ Sung

| ID | Task | File | Done when |
|---|---|---|---|
| T42a | Đổi hard-cap hiện tại thành smart hard-cap 2 tầng | `src/utils/yt-dlp.ts` | Vượt 160 ký tự hoặc 10s chỉ ngắt nếu fragment hoàn chỉnh; ép ngắt tuyệt đối ở 250 ký tự hoặc 15s |
| T42b | Thêm context-aware punctuation look-ahead | `src/utils/yt-dlp.ts` | Dấu câu không tự động ngắt nếu chunk tiếp theo bắt đầu bằng từ nối ý |
| T42c | Sửa `reconstructSentences()` dùng look-ahead khi xét dấu câu | `src/utils/yt-dlp.ts` | Không còn chỉ dùng `text.endsWith()` trên chunk hiện tại |
| T42d | Thêm post-pass merge orphan fragments | `src/utils/yt-dlp.ts` | Fragment dưới 5 từ, không có dấu câu, gap nhỏ được gom vào câu liền kề |
| T42e | Đánh lại index sau merge pass | `src/utils/yt-dlp.ts` | Output segment có index liên tục sau khi merge |

## 5. Guardrails Riêng Cho Phase 2.5b

- Không sửa `src/server.ts`.
- Không sửa runtime streaming queue/cache.
- Không thêm state mới vào extension FSM.
- Không bỏ CSS clamp 3 dòng đã thêm ở Phase 2.5.
- Không nâng hard-cap vô hạn; phải có giới hạn tuyệt đối để tránh câu quá dài.
- Danh sách continuation/incomplete endings chỉ xử lý tiếng Anh vì reconstruction chạy trước dịch.

## 6. Rủi Ro Và Cách Kiểm Soát

| Rủi ro | Cách kiểm soát |
|---|---|
| Câu dài hơn làm subtitle dài | CSS clamp Phase 2.5 đã giới hạn hiển thị |
| Look-ahead gom nhầm câu bắt đầu bằng "And" nhưng thật ra là câu mới | Hard-cap tuyệt đối 250 ký tự / 15s vẫn bảo vệ |
| Merge orphan gom nhầm fragment | Chỉ merge khi fragment rất ngắn, không có dấu câu và gap nhỏ |
| Tăng số lượng logic trong parser | Chi phí O(n), chạy một lần khi tạo session, không ảnh hưởng realtime playback |

## 7. Verification Đề Xuất

Kiểm tra kỹ thuật:

- Type-check riêng `src/utils/yt-dlp.ts`.
- Extension build vẫn pass vì UI clamp/loading không bị ảnh hưởng.
- Không cần full backend build nếu legacy V2 files còn nằm trong `tsconfig`.

Kiểm tra sản phẩm:

- Xóa `livetube_v3.db*` để test cold cache.
- Test lại video đã từng bị lỗi ngắt câu.
- Kỳ vọng không còn segment mồ côi kiểu "And if..." hoặc cụm quá ngắn bị đọc riêng.
- Chấp nhận câu dịch dài hơn, miễn phụ đề vẫn bị clamp tối đa 3 dòng.

## 8. Quan Hệ Với Roadmap Gốc

Roadmap gốc vẫn giữ nguyên:

- Phase 0-1: backend/runtime/server V3 đã hoàn thành.
- Phase 2: extension FSM/player V3 đã hoàn thành.
- Phase 2.5: bugfix UI loading, subtitle clamp, sentence boundary cơ bản.
- Phase 2.5b: bổ sung hardening cho sentence reconstruction.
- Sau Phase 2.5b mới quay lại Phase 3: dynamic rate, graceful degradation, UI feedback nâng cao.

Kết luận: nên thực hiện Phase 2.5b trước khi tiếp tục Phase 3.

## 9. Phase 2.5c — Clause Boundary Và Clamp 2 Dòng

Nguồn bổ sung mới vẫn đến từ file phân tích ngoài repo:
`/Users/phamminhtri/.gemini/antigravity-ide/brain/a51526bb-e82b-4f95-a87a-947c416d0f02/implementation_plan.md`

Sau test thực tế, lỗi "ngắt câu vô duyên" đã cải thiện rõ, nhưng phụ đề Việt vẫn có lúc chiếm quá nhiều diện tích màn hình. Cần phân biệt rõ hai vấn đề:

- Giảm CSS xuống 2 dòng không làm tăng tải server, nhưng nếu làm một mình sẽ tăng khả năng mất nội dung hiển thị do `...`.
- Giải pháp chính phải nằm ở thuật toán chia segment, để mỗi segment ngắn hơn nhưng vẫn là một mệnh đề tự nhiên.
- CSS clamp 2 dòng chỉ là mạng an toàn cuối cùng, không phải cách xử lý chính.

### Nhận định phản biện

Tăng số segment không tạo nghẽn đáng kể cho server V3 vì:

- Translate vẫn chạy batch theo session, không gọi từng câu riêng lẻ.
- TTS queue đã có giới hạn concurrency, nên không bắn vô hạn process song song.
- Tổng lượng audio cần sinh gần như không đổi; segment nhỏ hơn thì mỗi job ngắn hơn.
- Cache RAM tăng số entry nhưng tổng dung lượng audio gần tương đương.
- SQLite chỉ tăng số row ở bảng `segments`, vẫn nằm rất thấp so với ngưỡng tải thực tế.

Rủi ro thật sự là cắt sai timing nếu cắt theo vị trí ký tự trong một chunk VTT. Vì vậy Phase 2.5c chỉ cho phép split tại biên giữa hai chunks, khi chunk hiện tại kết thúc bằng dấu phẩy/chấm phẩy và chunk kế tiếp bắt đầu bằng từ nối mệnh đề rõ ràng.

### Task bổ sung

| ID | Task | File | Done when |
|---|---|---|---|
| T48a | Giảm soft-cap hiển thị xuống 90 ký tự | `src/utils/yt-dlp.ts` | Vượt 90 ký tự sẽ tìm ranh giới mệnh đề trước khi quyết định flush |
| T48b | Thêm clause-boundary detection tại biên chunk | `src/utils/yt-dlp.ts` | Chỉ split khi chunk hiện tại kết thúc bằng `,` hoặc `;` và chunk sau bắt đầu bằng clause starter |
| T48c | Giữ hard-cap tuyệt đối 250 ký tự / 15s | `src/utils/yt-dlp.ts` | Không gom câu vô hạn khi không tìm được ranh giới tốt |
| T48d | Giữ các lớp bảo vệ Phase 2.5b | `src/utils/yt-dlp.ts` | `shouldSplitOnPunctuation()` và `mergeOrphanFragments()` vẫn hoạt động |
| T48e | Giảm phụ đề Việt xuống tối đa 2 dòng | `extension/src/ui.ts` | `.sub-vi` dùng `-webkit-line-clamp: 2` |

### Guardrails

- Không sửa `src/server.ts`.
- Không sửa runtime queue/cache.
- Không thêm state mới vào extension FSM.
- Không cắt text trong một chunk VTT theo vị trí ký tự vì timing sẽ thiếu căn cứ.
- Không dùng CSS `...` như giải pháp chính; đây chỉ là fallback hiển thị.
- Danh sách clause/incomplete starters vẫn chỉ áp dụng tiếng Anh vì reconstruction chạy trước dịch.

Kết luận: Phase 2.5c là bước hardening chất lượng hiển thị và chia mệnh đề, vẫn nằm trước Phase 3 và không thay đổi kiến trúc V3.

# Phase 2.5 — Đánh Bóng & Fix Bug (Pre-Phase 3)

Dựa trên báo cáo kiểm thử E2E của Phase 0–2, tài liệu này phân tích nguyên nhân gốc rễ (Root Cause) cho 3 bug được phát hiện và đề xuất kế hoạch sửa chữa cụ thể để giao cho team code.

---

## Bug 1: Phụ đề dài che mất video

### Triệu chứng
Một số câu dịch tiếng Việt quá dài, chiếm diện tích rất lớn trên khung hiển thị video, cần giới hạn tối đa 3 dòng.

### Root Cause Analysis

**File gốc:** [ui.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/ui.ts#L226-L255)

CSS class `.sub-vi` (dòng 248-255) hiện tại chỉ định kiểu chữ nhưng **không có bất kỳ giới hạn nào** về số dòng hiển thị:

```css
.sub-vi {
  font-size: calc(16px + 0.7vw);
  color: #facc15;
  font-weight: bold;
  /* THIẾU: max-height, line-clamp, overflow */
}
```

Tương tự, container `#livetube-sub-overlay` (dòng 227-237) cũng không có giới hạn chiều cao.

Nguyên nhân phụ đằng sau: Thuật toán `reconstructSentences()` trong [yt-dlp.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/yt-dlp.ts#L193-L244) cho phép gom câu lên tới **220 ký tự tiếng Anh** hoặc **14 giây timeline**. Sau khi dịch sang tiếng Việt, bản dịch có thể dài hơn bản gốc 20-40%, dẫn tới câu hiển thị vượt quá 3 dòng trên màn hình.

### Đề xuất giải pháp

1. **CSS clamp 3 dòng** cho `.sub-vi` và `.sub-en`:
```css
.sub-vi {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-height: calc((16px + 0.7vw) * 1.4 * 3); /* line-height * 3 dòng */
}
```

2. **Giảm ngưỡng gom câu** trong `reconstructSentences()` từ `220` ký tự xuống khoảng `160` ký tự, và từ `14s` xuống `10s`, để câu gốc tiếng Anh ngắn hơn → bản dịch Việt cũng ngắn hơn.

### Phản biện rủi ro

- **Rủi ro giảm ngưỡng gom câu:** Nếu giảm quá mạnh (ví dụ xuống 80 ký tự), sẽ tạo ra quá nhiều segment nhỏ vụn → TTS phải sinh nhiều file audio ngắn hơn → tăng áp lực queue → có thể gây delay. **Khuyến nghị:** Giảm từ từ (220→160), test lại, chưa cần giảm sâu hơn.
- **Rủi ro CSS clamp:** `-webkit-line-clamp` sẽ cắt ngang câu nếu quá dài. Người dùng có thể mất nội dung cuối câu. **Chấp nhận được** vì đây là phụ đề hỗ trợ, không phải nội dung chính. Và audio đọc vẫn đầy đủ toàn bộ câu.

---

## Bug 2: TTS đọc bị ngắt quãng vô duyên do chia câu sai

### Triệu chứng
Subtitle bị chia thành 2 đoạn: "chúng tôi là những kỹ" và "sư AI" → TTS đọc thành 2 câu rời rạc thay vì đọc liền mạch "chúng tôi là những kỹ sư AI".

### Root Cause Analysis

**File gốc:** [yt-dlp.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/src/utils/yt-dlp.ts#L193-L244) — hàm `reconstructSentences()`

Thuật toán hiện tại quyết định **ngắt câu** dựa trên 2 tiêu chí:

1. **Khoảng lặng giữa 2 chunk ≥ 1.0 giây** (dòng 201-202):
```typescript
const gap = chunk.start - currentGroup[currentGroup.length - 1].end;
if (gap >= 1.0) { /* ngắt câu */ }
```

2. **Dấu chấm câu kết thúc** `.` `?` `!` (dòng 216-217)

**Vấn đề cốt lõi:** Tiêu chí gap ≥ 1.0s quá ngây thơ. YouTube auto-caption thường tạo ra các chunk rất ngắn (1-3 từ) với gap nhỏ, nhưng **sau bước `deduplicateAutoCaptions()`**, timing có thể bị dồn lại tạo ra gap giả > 1s ngay giữa một cụm từ chưa hoàn chỉnh.

**Quan trọng hơn:** Thuật toán hoàn toàn không kiểm tra **ngữ pháp/ngữ nghĩa** của chuỗi text khi quyết định ngắt. Nó chỉ nhìn vào thời gian (gap) và dấu câu cuối cùng. Kết quả: "chúng tôi là những kỹ" bị tách ra dù đây rõ ràng là một cụm từ chưa hoàn chỉnh.

### Đề xuất giải pháp: Thuật toán "Sentence Boundary Detection" cải tiến

Thêm một hàm kiểm tra **"câu có kết thúc hợp lệ hay không"** trước khi cho phép ngắt:

```typescript
function isCompleteSentenceFragment(text: string): boolean {
  const trimmed = text.trim();
  
  // Luôn cho phép ngắt nếu kết thúc bằng dấu chấm câu
  if (/[.!?]["']?$/.test(trimmed)) return true;
  
  // Từ cuối cùng của đoạn text
  const lastWord = trimmed.split(/\s+/).pop()?.toLowerCase() || '';
  
  // Danh sách các từ KHÔNG BAO GIỜ được kết thúc câu (tiếng Anh)
  // Đây là các determiners, prepositions, conjunctions, articles
  const INCOMPLETE_ENDINGS = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
    'by', 'from', 'and', 'or', 'but', 'nor', 'so', 'yet',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'has', 'have', 'had', 'do', 'does', 'did',
    'will', 'would', 'could', 'should', 'might', 'may', 'can',
    'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her',
    'its', 'our', 'their', 'some', 'any', 'no', 'every',
    'not', 'very', 'really', 'just', 'also', 'more', 'most',
    'who', 'which', 'where', 'when', 'how', 'what', 'why',
    'if', 'then', 'than', 'as',
  ]);
  
  // Nếu từ cuối nằm trong danh sách "không hoàn chỉnh" → KHÔNG cho ngắt
  if (INCOMPLETE_ENDINGS.has(lastWord)) return false;
  
  // Kiểm tra thêm: nếu độ dài < 20 ký tự thì khả năng là fragment
  if (trimmed.length < 20 && !(/[.!?]$/.test(trimmed))) return false;
  
  return true;
}
```

Sau đó, sửa logic ngắt câu trong `reconstructSentences()`:

```typescript
// Thay vì ngắt ngay khi gap >= 1.0s:
if (gap >= 1.0) {
  const accumulatedText = currentGroup.map(c => c.text).join(' ');
  if (isCompleteSentenceFragment(accumulatedText) || gap >= 3.0) {
    // Chỉ ngắt nếu câu có vẻ hoàn chỉnh, HOẶC gap quá lớn (> 3s)
    flush();
  }
  // Nếu không → tiếp tục gom vào group hiện tại
}
```

### Phản biện rủi ro

- **Rủi ro false negative:** Danh sách `INCOMPLETE_ENDINGS` không thể bao phủ 100% tiếng Anh. Một số edge case sẽ vẫn bị ngắt sai. **Giải pháp:** Sử dụng gap >= 3.0s làm ngưỡng "force-break" để tránh gom vô hạn.
- **Rủi ro câu quá dài:** Nếu thuật toán liên tục từ chối ngắt (vì `isCompleteSentenceFragment` trả `false`), câu sẽ dài mãi. **Giải pháp:** Giữ nguyên giới hạn hard-cap 160 ký tự / 10s từ Bug 1 để ép ngắt khi cần.
- **Rủi ro sau khi dịch:** Vấn đề ngắt câu này xảy ra **trước** khi dịch (ở tầng tiếng Anh). Sau khi gom câu đúng, bản dịch tiếng Việt sẽ tự nhiên mạch lạc hơn vì Google Translate nhận được câu hoàn chỉnh thay vì đoạn rời rạc.

---

## Bug 3: UI Loading thiếu chuyên nghiệp & Rủi ro vi phạm nguyên tắc "không pause"

### Triệu chứng
- Text trạng thái hệ thống ("Đang tải giọng đọc...", "Đang chuẩn bị phụ đề dịch...") bị nhét vào khung Subtitle, làm rác màn hình.
- Người dùng yêu cầu Loading Overlay chuyên nghiệp với spinner.
- **Lo ngại quan trọng:** Việc pause video trong Cold Start có thể vi phạm nguyên tắc V3 "không pause mỗi câu".

### Root Cause Analysis

**File gốc — Content Script:** [content.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/content.ts#L160-L207) — hàm `enableDubbing()`

Các dòng gây ra hiện tượng "rác subtitle":
- **Dòng 170:** `this.ui.updateSubtitles('vi', null, 'Đang chuẩn bị phụ đề dịch...');` — Nhét text trạng thái vào subtitle khi INITIALIZING
- **Dòng 184:** `this.ui.updateSubtitles('vi', null, 'Đang chuẩn bị giọng đọc...');` — Nhét text trạng thái vào subtitle khi BUFFERING
- **Dòng 396:** `this.ui.updateSubtitles(this.config.subMode, anchor.sourceText, 'Đang tải giọng đọc... ${anchor.translatedText}');` — Nhét text trạng thái vào subtitle khi SEEK_BUFFERING
- **Dòng 460:** `renderCurrentSubtitles()` cũng thêm prefix "Đang tải giọng đọc..." vào subtitle

**File gốc — UI Manager:** [ui.ts](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/ui.ts)

UI Manager hiện tại **không có phương thức nào** để hiển thị Loading Overlay. Nó chỉ có:
- `updateSubtitles()` — hiển thị phụ đề
- `updateStatusBadge()` — cập nhật badge nhỏ trên popover
- `updateVisualizer()` — bật/tắt thanh sóng nhạc

### Phân tích về việc pause video trong Cold Start

> [!IMPORTANT]
> **Đây là điểm cần xuy xét kỹ nhất trong toàn bộ báo cáo.**

Nguyên tắc V3: **"Không gọi `video.pause()` mỗi câu thoại"**. Nhưng nguyên tắc này **KHÔNG cấm** pause trong 2 tình huống cụ thể đã được thiết kế từ đầu:

1. **Initial Buffering (Cold Start):** Pause **1 lần duy nhất** khi người dùng vừa bật Dubbing, chờ server tải sub + dịch + sinh TTS cho câu đầu tiên. Đây là thiết kế có chủ đích, đã được ghi rõ trong [v3_implementation_tasks.md](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/docs/v3_implementation_tasks.md#L141) (Task T21) và [implementation_plan](file:///Users/phamminhtri/.gemini/antigravity-ide/brain/a51526bb-e82b-4f95-a87a-947c416d0f02/walkthrough.md).

2. **Seek Buffering:** Pause tối đa 8 giây khi user tua xa, chờ TTS sinh audio cho vị trí mới (Task T24).

**Kết luận:** Việc pause trong Cold Start **KHÔNG vi phạm** nguyên tắc V3. Nguyên tắc cấm là **pause MỖI câu thoại** (kiểu V2 Smart Pause), không cấm pause 1 lần duy nhất lúc khởi tạo. Code hiện tại ở [content.ts dòng 186-188](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/content.ts#L186-L188) đã implement đúng: chỉ pause khi state là `BUFFERING` (1 lần), và FSM guard ở [dòng 333](file:///Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber_v2/extension/src/content.ts#L333) đảm bảo `onTimeUpdate` không chạy trong các state `INITIALIZING/BUFFERING/SEEK_BUFFERING`.

> [!WARNING]
> **Tuy nhiên**, cần đảm bảo rằng Loading Overlay mới **LUÔN có timeout tự giải phóng** (ví dụ: tối đa 15s cho Initial, 8s cho Seek). Nếu server treo hoặc TTS fail, overlay phải tự biến mất và video phải resume bất kể kết quả. Đây là điều kiện tiên quyết để không biến cơ chế pause hợp lệ thành bug vô hạn.

### Đề xuất giải pháp

1. **Tạo phương thức mới trong `GhostInterfaceManager`:**
   - `showLoadingOverlay(message?: string)` — Hiển thị overlay tối bán trong suốt + spinner xoay vòng + text trạng thái nhỏ ở giữa màn hình video.
   - `hideLoadingOverlay()` — Ẩn overlay.

2. **Sửa `enableDubbing()` và `handleSeekBuffering()`:**
   - Thay tất cả các lệnh `this.ui.updateSubtitles('vi', null, 'Đang...')` bằng `this.ui.showLoadingOverlay('Đang chuẩn bị...')`.
   - Khi chuyển sang state `PLAYING`, gọi `this.ui.hideLoadingOverlay()`.

3. **Đảm bảo timeout an toàn:** Loading overlay phải tự hide sau timeout (đã có sẵn `INITIAL_BUFFER_TIMEOUT_MS = 10_000` và `SEEK_BUFFER_TIMEOUT_MS = 8_000`).

---

## Kế hoạch Task Phase 2.5

| ID | Task | Files | Depends | Done when |
|---|---|---|---|---|
| T40 | CSS clamp subtitle tối đa 3 dòng cho `.sub-vi` và `.sub-en` | `extension/src/ui.ts` | - | Câu dài bị cắt gọn, không che quá 3 dòng trên video |
| T41 | Giảm ngưỡng gom câu từ 220→160 ký tự và 14s→10s | `src/utils/yt-dlp.ts` | - | Segment gốc tiếng Anh ngắn hơn, dịch Việt gọn hơn |
| T42 | Implement `isCompleteSentenceFragment()` kiểm tra ngữ pháp trước khi ngắt | `src/utils/yt-dlp.ts` | T41 | Chuỗi kết thúc bằng "the", "a", "is", "những", v.v. không bị ngắt câu |
| T43 | Cập nhật `reconstructSentences()` dùng kiểm tra ngữ pháp kết hợp gap | `src/utils/yt-dlp.ts` | T42 | Câu như "chúng tôi là những kỹ sư AI" được gom liền thay vì tách rời |
| T44 | Tạo Loading Overlay trong `GhostInterfaceManager` (`showLoadingOverlay` / `hideLoadingOverlay`) | `extension/src/ui.ts` | - | Overlay tối bán trong suốt + spinner xoay giữa video |
| T45 | Thay thế tất cả `updateSubtitles()` status text bằng `showLoadingOverlay()` trong FSM | `extension/src/content.ts` | T44 | Không còn text trạng thái hệ thống trong khung Subtitle |
| T46 | Đảm bảo `hideLoadingOverlay()` luôn được gọi khi chuyển sang PLAYING hoặc khi timeout/error | `extension/src/content.ts` | T44, T45 | Overlay luôn biến mất, video luôn resume, không bao giờ bị treo vô hạn |
| T47 | Cập nhật version label trong popover từ "V2" → "V3" | `extension/src/ui.ts` | - | Popover header ghi "LiveTube Dubber V3", footer ghi "Version 3.0" |

### Thứ tự thực hiện đề xuất

```
Nhóm 1 (độc lập, làm song song):
  T40 — CSS clamp subtitle
  T41 + T42 + T43 — Thuật toán gom câu
  T44 — Loading Overlay UI component

Nhóm 2 (phụ thuộc nhóm 1):
  T45 + T46 — Tích hợp overlay vào FSM

Nhóm 3 (cleanup):
  T47 — Version label
```

### Verification Plan

```bash
# Build kiểm tra
npm run build
(cd extension && npm run build)

# Test Cold Start
rm livetube_v3.db livetube_v3.db-shm livetube_v3.db-wal
bun run dev
# → Bật dubbing → Thấy spinner overlay → Video pause → Server xong → Overlay ẩn → Video play + dubbing

# Test câu dài
# → Tìm video có phụ đề dài → Phụ đề Việt tối đa 3 dòng, không che hết video

# Test gom câu
# → Tìm video có auto-caption → Không thấy TTS đọc rách câu giữa chừng

# Test Seek
# → Tua xa → Thấy spinner overlay → Tối đa 8s → Overlay ẩn → Dubbing tiếp tục
```

### Guardrails Phase 2.5

- **KHÔNG** thêm state mới vào FSM. Overlay là component UI thuần túy, FSM vẫn giữ 5 state hiện tại.
- **KHÔNG** thay đổi logic pause/resume hiện tại. Chỉ thay đổi cách **hiển thị** trạng thái chờ.
- **KHÔNG** sửa backend server.ts hoặc các module runtime. Phase 2.5 chỉ sửa UI và thuật toán gom câu.
- Loading Overlay **BẮT BUỘC** phải có timeout tự giải phóng.

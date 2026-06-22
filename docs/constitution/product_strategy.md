# LiveTube Voice Dubber V2 - Product Strategy & Persona Definition

> [!NOTE]
> **Tuyên ngôn sứ mệnh của sản phẩm:**
> 
> *"LiveTube Voice Dubber tồn tại để giúp người Việt tiếp cận tri thức toàn cầu bằng tiếng mẹ đẻ mà không phải hy sinh sự tập trung.*
> 
> *Chúng tôi không cố gắng thay thế giọng nói gốc.*
> 
> *Chúng tôi giúp người dùng tiếp thu nội dung học tập, công nghệ và chuyên môn bằng tai thay vì bằng mắt."*

Tài liệu này định vị rõ đối tượng mục tiêu, Persona số 1, Use case số 1 và chiến lược giữ chân người dùng (Retention Loop) của sản phẩm LiveTube Voice Dubber V2. Thiết kế kỹ thuật và sản phẩm phải xoay quanh trục giá trị cốt lõi này để tránh lãng phí tài nguyên và đạt Product-Market Fit.

---

## 1. Chúng ta đang xây sản phẩm cho ai?

Sản phẩm này được xây dựng dành cho:
**Người Việt Nam có nhu cầu học tập, tiếp thu tri thức, tin tức công nghệ và khoa học từ các nguồn quốc tế (chủ yếu là tiếng Anh trên YouTube) nhưng gặp rào cản ngôn ngữ, hoặc cảm thấy mệt mỏi, mỏi mắt khi phải liên tục đọc phụ đề dịch.**

* **Họ KHÔNG PHẢI LÀ**: Người xem phim điện ảnh giải trí, MV ca nhạc hay Vlog nghệ thuật. (AI lồng tiếng hiện tại chưa đủ sức truyền tải cảm xúc nghệ thuật và việc đè giọng AI sẽ phá hỏng hoàn toàn trải nghiệm của các thể loại này).
* **Họ CHÍNH LÀ**: Học sinh, sinh viên, lập trình viên, nhà nghiên cứu, hoặc người đi làm muốn xem video **để lấy thông tin, học hỏi kỹ năng và cập nhật kiến thức.**

---

## 2. Persona số 1 (Chân dung khách hàng cốt lõi)

* **Tên đại diện**: Nam (24 tuổi)
* **Nghề nghiệp**: Lập trình viên trẻ (Junior Developer) hoặc sinh viên ngành Công nghệ thông tin / Kinh tế tại Việt Nam.
* **Hành vi**:
  - Thường xuyên xem các video hướng dẫn (tutorials), bài giảng công nghệ (freeCodeCamp, MIT OpenCourseWare), review sản phẩm công nghệ hoặc tin tức tài chính trên YouTube từ 1 đến 2 tiếng mỗi tối.
  - Kỹ năng tiếng Anh ở mức cơ bản (đọc hiểu tài liệu viết tốt, nhưng nghe người bản xứ nói nhanh hoặc nói accent Ấn Độ, Anh-Anh thì không kịp).
* **Pain Point (Nỗi đau lớn nhất)**:
  - Khi xem video hướng dẫn dài 30 phút, Nam phải **phân tán sự tập trung cực kỳ mệt mỏi**: vừa phải nhìn slide/dòng code trên màn hình, vừa phải liếc mắt xuống đáy màn hình để đọc phụ đề dịch tiếng Việt. 
  - Nếu Nam rời mắt khỏi phụ đề 2 giây để gõ code thực hành (code-along) trong IDE (VS Code) bên cạnh, anh ấy lập tức mất dấu nội dung người giảng đang nói.

---

## 3. Use Case số 1 (Tình huống sử dụng cốt lõi)

**"Xem và thực hành theo video hướng dẫn công nghệ / bài giảng chuyên ngành dài từ 15 đến 40 phút trên YouTube bằng tiếng Việt."**

* **Luồng trải nghiệm**:
  1. Nam mở một video hướng dẫn xây dựng ứng dụng React dài 30 phút của freeCodeCamp trên YouTube.
  2. Nam click vào nút Headphones của Extension để bật lồng tiếng Việt, chọn giọng đọc nam (Nam Minh).
  3. Extension lập tức tải phụ đề, dịch batch toàn bộ và bắt đầu phát giọng đọc tiếng Việt lồng tiếng mượt mà, đồng thời tự động giảm âm lượng giọng gốc xuống 30% (Voice-Over).
  4. Nam mở VS Code ở nửa màn hình bên cạnh và bắt đầu gõ code theo video.
  5. Anh ấy vừa nhìn màn hình code của mình, tay gõ phím, tai nghe giảng giải bằng tiếng Việt một cách tự nhiên mà không cần phải liếc nhìn phụ đề dịch ở dưới video.
  6. Khi cần tua lại (seek) để xem lại đoạn giải thích khó, hệ thống phản hồi ngay lập tức và phát tiếp tiếng Việt từ điểm tua mà không bị gián đoạn.

---

## 4. Điều gì khiến họ mở extension lần thứ 2? (The Hook / Day-2 Retention)

**Sự giải phóng đôi mắt (Eye Liberation) và trải nghiệm đa nhiệm (Multi-tasking) mượt mà ngay lập tức.**

* Trong lần đầu sử dụng, Nam Nam trải nghiệm cảm giác **"rảnh mắt, rảnh tay"**: Anh ấy có thể vừa rửa bát, vừa gõ code, hoặc vừa ghi chép sổ tay mà vẫn tiếp thu trọn vẹn 100% kiến thức của video tiếng Anh nước ngoài thông qua giọng nói tiếng Việt lồng cabin.
* Khi Nam nhận ra hiệu suất học tập của mình tăng lên rõ rệt, không còn bị mỏi mắt hay căng thẳng thần kinh sau khi xem clip dài, Nam sẽ tự động click vào extension lần thứ 2 ngay khi mở một video tiếng Anh tiếp theo.

---

## 5. Điều gì khiến họ tiếp tục dùng sau 30 ngày? (Habit Loop / Day-30 Retention)

Sau 30 ngày, sản phẩm phải chuyển hóa từ một "tiện ích thú vị" thành một **"thói quen tiếp thu tri thức không thể thiếu"** dựa trên 3 giá trị:

1. **Sự tin cậy tuyệt đối về thuật ngữ (Domain Glossary Trust)**:
   Nam nhận ra bản dịch của extension cực kỳ thông minh. Các thuật ngữ công nghệ (như API endpoint, state management, render) được giữ nguyên hoặc dịch chuẩn xác theo văn phong CNTT thay vì dịch ngô nghê. Nam tin tưởng hoàn toàn vào kiến thức chuyên môn mà giọng đọc truyền tải.
2. **Sự thoải mái về thính giác (Audio Comfort - No Fatigue)**:
   Giọng đọc AI có nhịp thở tự nhiên, tốc độ nói tự động co giãn thông minh theo timeline, âm lượng video gốc được vuốt nhỏ mượt mà (fade) giúp Nam nghe liên tục 1-2 tiếng mỗi ngày mà không bị mỏi tai, nhức đầu hay giật mình.
3. **Phá vỡ rào cản tâm lý tiếp cận tri thức nước ngoài (Mindset Change)**:
   Trước đây, Nam thường lướt qua hoặc ngại click vào các video tiếng Anh dài >20 phút vì ngại đọc sub mỏi mắt. Sau 30 ngày dùng extension, Nam tự tin click vào bất kỳ video công nghệ nước ngoài nào vì biết mình chỉ cần bật lồng tiếng lên là có thể nghe hiểu như tiếng mẹ đẻ. Ranh giới ngôn ngữ bị xóa bỏ hoàn toàn.

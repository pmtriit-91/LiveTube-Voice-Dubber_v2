import db, { statements, insertSegmentsTransaction } from './db';
import { downloadSubtitles, parseVtt, reconstructSentences } from './utils/yt-dlp';
import { translateBatch } from './utils/translator';
import { queueManager } from './queue';
import fs from 'fs';
import path from 'path';

const TEST_SESSION_ID = 'test_session_uuid_123456';
const TEST_URL = 'mock_test_url'; // Sẽ kích hoạt mock subtitle generator trong yt-dlp.ts

async function runIntegrationTest() {
  console.log('====================================================');
  console.log('🧪 BẮT ĐẦU CHẠY INTEGRATION TEST CHO BACKEND V2');
  console.log('====================================================');

  try {
    // 1. Tạo session
    console.log('\n[Test 1] Tạo Session test trong DB...');
    const now = Date.now();
    statements.insertSession.run(
      TEST_SESSION_ID,
      'mock_video_id',
      TEST_URL,
      'vi',
      'vi-VN-NamMinhNeural',
      '+0%',
      '+0%',
      'INIT',
      now,
      now
    );
    const session = statements.getSession.get(TEST_SESSION_ID) as any;
    if (session && session.id === TEST_SESSION_ID) {
      console.log('✅ Session tạo thành công trong DB.');
    } else {
      throw new Error('Không thể tạo Session trong DB.');
    }

    // 2. Ingestion & Parse Subtitle
    console.log('\n[Test 2] Tải và phân tích phụ đề (Ingestion & Parse)...');
    const vttPath = await downloadSubtitles(TEST_SESSION_ID, TEST_URL);
    console.log(`- File VTT được lưu tại: ${vttPath}`);
    
    const rawChunks = parseVtt(vttPath);
    console.log(`- Parse được ${rawChunks.length} raw chunks.`);

    const reconstructed = reconstructSentences(rawChunks);
    console.log(`- Gom cụm được ${reconstructed.length} câu thoại semantic.`);
    
    if (reconstructed.length > 0) {
      console.log(`  + Câu 1: [${reconstructed[0].start}s -> ${reconstructed[0].end}s] "${reconstructed[0].sourceText}"`);
      console.log('✅ Ingestion & Reconstruct thành công.');
    } else {
      throw new Error('Reconstruct trả về danh sách rỗng.');
    }

    // Ghi segments thô vào DB
    insertSegmentsTransaction(TEST_SESSION_ID, reconstructed);

    // 3. Dịch thuật Batch & Glossary
    console.log('\n[Test 3] Chạy dịch thuật Batch có Glossary IT...');
    const sourceTexts = reconstructed.map(s => s.sourceText);
    const translatedTexts = await translateBatch(sourceTexts);

    console.log(`- Kết quả dịch batch:`);
    for (let i = 0; i < reconstructed.length; i++) {
      console.log(`  + Câu ${i+1} dịch: "${sourceTexts[i]}" -> "${translatedTexts[i]}"`);
      
      // Update text dịch vào DB
      db.prepare('UPDATE segments SET translated_text = ? WHERE session_id = ? AND segment_index = ?')
        .run(translatedTexts[i], TEST_SESSION_ID, reconstructed[i].index);
    }
    console.log('✅ Dịch thuật batch & Glossary thành công.');

    // 4. Sinh TTS qua Queue (Fair Scheduler & WebSocket Client)
    console.log('\n[Test 4] Đẩy jobs sinh TTS qua hàng đợi WebSocket...');
    
    // Đẩy job khẩn cấp câu 1 (Priority 1)
    queueManager.addJob(TEST_SESSION_ID, 1, 1);
    
    // Đẩy job tải trước câu 2 (Priority 2)
    queueManager.addJob(TEST_SESSION_ID, 2, 2);

    console.log('- Đang chờ 5 giây để workers hoàn tất sinh audio...');
    await new Promise(r => setTimeout(r, 5000));

    // 5. Kiểm tra kết quả trên đĩa cứng
    console.log('\n[Test 5] Kiểm tra file audio được sinh ra trên disk...');
    const segment1 = statements.getSegment.get(TEST_SESSION_ID, 1) as any;
    const segment2 = statements.getSegment.get(TEST_SESSION_ID, 2) as any;

    if (segment1 && segment1.audio_status === 'READY' && segment1.audio_path) {
      console.log(`✅ File Audio câu 1 READY tại: ${segment1.audio_path}`);
      console.log(`- Kích thước file: ${fs.statSync(segment1.audio_path).size} bytes.`);
    } else {
      throw new Error(`Sinh TTS câu 1 thất bại. Trạng thái hiện tại: ${segment1?.audio_status}`);
    }

    if (segment2 && segment2.audio_status === 'READY' && segment2.audio_path) {
      console.log(`✅ File Audio câu 2 (Preload) READY tại: ${segment2.audio_path}`);
    } else {
      throw new Error(`Sinh TTS câu 2 thất bại. Trạng thái hiện tại: ${segment2?.audio_status}`);
    }

    console.log('\n====================================================');
    console.log('🎉 TẤT CẢ CÁC BÀI TEST CHẠY THÀNH CÔNG RỰC RỠ!');
    console.log('====================================================');

  } catch (error) {
    console.error('\n❌ TEST THẤT BẠI VỚI LỖI:', error);
  } finally {
    // Dọn dẹp session test khỏi DB để tránh rác
    console.log('\n[Cleanup] Xóa session test khỏi DB...');
    statements.deleteSession.run(TEST_SESSION_ID);
    
    // Dọn dẹp file sub tạm của session test
    const tempSub = path.join(process.cwd(), 'subtitles', `caption_temp_${TEST_SESSION_ID}.en.vtt`);
    if (fs.existsSync(tempSub)) {
      fs.unlinkSync(tempSub);
    }
    console.log('- Dọn dẹp xong. Đóng kết nối DB và thoát.');
    db.close();
    process.exit(0);
  }
}

runIntegrationTest();

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import db, { statements, insertSegmentsTransaction } from './db';
import { downloadSubtitles, parseVtt, reconstructSentences } from './utils/yt-dlp';
import { translateBatch } from './utils/translator';
import { queueManager } from './queue';
import { generateCacheKey, getCacheFilePath } from './utils/tts';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 8765;
const CACHE_DIR = path.join(process.cwd(), 'audio', 'cache');
const MAX_CACHE_SIZE_MB = 1000; // Giới hạn 1GB cache

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Phục vụ file audio tĩnh tĩnh từ thư mục cache (Non-blocking)
app.use('/audio/cache', express.static(CACHE_DIR));

/**
 * Trích xuất video ID từ URL YouTube
 */
function extractVideoId(url: string): string {
  if (url.includes('mock_test')) return 'mock_video_id';
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : 'unknown_video';
}

/**
 * Thu hồi bộ nhớ cache theo thuật toán LRU (Least Recently Used)
 */
function performCacheEviction() {
  console.log('[Cache] Đang thực hiện kiểm tra dung lượng cache ổ đĩa (LRU)...');
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    const fileStats = [];

    for (const file of files) {
      if (file.endsWith('.mp3')) {
        const filePath = path.join(CACHE_DIR, file);
        const stat = fs.statSync(filePath);
        totalSize += stat.size;
        fileStats.push({ name: file, path: filePath, size: stat.size, atime: stat.atimeMs });
      }
    }

    const totalSizeMB = totalSize / (1024 * 1024);
    console.log(`[Cache] Tổng dung lượng hiện tại: ${totalSizeMB.toFixed(2)} MB / ${MAX_CACHE_SIZE_MB} MB`);

    if (totalSizeMB > MAX_CACHE_SIZE_MB) {
      // Sắp xếp các file theo thời gian truy cập cuối cùng (atime) tăng dần (cũ nhất đứng trước)
      fileStats.sort((a, b) => a.atime - b.atime);

      let freedSize = 0;
      const targetFreedMB = MAX_CACHE_SIZE_MB * 0.3; // Xóa bớt 30% bộ nhớ

      for (const file of fileStats) {
        try {
          fs.unlinkSync(file.path);
          freedSize += file.size;
          console.log(`[Cache Evict] Đã xóa file cache cũ nhất: ${file.name}`);

          if ((totalSize - freedSize) / (1024 * 1024) <= MAX_CACHE_SIZE_MB - targetFreedMB) {
            break;
          }
        } catch (e) {
          console.warn(`[Cache WARNING] Không thể xóa file ${file.name}:`, e);
        }
      }
      console.log(`[Cache] Đã giải phóng thành công ${(freedSize / (1024 * 1024)).toFixed(2)} MB bộ nhớ.`);
    }
  } catch (error) {
    console.error('[Cache ERROR] Lỗi khi thu hồi dung lượng cache:', error);
  }
}

// Khôi phục trạng thái khi restart
function recoverOrphanedJobs() {
  console.log('[Server] Khôi phục các jobs và segments bị kẹt ở trạng thái chạy ngầm...');
  try {
    const now = Date.now();
    const jobsResult = statements.resetRunningJobs.run(now);
    const segmentsResult = statements.resetGeneratingSegments.run(now);
    console.log(`[Server] Khôi phục xong: ${jobsResult.changes} jobs quay lại PENDING, ${segmentsResult.changes} segments quay lại PENDING.`);
  } catch (error) {
    console.error('[Server ERROR] Lỗi khi khôi phục job mồ côi:', error);
  }
}

// Session reaper
function startSessionReaper() {
  setInterval(() => {
    console.log('[Reaper] Đang quét dọn dẹp các session hết hạn do rảnh rỗi quá 30 phút...');
    try {
      const expirationThreshold = Date.now() - 30 * 60 * 1000;
      const result = statements.deleteExpiredSessions.run(expirationThreshold);
      if (result.changes > 0) {
        console.log(`[Reaper] Đã xóa ${result.changes} sessions hết hạn cùng các phụ đề và jobs liên quan.`);
      }
    } catch (error) {
      console.error('[Reaper ERROR] Lỗi khi quét dọn dẹp session:', error);
    }
  }, 10 * 60 * 1000);
}

// --- API ROUTES ---

app.get('/status', (_req, res) => {
  res.status(200).json({ status: 'running', service: 'LiveTube Voice Dubber V2' });
});

/**
 * 1. POST /api/sessions
 * Khởi tạo session mới, tải phụ đề, dịch thuật toàn bộ và trả về timeline
 */
app.post('/api/sessions', async (req, res) => {
  const { sessionId, url, voice, rate, volume } = req.body;

  if (!sessionId || !url || !voice) {
    res.status(400).json({ error: 'Thiếu tham số bắt buộc: sessionId, url, voice' });
    return;
  }

  const videoId = extractVideoId(url);
  const now = Date.now();

  try {
    // Bước 1: Lưu/Cập nhật thông tin Session với status INIT
    statements.insertSession.run(
      sessionId,
      videoId,
      url,
      'vi',
      voice,
      rate || '+0%',
      volume || '+0%',
      'INIT',
      now,
      now
    );

    // Bước 2: Tải phụ đề từ YouTube
    statements.updateSessionStatus.run('FETCHING_SUBTITLES', Date.now(), sessionId);
    const vttPath = await downloadSubtitles(sessionId, url);

    // Bước 3: Parse VTT và Reconstruct câu thoại
    const rawChunks = parseVtt(vttPath);
    const reconstructed = reconstructSentences(rawChunks);

    if (reconstructed.length === 0) {
      statements.updateSessionStatus.run('FAILED', Date.now(), sessionId);
      res.status(200).json({ status: 'FAILED', error: 'Video không có phụ đề hoặc phụ đề rỗng.' });
      return;
    }

    // Ghi thô segments tiếng Anh vào DB trước
    insertSegmentsTransaction(sessionId, reconstructed);

    // Bước 4: Dịch thuật toàn bộ cuốn chiếu dạng Batching
    statements.updateSessionStatus.run('TRANSLATING', Date.now(), sessionId);
    const sourceTexts = reconstructed.map(s => s.sourceText);
    const translatedTexts = await translateBatch(sourceTexts);

    // Cập nhật nội dung dịch vào DB và kiểm tra cache-hits
    const updateNow = Date.now();
    const resolvedSegments = [];
    for (let i = 0; i < reconstructed.length; i++) {
      const translatedText = translatedTexts[i] || sourceTexts[i];
      reconstructed[i].translatedText = translatedText;

      const cacheKey = generateCacheKey(videoId, translatedText, {
        voice,
        rate: rate || '+0%',
        volume: volume || '+0%'
      });
      const audioPath = getCacheFilePath(cacheKey);
      const isCached = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;

      const audioStatus = isCached ? 'READY' : 'PENDING';
      const finalAudioPath = isCached ? audioPath : null;
      const finalCacheKey = isCached ? cacheKey : null;

      statements.updateSegmentAudioStatus.run(
        audioStatus,
        finalCacheKey,
        finalAudioPath,
        updateNow,
        sessionId,
        reconstructed[i].index
      );

      // Ghi đè text dịch vào DB
      db.prepare('UPDATE segments SET translated_text = ?, updated_at = ? WHERE session_id = ? AND segment_index = ?')
        .run(translatedText, updateNow, sessionId, reconstructed[i].index);

      resolvedSegments.push({
        index: reconstructed[i].index,
        start: reconstructed[i].start,
        end: reconstructed[i].end,
        sourceText: reconstructed[i].sourceText,
        translatedText: translatedText,
        audioStatus: audioStatus,
        cacheKey: cacheKey,
        audioUrl: isCached ? `/audio/cache/${cacheKey}.mp3` : null
      });
    }

    // Bước 5: Đẩy các jobs sinh TTS cho các segment chưa có sẵn trong cache
    // - Sinh gấp (Priority 1) cho 3 câu đầu tiên (nếu chưa READY)
    const firstSentencesCount = Math.min(3, resolvedSegments.length);
    for (let i = 1; i <= firstSentencesCount; i++) {
      if (resolvedSegments[i - 1].audioStatus !== 'READY') {
        queueManager.addJob(sessionId, i, 1);
      }
    }

    // - Sinh tải trước (Priority 2) cho toàn bộ các câu thoại tiếp theo (nếu chưa READY)
    for (let i = firstSentencesCount + 1; i <= resolvedSegments.length; i++) {
      if (resolvedSegments[i - 1].audioStatus !== 'READY') {
        queueManager.addJob(sessionId, i, 2);
      }
    }

    // Đánh dấu session thành READY
    statements.updateSessionStatus.run('READY', Date.now(), sessionId);

    // Trả về timeline dịch thuật đầy đủ cho extension kèm theo thông tin cache
    res.status(200).json({
      status: 'READY',
      sessionId,
      videoId,
      segments: resolvedSegments
    });

  } catch (error) {
    console.error(`[Server ERROR] Khởi tạo session ${sessionId} thất bại:`, error);
    statements.updateSessionStatus.run('FAILED', Date.now(), sessionId);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 2. POST /api/sessions/:sessionId/segments/:segmentIndex/request-audio
 * Yêu cầu sinh âm thanh gấp (Priority 1 - ON_DEMAND)
 */
app.post('/api/sessions/:sessionId/segments/:segmentIndex/request-audio', (req, res) => {
  const { sessionId, segmentIndex } = req.params;
  const index = parseInt(segmentIndex);

  try {
    const segment = statements.getSegment.get(sessionId, index) as any;
    if (!segment) {
      res.status(404).json({ error: 'Không tìm thấy segment tương ứng.' });
      return;
    }

    if (segment.audio_status === 'READY') {
      res.status(200).json({ segmentIndex: index, audioStatus: 'READY', audioUrl: `/audio/cache/${segment.cache_key}.mp3` });
      return;
    }

    // Nâng cấp hoặc tạo mới job sinh TTS với Priority 1
    queueManager.addJob(sessionId, index, 1);
    
    res.status(200).json({
      segmentIndex: index,
      audioStatus: 'GENERATING'
    });
  } catch (error) {
    console.error('[Server ERROR] Yêu cầu request-audio thất bại:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 3. GET /api/sessions/:sessionId/segments/:segmentIndex
 * Polling trạng thái của một segment
 */
app.get('/api/sessions/:sessionId/segments/:segmentIndex', (req, res) => {
  const { sessionId, segmentIndex } = req.params;
  const index = parseInt(segmentIndex);

  try {
    const segment = statements.getSegment.get(sessionId, index) as any;
    if (!segment) {
      res.status(404).json({ error: 'Không tìm thấy segment.' });
      return;
    }

    res.status(200).json({
      segmentIndex: index,
      audioStatus: segment.audio_status,
      audioUrl: segment.audio_status === 'READY' ? `/audio/cache/${segment.cache_key}.mp3` : null
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Chạy cron quét dọn dẹp cache 12 giờ một lần
setInterval(performCacheEviction, 12 * 60 * 60 * 1000);

// Khởi chạy Server
const server = app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`🚀 LiveTube Voice Dubber V2 Server is running on port: ${PORT}`);
  console.log(`================================================================`);
  
  // Chạy dọn dẹp và khôi phục
  recoverOrphanedJobs();
  startSessionReaper();
  performCacheEviction();
});

// Graceful Shutdown
function gracefulShutdown() {
  console.log('[Server] Đang tắt server an toàn...');
  
  server.close(() => {
    console.log('[Server] HTTP server đã dừng tiếp nhận kết nối mới.');
    try {
      db.close();
      console.log('[DB] Kết nối cơ sở dữ liệu SQLite đã đóng.');
    } catch (error) {
      console.error('[DB ERROR] Lỗi khi đóng database:', error);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Server] Buộc tắt server vì tiến trình đóng kéo dài quá 5 giây.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

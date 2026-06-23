import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_FILE = path.join(process.cwd(), 'livetube_v2.db');

// Đảm bảo thư mục dự án sẵn sàng (nếu cần)
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Khởi tạo Database SQLite
const db = new Database(DB_FILE);

// Cấu hình tối ưu hóa SQLite cho Multi-tab/Multi-session
db.pragma('journal_mode = WAL');       // Write-Ahead Logging để cho phép đọc ghi song song
db.pragma('busy_timeout = 5000');       // Chờ tối đa 5s khi DB bị khóa trước khi báo lỗi
db.pragma('foreign_keys = ON');         // Kích hoạt ràng buộc khóa ngoại để CASCADE delete hoạt động

// Tạo các bảng cơ sở dữ liệu nếu chưa tồn tại
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      url TEXT NOT NULL,
      target_language TEXT NOT NULL,
      voice TEXT NOT NULL,
      rate TEXT NOT NULL DEFAULT '+0%',
      volume TEXT NOT NULL DEFAULT '+0%',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      source_text TEXT NOT NULL,
      translated_text TEXT,
      audio_status TEXT NOT NULL DEFAULT 'PENDING',
      cache_key TEXT,
      audio_path TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, segment_index)
  );

  CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id, segment_index) REFERENCES segments(session_id, segment_index) ON DELETE CASCADE
  );

  -- Index tối ưu hóa truy vấn
  CREATE INDEX IF NOT EXISTS idx_segments_lookup ON segments(session_id, start_time, end_time);
  CREATE INDEX IF NOT EXISTS idx_jobs_scheduler ON jobs(status, priority, created_at);
`);

console.log(`[DB] Database SQLite initialized successfully at: ${DB_FILE}`);

// --- PREPARED STATEMENTS (Tập trung Prepared Statements để tái sử dụng hiệu năng cao) ---

export const statements = {
  // Session Statements
  insertSession: db.prepare(`
    INSERT INTO sessions (id, video_id, url, target_language, voice, rate, volume, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      video_id = excluded.video_id,
      url = excluded.url,
      target_language = excluded.target_language,
      voice = excluded.voice,
      rate = excluded.rate,
      volume = excluded.volume,
      status = excluded.status,
      updated_at = excluded.updated_at
  `),
  
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?'),
  
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE updated_at < ?'),

  // Segment Statements
  insertSegment: db.prepare(`
    INSERT INTO segments (session_id, segment_index, start_time, end_time, source_text, translated_text, audio_status, cache_key, audio_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, segment_index) DO UPDATE SET
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      source_text = excluded.source_text,
      translated_text = excluded.translated_text,
      audio_status = excluded.audio_status,
      cache_key = excluded.cache_key,
      audio_path = excluded.audio_path,
      updated_at = excluded.updated_at
  `),

  getSegments: db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY segment_index ASC'),
  
  getSegment: db.prepare('SELECT * FROM segments WHERE session_id = ? AND segment_index = ?'),
  
  updateSegmentAudioStatus: db.prepare(`
    UPDATE segments 
    SET audio_status = ?, cache_key = ?, audio_path = ?, updated_at = ? 
    WHERE session_id = ? AND segment_index = ?
  `),

  // Job Statements
  insertJob: db.prepare(`
    INSERT INTO jobs (id, session_id, segment_index, priority, status, attempts, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      priority = CASE WHEN excluded.priority < jobs.priority THEN excluded.priority ELSE jobs.priority END,
      status = CASE WHEN jobs.status = 'FAILED' THEN 'PENDING' ELSE jobs.status END,
      attempts = CASE WHEN jobs.status = 'FAILED' THEN 0 ELSE jobs.attempts END,
      updated_at = excluded.updated_at
  `),

  getJob: db.prepare('SELECT * FROM jobs WHERE session_id = ? AND segment_index = ?'),
  
  updateJobStatus: db.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?'),
  
  incrementJobAttempts: db.prepare('UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?'),

  deleteJob: db.prepare('DELETE FROM jobs WHERE session_id = ? AND segment_index = ?'),

  // Scheduler-specific query
  getPendingJobsByPriority: db.prepare(`
    SELECT * FROM jobs 
    WHERE status = 'PENDING' 
    ORDER BY priority ASC, created_at ASC
  `),

  // Reset stuck running jobs at startup
  resetRunningJobs: db.prepare(`
    UPDATE jobs 
    SET status = 'PENDING', updated_at = ? 
    WHERE status = 'RUNNING'
  `),
  
  resetGeneratingSegments: db.prepare(`
    UPDATE segments 
    SET audio_status = 'PENDING', updated_at = ? 
    WHERE audio_status = 'GENERATING'
  `)
};

// Hàm chạy Transaction an toàn để ghi hàng loạt segments
export function insertSegmentsTransaction(
  sessionId: string, 
  segmentsList: Array<{
    index: number;
    start: number;
    end: number;
    sourceText: string;
    translatedText?: string | null;
  }>
) {
  const insert = db.transaction((list) => {
    const now = Date.now();
    for (const seg of list) {
      statements.insertSegment.run(
        sessionId,
        seg.index,
        seg.start,
        seg.end,
        seg.sourceText,
        seg.translatedText || null,
        'PENDING',
        null,
        null,
        now
      );
    }
  });
  insert(segmentsList);
}

export default db;

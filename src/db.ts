import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DB_FILE = path.join(process.cwd(), 'livetube_v3.db');

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      url TEXT NOT NULL,
      target_language TEXT NOT NULL DEFAULT 'vi',
      voice TEXT NOT NULL,
      rate TEXT NOT NULL DEFAULT '+0%',
      volume TEXT NOT NULL DEFAULT '+0%',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS segments (
      video_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      source_text TEXT NOT NULL,
      translated_text TEXT,
      source_hash TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (video_id, segment_index)
  );

  CREATE INDEX IF NOT EXISTS idx_segments_lookup
  ON segments(video_id, start_time, end_time);

  CREATE INDEX IF NOT EXISTS idx_sessions_video_id
  ON sessions(video_id);
`);

console.log(`[DB] SQLite V3 text-only database initialized at: ${DB_FILE}`);

export interface SessionRecord {
  id: string;
  video_id: string;
  url: string;
  target_language: string;
  voice: string;
  rate: string;
  volume: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface SegmentRecord {
  video_id: string;
  segment_index: number;
  start_time: number;
  end_time: number;
  source_text: string;
  translated_text: string | null;
  source_hash: string | null;
  updated_at: number;
}

export interface SegmentInput {
  index: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText?: string | null;
}

export const statements = {
  insertSession: db.prepare(`
    INSERT INTO sessions (
      id,
      video_id,
      url,
      target_language,
      voice,
      rate,
      volume,
      status,
      created_at,
      updated_at
    )
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

  getSession: db.prepare(`
    SELECT *
    FROM sessions
    WHERE id = ?
  `),

  updateSessionStatus: db.prepare(`
    UPDATE sessions
    SET status = ?, updated_at = ?
    WHERE id = ?
  `),

  deleteSession: db.prepare(`
    DELETE FROM sessions
    WHERE id = ?
  `),

  deleteExpiredSessions: db.prepare(`
    DELETE FROM sessions
    WHERE updated_at < ?
  `),

  upsertSegment: db.prepare(`
    INSERT INTO segments (
      video_id,
      segment_index,
      start_time,
      end_time,
      source_text,
      translated_text,
      source_hash,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, segment_index) DO UPDATE SET
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      source_text = excluded.source_text,
      translated_text = excluded.translated_text,
      source_hash = excluded.source_hash,
      updated_at = excluded.updated_at
  `),

  getSegmentsByVideoId: db.prepare(`
    SELECT *
    FROM segments
    WHERE video_id = ?
    ORDER BY segment_index ASC
  `),

  getSegmentByVideoId: db.prepare(`
    SELECT *
    FROM segments
    WHERE video_id = ? AND segment_index = ?
  `),

  updateSegmentTranslation: db.prepare(`
    UPDATE segments
    SET translated_text = ?, updated_at = ?
    WHERE video_id = ? AND segment_index = ?
  `)
};

function createSourceHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

export function insertSegmentsTransaction(
  videoId: string,
  segmentsList: SegmentInput[]
) {
  const insert = db.transaction((list: SegmentInput[]) => {
    const now = Date.now();

    for (const seg of list) {
      statements.upsertSegment.run(
        videoId,
        seg.index,
        seg.start,
        seg.end,
        seg.sourceText,
        seg.translatedText || null,
        createSourceHash(seg.sourceText),
        now
      );
    }
  });

  insert(segmentsList);
}

export default db;

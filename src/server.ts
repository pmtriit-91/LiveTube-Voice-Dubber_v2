import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import db, {
  SegmentRecord,
  SessionRecord,
  insertSegmentsTransaction,
  statements
} from './db';
import { downloadSubtitles, parseVtt, reconstructSentences } from './utils/yt-dlp';
import { translateBatch } from './utils/translator';
import { audioCache, buildAudioCacheKey, AudioCacheKeyParts } from './runtime/audio-cache';
import {
  estimateRateDetails,
  estimateTTSTimeoutMs
} from './runtime/rate-estimator';
import type { RateEstimate } from './runtime/rate-estimator';
import { ttsQueue } from './runtime/tts-queue';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8765);
const DEFAULT_LOOK_AHEAD = 5;
const RATE_ESTIMATOR_ENABLED = process.env.RATE_ESTIMATOR_ENABLED !== 'false';

type PrepareMode = 'INITIAL' | 'PLAYBACK' | 'SEEK';

interface SessionRequestBody {
  sessionId?: string;
  url?: string;
  voice?: string;
  rate?: string;
  volume?: string;
}

interface PrepareRequestBody {
  anchorIndex?: number;
  mode?: PrepareMode;
  lookAhead?: number;
}

interface TimelineSegment {
  index: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
}

interface SegmentAudioPlan {
  parts: AudioCacheKeyParts;
  cacheKey: string;
  text: string;
  timeoutMs: number;
  rateEstimate: RateEstimate;
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

function extractVideoId(url: string): string {
  if (url.includes('mock_test')) return 'mock_video_id';

  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : 'unknown_video';
}

function normalizeRate(rate?: string): string {
  return rate && rate.trim().length > 0 ? rate : '+0%';
}

function normalizeVolume(volume?: string): string {
  return volume && volume.trim().length > 0 ? volume : '+0%';
}

function toTimelineSegment(record: SegmentRecord): TimelineSegment {
  return {
    index: record.segment_index,
    start: record.start_time,
    end: record.end_time,
    sourceText: record.source_text,
    translatedText: record.translated_text || record.source_text
  };
}

function getSessionOrNull(sessionId: string): SessionRecord | null {
  return (statements.getSession.get(sessionId) as SessionRecord | undefined) || null;
}

function getSegmentOrNull(videoId: string, segmentIndex: number): SegmentRecord | null {
  return (statements.getSegmentByVideoId.get(videoId, segmentIndex) as SegmentRecord | undefined) || null;
}

function getSegmentText(segment: SegmentRecord): string {
  return segment.translated_text || segment.source_text;
}

function getSegmentDuration(segment: SegmentRecord): number {
  return Math.max(0.1, segment.end_time - segment.start_time);
}

function buildAudioPlanForSegment(session: SessionRecord, segment: SegmentRecord): SegmentAudioPlan {
  const text = getSegmentText(segment);
  const segmentDuration = getSegmentDuration(segment);
  const rateEstimate = estimateRateDetails(text, segmentDuration, {
    baseRate: session.rate,
    enabled: RATE_ESTIMATOR_ENABLED
  });
  const timeoutMs = estimateTTSTimeoutMs(text, rateEstimate);
  const parts: AudioCacheKeyParts = {
    sessionId: session.id,
    segmentIndex: segment.segment_index,
    voice: session.voice,
    rate: rateEstimate.rate,
    volume: session.volume
  };

  return {
    parts,
    cacheKey: buildAudioCacheKey(parts),
    text,
    timeoutMs,
    rateEstimate
  };
}

function logStructured(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    component: 'server',
    event,
    ...payload
  }));
}

function logRateDecision(session: SessionRecord, plan: SegmentAudioPlan): void {
  if (plan.rateEstimate.speedupPercent <= 0 && plan.rateEstimate.rate === plan.rateEstimate.baseRate) {
    return;
  }

  logStructured('rate.estimated', {
    sessionId: session.id,
    videoId: session.video_id,
    segmentIndex: plan.parts.segmentIndex,
    baseRate: plan.rateEstimate.baseRate,
    estimatedRate: plan.rateEstimate.rate,
    speedupPercent: plan.rateEstimate.speedupPercent,
    clamped: plan.rateEstimate.clamped,
    tokenCount: plan.rateEstimate.tokenCount,
    textLength: plan.rateEstimate.textLength,
    segmentDurationSeconds: Number(plan.rateEstimate.segmentDurationSeconds.toFixed(2)),
    estimatedDurationSeconds: Number(plan.rateEstimate.estimatedDurationSeconds.toFixed(2)),
    timeoutMs: plan.timeoutMs
  });
}

function logAudioCacheDecision(
  event: string,
  session: SessionRecord,
  plan: SegmentAudioPlan,
  cacheStatus: string
): void {
  logStructured(event, {
    sessionId: session.id,
    videoId: session.video_id,
    segmentIndex: plan.parts.segmentIndex,
    cacheStatus,
    rate: plan.parts.rate,
    timeoutMs: plan.timeoutMs
  });
}

function getPriorityForMode(mode: PrepareMode): number {
  if (mode === 'SEEK') return 0;
  if (mode === 'INITIAL') return 1;
  return 2;
}

function parseSegmentIndex(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function startSessionReaper(): void {
  setInterval(() => {
    try {
      const expirationThreshold = Date.now() - 30 * 60 * 1000;
      statements.deleteExpiredSessions.run(expirationThreshold);
    } catch (error) {
      console.error('[Reaper ERROR] Failed to delete expired sessions:', error);
    }
  }, 10 * 60 * 1000);
}

async function resolveTimeline(sessionId: string, videoId: string, url: string): Promise<TimelineSegment[]> {
  const existingSegments = statements.getSegmentsByVideoId.all(videoId) as SegmentRecord[];
  if (existingSegments.length > 0 && existingSegments.every((segment) => segment.translated_text)) {
    return existingSegments.map(toTimelineSegment);
  }

  statements.updateSessionStatus.run('FETCHING_SUBTITLES', Date.now(), sessionId);
  const vttPath = await downloadSubtitles(sessionId, url);
  const rawChunks = parseVtt(vttPath);
  const reconstructed = reconstructSentences(rawChunks);

  if (reconstructed.length === 0) {
    throw new Error('Video không có phụ đề hoặc phụ đề rỗng.');
  }

  insertSegmentsTransaction(videoId, reconstructed);

  statements.updateSessionStatus.run('TRANSLATING', Date.now(), sessionId);
  const sourceTexts = reconstructed.map((segment) => segment.sourceText);
  const translatedTexts = await translateBatch(sourceTexts);

  const translatedSegments = reconstructed.map((segment, index) => ({
    ...segment,
    translatedText: translatedTexts[index] || segment.sourceText
  }));

  insertSegmentsTransaction(videoId, translatedSegments);

  return translatedSegments.map((segment) => ({
    index: segment.index,
    start: segment.start,
    end: segment.end,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText || segment.sourceText
  }));
}

app.get('/status', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'running',
    service: 'LiveTube Voice Dubber V3',
    queue: ttsQueue.stats(),
    cache: audioCache.stats()
  });
});

app.post('/api/sessions', async (req: Request<unknown, unknown, SessionRequestBody>, res: Response) => {
  const { sessionId, url, voice } = req.body;

  if (!sessionId || !url || !voice) {
    res.status(400).json({ error: 'Thiếu tham số bắt buộc: sessionId, url, voice' });
    return;
  }

  const videoId = extractVideoId(url);
  const now = Date.now();
  const rate = normalizeRate(req.body.rate);
  const volume = normalizeVolume(req.body.volume);

  try {
    statements.insertSession.run(
      sessionId,
      videoId,
      url,
      'vi',
      voice,
      rate,
      volume,
      'INIT',
      now,
      now
    );

    const segments = await resolveTimeline(sessionId, videoId, url);
    statements.updateSessionStatus.run('READY', Date.now(), sessionId);

    res.status(200).json({
      status: 'READY',
      sessionId,
      videoId,
      segments
    });
  } catch (error) {
    console.error(`[Server ERROR] Failed to initialize session ${sessionId}:`, error);
    statements.updateSessionStatus.run('FAILED', Date.now(), sessionId);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post(
  '/api/sessions/:id/prepare',
  (req: Request<{ id: string }, unknown, PrepareRequestBody>, res: Response) => {
    const session = getSessionOrNull(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Không tìm thấy session.' });
      return;
    }

    const anchorIndex = Number(req.body.anchorIndex);
    if (!Number.isInteger(anchorIndex) || anchorIndex <= 0) {
      res.status(400).json({ error: 'anchorIndex phải là số nguyên dương.' });
      return;
    }

    const mode = req.body.mode || 'PLAYBACK';
    if (!['INITIAL', 'PLAYBACK', 'SEEK'].includes(mode)) {
      res.status(400).json({ error: 'mode phải là INITIAL, PLAYBACK hoặc SEEK.' });
      return;
    }

    const lookAhead = Number.isInteger(req.body.lookAhead) && Number(req.body.lookAhead) >= 0
      ? Number(req.body.lookAhead)
      : DEFAULT_LOOK_AHEAD;
    const priority = getPriorityForMode(mode);
    const ready: number[] = [];
    const queued: number[] = [];
    const generating: number[] = [];
    const failed: number[] = [];
    const missing: number[] = [];

    if (mode === 'SEEK') {
      ttsQueue.cancelOutsideWindow(session.id, anchorIndex, lookAhead);
    }

    for (let segmentIndex = anchorIndex; segmentIndex <= anchorIndex + lookAhead; segmentIndex++) {
      const segment = getSegmentOrNull(session.video_id, segmentIndex);
      if (!segment) {
        missing.push(segmentIndex);
        continue;
      }

      const plan = buildAudioPlanForSegment(session, segment);
      logRateDecision(session, plan);

      const existingEntry = audioCache.get(plan.cacheKey);
      logAudioCacheDecision(
        'prepare.cache',
        session,
        plan,
        existingEntry?.status || 'MISS'
      );

      if (existingEntry?.status === 'READY') {
        ready.push(segmentIndex);
        continue;
      }

      if (existingEntry?.status === 'GENERATING') {
        generating.push(segmentIndex);
        continue;
      }

      if (existingEntry?.status === 'FAILED') {
        audioCache.delete(plan.cacheKey);
        failed.push(segmentIndex);
      }

      ttsQueue.enqueue({
        ...plan.parts,
        text: plan.text,
        priority,
        timeoutMs: plan.timeoutMs
      });
      queued.push(segmentIndex);
    }

    res.status(200).json({
      sessionId: session.id,
      anchorIndex,
      mode,
      lookAhead,
      ready,
      queued,
      generating,
      failed,
      missing
    });
  }
);

app.get('/api/stream/:sessionId/:segmentIndex', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  const segmentIndex = parseSegmentIndex(req.params.segmentIndex);

  if (!segmentIndex) {
    res.status(400).json({ error: 'segmentIndex phải là số nguyên dương.' });
    return;
  }

  const session = getSessionOrNull(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Không tìm thấy session.' });
    return;
  }

  const segment = getSegmentOrNull(session.video_id, segmentIndex);
  if (!segment) {
    res.status(404).json({ error: 'Không tìm thấy segment.' });
    return;
  }

  const plan = buildAudioPlanForSegment(session, segment);
  logRateDecision(session, plan);

  const existingEntry = audioCache.get(plan.cacheKey);
  logAudioCacheDecision(
    'stream.cache',
    session,
    plan,
    existingEntry?.status || 'MISS'
  );

  if (existingEntry?.status === 'FAILED') {
    audioCache.delete(plan.cacheKey);
  }

  const entry = audioCache.getOrCreate(plan.parts);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-LiveTube-Stream', 'v3');
  res.flushHeaders();

  const unsubscribe = audioCache.subscribe(entry.key, res);
  req.on('close', unsubscribe);

  if (entry.status === 'PENDING') {
    ttsQueue.enqueue({
      ...plan.parts,
      text: plan.text,
      priority: 0,
      timeoutMs: plan.timeoutMs
    });
  }
});

const server = app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`LiveTube Voice Dubber V3 Server is running on port: ${PORT}`);
  console.log('================================================================');
  startSessionReaper();
});

function gracefulShutdown(): void {
  console.log('[Server] Shutting down...');

  server.close(() => {
    try {
      db.close();
      console.log('[DB] SQLite connection closed.');
    } catch (error) {
      console.error('[DB ERROR] Failed to close database:', error);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

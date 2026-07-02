const DEFAULT_BASE_URL = 'http://localhost:8765';
const BASE_URL = process.env.LIVETUBE_TEST_BASE_URL || DEFAULT_BASE_URL;
const TEST_SESSION_ID = `phase4_smoke_${Date.now()}`;

interface StatusResponse {
  status: string;
  service: string;
  queue: {
    pending: number;
    running: number;
    activeWorkers: number;
    maxConcurrent: number;
    isThrottled?: boolean;
  };
  cache: {
    entries: number;
    bytes: number;
    subscribers: number;
  };
}

interface SessionResponse {
  status: 'READY' | 'FAILED';
  sessionId: string;
  videoId: string;
  segments: Array<{
    index: number;
    start: number;
    end: number;
    sourceText: string;
    translatedText: string;
  }>;
  error?: string;
}

interface PrepareResponse {
  sessionId: string;
  anchorIndex: number;
  mode: 'INITIAL' | 'PLAYBACK' | 'SEEK';
  lookAhead: number;
  ready: number[];
  queued: number[];
  generating: number[];
  failed: number[];
  missing: number[];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
  }

  return body as T;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runIntegrationTest(): Promise<void> {
  console.log('====================================================');
  console.log('LiveTube V3 HTTP integration smoke test');
  console.log('====================================================');
  console.log(`Backend: ${BASE_URL}`);

  const status = await requestJson<StatusResponse>('/status');
  assertCondition(status.status === 'running', 'Expected /status to report running.');
  assertCondition(typeof status.queue.pending === 'number', 'Expected queue stats in /status.');
  assertCondition(typeof status.cache.entries === 'number', 'Expected cache stats in /status.');
  console.log('[OK] /status returned V3 queue/cache metrics.');

  const session = await requestJson<SessionResponse>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: TEST_SESSION_ID,
      url: 'mock_test_url',
      voice: 'vi-VN-NamMinhNeural',
      rate: '+0%',
      volume: '+0%'
    })
  });

  assertCondition(session.status === 'READY', `Session did not become READY: ${session.error || 'unknown error'}`);
  assertCondition(session.sessionId === TEST_SESSION_ID, 'Session id mismatch.');
  assertCondition(session.videoId === 'mock_video_id', 'Mock video id mismatch.');
  assertCondition(session.segments.length > 0, 'Expected at least one timeline segment.');
  assertCondition(!('audioStatus' in session.segments[0]), 'Timeline must be text-only and not include audioStatus.');
  assertCondition(!('audioUrl' in session.segments[0]), 'Timeline must not include static audioUrl.');
  console.log(`[OK] /api/sessions returned ${session.segments.length} text-only segments.`);

  const prepare = await requestJson<PrepareResponse>(`/api/sessions/${TEST_SESSION_ID}/prepare`, {
    method: 'POST',
    body: JSON.stringify({
      anchorIndex: session.segments[0].index,
      mode: 'INITIAL',
      lookAhead: 2
    })
  });

  assertCondition(prepare.sessionId === TEST_SESSION_ID, 'Prepare session id mismatch.');
  assertCondition(prepare.mode === 'INITIAL', 'Prepare mode mismatch.');
  assertCondition(Array.isArray(prepare.queued), 'Prepare response missing queued array.');
  assertCondition(Array.isArray(prepare.ready), 'Prepare response missing ready array.');
  assertCondition(Array.isArray(prepare.generating), 'Prepare response missing generating array.');
  assertCondition(Array.isArray(prepare.failed), 'Prepare response missing failed array.');
  assertCondition(Array.isArray(prepare.missing), 'Prepare response missing missing array.');
  console.log('[OK] /prepare returned V3 queue window response.');

  console.log('====================================================');
  console.log('LiveTube V3 HTTP integration smoke test passed.');
  console.log('====================================================');
}

runIntegrationTest().catch((error) => {
  console.error('LiveTube V3 HTTP integration smoke test failed:', error);
  process.exit(1);
});

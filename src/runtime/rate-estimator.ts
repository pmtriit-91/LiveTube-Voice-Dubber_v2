const DEFAULT_SYLLABLES_PER_TOKEN = 1.25;
const DEFAULT_SYLLABLES_PER_SECOND = 4.5;
const DEFAULT_MAX_RATE_PERCENT = 40;
const DEFAULT_MIN_RATE_PERCENT = -50;
const DEFAULT_MIN_SEGMENT_DURATION_SECONDS = 0.4;
const DEFAULT_DURATION_TOLERANCE = 1.05;
const DEFAULT_MIN_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TIMEOUT_MS = 45_000;

export interface RateEstimateOptions {
  baseRate?: string;
  enabled?: boolean;
  syllablesPerToken?: number;
  syllablesPerSecond?: number;
  maxRatePercent?: number;
  minRatePercent?: number;
  minSegmentDurationSeconds?: number;
  durationTolerance?: number;
}

export interface RateEstimate {
  rate: string;
  baseRate: string;
  baseRatePercent: number;
  finalRatePercent: number;
  speedupPercent: number;
  tokenCount: number;
  textLength: number;
  estimatedSyllables: number;
  estimatedDurationSeconds: number;
  segmentDurationSeconds: number;
  clamped: boolean;
  enabled: boolean;
}

export interface TTSTimeoutOptions {
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
}

export function estimateRate(translatedText: string, segmentDurationSeconds: number): string {
  return estimateRateDetails(translatedText, segmentDurationSeconds).rate;
}

export function estimateRateDetails(
  translatedText: string,
  segmentDurationSeconds: number,
  options: RateEstimateOptions = {}
): RateEstimate {
  const normalizedText = normalizeText(translatedText);
  const tokenCount = countTokens(normalizedText);
  const baseRate = normalizeRate(options.baseRate || '+0%');
  const baseRatePercent = parseRatePercent(baseRate);
  const enabled = options.enabled !== false;
  const safeSegmentDuration = Number.isFinite(segmentDurationSeconds) ? Math.max(0, segmentDurationSeconds) : 0;
  const syllablesPerToken = options.syllablesPerToken || DEFAULT_SYLLABLES_PER_TOKEN;
  const syllablesPerSecond = options.syllablesPerSecond || DEFAULT_SYLLABLES_PER_SECOND;
  const maxRatePercent = options.maxRatePercent ?? DEFAULT_MAX_RATE_PERCENT;
  const minRatePercent = options.minRatePercent ?? DEFAULT_MIN_RATE_PERCENT;
  const minSegmentDuration = options.minSegmentDurationSeconds ?? DEFAULT_MIN_SEGMENT_DURATION_SECONDS;
  const durationTolerance = options.durationTolerance || DEFAULT_DURATION_TOLERANCE;
  const estimatedSyllables = tokenCount * syllablesPerToken;
  const estimatedDurationSeconds = syllablesPerSecond > 0
    ? estimatedSyllables / syllablesPerSecond
    : 0;

  let requestedSpeedupPercent = 0;

  if (
    enabled &&
    tokenCount > 0 &&
    safeSegmentDuration >= minSegmentDuration &&
    estimatedDurationSeconds > safeSegmentDuration * durationTolerance
  ) {
    const speedupRatio = estimatedDurationSeconds / safeSegmentDuration;
    requestedSpeedupPercent = Math.max(0, Math.ceil((speedupRatio - 1) * 100));
  }

  const unclampedFinalRatePercent = baseRatePercent + requestedSpeedupPercent;
  const finalRatePercent = clamp(unclampedFinalRatePercent, minRatePercent, maxRatePercent);
  const speedupPercent = Math.max(0, finalRatePercent - baseRatePercent);

  return {
    rate: formatRatePercent(finalRatePercent),
    baseRate,
    baseRatePercent,
    finalRatePercent,
    speedupPercent,
    tokenCount,
    textLength: normalizedText.length,
    estimatedSyllables,
    estimatedDurationSeconds,
    segmentDurationSeconds: safeSegmentDuration,
    clamped: finalRatePercent !== unclampedFinalRatePercent,
    enabled
  };
}

export function estimateTTSTimeoutMs(
  translatedText: string,
  estimate: RateEstimate,
  options: TTSTimeoutOptions = {}
): number {
  const minTimeoutMs = options.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const normalizedText = normalizeText(translatedText);
  const rateMultiplier = Math.max(0.5, 1 + (estimate.finalRatePercent / 100));
  const effectiveAudioDurationMs = (estimate.estimatedDurationSeconds / rateMultiplier) * 1000;
  const durationBasedTimeoutMs = effectiveAudioDurationMs * 2 + 5_000;
  const lengthBasedTimeoutMs = normalizedText.length * 45 + 5_000;
  const timeoutMs = Math.ceil(Math.max(minTimeoutMs, durationBasedTimeoutMs, lengthBasedTimeoutMs));

  return clamp(timeoutMs, minTimeoutMs, maxTimeoutMs);
}

export function parseRatePercent(rate: string): number {
  const normalized = normalizeRate(rate);
  const parsed = Number.parseInt(normalized.replace('%', ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function countTokens(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function normalizeRate(rate: string): string {
  const trimmed = rate.trim();
  if (!trimmed) return '+0%';
  const withPercent = trimmed.endsWith('%') ? trimmed : `${trimmed}%`;

  if (withPercent.startsWith('+') || withPercent.startsWith('-')) {
    return withPercent;
  }

  return `+${withPercent}`;
}

function formatRatePercent(percent: number): string {
  const rounded = Math.round(percent);
  return rounded >= 0 ? `+${rounded}%` : `${rounded}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

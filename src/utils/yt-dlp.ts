import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execPromise = promisify(exec);
const SUBTITLE_DIR = path.join(process.cwd(), 'subtitles');
const DISPLAY_SOFT_CHAR_LIMIT = 90;
const SENTENCE_SOFT_DURATION_LIMIT = 10.0;
const SENTENCE_HARD_CHAR_LIMIT = 250;
const SENTENCE_HARD_DURATION_LIMIT = 15.0;

// Đảm bảo thư mục phụ đề tồn tại
if (!fs.existsSync(SUBTITLE_DIR)) {
  fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
}

export interface RawSubtitleChunk {
  start: number;
  end: number;
  text: string;
}

export interface ReconstructedSentence {
  index: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText?: string | null;
}

/**
 * Tải phụ đề từ YouTube bằng yt-dlp CLI
 * @param sessionId ID của phiên làm việc
 * @param url URL của video YouTube
 * @returns Đường dẫn vật lý của file phụ đề .vtt tải về
 */
const V1_VENV_CLI = '/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/yt-dlp';

export async function downloadSubtitles(sessionId: string, url: string): Promise<string> {
  const targetPath = path.join(SUBTITLE_DIR, `caption_temp_${sessionId}.en.vtt`);

  // Hỗ trợ Mock Test phục vụ E2E Offline testing
  if (url.includes('mock_test')) {
    console.log(`[Subtitle] Generating mock subtitles for session: ${sessionId}`);
    const mockVtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000
[♪♪♪]

00:00:04.000 --> 00:00:08.000
Hello, welcome to LiveTube Voice Dubber.

00:00:09.000 --> 00:00:12.000
This is a test of session isolation.
`;
    fs.writeFileSync(targetPath, mockVtt, 'utf-8');
    return targetPath;
  }

  console.log(`[Subtitle] Downloading subtitles for session ${sessionId}: ${url}...`);

  // Lựa chọn file thực thi yt-dlp CLI
  let cliPath = 'yt-dlp';
  if (fs.existsSync(V1_VENV_CLI)) {
    cliPath = V1_VENV_CLI;
  }

  // Option chạy yt-dlp: Chỉ lấy sub tiếng Anh, không tải video
  const outTemplate = path.join(SUBTITLE_DIR, `caption_temp_${sessionId}`);
  const command = `"${cliPath}" --skip-download --write-subs --write-auto-subs --sub-langs en -o "${outTemplate}" "${url}"`;

  try {
    await execPromise(command);

    // yt-dlp có thể lưu thành caption_temp_session.en.vtt hoặc caption_temp_session.en.exceptions...
    // Quét file thực tế được lưu trên disk
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    // Fallback tìm file .vtt tương ứng được tạo ra
    const files = fs.readdirSync(SUBTITLE_DIR);
    for (const file of files) {
      if (file.startsWith(`caption_temp_${sessionId}`) && file.endsWith('.vtt')) {
        const foundPath = path.join(SUBTITLE_DIR, file);
        fs.renameSync(foundPath, targetPath);
        return targetPath;
      }
    }

    throw new Error('Không tìm thấy file phụ đề .vtt sau khi chạy yt-dlp');
  } catch (error) {
    console.error(`[Subtitle ERROR] Tải phụ đề thất bại cho session ${sessionId}:`, error);
    throw new Error(`Tải phụ đề thất bại: ${(error as Error).message}`);
  }
}

/**
 * Parse file VTT thành danh sách các câu thô
 */
export function parseVtt(filePath: string): RawSubtitleChunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  
  const chunks: RawSubtitleChunk[] = [];
  let currentTimeLine: string | null = null;
  let currentTextLines: string[] = [];

  const isAutoCaption = content.includes('<') && /\d{2}:\d{2}:\d{2}/.test(content); // YouTube auto caption có timeline nội bộ trong tag <>

  for (const line of lines) {
    const lineStripped = line.trim();
    if (lineStripped.includes('-->')) {
      if (currentTimeLine) {
        const chunk = processBlock(currentTimeLine, currentTextLines, isAutoCaption);
        if (chunk) chunks.push(chunk);
      }
      currentTimeLine = lineStripped;
      currentTextLines = [];
    } else if (currentTimeLine && lineStripped) {
      currentTextLines.push(lineStripped);
    }
  }

  // Xử lý block cuối cùng
  if (currentTimeLine) {
    const chunk = processBlock(currentTimeLine, currentTextLines, isAutoCaption);
    if (chunk) chunks.push(chunk);
  }

  // Tối ưu hóa khử trùng lặp tiền tố cho auto caption của YouTube
  if (isAutoCaption) {
    return deduplicateAutoCaptions(chunks);
  }

  return chunks;
}

function processBlock(timeLine: string, textLines: string[], isAutoCaption: boolean): RawSubtitleChunk | null {
  try {
    const parts = timeLine.split('-->');
    const startStr = parts[0].trim().split(/\s+/)[0];
    const endStr = parts[1].trim().split(/\s+/)[0];

    const startSec = timeToSeconds(startStr);
    const endSec = timeToSeconds(endStr);

    let text = '';
    if (isAutoCaption && textLines.length > 1) {
      // Auto caption thường có dòng trước lặp lại, dòng cuối là chữ mới xuất hiện
      text = textLines[textLines.length - 1];
    } else {
      text = textLines.join(' ');
    }

    text = cleanText(text);
    if (text) {
      return { start: startSec, end: endSec, text };
    }
  } catch (e) {
    // Bỏ qua dòng lỗi parse
  }
  return null;
}

/**
 * Khử trùng lặp từ xuất hiện liên tục trong phụ đề tự động của YouTube
 */
function deduplicateAutoCaptions(chunks: RawSubtitleChunk[]): RawSubtitleChunk[] {
  const deduped: RawSubtitleChunk[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const curr = chunks[i];
    if (i < chunks.length - 1) {
      const nxt = chunks[i + 1];
      const currClean = curr.text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const nxtClean = nxt.text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      
      // Nếu câu sau chứa trọn câu trước và khoảng cách bắt đầu ngắn, gộp thời gian bắt đầu
      if (nxtClean.startsWith(currClean) && (nxt.start - curr.start < 6.0)) {
        nxt.start = curr.start; // Giữ start time gốc
        continue;
      }
    }
    deduped.push(curr);
  }

  return deduped;
}

/**
 * Thuật toán gom cụm câu thoại tự nhiên (Sentence Reconstructor)
 */
export function reconstructSentences(chunks: RawSubtitleChunk[]): ReconstructedSentence[] {
  const reconstructed: ReconstructedSentence[] = [];
  let currentGroup: RawSubtitleChunk[] = [];
  let sentenceId = 1;

  const flushCurrentGroup = () => {
    const sentence = buildSentence(sentenceId, currentGroup);
    if (sentence) {
      reconstructed.push(sentence);
      sentenceId++;
    }
    currentGroup = [];
  };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const nextChunk = chunks[i + 1] || null;

    if (currentGroup.length > 0) {
      const gap = chunk.start - currentGroup[currentGroup.length - 1].end;
      if (gap >= 1.0) {
        const accumulatedText = currentGroup.map(c => c.text).join(' ');
        if (isCompleteSentenceFragment(accumulatedText) || gap >= 3.0) {
          flushCurrentGroup();
        }
      }
    }

    currentGroup.push(chunk);
    const text = chunk.text;
    
    // Dấu câu chỉ là tín hiệu ngắt khi chunk kế tiếp không nối tiếp ý.
    let isEnd = shouldSplitOnPunctuation(text, nextChunk?.text || null);

    // Soft-cap ưu tiên ranh giới mệnh đề để phụ đề vừa 1-2 dòng; hard-cap tránh gom vô hạn.
    const accumulatedLen = currentGroup.reduce((sum, c) => sum + c.text.length, 0);
    const duration = chunk.end - currentGroup[0].start;
    if (accumulatedLen > DISPLAY_SOFT_CHAR_LIMIT || duration > SENTENCE_SOFT_DURATION_LIMIT) {
      const accumulatedText = currentGroup.map(c => c.text).join(' ');
      if (
        (accumulatedLen > DISPLAY_SOFT_CHAR_LIMIT && isClauseBoundary(text, nextChunk?.text || null)) ||
        isCompleteSentenceFragment(accumulatedText) ||
        accumulatedLen > SENTENCE_HARD_CHAR_LIMIT ||
        duration > SENTENCE_HARD_DURATION_LIMIT
      ) {
        isEnd = true;
      }
    }

    if (isEnd) {
      flushCurrentGroup();
    }
  }

  // Gộp nhóm còn lại cuối cùng
  if (currentGroup.length > 0) {
    const sentence = buildSentence(sentenceId, currentGroup);
    if (sentence) {
      reconstructed.push(sentence);
    }
  }

  return mergeOrphanFragments(reconstructed);
}

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
  'if', 'then', 'than', 'as'
]);

const CONTINUATION_STARTERS = new Set([
  'and', 'but', 'or', 'so', 'because', 'since', 'although',
  'however', 'therefore', 'moreover', 'furthermore',
  'if', 'unless', 'while', 'whereas', 'though',
  'which', 'who', 'that', 'where', 'when'
]);

const CLAUSE_STARTERS = new Set([
  'and', 'but', 'or', 'so', 'because', 'since', 'although',
  'however', 'therefore', 'moreover', 'furthermore',
  'if', 'then', 'unless', 'while', 'whereas', 'though',
  'which', 'who', 'that', 'where', 'when', 'why', 'what', 'how'
]);

function isCompleteSentenceFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[.!?]["']?$/.test(trimmed)) return true;
  if (/[,;:—-]$/.test(trimmed)) return false;

  const lastWord = trimmed
    .split(/\s+/)
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z']/g, '') || '';

  if (INCOMPLETE_ENDINGS.has(lastWord)) return false;
  if (trimmed.length < 20) return false;

  return true;
}

function shouldSplitOnPunctuation(currentChunkText: string, nextChunkText: string | null): boolean {
  const currentTrimmed = currentChunkText.trim();
  if (!/[.!?]["']?$/.test(currentTrimmed)) return false;
  if (!nextChunkText) return true;

  const nextTrimmed = nextChunkText.trim();
  const firstWord = getFirstNormalizedWord(nextTrimmed);

  if (CONTINUATION_STARTERS.has(firstWord)) return false;
  if (/^[a-z]/.test(nextTrimmed)) return false;

  return true;
}

function isClauseBoundary(currentChunkText: string, nextChunkText: string | null): boolean {
  if (!nextChunkText) return false;

  const currentTrimmed = currentChunkText.trim();
  if (!/[,;]["']?$/.test(currentTrimmed)) return false;

  const nextTrimmed = nextChunkText.trim();
  const firstWord = getFirstNormalizedWord(nextTrimmed);

  if (CLAUSE_STARTERS.has(firstWord)) return true;
  return /^[A-Z]/.test(nextTrimmed);
}

function getFirstNormalizedWord(text: string): string {
  return text
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[^a-z']/g, '') || '';
}

function mergeOrphanFragments(sentences: ReconstructedSentence[]): ReconstructedSentence[] {
  if (sentences.length <= 1) return sentences;

  const merged: ReconstructedSentence[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const current = sentences[i];

    if (
      merged.length > 0 &&
      isOrphanFragment(current.sourceText) &&
      current.start - merged[merged.length - 1].end < 1.5
    ) {
      const previous = merged[merged.length - 1];
      previous.sourceText = `${previous.sourceText} ${current.sourceText}`.replace(/\s+/g, ' ').trim();
      previous.end = current.end;
      continue;
    }

    if (
      i + 1 < sentences.length &&
      isOrphanFragment(current.sourceText) &&
      sentences[i + 1].start - current.end < 1.5
    ) {
      const next = sentences[i + 1];
      next.sourceText = `${current.sourceText} ${next.sourceText}`.replace(/\s+/g, ' ').trim();
      next.start = current.start;
      continue;
    }

    merged.push({ ...current });
  }

  return merged.map((sentence, index) => ({
    ...sentence,
    index: index + 1,
    translatedText: null
  }));
}

function isOrphanFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /[.!?]["']?$/.test(trimmed)) return false;

  const wordCount = trimmed.split(/\s+/).length;
  return wordCount < 5 || trimmed.length < 30;
}

function buildSentence(id: number, group: RawSubtitleChunk[]): ReconstructedSentence | null {
  const startTime = group[0].start;
  const endTime = group[group.length - 1].end;
  let combinedText = group.map(c => c.text).join(' ');
  combinedText = combinedText.replace(/\s+/g, ' ').trim();

  // Giữ lại fragment ngắn có chữ để merge-pass xử lý orphan trước khi trả output cuối.
  if ((endTime - startTime >= 0.5 || isOrphanFragment(combinedText)) && combinedText.length > 0) {
    return {
      index: id,
      start: startTime,
      end: endTime,
      sourceText: combinedText,
      translatedText: null
    };
  }
  return null;
}

function timeToSeconds(tStr: string): number {
  const parts = tStr.trim().split(':');
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2]);
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    return m * 60 + s;
  }
  return 0.0;
}

function cleanText(text: string): string {
  const cleaned = text
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '') // Xóa các tag html/xml nội bộ của YT
    .replace(/\[[^\]]*\]/g, '') // Xóa các thẻ ngoặc vuông [Music], [♪♪♪]
    .replace(/\([^)]*\)/g, '') // Xóa các thẻ ngoặc tròn (laughter)
    .replace(/\*[^*]*\*/g, '') // Xóa các ký tự nằm giữa dấu sao *giggles*
    .replace(/[♪♫🎵🎶♯♭]/g, '') // Xóa các ký hiệu nốt nhạc
    .replace(/\s+/g, ' ')
    .trim();

  // Kiểm tra nếu chuỗi chỉ còn lại ký tự đặc biệt/dấu câu mà không có chữ hoặc số
  // Sử dụng unicode flag u và \p{L} để bắt cả tiếng Việt và các ngôn ngữ khác
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    return '';
  }
  return cleaned;
}

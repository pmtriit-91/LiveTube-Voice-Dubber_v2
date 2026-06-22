import http from 'http';
import https from 'https';

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

// Từ điển Glossary mặc định chuyên ngành IT phục vụ Persona #1
const IT_GLOSSARY: Record<string, string> = {
  'React state': 'trạng thái React',
  'state management': 'quản lý trạng thái',
  'callback': 'hàm callback',
  'callback function': 'hàm gọi lại callback',
  'API endpoint': 'điểm cuối API',
  'database': 'cơ sở dữ liệu',
  'open source': 'mã nguồn mở',
  'developer': 'nhà phát triển',
  'loop': 'vòng lặp',
  'thread pool': 'hàng đợi luồng (thread pool)',
  'gradient descent': 'thuật toán gradient descent',
  'machine learning': 'học máy',
  'source code': 'mã nguồn',
  'programming language': 'ngôn ngữ lập trình',
  'web application': 'ứng dụng web'
};

/**
 * Hàm trì hoãn (sleep) hỗ trợ backoff
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gửi HTTP GET request dịch một đoạn text
 */
function fetchTranslation(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: 'en',
      tl: 'vi',
      dt: 't',
      q: text
    });

    const fullUrl = `${GOOGLE_TRANSLATE_URL}?${params.toString()}`;
    const client = fullUrl.startsWith('https') ? https : http;

    client.get(fullUrl, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Google API trả về mã lỗi: ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Định dạng response Google gtx: [[[translatedText, sourceText, ...]]]
          const translatedText = parsed[0]
            .map((item: Array<string | null>) => item[0])
            .filter(Boolean)
            .join('');
          resolve(translatedText);
        } catch (err) {
          reject(new Error(`Lỗi parse kết quả dịch: ${(err as Error).message}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Dịch một câu đơn lẻ có retry và exponential backoff
 */
export async function translateSingle(text: string, retries = 3): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let translated = await fetchTranslation(trimmed);
      
      // Áp dụng Glossary IT
      translated = applyGlossary(translated);
      return translated;
    } catch (error) {
      console.warn(`[Translator WARNING] Dịch thử lần ${attempt} thất bại cho câu: "${text.substring(0, 30)}...". Lỗi: ${(error as Error).message}`);
      if (attempt === retries) {
        console.error(`[Translator ERROR] Không thể dịch câu thoại sau ${retries} lần thử.`);
        return text; // Fallback trả về tiếng Anh gốc để không bị đơ app
      }
      // Exponential backoff: 1s, 2s...
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  return text;
}

/**
 * Dịch hàng loạt các câu thoại sử dụng giải thuật Batching & Fallback
 * @param sentences Mảng các câu tiếng Anh gốc
 * @param batchSize Số lượng câu tối đa ghép dịch trong 1 request
 */
export async function translateBatch(sentences: string[], batchSize = 25): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < sentences.length; i += batchSize) {
    const batch = sentences.slice(i, i + batchSize);
    console.log(`[Translator] Đang dịch batch từ câu ${i + 1} đến ${Math.min(i + batchSize, sentences.length)}...`);

    // Ghép các câu trong batch bằng dấu xuống dòng '\n' làm ký tự phân tách tự nhiên
    const combinedText = batch.join('\n');
    
    try {
      const translatedCombined = await translateSingle(combinedText);
      const translatedLines = translatedCombined.split('\n').map(s => s.trim());

      // Kiểm tra tính nhất quán: Số lượng dòng dịch trả về phải KHỚP số lượng dòng gửi đi
      if (translatedLines.length === batch.length) {
        results.push(...translatedLines);
      } else {
        console.warn(`[Translator WARNING] Số câu dịch trả về (${translatedLines.length}) không khớp với số câu gửi đi (${batch.length}). Chuyển sang dịch từng câu đơn lẻ cho batch này để đảm bảo an toàn.`);
        // Fallback: Dịch tuần tự từng câu một trong batch đó để bảo đảm tính chính xác của index
        for (const sentence of batch) {
          const singleResult = await translateSingle(sentence);
          results.push(singleResult);
        }
      }
    } catch (error) {
      console.error(`[Translator ERROR] Dịch batch thất bại, chuyển sang chế độ an toàn dịch đơn lẻ:`, error);
      for (const sentence of batch) {
        const singleResult = await translateSingle(sentence);
        results.push(singleResult);
      }
    }

    // Delay nhỏ giữa các batch để tránh bị Google coi là spam
    await sleep(200);
  }

  return results;
}

/**
 * Hàm đối chiếu thay thế Glossary
 */
function applyGlossary(text: string): string {
  let result = text;
  // Sắp xếp các từ khóa glossary theo chiều dài giảm dần để tránh thay thế đè các từ con
  const sortedTerms = Object.keys(IT_GLOSSARY).sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    // Tìm kiếm không phân biệt chữ hoa chữ thường
    const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    result = result.replace(regex, IT_GLOSSARY[term]);
  }
  
  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Gemini OCR + タイトル照合（api.json / books_database.csv 自動読込） */

/* DOM */
const video = document.getElementById('video');
const startCamBtn = document.getElementById('start-cam');
const captureBtn  = document.getElementById('capture-btn');
const imgFile     = document.getElementById('img-file');

const thresholdInput = document.getElementById('threshold');
const thresholdVal   = document.getElementById('thresholdVal');

const resultDiv  = document.getElementById('result');
const matchDiv   = document.getElementById('match');
const copyBtn    = document.getElementById('copy-btn');

const loadingOverlay = document.getElementById('loading-overlay');
const statusP        = document.getElementById('status');

const dbCountEl  = document.getElementById('db-count');
const dbErrorEl  = document.getElementById('db-error');
const reloadDbBtn= document.getElementById('reload-db');

const apiKeyInput= document.getElementById('api-key');
const toggleKey  = document.getElementById('toggle-key');
const apiHint    = document.getElementById('api-hint');

const canvas = document.getElementById('canvas');
const ctx     = canvas.getContext('2d');

/* 状態 */
let isProcessing = false;
let fuse = null;
let titles = []; // {raw, norm}

/* ---- Utils ---- */
function norm(s) {
  if (!s) return '';
  try { s = s.normalize('NFKC'); } catch {}
  s = s.replace(/[\s\u3000]+/g, ' ').trim();
  s = s.replace(/[\-‐–—―ー−_・･,，．。:：;；!！?？”“"'’()（）\[\]{}〈〉《》【】]/g, ' ');
  s = s.replace(/\s+/g, ' ').toLowerCase();
  return s;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function showStatus(m) {
  statusP.textContent = m;
  loadingOverlay.classList.remove('hidden');
  isProcessing = true;
  captureBtn.disabled = true;
}
function hideStatus() {
  loadingOverlay.classList.add('hidden');
  isProcessing = false;
  captureBtn.disabled = false;
}
function setDB(items) {
  titles = items;
  fuse = new Fuse(titles, {
    includeScore: true,
    keys: ['norm'],
    threshold: parseFloat(thresholdInput.value),
    distance: 100,
    minMatchCharLength: 2,
    ignoreLocation: true
  });
  dbCountEl.textContent = titles.length;
  dbErrorEl.textContent = '';
}
function buildItemsFromCsvText(csvText) {
  let rows = [];
  try {
    // まずヘッダありで
    let res = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    rows = res.data;
    // ヘッダなしを再試行（1列目をtitleとみなす）
    if (!rows.length || typeof rows[0]?.title === 'undefined') {
      res = Papa.parse(csvText, { header: false, skipEmptyLines: true });
      rows = res.data.map(arr => ({ title: Array.isArray(arr) ? arr[0] : arr }));
    }
  } catch (e) {
    console.error(e);
    dbErrorEl.textContent = 'CSV解析に失敗しました。UTF-8/改行コードをご確認ください。';
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const t = row && row.title != null ? String(row.title) : '';
    const tnorm = norm(t);
    if (!tnorm || seen.has(tnorm)) continue;
    seen.add(tnorm);
    out.push({ raw: t.trim(), norm: tnorm });
  }
  return out;
}

/* ---- 外部ファイルの自動読み込み ---- */
// 1) APIキー: api.json { "apiKey": "..." }
async function preloadApiKey() {
  try {
    const res = await fetch('./api.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const js = await res.json();
    const key = (js && typeof js.apiKey === 'string') ? js.apiKey.trim() : '';
    if (key) {
      apiKeyInput.value = key;
      apiHint.textContent = 'api.json からAPIキーを読み込みました。';
    } else {
      apiHint.textContent = 'api.json に apiKey が未設定です。手動入力してください。';
    }
  } catch (e) {
    apiHint.textContent = 'api.json を読み込めませんでした。手動入力してください。';
  }
}

// 2) タイトルDB: books_database.csv
async function loadCsvFromSameDir() {
  try {
    const res = await fetch('./books_database.csv', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const csvText = await res.text();
    const items = buildItemsFromCsvText(csvText);
    if (items.length === 0) {
      dbErrorEl.textContent = 'CSVに有効なタイトルが見つかりませんでした（ヘッダは title を推奨）。';
    }
    setDB(items);
  } catch (e) {
    console.error(e);
    dbErrorEl.textContent = 'books_database.csv を読み込めませんでした。同ディレクトリに配置してください。';
    setDB([]);
  }
}

/* ---- カメラ ---- */
async function initCamera() {
  showStatus('カメラを準備中…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
    hideStatus();
    captureBtn.disabled = false;
  } catch (e) {
    console.error(e);
    statusP.textContent = 'カメラにアクセスできません。権限設定を確認するか、画像選択をご利用ください。';
    loadingOverlay.classList.remove('hidden');
  }
}

/* ---- OCR (Gemini) ---- */
async function ocrWithGeminiFromCanvas() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('APIキーを入力してください。');

  // スマホでも過負荷にならない程度に縮小（長辺1280px）
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = 1280 / Math.max(vw, vh);
  const cw = Math.round(vw * (scale > 1 ? 1 : scale));
  const ch = Math.round(vh * (scale > 1 ? 1 : scale));

  canvas.width = cw;
  canvas.height = ch;
  ctx.drawImage(video, 0, 0, cw, ch);
  const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

  return await ocrWithGeminiBase64(base64, apiKey);
}

async function ocrWithGeminiFromFile(file) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('APIキーを入力してください。');

  const base64 = await fileToBase64Only(file);
  return await ocrWithGeminiBase64(base64, apiKey);
}

async function ocrWithGeminiBase64(base64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{
      parts: [
        { text: "あなたは日本語の文字起こしのプロフェッショナルです。この画像に含まれる日本語のテキストを、改行や句読点を含めて可能な限り正確に、一字一句違わずに書き出してください。テキスト以外の一切の説明や前置きは不要です。" },
        { inlineData: { mimeType: "image/jpeg", data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.1 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg += ' - ' + body.error.message;
    } catch {}
    throw new Error('Gemini APIエラー: ' + msg);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

function fileToBase64Only(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.split(',')[1] || '');
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---- 照合 ---- */
function renderMatch(ocrText) {
  if (!fuse || titles.length === 0) {
    matchDiv.innerHTML = '<div class="text-gray-500 text-sm">タイトルDBが未ロードです。</div>';
    return;
  }
  const ocrNorm = norm(ocrText);
  const exact = titles.find(t => t.norm === ocrNorm);
  const th = parseFloat(thresholdInput.value);
  const res = fuse.search(ocrNorm, { limit: 10 });

  let html = '';
  if (exact) {
    html += `<div class="mb-2 text-green-700 font-semibold">厳密一致：${escapeHtml(exact.raw)}</div>`;
  } else if (res.length) {
    const best = res[0];
    const conf = Math.max(0, 1 - best.score);
    const isHit = best.score <= th;
    html += isHit
      ? `<div class="mb-2 text-emerald-700 font-semibold">一致（ファジー）：${escapeHtml(best.item.raw)} <span class="text-xs text-emerald-800">(信頼度 ${(conf*100).toFixed(1)}%)</span></div>`
      : `<div class="mb-2 text-amber-700 font-semibold">候補（しきい値未満）：${escapeHtml(best.item.raw)} <span class="text-xs text-amber-800">(信頼度 ${(conf*100).toFixed(1)}%)</span></div>`;
  } else {
    html += `<div class="mb-2 text-gray-600">候補なし</div>`;
  }

  if (res.length) {
    html += `<div class="text-sm text-gray-700">候補上位：</div><ul class="list-disc pl-5 text-sm">`;
    for (const r of res.slice(0, 5)) {
      const c = Math.max(0, 1 - r.score);
      html += `<li>${escapeHtml(r.item.raw)} <span class="text-xs text-gray-500">(信頼度 ${(c*100).toFixed(1)}%)</span></li>`;
    }
    html += `</ul>`;
  }
  matchDiv.innerHTML = html;
}

/* ---- イベント ---- */
thresholdInput.addEventListener('input', () => {
  thresholdVal.textContent = thresholdInput.value;
  if (fuse) fuse.setOptions({ threshold: parseFloat(thresholdInput.value) });
});

copyBtn.addEventListener('click', () => {
  const text = resultDiv.textContent;
  if (!text || text.startsWith('エラー') || text.includes('表示されます')) return;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'COPIED!';
    setTimeout(() => (copyBtn.textContent = 'COPY'), 1200);
  });
});

toggleKey.addEventListener('click', () => {
  const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
  apiKeyInput.setAttribute('type', type);
  toggleKey.textContent = type === 'password' ? '表示' : '隠す';
});

startCamBtn.addEventListener('click', initCamera);

captureBtn.addEventListener('click', async () => {
  if (isProcessing) return;
  showStatus('AIが画像を認識中…');
  resultDiv.textContent = 'AIが画像を認識中…';
  copyBtn.classList.add('hidden');
  try {
    const text = await ocrWithGeminiFromCanvas();
    resultDiv.textContent = text || 'テキストが検出されませんでした。';
    if (text) copyBtn.classList.remove('hidden');
    renderMatch(text || '');
  } catch (e) {
    console.error(e);
    resultDiv.textContent = `エラー: ${e.message}`;
    matchDiv.innerHTML = '<div class="text-gray-500 text-sm">照合不可（OCRエラー）。</div>';
  } finally {
    hideStatus();
  }
});

imgFile.addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  if (!f || isProcessing) return;
  showStatus('AIが画像を認識中…');
  resultDiv.textContent = 'AIが画像を認識中…';
  copyBtn.classList.add('hidden');
  try {
    const text = await ocrWithGeminiFromFile(f);
    resultDiv.textContent = text || 'テキストが検出されませんでした。';
    if (text) copyBtn.classList.remove('hidden');
    renderMatch(text || '');
  } catch (e) {
    console.error(e);
    resultDiv.textContent = `エラー: ${e.message}`;
    matchDiv.innerHTML = '<div class="text-gray-500 text-sm">照合不可（OCRエラー）。</div>';
  } finally {
    hideStatus();
  }
});

reloadDbBtn.addEventListener('click', loadCsvFromSameDir);

/* ---- 起動 ---- */
(async function boot() {
  thresholdVal.textContent = thresholdInput.value;
  await preloadApiKey();        // api.json 読み込み（任意）
  await loadCsvFromSameDir();   // books_database.csv 自動ロード
  // カメラはユーザ操作で開始（自動再生制限対策）
})();

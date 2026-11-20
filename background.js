// ───────────────────────── Máy trạng thái ─────────────────────────
const TRANSITIONS = {
  IDLE:       { START: 'VALIDATING' },
  VALIDATING: { VALID: 'REQUESTING', INVALID: 'ERROR' },
  REQUESTING: { RECEIVED: 'SAVING', FAIL: 'ERROR', CANCEL: 'CANCELLED' },
  SAVING:     { SAVED: 'DONE', FAIL: 'ERROR' },
  DONE:       { START: 'VALIDATING', RESET: 'IDLE' },
  ERROR:      { START: 'VALIDATING', RESET: 'IDLE' },
  CANCELLED:  { START: 'VALIDATING', RESET: 'IDLE' }
};
const ACTIVE = ['VALIDATING', 'REQUESTING', 'SAVING'];

// Tên tiếng Việt của trạng thái và hoạt động
const STATE_VI = {
  IDLE: 'Sẵn sàng', VALIDATING: 'Kiểm tra', REQUESTING: 'Đang tạo ảnh',
  SAVING: 'Đang lưu', DONE: 'Đã lưu', ERROR: 'Lỗi', CANCELLED: 'Đã hủy'
};
const EVENT_VI = {
  START: 'Bắt đầu', VALID: 'Hợp lệ', INVALID: 'Không hợp lệ', RECEIVED: 'Nhận được ảnh',
  FAIL: 'Thất bại', CANCEL: 'Hủy', SAVED: 'Lưu xong', RESET: 'Làm mới'
};
const BADGE = {
  IDLE: ['', '#000'], VALIDATING: ['…', '#2457F5'], REQUESTING: ['…', '#2457F5'],
  SAVING: ['…', '#2457F5'], DONE: ['✓', '#17855A'], ERROR: ['!', '#C23B2E'], CANCELLED: ['', '#000']
};

// ───────────────────────── Cấu hình Beeknoee ─────────────────────────
const BEE_ORIGIN = 'https://platform.beeknoee.com';
const DEFAULTS = {
  apiKey: '',
  baseUrl: BEE_ORIGIN,
  model: 'recraft/recraft-v4.1-flash-v2', // ~$0.011 / ảnh
  aspect: '1:1',
  folder: 'AI-Images'
};
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

let current = null; // { controller, timedOut }

const getJob = async () => (await chrome.storage.session.get('job')).job ?? { state: 'IDLE' };
const getSettings = () => chrome.storage.local.get(DEFAULTS);

async function transition(event, patch = {}) {
  const job = await getJob();
  const next = TRANSITIONS[job.state]?.[event];
  if (!next) throw new Error(`Không thể "${EVENT_VI[event]}" khi đang ở trạng thái "${STATE_VI[job.state]}".`);
  const updated = { ...job, ...patch, state: next, updatedAt: Date.now() };
  if (next === 'ERROR') updated.failedAt = job.state;
  await chrome.storage.session.set({ job: updated });
  const [text, color] = BADGE[next];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  return updated;
}
async function updateJob(patch) {
  const job = await getJob();
  await chrome.storage.session.set({ job: { ...job, ...patch } });
}

// Service worker có thể bị khởi động lại giữa chừng → đánh dấu tiến trình mồ côi là lỗi.
const ready = (async () => {
  const job = await getJob();
  if (ACTIVE.includes(job.state) && !current) {
    await chrome.storage.session.set({
      job: { ...job, state: 'ERROR', failedAt: job.state, error: 'Tiến trình bị gián đoạn. Hãy thử lại.' }
    });
    chrome.action.setBadgeText({ text: '!' });
  }
})();

// ───────────────────────── Tiện ích ─────────────────────────
function slugify(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
}
const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return abort();
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function readApiError(res) {
  try {
    const body = await res.json();
    const msg = body?.error?.message ?? body?.message ?? body?.error ?? res.statusText;
    return `HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch {
    return `HTTP ${res.status}: ${res.statusText}`;
  }
}

async function validate(prompt, s) {
  if (!s.apiKey) return 'Chưa có API key Beeknoee. Mở phần Cài đặt để nhập.';
  if (!s.model) return 'Chưa nhập model.';
  if (!prompt || prompt.trim().length < 3) return 'Mô tả ảnh quá ngắn (tối thiểu 3 ký tự).';
  if (prompt.length > 4000) return 'Mô tả ảnh quá dài (tối đa 4000 ký tự).';
  if (!ASPECTS.includes(s.aspect)) return 'Tỉ lệ khung hình không hợp lệ.';
  let url;
  try { url = new URL(s.baseUrl); } catch { return 'Base URL không hợp lệ.'; }
  if (url.protocol !== 'https:') return 'Base URL phải dùng https.';
  if (url.origin !== BEE_ORIGIN) {
    const ok = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
    if (!ok) return `Chưa cấp quyền truy cập ${url.origin}. Lưu lại Cài đặt để cấp quyền.`;
  }
  return null;
}

// Lấy dữ liệu ảnh: hỗ trợ b64_json, đường dẫn tải của Beeknoee (cần Authorization) và URL tuyệt đối.
async function fetchImage(item, base, headers, signal) {
  if (item.b64_json) return { dataUrl: `data:image/png;base64,${item.b64_json}`, mime: 'image/png' };
  if (!item.url) throw new Error('API không trả về dữ liệu ảnh.');

  const candidates = item.url.startsWith('/') ? [`${base}${item.url}`, `${base}/api${item.url}`] : [item.url];
  let lastError = 'Không tải được ảnh.';
  for (const url of candidates) {
    const res = await fetch(url, { headers: url.startsWith(base) ? headers : {}, signal });
    if (res.ok) {
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      return { dataUrl: `data:${mime};base64,${toBase64(await res.arrayBuffer())}`, mime };
    }
    lastError = await readApiError(res);
  }
  throw new Error(lastError);
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const cleanup = () => chrome.downloads.onChanged.removeListener(onChanged);
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { cleanup(); resolve(); }
      if (d.state.current === 'interrupted') {
        cleanup(); reject(new Error(`Tải xuống bị gián đoạn (${d.error?.current ?? 'không rõ'}).`));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') { cleanup(); resolve(); }
    });
  });
}

// ───────────────────────── Luồng chính ─────────────────────────
async function startJob(prompt) {
  await chrome.storage.session.remove('preview');
  await transition('START', { prompt, error: null, savedTo: null, failedAt: null, elapsed: null, cost: null });

  const settings = await getSettings();
  const problem = await validate(prompt, settings);
  if (problem) return transition('INVALID', { error: problem });
  await transition('VALID');

  const base = new URL(settings.baseUrl).origin;
  const headers = { Authorization: `Bearer ${settings.apiKey}` };
  current = { controller: new AbortController(), timedOut: false };
  const { signal } = current.controller;
  const timer = setTimeout(() => { current.timedOut = true; current.controller.abort(); }, REQUEST_TIMEOUT_MS);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);

  try {
    // 1. Gửi yêu cầu tạo ảnh
    const res = await fetch(`${base}/v1/image/generations`, {
      method: 'POST',
      signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, prompt: prompt.trim(), aspect_ratio: settings.aspect })
    });
    if (!res.ok) throw new Error(await readApiError(res));
    let result = await res.json();

    // 2. Nếu đang xử lý (PROCESSING) thì hỏi lại cho tới khi COMPLETED hoặc FAILED
    const startedAt = Date.now();
    while (result.status === 'PROCESSING') {
      if (!result.job_id) throw new Error('Phản hồi thiếu job_id.');
      await sleep(POLL_INTERVAL_MS, signal);
      await updateJob({ elapsed: Math.round((Date.now() - startedAt) / 1000) });
      const poll = await fetch(`${base}/v1/image/generations/${result.job_id}`, { headers, signal });
      if (!poll.ok) throw new Error(await readApiError(poll));
      result = await poll.json();
    }
    if (result.status === 'FAILED') throw new Error(result.error_message || 'Nhà cung cấp báo lỗi khi tạo ảnh.');

    const item = result.data?.[0];
    if (!item) throw new Error('API không trả về ảnh.');
    const { dataUrl, mime } = await fetchImage(item, base, headers, signal);
    await transition('RECEIVED');

    // 3. Lưu tệp vào Tải xuống
    const ext = EXT_BY_MIME[mime] ?? 'png';
    const folder = settings.folder.replace(/[^\w\- ]/g, '').trim();
    const filename = `${folder ? folder + '/' : ''}${slugify(prompt)}-${timestamp()}.${ext}`;
    const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false });
    await waitForDownload(id);
    const [saved] = await chrome.downloads.search({ id });

    try { await chrome.storage.session.set({ preview: dataUrl }); } catch { /* ảnh quá lớn cho session storage */ }
    return await transition('SAVED', { savedTo: saved?.filename ?? filename, cost: result.cost_vnd ?? null });
  } catch (err) {
    const job = await getJob();
    if (err.name === 'AbortError' && !current.timedOut && job.state === 'REQUESTING') {
      return transition('CANCEL');
    }
    const message = current.timedOut
      ? 'Hết thời gian chờ (5 phút). Ảnh có thể vẫn được tạo, hãy kiểm tra Thư viện trên Beeknoee.'
      : err.message;
    if (job.state === 'REQUESTING' || job.state === 'SAVING') return transition('FAIL', { error: message });
    throw err;
  } finally {
    clearTimeout(timer);
    clearInterval(keepAlive);
    current = null;
  }
}

// ───────────────────────── Giao tiếp ─────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    try {
      if (msg.type === 'START') { startJob(msg.prompt).catch(console.error); }
      else if (msg.type === 'CANCEL') { current?.controller.abort(); }
      else if (msg.type === 'RESET') { await chrome.storage.session.remove('preview'); await transition('RESET'); }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'generate-from-selection',
    title: 'Tạo ảnh AI từ đoạn đã chọn',
    contexts: ['selection']
  });
});
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'generate-from-selection' || !info.selectionText) return;
  await ready;
  startJob(info.selectionText.slice(0, 4000)).catch(console.error);
});

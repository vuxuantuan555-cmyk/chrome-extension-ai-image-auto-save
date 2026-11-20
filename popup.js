const $ = (s) => document.querySelector(s);
const ORDER = ['VALIDATING', 'REQUESTING', 'SAVING', 'DONE'];
const ACTIVE = ['VALIDATING', 'REQUESTING', 'SAVING'];
const BEE_ORIGIN = 'https://platform.beeknoee.com';
const LABEL = {
  IDLE: 'Sẵn sàng', VALIDATING: 'Kiểm tra', REQUESTING: 'Đang tạo ảnh',
  SAVING: 'Đang lưu', DONE: 'Đã lưu', ERROR: 'Lỗi', CANCELLED: 'Đã hủy'
};
const DEFAULTS = {
  apiKey: '', baseUrl: BEE_ORIGIN, model: 'recraft/recraft-v4.1-flash-v2',
  aspect: '1:1', folder: 'AI-Images', draft: ''
};

const send = (msg) => chrome.runtime.sendMessage(msg);

function render(job = { state: 'IDLE' }, preview) {
  const state = job.state;
  const chip = $('#chip');
  chip.textContent = LABEL[state];
  chip.dataset.state = state;

  const reached = state === 'ERROR' ? ORDER.indexOf(job.failedAt) : ORDER.indexOf(state);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step);
    li.className = '';
    if (state === 'IDLE' || state === 'CANCELLED') return;
    if (state === 'DONE') li.classList.add('done');
    else if (i < reached) li.classList.add('done');
    else if (i === reached) li.classList.add(state === 'ERROR' ? 'failed' : 'current', ...(state === 'ERROR' ? [] : ['pulse']));
  });

  const busy = ACTIVE.includes(state);
  $('#generate').disabled = busy;
  $('#prompt').disabled = busy;
  $('#cancel').hidden = state !== 'REQUESTING';

  const elapsed = $('#elapsed');
  elapsed.hidden = !(state === 'REQUESTING' && job.elapsed);
  elapsed.textContent = job.elapsed ? `Đã chờ ${job.elapsed} giây…` : '';

  const err = $('#error');
  err.hidden = state !== 'ERROR';
  err.textContent = job.error ?? '';

  const done = state === 'DONE';
  $('#result').hidden = !done;
  if (done) {
    $('#savedTo').textContent = job.savedTo ?? '';
    $('#preview').hidden = !preview;
    if (preview) $('#preview').src = preview;
    const cost = $('#cost');
    cost.hidden = job.cost == null;
    cost.textContent = job.cost == null ? '' : `Chi phí: ${Number(job.cost).toLocaleString('vi-VN')}đ`;
  }
  if (job.prompt && $('#prompt').value === '') $('#prompt').value = job.prompt;
}

async function refresh() {
  const { job, preview } = await chrome.storage.session.get(['job', 'preview']);
  render(job, preview);
}

async function init() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of ['apiKey', 'baseUrl', 'model', 'folder']) $('#' + k).value = s[k];
  $('#aspect').value = s.aspect;
  $('#prompt').value = s.draft;
  if (!s.apiKey) $('#settings').open = true;
  await refresh();
}

chrome.storage.onChanged.addListener((_c, area) => { if (area === 'session') refresh(); });

$('#prompt').addEventListener('input', (e) => chrome.storage.local.set({ draft: e.target.value }));
$('#aspect').addEventListener('change', (e) => chrome.storage.local.set({ aspect: e.target.value }));

$('#generate').addEventListener('click', async () => {
  await chrome.storage.local.set({ aspect: $('#aspect').value });
  await send({ type: 'START', prompt: $('#prompt').value });
});
$('#cancel').addEventListener('click', () => send({ type: 'CANCEL' }));
$('#again').addEventListener('click', async () => {
  $('#prompt').value = '';
  chrome.storage.local.set({ draft: '' });
  await send({ type: 'RESET' });
});

$('#save').addEventListener('click', async () => {
  const msg = $('#saveMsg');
  const show = (text, bad) => { msg.hidden = false; msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  let origin;
  try {
    const url = new URL($('#baseUrl').value.trim());
    if (url.protocol !== 'https:') throw new Error();
    origin = url.origin;
  } catch { return show('Base URL phải là URL https hợp lệ.', true); }

  if (origin !== BEE_ORIGIN) {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return show('Cần cấp quyền truy cập domain này để gọi API.', true);
  }
  await chrome.storage.local.set({
    apiKey: $('#apiKey').value.trim(),
    baseUrl: origin,
    model: $('#model').value.trim(),
    folder: $('#folder').value.trim()
  });
  $('#baseUrl').value = origin;
  show('Đã lưu cài đặt.');
});

init();

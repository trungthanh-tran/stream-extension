// Popup: liệt kê video phát hiện trong trang (mọi frame) và URL media bắt được qua mạng.
function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}

function nameFromUrl(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || u); } catch (e) { return u; }
}

function section(title, items, render) {
  if (!items.length) return null;
  const h = document.createElement('h2'); h.textContent = title;
  const ul = document.createElement('ul');
  for (const it of items) ul.appendChild(render(it));
  const frag = document.createDocumentFragment();
  frag.appendChild(h); frag.appendChild(ul);
  return frag;
}

function row(name, meta, onClick) {
  const li = document.createElement('li');
  const t = document.createElement('div'); t.className = 't';
  const n = document.createElement('div'); n.className = 'n'; n.textContent = name; n.title = name;
  const m = document.createElement('div'); m.className = 'm'; m.textContent = meta; m.title = meta;
  t.appendChild(n); t.appendChild(m);
  const b = document.createElement('button'); b.textContent = 'Tải về';
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Đang tải…';
    try { await onClick(); b.textContent = 'Đã gửi'; }
    catch (e) { b.textContent = 'Lỗi'; b.title = e && e.message; }
    setTimeout(() => { b.disabled = false; b.textContent = 'Tải về'; }, 3000);
  });
  li.appendChild(t); li.appendChild(b);
  return li;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const box = document.getElementById('list');
  if (!tab) return;

  // 1) Video trong DOM của từng frame.
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0 }]);
  const domVideos = [];
  for (const f of frames || [{ frameId: 0 }]) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'listVideos' }, { frameId: f.frameId });
      for (const v of (r && r.videos) || []) domVideos.push({ ...v, frameId: f.frameId });
    } catch (e) { /* frame không có content script */ }
  }
  // 2) URL media bắt được qua mạng.
  const cap = await chrome.runtime.sendMessage({ type: 'getCapturedMedia', tabId: tab.id });
  const media = ((cap && cap.list) || []).slice().reverse();

  const s1 = section('Video trên trang', domVideos, v => row(
    v.title || 'video',
    [v.w && v.h ? v.w + '×' + v.h : '', fmtDur(v.duration), v.src === 'blob:' ? 'blob/stream' : v.src].filter(Boolean).join(' · '),
    () => chrome.tabs.sendMessage(tab.id, { type: 'clickVideo', key: v.key }, { frameId: v.frameId })
  ));
  const s2 = section('Media bắt được qua mạng', media.filter(m => m.kind !== 'dash'), m => row(
    nameFromUrl(m.url),
    (m.kind === 'hls' ? 'HLS · ' : '') + m.url,
    async () => {
      const name = nameFromUrl(m.url).replace(/\.[a-z0-9]{2,5}$/i, '') || tab.title || 'video';
      const ext = (m.url.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1] || '';
      const r = await chrome.runtime.sendMessage(m.kind === 'hls'
        ? { type: 'downloadHls', url: m.url, filename: name, tabId: tab.id, key: 'popup', pageUrl: tab.url }
        : { type: 'download', url: m.url, filename: name, ext, pageUrl: tab.url });
      if (r && r.error) throw new Error(r.error);
    }
  ));
  if (!s1 && !s2) {
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = 'Chưa phát hiện video. Hãy phát video rồi mở lại.';
    box.appendChild(d);
  }
  if (s1) box.appendChild(s1);
  if (s2) box.appendChild(s2);
}
main();

// Content script: phát hiện <video> trên trang và phủ nút "Tải về" (và "Ghi" cho video MediaSource) lên mỗi video.
(() => {
  if (window.__vtvLoaded) return;
  window.__vtvLoaded = true;

  const MIN_W = 100, MIN_H = 60;
  const root = document.createElement('div');
  root.id = 'vtv-overlay-root';
  const entries = new Map(); // video -> entry
  let rafPending = false;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';
  const ICON_REC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>';

  function ensureRoot() {
    if (!root.isConnected) (document.documentElement || document.body).appendChild(root);
  }

  function sanitize(name) {
    return (name || 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
  }

  function extOf(url) {
    try {
      const p = new URL(url, location.href).pathname.toLowerCase();
      const m = p.match(/\.([a-z0-9]{2,5})$/);
      if (m) return m[1];
    } catch (e) { /* ignore */ }
    return '';
  }

  function fmtBytes(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function directSrc(video) {
    const cands = [video.currentSrc, video.src];
    for (const s of video.querySelectorAll('source')) cands.push(s.src || s.getAttribute('src'));
    for (const c of cands) {
      if (!c) continue;
      if (c.startsWith('blob:') || c.startsWith('data:')) continue;
      try { return new URL(c, location.href).href; } catch (e) { /* ignore */ }
    }
    return null;
  }

  function hasBlob(video) {
    const s = video.currentSrc || video.src || '';
    return s.startsWith('blob:') || (!s && !!video.srcObject);
  }

  function labelFor(video) {
    const w = video.videoWidth, h = video.videoHeight;
    return w && h ? w + '×' + h : '';
  }

  function baseName(video, url) {
    let name = '';
    if (url) {
      try {
        const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
        name = decodeURIComponent(seg.replace(/\.[a-z0-9]{2,5}$/i, ''));
      } catch (e) { /* ignore */ }
    }
    if (!name || /^(index|master|playlist|video|media|manifest|\d+)$/i.test(name)) {
      name = (document.title || location.hostname || 'video').trim();
    }
    return sanitize(name);
  }

  // ---------- Giao tiếp với inject.js (MAIN world) ----------
  let reqSeq = 0;
  const pending = new Map();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || typeof ev.data.__vtv !== 'string') return;
    if (ev.data.__vtv !== 'mse-status' && ev.data.__vtv !== 'mse-data') return;
    const p = pending.get(ev.data.reqId);
    if (p) { pending.delete(ev.data.reqId); p(ev.data); }
  });
  function askPage(cmd, key, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      window.postMessage({ __vtv: 'mse', cmd, key, reqId }, '*');
      setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve(null); } }, timeoutMs || 3000);
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // Gửi dữ liệu MediaSource sang offscreen qua Port (base64 từng khúc 2 MB).
  async function sendMseToOffscreen(entry, data, name) {
    const total = data.buffers.reduce((s, b) => s + b.chunks.reduce((t, c) => t + c.byteLength, 0), 0);
    if (!total) throw new Error('Chưa ghi được dữ liệu. Hãy phát video rồi thử lại.');
    await chrome.runtime.sendMessage({ type: 'ensureOffscreen' });
    const port = chrome.runtime.connect({ name: 'vtv-mse' });
    const CH = 2 * 1024 * 1024;
    let sent = 0;
    port.postMessage({ type: 'begin', key: entry.key, filename: name, total });
    for (const b of data.buffers) {
      port.postMessage({ type: 'buffer', mime: b.mime });
      const blob = new Blob(b.chunks);
      for (let off = 0; off < blob.size; off += CH) {
        const b64 = await blobToBase64(blob.slice(off, Math.min(off + CH, blob.size)));
        port.postMessage({ type: 'chunk', b64 });
        sent += Math.min(CH, blob.size - off);
        setState(entry, 'vtv-busy', 'Đang chuyển ' + Math.round(sent * 100 / total) + '%');
      }
    }
    port.postMessage({ type: 'end' });
    port.disconnect();
  }

  function setState(entry, cls, text, ms) {
    const btn = entry.btn;
    btn.className = 'vtv-btn' + (cls ? ' ' + cls : '');
    btn.innerHTML = ICON + '<span></span>';
    btn.lastChild.textContent = text;
    clearTimeout(entry.timer);
    if (ms) entry.timer = setTimeout(() => render(entry), ms);
  }

  function render(entry) {
    const info = labelFor(entry.video);
    entry.btn.className = 'vtv-btn';
    entry.btn.innerHTML = ICON + '<span>Tải về</span>' + (info ? '<span class="vtv-info">' + info + '</span>' : '');
  }

  function renderRec(entry) {
    const b = entry.recBtn;
    if (!entry.mseBytes) { b.style.display = 'none'; return; }
    b.className = 'vtv-btn vtv-rec';
    b.innerHTML = ICON_REC + '<span>Ghi</span><span class="vtv-info"></span>';
    b.lastChild.textContent = fmtBytes(entry.mseBytes) + (entry.video.ended ? ' ✓' : '');
  }

  async function refreshMse(entry) {
    if (!hasBlob(entry.video)) { entry.mseBytes = 0; renderRec(entry); return; }
    const st = await askPage('status', entry.key, 1500);
    entry.mseBytes = st ? st.buffers.reduce((s, b) => s + b.bytes, 0) : 0;
    if (!entry.busy) renderRec(entry);
    if (visible(entry.video)) position(entry);
  }

  async function resolveTarget(video) {
    let url = directSrc(video);
    if (url) return { url, kind: extOf(url) === 'm3u8' ? 'hls' : extOf(url) === 'mpd' ? 'dash' : 'direct' };
    // Video dùng blob/MSE: hỏi background lấy URL media đã bắt được qua mạng.
    const res = await chrome.runtime.sendMessage({ type: 'getCapturedMedia' });
    const list = (res && res.list) || [];
    const direct = list.filter(x => x.kind === 'direct').pop();
    const hls = list.filter(x => x.kind === 'hls').pop();
    const dash = list.filter(x => x.kind === 'dash').pop();
    const pick = direct || hls || dash;
    if (pick) return { url: pick.url, kind: pick.kind };
    return { url: null, kind: 'mse' };
  }

  async function saveMse(entry) {
    const data = await askPage('get', entry.key, 20000);
    if (!data || !data.buffers.length) throw new Error('Không có dữ liệu MediaSource. Hãy phát video rồi thử lại.');
    const name = baseName(entry.video, null);
    await sendMseToOffscreen(entry, data, name);
  }

  async function onClick(entry) {
    const video = entry.video;
    if (entry.busy) return;
    entry.busy = true;
    setState(entry, 'vtv-busy', 'Đang xử lý…');
    try {
      const { url, kind } = await resolveTarget(video);
      if (kind === 'mse') {
        // Không bắt được gì qua mạng: dùng dữ liệu MediaSource đã ghi.
        await saveMse(entry);
        return; // chờ tiến trình qua message 'hlsProgress'
      }
      const name = baseName(video, url);
      const res = await chrome.runtime.sendMessage({
        type: kind === 'hls' ? 'downloadHls' : kind === 'dash' ? 'downloadDash' : 'download',
        url, filename: name, ext: kind === 'direct' ? extOf(url) : '', key: entry.key, pageUrl: location.href
      });
      if (res && res.error) throw new Error(res.error);
      if (kind === 'direct' && !(res && res.via === 'fetch')) { setState(entry, 'vtv-ok', 'Đã bắt đầu tải', 2500); entry.busy = false; }
    } catch (e) {
      setState(entry, 'vtv-err', (e && e.message) || 'Lỗi', 5000);
      entry.busy = false;
    }
  }

  async function onRecClick(entry) {
    if (entry.busy) return;
    entry.busy = true;
    setState(entry, 'vtv-busy', 'Đang lấy dữ liệu…');
    try { await saveMse(entry); }
    catch (e) { setState(entry, 'vtv-err', (e && e.message) || 'Lỗi', 5000); entry.busy = false; }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'hlsProgress') {
      for (const entry of entries.values()) {
        if (entry.key !== msg.key) continue;
        if (msg.error) { setState(entry, 'vtv-err', msg.error, 6000); entry.busy = false; }
        else if (msg.done) { setState(entry, 'vtv-ok', 'Đã tải xong', 3000); entry.busy = false; }
        else if (msg.text) setState(entry, 'vtv-busy', msg.text);
        else setState(entry, 'vtv-busy', 'Đang tải ' + msg.pct + (typeof msg.pct === 'number' ? '%' : ''));
      }
    } else if (msg.type === 'listVideos') {
      const out = [];
      for (const entry of entries.values()) {
        const v = entry.video;
        const src = directSrc(v);
        out.push({ src: src || (hasBlob(v) ? 'blob:' : ''), w: v.videoWidth, h: v.videoHeight, duration: v.duration || 0, key: entry.key, title: baseName(v, src), mseBytes: entry.mseBytes || 0 });
      }
      sendResponse({ videos: out, frame: location.href });
    } else if (msg.type === 'clickVideo') {
      for (const entry of entries.values()) if (entry.key === msg.key) onClick(entry);
      sendResponse({ ok: true });
    } else if (msg.type === 'recVideo') {
      for (const entry of entries.values()) if (entry.key === msg.key) onRecClick(entry);
      sendResponse({ ok: true });
    }
    return false;
  });

  function visible(video) {
    const r = video.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(video);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
  }

  function position(entry) {
    const r = entry.video.getBoundingClientRect();
    const left = Math.max(0, r.left + 8), top = Math.max(0, r.top + 8);
    entry.btn.style.left = left + 'px';
    entry.btn.style.top = top + 'px';
    entry.recBtn.style.left = (left + entry.btn.offsetWidth + 6) + 'px';
    entry.recBtn.style.top = top + 'px';
  }

  function attach(video) {
    if (entries.has(video)) return;
    const key = Math.random().toString(36).slice(2);
    video.setAttribute('data-vtv-key', key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Tải video này về máy';
    const recBtn = document.createElement('button');
    recBtn.type = 'button';
    recBtn.title = 'Lưu phần video đã phát (ghi từ MediaSource). Phát hết video để đủ nội dung.';
    recBtn.style.display = 'none';
    const entry = { video, btn, recBtn, key, busy: false, timer: null, mseBytes: 0 };
    btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(entry); });
    btn.addEventListener('mousedown', ev => ev.stopPropagation());
    recBtn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onRecClick(entry); });
    recBtn.addEventListener('mousedown', ev => ev.stopPropagation());
    render(entry);
    entries.set(video, entry);
    root.appendChild(btn);
    root.appendChild(recBtn);
    video.addEventListener('loadedmetadata', () => { if (!entry.busy) render(entry); });
  }

  function collectVideos(node, out) {
    for (const v of node.querySelectorAll('video')) out.push(v);
    for (const el of node.querySelectorAll('*')) if (el.shadowRoot) collectVideos(el.shadowRoot, out);
  }

  function layout() {
    for (const entry of entries.values()) {
      if (visible(entry.video)) {
        entry.btn.style.display = 'flex';
        entry.recBtn.style.display = entry.mseBytes ? 'flex' : 'none';
        position(entry);
      } else { entry.btn.style.display = 'none'; entry.recBtn.style.display = 'none'; }
    }
  }

  function scan() {
    ensureRoot();
    const found = [];
    collectVideos(document, found);
    const set = new Set(found);
    for (const v of found) attach(v);
    for (const [v, entry] of entries) {
      if (!set.has(v) || !v.isConnected) { entry.btn.remove(); entry.recBtn.remove(); entries.delete(v); }
    }
    layout();
  }

  function scheduleLayout() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; layout(); });
  }

  let scanTimer = null;
  function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); }

  document.addEventListener('fullscreenchange', () => { root.style.display = document.fullscreenElement ? 'none' : ''; });
  addEventListener('scroll', scheduleLayout, true);
  addEventListener('resize', scheduleLayout);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class']
  });
  setInterval(scan, 1500);
  setInterval(() => { for (const entry of entries.values()) refreshMse(entry); }, 2000);
  scan();
})();

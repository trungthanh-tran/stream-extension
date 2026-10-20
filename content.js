// Content script: phát hiện <video> trên trang và phủ nút "Tải về" lên mỗi video.
(() => {
  if (window.__vtvLoaded) return;
  window.__vtvLoaded = true;

  const MIN_W = 100, MIN_H = 60;
  const root = document.createElement('div');
  root.id = 'vtv-overlay-root';
  const entries = new Map(); // video -> entry
  let rafPending = false;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';

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

  async function resolveTarget(video) {
    let url = directSrc(video);
    let kind = 'direct';
    if (url) {
      if (extOf(url) === 'm3u8') kind = 'hls';
      return { url, kind };
    }
    // Video dùng blob/MSE: hỏi background lấy URL media đã bắt được qua mạng.
    const res = await chrome.runtime.sendMessage({ type: 'getCapturedMedia' });
    const list = (res && res.list) || [];
    if (!list.length) throw new Error('Không tìm thấy URL video (blob/DRM). Hãy phát video vài giây rồi thử lại.');
    const direct = list.filter(x => x.kind === 'direct').pop();
    const hls = list.filter(x => x.kind === 'hls').pop();
    const pick = direct || hls;
    if (!pick) throw new Error('Chỉ bắt được DASH/DRM, chưa hỗ trợ.');
    return { url: pick.url, kind: pick.kind };
  }

  async function onClick(entry) {
    const video = entry.video;
    if (entry.busy) return;
    entry.busy = true;
    setState(entry, 'vtv-busy', 'Đang xử lý…');
    try {
      const { url, kind } = await resolveTarget(video);
      const name = baseName(video, url);
      const res = await chrome.runtime.sendMessage({
        type: kind === 'hls' ? 'downloadHls' : 'download',
        url, filename: name, ext: kind === 'hls' ? '' : (extOf(url) || 'mp4'), key: entry.key
      });
      if (res && res.error) throw new Error(res.error);
      if (kind !== 'hls') { setState(entry, 'vtv-ok', 'Đã bắt đầu tải', 2500); entry.busy = false; }
      // HLS: chờ tiến trình qua message 'hlsProgress'.
    } catch (e) {
      setState(entry, 'vtv-err', (e && e.message) || 'Lỗi', 5000);
      entry.busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'hlsProgress') {
      for (const entry of entries.values()) {
        if (entry.key !== msg.key) continue;
        if (msg.error) { setState(entry, 'vtv-err', msg.error, 6000); entry.busy = false; }
        else if (msg.done) { setState(entry, 'vtv-ok', 'Đã tải xong', 3000); entry.busy = false; }
        else setState(entry, 'vtv-busy', 'Đang tải ' + msg.pct + '%');
      }
    } else if (msg.type === 'listVideos') {
      const out = [];
      for (const entry of entries.values()) {
        const v = entry.video;
        const src = directSrc(v);
        out.push({ src: src || (hasBlob(v) ? 'blob:' : ''), w: v.videoWidth, h: v.videoHeight, duration: v.duration || 0, key: entry.key, title: baseName(v, src) });
      }
      sendResponse({ videos: out, frame: location.href });
    } else if (msg.type === 'clickVideo') {
      for (const entry of entries.values()) if (entry.key === msg.key) onClick(entry);
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
    entry.btn.style.left = Math.max(0, r.left + 8) + 'px';
    entry.btn.style.top = Math.max(0, r.top + 8) + 'px';
  }

  function attach(video) {
    if (entries.has(video)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Tải video này về máy';
    const entry = { video, btn, key: Math.random().toString(36).slice(2), busy: false, timer: null };
    btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(entry); });
    btn.addEventListener('mousedown', ev => ev.stopPropagation());
    render(entry);
    entries.set(video, entry);
    root.appendChild(btn);
    video.addEventListener('loadedmetadata', () => { if (!entry.busy) render(entry); });
  }

  function collectVideos(node, out) {
    for (const v of node.querySelectorAll('video')) out.push(v);
    // Quét cả shadow DOM mở.
    for (const el of node.querySelectorAll('*')) if (el.shadowRoot) collectVideos(el.shadowRoot, out);
  }

  function layout() {
    for (const entry of entries.values()) {
      if (visible(entry.video)) { entry.btn.style.display = 'flex'; position(entry); }
      else entry.btn.style.display = 'none';
    }
  }

  function scan() {
    ensureRoot();
    const found = [];
    collectVideos(document, found);
    const set = new Set(found);
    for (const v of found) attach(v);
    for (const [v, entry] of entries) {
      if (!set.has(v) || !v.isConnected) { entry.btn.remove(); entries.delete(v); }
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

  // Khi fullscreen, overlay nằm ngoài phần tử fullscreen nên ẩn đi.
  document.addEventListener('fullscreenchange', () => { root.style.display = document.fullscreenElement ? 'none' : ''; });
  addEventListener('scroll', scheduleLayout, true);
  addEventListener('resize', scheduleLayout);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class']
  });
  setInterval(scan, 1500);
  scan();
})();

// Content script (chỉ frame chính): phát hiện "cả bộ" (nhiều tập) trên trang và gợi ý tải cả bộ.
// Lớp A: trang nhúng sẵn danh sách URL media (mp4/m3u8/mpd) cùng mẫu, chỉ khác số.
// Lớp B: các link <a> cùng mẫu chỉ khác số tập (ví dụ /play/17711/1 ... /play/17711/50).
(() => {
  if (window.__vtvSeriesLoaded || window.top !== window) return;
  window.__vtvSeriesLoaded = true;

  const MEDIA_RE = /https?:\/\/[^\s"'<>\\]+?\.(mp4|m3u8|webm|mpd)(\?[^\s"'<>\\]*)?/gi;
  let panel = null, lastSig = '', closedSig = '', running = false, lastScan = 0;

  function sanitize(name) {
    return (name || 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';
  }
  function seriesTitle() {
    let t = (document.title || location.hostname).split(/\s[-|–—]\s/)[0].trim();
    return sanitize(t);
  }

  // Gom các chuỗi theo mẫu: thay từng cụm số bằng '#', cụm số khác nhau ở đúng một vị trí.
  function groupByTemplate(items) {
    // items: [{ url, text }]
    const groups = new Map();
    for (const it of items) {
      const nums = [];
      const key = it.url.replace(/\d+/g, (m) => { nums.push(m); return '#'; });
      if (!nums.length) continue;
      let g = groups.get(key);
      if (!g) { g = { key, members: [] }; groups.set(key, g); }
      g.members.push({ ...it, nums });
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.members.length < 3) continue;
      const n = g.members[0].nums.length;
      // Tìm vị trí số biến thiên (chỉ chấp nhận đúng một vị trí thay đổi).
      let varyIdx = -1, ok = true;
      for (let i = 0; i < n; i++) {
        const vals = new Set(g.members.map(m => m.nums[i]));
        if (vals.size > 1) { if (varyIdx >= 0) { ok = false; break; } varyIdx = i; }
      }
      if (!ok || varyIdx < 0) continue;
      const seen = new Set();
      const eps = [];
      for (const m of g.members) {
        const num = parseInt(m.nums[varyIdx], 10);
        if (seen.has(num)) continue;
        seen.add(num);
        eps.push({ url: m.url, num, text: m.text || '' });
      }
      if (eps.length < 3) continue;
      eps.sort((a, b) => a.num - b.num);
      out.push({ key: g.key, eps });
    }
    return out.sort((a, b) => b.eps.length - a.eps.length);
  }

  function scanEmbeddedMedia() {
    let html = '';
    try { html = document.documentElement.outerHTML; } catch (e) { return []; }
    if (html.length > 6 * 1024 * 1024) html = html.slice(0, 6 * 1024 * 1024);
    html = html.replace(/\\\//g, '/');
    const urls = new Set();
    let m;
    MEDIA_RE.lastIndex = 0;
    while ((m = MEDIA_RE.exec(html))) {
      const u = m[0].replace(/&amp;/g, '&');
      if (/\.(ts|m4s)(\?|$)/i.test(u)) continue;
      urls.add(u);
    }
    // Gom theo thư mục (URL tới dấu '/' cuối): cùng thư mục, >= 3 file là nghi ngờ một bộ.
    // Số tập lấy từ cụm số đầu tiên trong tên file (001_abc.mp4, ep12.m3u8...); không có số thì theo thứ tự xuất hiện.
    const byDir = new Map();
    for (const u of urls) {
      const q = u.split('?')[0];
      const i = q.lastIndexOf('/');
      if (i < 10) continue;
      const dir = q.slice(0, i), file = q.slice(i + 1);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ url: u, file });
    }
    let best = null;
    for (const [dir, files] of byDir) {
      if (files.length < 3) continue;
      const nums = files.map(f => { const mm = /\d+/.exec(f.file); return mm ? parseInt(mm[0], 10) : NaN; });
      const numbered = nums.every(n => !isNaN(n)) && new Set(nums).size === nums.length;
      const eps = files.map((f, idx) => ({ url: f.url, num: numbered ? nums[idx] : idx + 1, text: '' })).sort((a, b) => a.num - b.num);
      if (!best || eps.length > best.eps.length) best = { kind: 'media', eps, dir };
    }
    return best ? [best] : [];
  }

  // Nhãn kiểu tập: 第01集, 第1话, Tập 1, Tap 01, Episode 3, Ep.3, EP03, E03, 1 (số thuần)
  const EP_TEXT_RE = /^(?:第\s*0*(\d{1,4})\s*[集话話回]?|t[ậa]p\s*0*(\d{1,4})|ep(?:isode)?\.?\s*0*(\d{1,4})|e0*(\d{1,4})|(\d{1,4}))\s*$/i;
  const EP_LOOSE_RE = /(?:第\s*0*(\d{1,4})\s*[集话話回]|t[ậa]p\s*0*(\d{1,4})|ep(?:isode)?\.?\s*0*(\d{1,4})\b)/i;
  const HINT_RE = /(episode|epis|ep[-_]?list|tap|tập|chapter|playlist|server|list|dram|video)/i;

  function epNumber(text) {
    let m = EP_TEXT_RE.exec(text);
    if (m) { for (let i = 1; i < m.length; i++) if (m[i] != null) return { num: parseInt(m[i], 10), pure: i === 5 }; }
    m = EP_LOOSE_RE.exec(text);
    if (m) { for (let i = 1; i < m.length; i++) if (m[i] != null) return { num: parseInt(m[i], 10), pure: false }; }
    return null;
  }

  function containerHint(a) {
    let n = a, depth = 0;
    while (n && n.nodeType === 1 && depth < 6) {
      const sig = (n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '');
      if (HINT_RE.test(sig)) return true;
      n = n.parentElement; depth++;
    }
    return false;
  }

  function collectLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let href;
      try { href = new URL(a.getAttribute('href'), location.href).href; } catch (e) { continue; }
      if (!/^https?:/.test(href)) continue;
      href = href.replace(/[#].*$/, '');
      let host = '';
      try { host = new URL(href).host; } catch (e) { continue; }
      if (host !== location.host) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      out.push({ url: href, text, a });
    }
    return out;
  }

  // Lớp B1: URL cùng mẫu, khác đúng một số.
  function byUrlTemplate(links) {
    const cur = location.href.replace(/[#?].*$/, '').replace(/\/$/, '');
    const results = [];
    for (const g of groupByTemplate(links)) {
      const hasCur = g.eps.some(e => e.url.replace(/\/$/, '') === cur);
      const nums = g.eps.map(e => { const r = epNumber(e.text); return r ? r.num : NaN; });
      const seq = nums.every(n => !isNaN(n)) && nums.every((n, i) => i === 0 || n > nums[i - 1]);
      if (hasCur || seq) results.push({ kind: 'page', eps: g.eps, score: g.eps.length + (hasCur ? 100 : 0) + (seq ? 50 : 0) });
    }
    return results;
  }

  // Lớp B2: nhãn link trông như số tập (URL bất kỳ, kể cả slug không có số).
  function byLabel(links) {
    const groups = new Map(); // parent element -> items
    for (const l of links) {
      const r = epNumber(l.text);
      if (!r) continue;
      if (r.pure && !containerHint(l.a)) continue; // số thuần chỉ tính khi vùng chứa gợi ý danh sách tập (tránh phân trang)
      // Gom theo ông/cha gần nhất có nhiều link con để các tập nằm chung một khối.
      let parent = l.a.parentElement, depth = 0;
      while (parent && depth < 4 && parent.querySelectorAll('a[href]').length < 3) { parent = parent.parentElement; depth++; }
      const k = parent || document.body;
      if (!groups.has(k)) groups.set(k, new Map());
      const m = groups.get(k);
      if (!m.has(r.num)) m.set(r.num, { url: l.url, num: r.num, text: l.text });
    }
    const results = [];
    for (const m of groups.values()) {
      const eps = [...m.values()].sort((a, b) => a.num - b.num);
      const distinctUrls = new Set(eps.map(e => e.url)).size;
      if (eps.length < 3 || distinctUrls < 3) continue;
      const pure = eps.every(e => /^\d+$/.test(e.text));
      if (pure && eps.length < 4) continue;
      results.push({ kind: 'page', eps, score: eps.length + 30 });
    }
    return results;
  }

  function scanEpisodeLinks() {
    const links = collectLinks();
    const results = [...byUrlTemplate(links), ...byLabel(links)];
    results.sort((a, b) => b.score - a.score);
    return results.length ? [results[0]] : [];
  }

  function detect() {
    const a = scanEmbeddedMedia();
    const b = scanEpisodeLinks();
    // Ưu tiên lớp A nếu số tập không ít hơn lớp B (tải thẳng, không phải mở tab).
    if (a.length && (!b.length || a[0].eps.length >= b[0].eps.length)) return a[0];
    return b[0] || null;
  }

  // ---------------- Ghi file vào thư mục đã chọn (nhận dữ liệu từ offscreen qua Port) ----------------
  let dirHandle = null, sinkPort = null;
  function ensureSinkPort() {
    if (sinkPort) return;
    sinkPort = chrome.runtime.connect({ name: 'vtv-sink' });
    const files = new Map(); // fileId -> writable
    let chain = Promise.resolve();
    const ack = (m, error) => { try { sinkPort.postMessage({ type: 'ack', token: m.token, error }); } catch (e) { /* ignore */ } };
    sinkPort.onMessage.addListener((m) => {
      chain = chain.then(async () => {
        try {
          if (m.type === 'open') {
            if (!dirHandle) throw new Error('Chưa chọn thư mục');
            const h = await dirHandle.getFileHandle(sanitize(m.name), { create: true });
            files.set(m.fileId, await h.createWritable());
          } else if (m.type === 'chunk') {
            const w = files.get(m.fileId); if (!w) throw new Error('File chưa mở');
            const bin = atob(m.b64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await w.write(bytes);
          } else if (m.type === 'close') {
            const w = files.get(m.fileId); files.delete(m.fileId);
            if (w) await w.close();
          } else if (m.type === 'abort') {
            const w = files.get(m.fileId); files.delete(m.fileId);
            if (w) { try { await w.abort(); } catch (e) { /* ignore */ } }
          }
          ack(m);
        } catch (e) { ack(m, (e && e.message) || String(e)); }
      });
    });
    sinkPort.onDisconnect.addListener(() => { sinkPort = null; });
  }

  // ---------------- Giao diện gợi ý ----------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showPanel(series) {
    const sig = series.kind + ':' + series.eps.length + ':' + series.eps[0].url;
    if (sig === closedSig) return;
    if (panel && sig === lastSig) return;
    lastSig = sig;
    if (panel) panel.remove();
    panel = el('div', 'vtv-series');
    const first = series.eps[0].num, last = series.eps[series.eps.length - 1].num;
    const head = el('div', 'vtv-series-head');
    head.appendChild(el('span', 'vtv-series-title', 'Phát hiện bộ ' + series.eps.length + ' tập (' + first + '–' + last + ')'));
    const close = el('button', 'vtv-series-x', '×');
    close.title = 'Đóng';
    close.addEventListener('click', () => { closedSig = sig; panel.remove(); panel = null; });
    head.appendChild(close);
    panel.appendChild(head);

    const row = el('div', 'vtv-series-row');
    row.appendChild(el('span', null, 'Từ tập'));
    const from = el('input'); from.type = 'number'; from.value = first; from.min = first; from.max = last;
    const to = el('input'); to.type = 'number'; to.value = last; to.min = first; to.max = last;
    row.appendChild(from);
    row.appendChild(el('span', null, 'đến'));
    row.appendChild(to);
    const btn = el('button', 'vtv-series-btn', 'Tải cả bộ');
    row.appendChild(btn);
    panel.appendChild(row);
    const status = el('div', 'vtv-series-status', series.kind === 'media'
      ? 'C\u00f3 s\u1eb5n link video t\u1eebng t\u1eadp. L\u01b0u v\u00e0o th\u01b0 m\u1ee5c "' + seriesTitle() + '".'
      : 'S\u1ebd m\u1edf t\u1eebng t\u1eadp \u1edf tab \u1ea9n \u0111\u1ec3 l\u1ea5y link. L\u01b0u v\u00e0o th\u01b0 m\u1ee5c "' + seriesTitle() + '".');
    panel.appendChild(status);

    // Danh sách từng tập, mỗi tập một nút tải lẻ.
    const list = el('div', 'vtv-series-list');
    const rows = new Map();
    const pad = String(last).length < 2 ? 2 : String(last).length;
    const itemOf = (e) => ({ url: e.url, kind: series.kind, num: e.num, name: 'Tap ' + String(e.num).padStart(pad, '0') });
    for (const e of series.eps) {
      const r = el('div', 'vtv-series-item');
      const label = el('span', 'vtv-series-item-name', 'T\u1eadp ' + e.num + (e.text && !EP_TEXT_RE.test(e.text) ? ' \u00b7 ' + e.text : ''));
      label.title = e.url;
      const st = el('span', 'vtv-series-item-st', '');
      const b = el('button', 'vtv-series-item-btn', 'T\u1ea3i');
      b.addEventListener('click', () => start([e], false));
      r.appendChild(label); r.appendChild(st); r.appendChild(b);
      list.appendChild(r);
      rows.set(e.num, { st, b });
    }
    panel.appendChild(list);
    panel.__status = status; panel.__btn = btn; panel.__rows = rows;

    async function start(eps, pickFolder) {
      if (running) return;
      let sink = null;
      if (pickFolder && typeof window.showDirectoryPicker === 'function') {
        // Ch\u1ecdn th\u01b0 m\u1ee5c m\u1ed9t l\u1ea7n cho c\u1ea3 b\u1ed9 (File System Access). Ph\u1ea3i g\u1ecdi ngay trong c\u1eed ch\u1ec9 b\u1ea5m chu\u1ed9t.
        try {
          let testOpfs = false;
          try { testOpfs = localStorage.getItem('vtvTestOpfs') === '1'; } catch (e) { /* ignore */ }
          dirHandle = testOpfs ? await navigator.storage.getDirectory() // móc để test tự động, cùng API với thư mục thật
            : await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
          sink = 'fs';
          await chrome.runtime.sendMessage({ type: 'ensureOffscreen' }); // offscreen phải có trước khi mở cổng
          ensureSinkPort();
        } catch (e) {
          if (e && e.name === 'AbortError') { status.textContent = '\u0110\u00e3 hu\u1ef7 ch\u1ecdn th\u01b0 m\u1ee5c.'; return; }
          status.textContent = 'Kh\u00f4ng ch\u1ecdn \u0111\u01b0\u1ee3c th\u01b0 m\u1ee5c, d\u00f9ng c\u00e1ch t\u1ea3i th\u01b0\u1eddng.';
        }
      }
      running = true;
      btn.textContent = 'D\u1eebng';
      status.textContent = sink ? 'L\u01b0u v\u00e0o th\u01b0 m\u1ee5c "' + dirHandle.name + '". \u0110\u1eebng \u0111\u00f3ng hay r\u1eddi trang khi \u0111ang t\u1ea3i.' : 'B\u1eaft \u0111\u1ea7u\u2026';
      for (const e of eps) { const r = rows.get(e.num); if (r) { r.st.textContent = '\u0111\u1ee3i'; r.st.className = 'vtv-series-item-st'; } }
      const res = await chrome.runtime.sendMessage({ type: 'batchStart', folder: seriesTitle(), pageUrl: location.href, items: eps.map(itemOf), sink });
      if (res && res.error) { status.textContent = res.error; running = false; btn.textContent = 'T\u1ea3i c\u1ea3 b\u1ed9'; }
    }

    btn.addEventListener('click', () => {
      if (running) { chrome.runtime.sendMessage({ type: 'batchCancel' }); return; }
      const f = parseInt(from.value, 10), t = parseInt(to.value, 10);
      const eps = series.eps.filter(e => e.num >= Math.min(f, t) && e.num <= Math.max(f, t));
      if (!eps.length) { status.textContent = 'Kho\u1ea3ng t\u1eadp kh\u00f4ng h\u1ee3p l\u1ec7.'; return; }
      start(eps, true);
    });
    (document.body || document.documentElement).appendChild(panel);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'batchProgress' || !panel) return;
    const s = panel.__status, b = panel.__btn, rows = panel.__rows;
    const r = msg.current != null ? rows.get(msg.current) : null;
    if (msg.finished) {
      running = false;
      b.textContent = 'T\u1ea3i c\u1ea3 b\u1ed9';
      s.textContent = (msg.cancelled ? '\u0110\u00e3 d\u1eebng. ' : 'Xong. ') + 'Th\u00e0nh c\u00f4ng ' + msg.ok + '/' + msg.total +
        (msg.failed.length ? '. L\u1ed7i t\u1eadp: ' + msg.failed.join(', ') : '');
    } else if (msg.itemDone) {
      if (r) { r.st.textContent = msg.error ? ('l\u1ed7i: ' + msg.error) : '\u2713'; r.st.className = 'vtv-series-item-st ' + (msg.error ? 'err' : 'ok'); r.st.title = msg.error || ''; }
    } else {
      s.textContent = 'T\u1eadp ' + msg.current + ' (' + (msg.done + 1) + '/' + msg.total + '): ' + (msg.text || '\u0111ang t\u1ea3i\u2026');
      if (r) { r.st.textContent = msg.text || '\u0111ang t\u1ea3i\u2026'; r.st.className = 'vtv-series-item-st busy'; }
    }
  });

  function tick() {
    if (running) return;
    const now = Date.now();
    if (now - lastScan < 4000) return;
    lastScan = now;
    const series = detect();
    if (series) showPanel(series);
    else if (panel) { panel.remove(); panel = null; lastSig = ''; }
  }
  setTimeout(tick, 1500);
  setInterval(tick, 5000);
})();

// Offscreen document: tải playlist HLS (.m3u8), gộp các đoạn (giải mã AES-128 nếu có) thành một file rồi tạo blob URL.
const CONCURRENCY = 4;

function abs(base, rel) { return new URL(rel, base).href; }

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] != null ? m[3] : m[2];
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' khi tai playlist');
  return r.text();
}

async function fetchBuf(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw last;
}

// Chọn luồng chất lượng cao nhất nếu là master playlist.
async function resolveMedia(url) {
  let text = await fetchText(url);
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const lines = text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const a = parseAttrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
        const bw = parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10);
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (j < lines.length && (!best || bw > best.bw)) best = { bw, url: abs(url, lines[j].trim()) };
      }
    }
    if (!best) throw new Error('Master playlist khong co luong nao');
    url = best.url;
    text = await fetchText(url);
  }
  return { url, text };
}

function parseMedia(baseUrl, text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const segs = [];
  let map = null, key = null, seq = 0, isFmp4 = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice('#EXT-X-MAP:'.length));
      map = { url: abs(baseUrl, a.URI), range: a.BYTERANGE || null };
      isFmp4 = true;
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { url: abs(baseUrl, a.URI), iv: a.IV || null };
      else throw new Error('Ma hoa ' + a.METHOD + ' (DRM) khong ho tro');
    } else if (l.startsWith('#')) {
      continue;
    } else {
      segs.push({ url: abs(baseUrl, l), key, seq: seq + segs.length });
    }
  }
  return { segs, map, isFmp4 };
}

const keyCache = new Map();
async function getKey(url) {
  if (!keyCache.has(url)) keyCache.set(url, fetchBuf(url).then(b => crypto.subtle.importKey('raw', b, { name: 'AES-CBC' }, false, ['decrypt'])));
  return keyCache.get(url);
}

function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq >>> 0);
  }
  return iv;
}

async function loadSegment(seg) {
  let buf = await fetchBuf(seg.url);
  if (seg.key) {
    const k = await getKey(seg.key.url);
    buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, k, buf);
  }
  return buf;
}

async function downloadHls(job) {
  const report = (extra) => chrome.runtime.sendMessage({ type: 'hlsProgress', key: job.key, tabId: job.tabId, frameId: job.frameId, ruleId: job.ruleId, ...extra }).catch(() => {});
  try {
    report({ pct: 0 });
    const { url, text } = await resolveMedia(job.url);
    const { segs, map, isFmp4 } = parseMedia(url, text);
    if (!segs.length) throw new Error('Playlist khong co doan nao');
    const parts = new Array(segs.length);
    if (map) parts.unshift(await fetchBuf(map.url));
    const offset = map ? 1 : 0;
    let done = 0, next = 0;
    async function worker() {
      while (next < segs.length) {
        const i = next++;
        parts[i + offset] = await loadSegment(segs[i]);
        done++;
        if (done % 2 === 0 || done === segs.length) report({ pct: Math.round(done * 100 / segs.length) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
    const ext = isFmp4 ? 'mp4' : 'ts';
    const blob = new Blob(parts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' });
    const blobUrl = URL.createObjectURL(blob);
    const res = await chrome.runtime.sendMessage({ type: 'hlsBlobReady', blobUrl, filename: (job.filename || 'video') + '.' + ext });
    if (res && res.error) throw new Error(res.error);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}


// Tải một file trực tiếp bằng fetch (có Referer nhờ rule DNR ở background), báo % rồi lưu blob.
async function downloadFile(job) {
  const report = (extra) => chrome.runtime.sendMessage({ type: 'hlsProgress', key: job.key, tabId: job.tabId, frameId: job.frameId, ruleId: job.ruleId, ...extra }).catch(() => {});
  try {
    report({ pct: 0 });
    const r = await fetch(job.url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = parseInt(r.headers.get('content-length') || '0', 10);
    const reader = r.body.getReader();
    const chunks = []; let got = 0, lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.byteLength;
      const pct = total ? Math.floor(got * 100 / total) : Math.floor(got / 1048576);
      if (pct !== lastPct) { lastPct = pct; report(total ? { pct } : { pct: pct + ' MB' }); }
    }
    const blob = new Blob(chunks, { type: job.mime || 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const res = await chrome.runtime.sendMessage({ type: 'hlsBlobReady', blobUrl, filename: job.filename });
    if (res && res.error) throw new Error(res.error);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'offscreenHls') downloadHls(msg);
  else if (msg.type === 'offscreenFetch') downloadFile(msg);
});

// Offscreen document: tải HLS/DASH, lắp dữ liệu MediaSource, ghép/remux bằng ffmpeg.wasm, tạo blob URL để tải về.
import { FFmpeg } from './lib/ffmpeg/esm/index.js';
const CONCURRENCY = 4;

// ---------------- Tiện ích chung ----------------
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
  if (!r.ok) throw new Error('HTTP ' + r.status + ' khi tải manifest');
  return r.text();
}

async function fetchBuf(url, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw last;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p instanceof Uint8Array ? p : new Uint8Array(p), off); off += p.byteLength; }
  return out;
}

function makeReporter(job) {
  return (extra) => chrome.runtime.sendMessage({ type: 'hlsProgress', key: job.key, tabId: job.tabId, frameId: job.frameId, ruleId: job.ruleId, ...extra }).catch(() => {});
}

async function deliver(data, mime, filename) {
  const blob = new Blob([data], { type: mime });
  const blobUrl = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ type: 'hlsBlobReady', blobUrl, filename });
  if (res && res.error) throw new Error(res.error);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
}

// Tải song song giữ đúng thứ tự, báo %.
async function fetchAll(items, report, label, loader) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await (loader ? loader(items[i]) : fetchBuf(items[i]));
      done++;
      if (done % 2 === 0 || done === items.length) report({ text: label + ' ' + Math.round(done * 100 / items.length) + '%' });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// ---------------- ffmpeg.wasm ----------------
let ff = null, ffLoading = null;
async function getFFmpeg() {
  if (ff) return ff;
  if (!ffLoading) {
    ffLoading = (async () => {
      const f = new FFmpeg();
      await f.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm'),
        classWorkerURL: chrome.runtime.getURL('lib/ffmpeg/esm/worker.js')
      });
      ff = f;
      return f;
    })().catch(e => { ffLoading = null; throw e; });
  }
  return ffLoading;
}

window.getFFmpeg = getFFmpeg; // để debug từ tab offscreen.html
let ffQueue = Promise.resolve();
// Chạy ffmpeg tuần tự (một instance): ghi input vào MEMFS, exec, đọc output, dọn dẹp.
function ffRun(inputs, args, outName, report) {
  const task = async () => {
    const f = await getFFmpeg();
    const names = [];
    try {
      for (const inp of inputs) { await f.writeFile(inp.name, inp.data); names.push(inp.name); }
      const onLog = report ? ({ message }) => { const m = /time=(\d+:\d+:\d+)/.exec(message); if (m) report({ text: 'ffmpeg ' + m[1] }); } : null;
      if (onLog) f.on('log', onLog);
      let rc;
      try { rc = await f.exec(args); } finally { if (onLog) f.off('log', onLog); }
      if (rc !== 0) throw new Error('ffmpeg lỗi (mã ' + rc + ')');
      const out = await f.readFile(outName);
      names.push(outName);
      if (!out || !out.byteLength) throw new Error('ffmpeg không tạo được file');
      return out;
    } finally {
      for (const n of names) { try { await f.deleteFile(n); } catch (e) { /* ignore */ } }
    }
  };
  const p = ffQueue.then(task, task);
  ffQueue = p.catch(() => {});
  return p;
}

// Remux sang mp4 (copy stream). Thất bại thì trả null để dùng file gốc.
async function remuxToMp4(data, inName, report) {
  try {
    report({ text: 'Đang chuyển sang MP4…' });
    const args = ['-i', inName, '-c', 'copy', '-movflags', '+faststart'];
    if (/\.ts$/i.test(inName)) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('out.mp4');
    return await ffRun([{ name: inName, data }], args, 'out.mp4', report);
  } catch (e) {
    console.warn('remux fail', e);
    return null;
  }
}

async function muxAV(video, audio, vName, aName, report) {
  report({ text: 'Đang ghép hình + tiếng…' });
  return ffRun([{ name: vName, data: video }, { name: aName, data: audio }],
    ['-i', vName, '-i', aName, '-c', 'copy', '-movflags', '+faststart', 'out.mp4'], 'out.mp4', report);
}

// ---------------- HLS ----------------
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
    if (!best) throw new Error('Master playlist không có luồng nào');
    url = best.url;
    text = await fetchText(url);
  }
  return { url, text };
}

function parseMedia(baseUrl, text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const segs = [];
  let map = null, key = null, seq = 0, isFmp4 = false;
  for (const l of lines) {
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice('#EXT-X-MAP:'.length));
      map = { url: abs(baseUrl, a.URI) };
      isFmp4 = true;
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { url: abs(baseUrl, a.URI), iv: a.IV || null };
      else throw new Error('Mã hóa ' + a.METHOD + ' (DRM) không hỗ trợ');
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
  const report = makeReporter(job);
  try {
    report({ pct: 0 });
    const { url, text } = await resolveMedia(job.url);
    const { segs, map, isFmp4 } = parseMedia(url, text);
    if (!segs.length) throw new Error('Playlist không có đoạn nào');
    const parts = [];
    if (map) parts.push(await fetchBuf(map.url));
    parts.push(...await fetchAll(segs, report, 'Đang tải', loadSegment));
    const raw = concat(parts);
    const mp4 = await remuxToMp4(raw, isFmp4 ? 'in.mp4' : 'in.ts', report);
    const name = job.filename || 'video';
    if (mp4) await deliver(mp4, 'video/mp4', name + '.mp4');
    else await deliver(raw, isFmp4 ? 'video/mp4' : 'video/mp2t', name + (isFmp4 ? '.mp4' : '.ts'));
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}

// ---------------- DASH (MPD tĩnh) ----------------
function isoDuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(s);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function fillTemplate(t, vars) {
  return t.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, name, pad) => {
    let v = String(vars[name] != null ? vars[name] : '');
    if (pad) v = v.padStart(parseInt(pad, 10), '0');
    return v;
  }).replace(/\$\$/g, '$');
}

function child(el, name) { return Array.from(el.children).find(c => c.localName === name) || null; }
function children(el, name) { return Array.from(el.children).filter(c => c.localName === name); }

function childBaseUrl(el, base) {
  const b = child(el, 'BaseURL');
  return b ? abs(base, b.textContent.trim()) : base;
}

function pickTemplate(rep, as) {
  // Thuộc tính của Representation ghi đè AdaptationSet.
  const tAs = child(as, 'SegmentTemplate'), tRep = child(rep, 'SegmentTemplate');
  if (!tAs && !tRep) return null;
  const get = (name) => (tRep && tRep.getAttribute(name)) || (tAs && tAs.getAttribute(name)) || null;
  const tl = (tRep && child(tRep, 'SegmentTimeline')) || (tAs && child(tAs, 'SegmentTimeline')) || null;
  return { init: get('initialization'), media: get('media'), start: parseInt(get('startNumber') || '1', 10),
    timescale: parseInt(get('timescale') || '1', 10), duration: parseInt(get('duration') || '0', 10), timeline: tl };
}

// Trả về { init: url|null, segments: [url] }
function segmentsFor(rep, as, base, periodDur) {
  const vars = { RepresentationID: rep.getAttribute('id'), Bandwidth: rep.getAttribute('bandwidth') };
  const t = pickTemplate(rep, as);
  if (t && t.media) {
    const init = t.init ? abs(base, fillTemplate(t.init, vars)) : null;
    const segments = [];
    if (t.timeline) {
      let time = 0, num = t.start;
      for (const S of children(t.timeline, 'S')) {
        if (S.hasAttribute('t')) time = parseInt(S.getAttribute('t'), 10);
        const d = parseInt(S.getAttribute('d'), 10), r = parseInt(S.getAttribute('r') || '0', 10);
        for (let i = 0; i <= r; i++) {
          segments.push(abs(base, fillTemplate(t.media, { ...vars, Number: num, Time: time })));
          time += d; num++;
        }
      }
    } else {
      if (!t.duration || !periodDur) throw new Error('MPD thiếu thông tin độ dài đoạn');
      const count = Math.ceil(periodDur * t.timescale / t.duration);
      for (let i = 0; i < count; i++) segments.push(abs(base, fillTemplate(t.media, { ...vars, Number: t.start + i })));
    }
    return { init, segments };
  }
  const list = child(rep, 'SegmentList') || child(as, 'SegmentList');
  if (list) {
    const initEl = child(list, 'Initialization');
    const init = initEl && initEl.getAttribute('sourceURL') ? abs(base, initEl.getAttribute('sourceURL')) : null;
    const segments = children(list, 'SegmentURL').map(s => abs(base, s.getAttribute('media')));
    return { init, segments };
  }
  // SegmentBase / chỉ BaseURL: một file duy nhất.
  return { init: null, segments: [base] };
}

function bestRep(as) {
  const reps = children(as, 'Representation');
  return reps.sort((a, b) => (parseInt(b.getAttribute('bandwidth') || '0', 10) - parseInt(a.getAttribute('bandwidth') || '0', 10)))[0] || null;
}

function mimeOf(as, rep) { return (rep && rep.getAttribute('mimeType')) || as.getAttribute('mimeType') || ''; }

async function downloadDash(job) {
  const report = makeReporter(job);
  try {
    report({ pct: 0 });
    const text = await fetchText(job.url);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error('Không phải file MPD');
    if (mpd.getAttribute('type') === 'dynamic') throw new Error('DASH live (dynamic) chưa hỗ trợ');
    if (doc.getElementsByTagName('ContentProtection').length) throw new Error('Nội dung DRM, không tải được');
    let base = childBaseUrl(mpd, job.url);
    const period = child(mpd, 'Period');
    if (!period) throw new Error('MPD không có Period');
    base = childBaseUrl(period, base);
    const periodDur = isoDuration(period.getAttribute('duration')) || isoDuration(mpd.getAttribute('mediaPresentationDuration'));

    let video = null, audio = null;
    for (const as of children(period, 'AdaptationSet')) {
      const rep = bestRep(as);
      if (!rep) continue;
      const ct = as.getAttribute('contentType') || mimeOf(as, rep).split('/')[0];
      const bw = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const lang = as.getAttribute('lang') || '';
      const item = { as, rep, bw, lang, vi: /^vi/i.test(lang) };
      if (ct === 'video' && (!video || bw > video.bw)) video = item;
      if (ct === 'audio' && (!audio || (item.vi && !audio.vi) || (item.vi === audio.vi && bw > audio.bw))) audio = item;
    }
    if (!video && !audio) throw new Error('MPD không có luồng video/audio');

    async function fetchTrack(item, label) {
      const b = childBaseUrl(item.rep, childBaseUrl(item.as, base));
      const { init, segments } = segmentsFor(item.rep, item.as, b, periodDur);
      const parts = [];
      if (init) parts.push(await fetchBuf(init));
      parts.push(...await fetchAll(segments, report, label));
      return concat(parts);
    }

    const name = job.filename || 'video';
    const vData = video ? await fetchTrack(video, 'Tải hình') : null;
    const aData = audio ? await fetchTrack(audio, 'Tải tiếng') : null;
    const vMime = video ? (mimeOf(video.as, video.rep) || 'video/mp4') : '';
    const aMime = audio ? (mimeOf(audio.as, audio.rep) || 'audio/mp4') : '';
    const vExt = /webm/.test(vMime) ? 'webm' : 'mp4';
    const aExt = /webm/.test(aMime) ? 'webm' : 'm4a';

    if (vData && aData) {
      let out = null;
      try { out = await muxAV(vData, aData, 'v.' + vExt, 'a.' + aExt, report); } catch (e) { console.warn('mux fail', e); }
      if (out) await deliver(out, 'video/mp4', name + '.mp4');
      else {
        await deliver(vData, vMime, name + '.video.' + vExt);
        await deliver(aData, aMime, name + '.audio.' + aExt);
      }
    } else if (vData) {
      const out = await remuxToMp4(vData, 'v.' + vExt, report);
      if (out) await deliver(out, 'video/mp4', name + '.mp4'); else await deliver(vData, vMime, name + '.' + vExt);
    } else {
      await deliver(aData, aMime, name + '.' + aExt);
    }
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}

// ---------------- Tải file trực tiếp (có Referer) ----------------
async function downloadFile(job) {
  const report = makeReporter(job);
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
    await deliver(new Blob(chunks), job.mime || 'video/mp4', job.filename);
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}

// ---------------- MediaSource (nhận qua Port từ content script) ----------------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function assembleMse(job) {
  const report = makeReporter(job);
  try {
    const tracks = job.buffers.filter(b => b.parts.length).map(b => ({ mime: b.mime, data: concat(b.parts) }));
    if (!tracks.length) throw new Error('Không có dữ liệu');
    const name = job.filename || 'video';
    const extFor = (mime) => /webm/i.test(mime) ? 'webm' : /^audio/i.test(mime) ? 'm4a' : 'mp4';
    const isAudio = (mime) => /^audio/i.test(mime) || (/mp4a|opus|vorbis/i.test(mime) && !/avc|hev|hvc|vp0?9|av01/i.test(mime));
    const v = tracks.find(t => !isAudio(t.mime)) || null;
    const a = tracks.find(t => isAudio(t.mime)) || null;

    if (v && a) {
      let out = null;
      try { out = await muxAV(v.data, a.data, 'v.' + extFor(v.mime), 'a.' + extFor(a.mime), report); } catch (e) { console.warn('mux fail', e); }
      if (out) await deliver(out, 'video/mp4', name + '.mp4');
      else {
        await deliver(v.data, v.mime.split(';')[0], name + '.video.' + extFor(v.mime));
        await deliver(a.data, a.mime.split(';')[0], name + '.audio.' + extFor(a.mime));
      }
    } else {
      const t = v || a;
      const out = await remuxToMp4(t.data, 'in.' + extFor(t.mime), report);
      if (out) await deliver(out, 'video/mp4', name + '.mp4');
      else await deliver(t.data, t.mime.split(';')[0], name + '.' + extFor(t.mime));
    }
    report({ done: true, pct: 100 });
  } catch (e) {
    report({ error: (e && e.message) || String(e) });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vtv-mse') return;
  const job = { key: null, filename: 'video', buffers: [], tabId: port.sender && port.sender.tab ? port.sender.tab.id : null, frameId: port.sender ? port.sender.frameId : null };
  let cur = null;
  port.onMessage.addListener((m) => {
    if (m.type === 'begin') { job.key = m.key; job.filename = m.filename; }
    else if (m.type === 'buffer') { cur = { mime: m.mime, parts: [] }; job.buffers.push(cur); }
    else if (m.type === 'chunk' && cur) cur.parts.push(b64ToBytes(m.b64));
    else if (m.type === 'end') assembleMse(job);
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'offscreenHls') downloadHls(msg);
  else if (msg.type === 'offscreenDash') downloadDash(msg);
  else if (msg.type === 'offscreenFetch') downloadFile(msg);
});

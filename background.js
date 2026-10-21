// Service worker: bắt URL media qua mạng theo tab, tải trực tiếp, điều phối tải HLS qua offscreen document.
const MEDIA_EXT = /\.(mp4|webm|m4v|mov|flv|mkv|avi|ogv|m3u8|mpd)(\?|#|$)/i;
const captured = new Map(); // tabId -> [{url, kind, ts}]

function kindOf(url, ctype) {
  const u = url.toLowerCase();
  if (/\.m3u8(\?|#|$)/.test(u) || /mpegurl/i.test(ctype || '')) return 'hls';
  if (/\.mpd(\?|#|$)/.test(u) || /dash\+xml/i.test(ctype || '')) return 'dash';
  if (/\.(ts|m4s)(\?|#|$)/.test(u)) return null; // đoạn HLS/DASH: bỏ qua
  if (MEDIA_EXT.test(u) || /^video\//i.test(ctype || '')) return 'direct';
  return null;
}

function remember(tabId, url, kind) {
  if (tabId < 0 || !kind) return;
  const list = captured.get(tabId) || [];
  const clean = url.split('#')[0];
  const idx = list.findIndex(x => x.url === clean);
  if (idx >= 0) list.splice(idx, 1);
  list.push({ url: clean, kind, ts: Date.now() });
  if (list.length > 50) list.shift();
  captured.set(tabId, list);
  chrome.storage.session.set({ ['tab_' + tabId]: list }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  let ctype = '';
  for (const h of details.responseHeaders || []) {
    if (h.name.toLowerCase() === 'content-type') ctype = h.value || '';
  }
  const kind = kindOf(details.url, ctype);
  if (kind) remember(details.tabId, details.url, kind);
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => {
  captured.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId).catch(() => {});
});
// Điều hướng sang trang mới ở frame chính: xoá danh sách cũ.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    captured.delete(tabId);
    chrome.storage.session.remove('tab_' + tabId).catch(() => {});
  }
});

async function getList(tabId) {
  if (tabId == null) return [];
  if (captured.has(tabId)) return captured.get(tabId);
  const o = await chrome.storage.session.get('tab_' + tabId);
  const list = o['tab_' + tabId] || [];
  captured.set(tabId, list);
  return list;
}


// ---- Referer giả lập trang gốc cho request do extension/trình duyệt tải (chống chặn hotlink) ----
let ruleSeq = 1000;
const activeRules = new Map();     // ruleId -> origin
const needsReferer = new Set();    // origin đã biết là chặn hotlink (trong phiên)
function originOf(u) { try { return new URL(u).origin; } catch (e) { return ''; } }
function refererActive(origin) { for (const o of activeRules.values()) if (o === origin) return true; return false; }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function addRefererRule(targetUrl, pageUrl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return null;
  let origin = '';
  try { origin = new URL(targetUrl).origin; } catch (e) { return null; }
  const id = ruleSeq++;
  activeRules.set(id, origin);
  const pageOrigin = new URL(pageUrl).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: pageUrl },
        { header: 'Origin', operation: 'set', value: pageOrigin }
      ] },
      condition: { regexFilter: '^' + escapeRegex(origin) + '/' }
    }]
  });
  return id;
}
async function removeRule(id, delayMs) {
  if (id == null) return;
  setTimeout(() => {
    activeRules.delete(id);
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }, delayMs || 0);
}

const EXT_BY_TYPE = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-flv': 'flv', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'video/mp2t': 'ts', 'video/3gpp': '3gp', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };

// Thăm dò URL trước khi tải: bảo đảm server trả về video, lấy đuôi file từ content-type.
async function probe(url) {
  let r;
  try {
    r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' }, credentials: 'include', redirect: 'follow' });
  } catch (e) {
    throw new Error('Không kết nối được tới server video');
  }
  const ctype = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  try { await r.body?.cancel(); } catch (e) { /* ignore */ }
  if (!r.ok && r.status !== 206) throw new Error('Server từ chối (HTTP ' + r.status + ')');
  if (/^text\/html|application\/xhtml/.test(ctype)) throw new Error('Server trả về trang HTML thay vì video (chặn hotlink/cần đăng nhập)');
  return { ctype, finalUrl: r.url || url };
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Gop cac doan HLS/DASH/MediaSource, chay ffmpeg.wasm va tao blob URL de tai ve.'
    }).catch(e => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function handle(msg, sender) {
  const out = {};
  const sendResponse = (r) => { Object.assign(out, r || {}); };
  {
    {
      if (msg.type === 'getCapturedMedia') {
        const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
        sendResponse({ list: await getList(tabId) });
      } else if (msg.type === 'download') {
        const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url);
        // 1) Thử không Referer: nếu server chấp nhận thì để Chrome tải thẳng xuống đĩa (không tốn RAM).
        // Bỏ qua bước này nếu origin đã biết là chặn hotlink, hoặc đang có rule Referer cho origin đó (thăm dò sẽ sai).
        const origin = originOf(msg.url);
        let plain = null;
        if (msg.sink !== 'fs' && !needsReferer.has(origin) && !refererActive(origin)) {
          try { plain = await probe(msg.url); } catch (e) { plain = null; }
        }
        if (plain) {
          const ext = msg.ext || EXT_BY_TYPE[plain.ctype] || 'mp4';
          const id = await chrome.downloads.download({ url: msg.url, filename: (msg.filename || 'video') + '.' + ext, saveAs: false, conflictAction: 'uniquify' });
          sendResponse({ ok: true, id, via: 'direct' });
          return out;
        }
        // 2) Server chặn hotlink: gắn Referer của trang, tải bằng fetch trong offscreen rồi lưu blob.
        const ruleId = await addRefererRule(msg.url, pageUrl);
        let probed;
        try { probed = await probe(msg.url); } catch (e) { removeRule(ruleId, 0); throw e; }
        if (origin) needsReferer.add(origin);
        const ext = msg.ext || EXT_BY_TYPE[probed.ctype] || 'mp4';
        await ensureOffscreen();
        chrome.runtime.sendMessage({ type: 'offscreenFetch', url: msg.url, filename: (msg.filename || 'video') + '.' + ext, mime: probed.ctype || 'video/mp4',
          key: msg.key, tabId: sender.tab ? sender.tab.id : msg.tabId, frameId: sender.frameId, ruleId, sink: msg.sink }).catch(() => {});
        sendResponse({ ok: true, via: 'fetch' });
      } else if (msg.type === 'ensureOffscreen') {
        await ensureOffscreen();
        sendResponse({ ok: true });
      } else if (msg.type === 'downloadDash') {
        await ensureOffscreen();
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url);
        const ruleId = await addRefererRule(msg.url, pageUrl);
        chrome.runtime.sendMessage({ type: 'offscreenDash', url: msg.url, filename: msg.filename, key: msg.key, tabId, frameId: sender.frameId, ruleId, sink: msg.sink }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'downloadHls') {
        await ensureOffscreen();
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const frameId = sender.frameId;
        const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url);
        const ruleId = await addRefererRule(msg.url, pageUrl);
        chrome.runtime.sendMessage({ type: 'offscreenHls', url: msg.url, filename: msg.filename, key: msg.key, tabId, frameId, ruleId, sink: msg.sink }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'hlsProgress') {
        if ((msg.done || msg.error) && msg.ruleId != null) removeRule(msg.ruleId, 5000);
        if (typeof msg.key === 'string' && msg.key.startsWith('batch:')) {
          if (msg.done || msg.error) { const w = batchWaiters.get(msg.key); if (w) { batchWaiters.delete(msg.key); w(msg); } }
          else notifyOrigin({ current: batch && batch.items[batch.done] ? batch.items[batch.done].num : null, text: msg.text || (msg.pct != null ? msg.pct + (typeof msg.pct === 'number' ? '%' : '') : '') });
          sendResponse({ ok: true });
          return out;
        }
        // Từ offscreen: chuyển về content script của tab/frame tương ứng và popup (nếu mở).
        if (msg.tabId != null) {
          const opts = msg.frameId != null ? { frameId: msg.frameId } : {};
          chrome.tabs.sendMessage(msg.tabId, msg, opts).catch(() => {});
        }
        chrome.runtime.sendMessage({ ...msg, type: 'hlsProgressPopup' }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'hlsBlobReady') {
        const id = await chrome.downloads.download({ url: msg.blobUrl, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' });
        sendResponse({ ok: true, id });
      } else if (msg.type === 'batchStart') {
        sendResponse(await batchStart(msg, sender));
      } else if (msg.type === 'batchCancel') {
        if (batch) batch.cancelled = true;
        sendResponse({ ok: true });
      } else {
        sendResponse({});
      }
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: (e && e.message) || String(e) }));
  return true;
});

// ---------------- Tải cả bộ (hàng đợi tuần tự) ----------------
let batch = null;
const batchWaiters = new Map(); // key -> resolve(progressMsg)

function notifyOrigin(extra) {
  if (!batch) return;
  chrome.tabs.sendMessage(batch.tabId, { type: 'batchProgress', total: batch.items.length, done: batch.done, ...extra }, { frameId: 0 }).catch(() => {});
}

function waitKey(key, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { batchWaiters.delete(key); resolve({ error: 'Quá thời gian' }); }, timeoutMs);
    batchWaiters.set(key, (m) => { clearTimeout(t); resolve(m); });
  });
}

function waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.downloads.onChanged.removeListener(fn); resolve({ error: 'Quá thời gian' }); }, timeoutMs);
    const fn = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { clearTimeout(timer); chrome.downloads.onChanged.removeListener(fn); resolve({ done: true }); }
      else if (d.state.current === 'interrupted') { clearTimeout(timer); chrome.downloads.onChanged.removeListener(fn); resolve({ error: 'Tải bị ngắt' }); }
    };
    chrome.downloads.onChanged.addListener(fn);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mở tab ẩn cho trang tập, chờ content script tìm được video (src trực tiếp) hoặc bắt được media qua mạng.
async function resolveEpisodePage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (batch && batch.cancelled) throw new Error('Đã dừng');
      await sleep(1500);
      let frames = [];
      try { frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) || []; } catch (e) { frames = [{ frameId: 0 }]; }
      let blobSeen = false;
      for (const f of frames) {
        let r = null;
        try { r = await chrome.tabs.sendMessage(tab.id, { type: 'listVideos' }, { frameId: f.frameId }); } catch (e) { continue; }
        for (const v of (r && r.videos) || []) {
          if (v.src && v.src !== 'blob:') {
            const ext = (v.src.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1] || '';
            return { url: v.src, kind: ext === 'm3u8' ? 'hls' : ext === 'mpd' ? 'dash' : 'direct', pageUrl: tab.url || url };
          }
          if (v.src === 'blob:') blobSeen = true;
        }
      }
      const list = await getList(tab.id);
      const pick = list.filter(x => x.kind === 'direct').pop() || list.filter(x => x.kind === 'hls').pop() || list.filter(x => x.kind === 'dash').pop();
      if (pick) return { url: pick.url, kind: pick.kind, pageUrl: tab.url || url };
      if (blobSeen) {
        // Thử bấm play để player tải manifest.
        for (const f of frames) chrome.tabs.sendMessage(tab.id, { type: 'playAll' }, { frameId: f.frameId }).catch(() => {});
      }
    }
    throw new Error('Không tìm thấy video trong trang tập');
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function kindOfUrl(u) {
  const ext = (u.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1] || '';
  return { ext, kind: ext === 'm3u8' ? 'hls' : ext === 'mpd' ? 'dash' : 'direct' };
}

async function runBatchItem(item, idx) {
  const key = 'batch:' + batch.id + ':' + idx;
  let target = { url: item.url, kind: 'direct', pageUrl: batch.pageUrl };
  if (item.kind === 'page') {
    notifyOrigin({ current: item.num, text: 'đang mở trang tập…' });
    target = await resolveEpisodePage(item.url);
  } else {
    target.kind = kindOfUrl(item.url).kind;
  }
  const filename = batch.sink === 'fs' ? item.name : batch.folder + '/' + item.name;
  const sender = { tab: { id: batch.tabId, url: target.pageUrl }, frameId: 0 };
  const type = target.kind === 'hls' ? 'downloadHls' : target.kind === 'dash' ? 'downloadDash' : 'download';
  const ext = target.kind === 'direct' ? kindOfUrl(target.url).ext : '';
  const waiter = waitKey(key, 60 * 60 * 1000);
  const res = await handle({ type, url: target.url, filename, ext, key, pageUrl: target.pageUrl, tabId: batch.tabId, sink: batch.sink }, sender);
  if (res && res.error) { batchWaiters.delete(key); throw new Error(res.error); }
  if (type === 'download' && res.via === 'direct') {
    batchWaiters.delete(key);
    const r = await waitDownload(res.id, 60 * 60 * 1000);
    if (r.error) throw new Error(r.error);
    return;
  }
  const r = await waiter;
  if (r.error) throw new Error(r.error);
}

async function batchStart(msg, sender) {
  if (batch && !batch.finished) return { error: 'Đang có một đợt tải khác, hãy dừng trước.' };
  if (!msg.items || !msg.items.length) return { error: 'Không có tập nào' };
  batch = { id: Date.now().toString(36), items: msg.items, folder: (msg.folder || 'video').replace(/[\\/:*?"<>|]+/g, '_'), pageUrl: msg.pageUrl,
    tabId: sender.tab ? sender.tab.id : msg.tabId, sink: msg.sink || null, done: 0, ok: 0, failed: [], cancelled: false, finished: false };
  (async () => {
    for (let i = 0; i < batch.items.length; i++) {
      if (batch.cancelled) break;
      const item = batch.items[i];
      notifyOrigin({ current: item.num, text: 'đang tải…' });
      try {
        await runBatchItem(item, i);
        batch.ok++;
        notifyOrigin({ current: item.num, itemDone: true });
      } catch (e) {
        batch.failed.push(item.num);
        notifyOrigin({ current: item.num, itemDone: true, error: (e && e.message) || String(e) });
      }
      batch.done++;
    }
    batch.finished = true;
    notifyOrigin({ finished: true, ok: batch.ok, failed: batch.failed, cancelled: batch.cancelled });
  })();
  return { ok: true };
}

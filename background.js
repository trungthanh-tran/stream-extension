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
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function addRefererRule(targetUrl, pageUrl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return null;
  let origin = '';
  try { origin = new URL(targetUrl).origin; } catch (e) { return null; }
  const id = ruleSeq++;
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
  setTimeout(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {}), delayMs || 0);
}

const EXT_BY_TYPE = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-flv': 'flv', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'video/mp2t': 'ts', 'video/3gpp': '3gp', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };

// Thăm dò URL trước khi tải: bảo đảm server trả về video, lấy đuôi file từ content-type.
async function probe(url) {
  let r;
  try {
    r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' }, credentials: 'include', redirect: 'follow' });
  } catch (e) {
    throw new Error('Khong ket noi duoc toi server video');
  }
  const ctype = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  try { await r.body?.cancel(); } catch (e) { /* ignore */ }
  if (!r.ok && r.status !== 206) throw new Error('Server tu choi (HTTP ' + r.status + ')');
  if (/^text\/html|application\/xhtml/.test(ctype)) throw new Error('Server tra ve trang HTML thay vi video (chan hotlink/can dang nhap)');
  return { ctype, finalUrl: r.url || url };
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Gop cac doan HLS thanh mot file va tao blob URL de tai ve.'
    }).catch(e => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'getCapturedMedia') {
        const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
        sendResponse({ list: await getList(tabId) });
      } else if (msg.type === 'download') {
        const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url);
        // 1) Thử không Referer: nếu server chấp nhận thì để Chrome tải thẳng xuống đĩa (không tốn RAM).
        let plain = null;
        try { plain = await probe(msg.url); } catch (e) { plain = null; }
        if (plain) {
          const ext = msg.ext || EXT_BY_TYPE[plain.ctype] || 'mp4';
          const id = await chrome.downloads.download({ url: msg.url, filename: (msg.filename || 'video') + '.' + ext, saveAs: false, conflictAction: 'uniquify' });
          sendResponse({ ok: true, id, via: 'direct' });
          return;
        }
        // 2) Server chặn hotlink: gắn Referer của trang, tải bằng fetch trong offscreen rồi lưu blob.
        const ruleId = await addRefererRule(msg.url, pageUrl);
        let probed;
        try { probed = await probe(msg.url); } catch (e) { removeRule(ruleId, 0); throw e; }
        const ext = msg.ext || EXT_BY_TYPE[probed.ctype] || 'mp4';
        await ensureOffscreen();
        chrome.runtime.sendMessage({ type: 'offscreenFetch', url: msg.url, filename: (msg.filename || 'video') + '.' + ext, mime: probed.ctype || 'video/mp4',
          key: msg.key, tabId: sender.tab ? sender.tab.id : msg.tabId, frameId: sender.frameId, ruleId }).catch(() => {});
        sendResponse({ ok: true, via: 'fetch' });
      } else if (msg.type === 'downloadHls') {
        await ensureOffscreen();
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const frameId = sender.frameId;
        const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url);
        const ruleId = await addRefererRule(msg.url, pageUrl);
        chrome.runtime.sendMessage({ type: 'offscreenHls', url: msg.url, filename: msg.filename, key: msg.key, tabId, frameId, ruleId }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'hlsProgress') {
        if ((msg.done || msg.error) && msg.ruleId != null) removeRule(msg.ruleId, 5000);
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
      } else {
        sendResponse({});
      }
    } catch (e) {
      sendResponse({ error: (e && e.message) || String(e) });
    }
  })();
  return true;
});

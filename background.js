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
        const filename = (msg.filename || 'video') + '.' + (msg.ext || 'mp4');
        const id = await chrome.downloads.download({ url: msg.url, filename, saveAs: false, conflictAction: 'uniquify' });
        sendResponse({ ok: true, id });
      } else if (msg.type === 'downloadHls') {
        await ensureOffscreen();
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const frameId = sender.frameId;
        chrome.runtime.sendMessage({ type: 'offscreenHls', url: msg.url, filename: msg.filename, key: msg.key, tabId, frameId }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'hlsProgress') {
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

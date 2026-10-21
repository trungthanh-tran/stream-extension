// Chạy trong MAIN world của trang: hook MediaSource để ghi lại các đoạn dữ liệu player đưa vào SourceBuffer.
// Dùng làm phương án dự phòng khi không bắt được URL video qua mạng (URL mã hóa, token đổi liên tục...).
(() => {
  if (window.__vtvMseHooked || typeof MediaSource === 'undefined') return;
  window.__vtvMseHooked = true;

  const CAP_BYTES = 1.5 * 1024 * 1024 * 1024; // tối đa 1.5 GB giữ trong RAM của trang
  const records = new Map();   // MediaSource -> { buffers: [{ mime, chunks, bytes }] }
  const sbInfo = new WeakMap(); // SourceBuffer -> buffer record
  const blobToMs = new Map();  // blob URL -> MediaSource
  let total = 0, capped = false;

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    let rec = records.get(this);
    if (!rec) { rec = { buffers: [] }; records.set(this, rec); }
    const b = { mime: String(mime || ''), chunks: [], bytes: 0 };
    rec.buffers.push(b);
    sbInfo.set(sb, b);
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const b = sbInfo.get(this);
    if (b && data && !capped) {
      try {
        const copy = data instanceof ArrayBuffer ? data.slice(0)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
        if (total + copy.byteLength > CAP_BYTES) capped = true;
        else { b.chunks.push(copy); b.bytes += copy.byteLength; total += copy.byteLength; }
      } catch (e) { /* ignore */ }
    }
    return origAppend.call(this, data);
  };

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const u = origCreate.call(URL, obj);
    if (obj instanceof MediaSource) blobToMs.set(u, obj);
    return u;
  };

  function recordForVideo(video) {
    if (!video) return null;
    if (video.srcObject instanceof MediaSource) return records.get(video.srcObject) || null;
    const src = video.currentSrc || video.src || '';
    const ms = blobToMs.get(src);
    return ms ? records.get(ms) || null : null;
  }

  function findVideo(key) {
    const all = [];
    const walk = (root) => {
      for (const v of root.querySelectorAll('video')) all.push(v);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return all.find(v => v.getAttribute('data-vtv-key') === key) || null;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__vtv !== 'mse') return;
    const { cmd, key, reqId } = ev.data;
    const rec = recordForVideo(findVideo(key));
    if (cmd === 'status') {
      window.postMessage({ __vtv: 'mse-status', key, reqId, capped,
        buffers: rec ? rec.buffers.map(b => ({ mime: b.mime, bytes: b.bytes, count: b.chunks.length })) : [] }, '*');
    } else if (cmd === 'get') {
      if (!rec) { window.postMessage({ __vtv: 'mse-data', key, reqId, buffers: [] }, '*'); return; }
      // Gửi bản sao (structured clone) để trang vẫn giữ dữ liệu, có thể lưu lại lần nữa.
      window.postMessage({ __vtv: 'mse-data', key, reqId, buffers: rec.buffers.map(b => ({ mime: b.mime, chunks: b.chunks })) }, '*');
    }
  });
})();

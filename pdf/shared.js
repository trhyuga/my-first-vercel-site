// Common helpers for all PDF tools
window.PDFApp = (function () {
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 30 s — Safari/iOS may take a while to actually claim the URL after click().
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function safeFilename(name, fallback) {
    let out = (name || fallback || 'output').trim();
    // Strip control chars and Windows-illegal chars; trim trailing dots/spaces.
    out = out.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_');
    out = out.replace(/[. ]+$/, '');
    if (!out) out = fallback || 'output';
    if (out.length > 180) out = out.slice(0, 180);
    return out;
  }

  // Detect whether a loaded pdf-lib document is encrypted. Vanilla pdf-lib
  // happily loads such PDFs with { ignoreEncryption: true } but produces
  // garbled or unreadable output, so tools should refuse and steer the user
  // to the unlock tool instead.
  function isEncryptedSource(pdfDoc) {
    try { return !!pdfDoc.isEncrypted; } catch (e) { return false; }
  }
  // Throw a friendly Japanese error if the doc is encrypted.
  function refuseIfEncrypted(pdfDoc) {
    if (isEncryptedSource(pdfDoc)) {
      throw new Error('このPDFはパスワードで保護されています。「🔓 パスワード解除」で解錠してから再度お試しください。');
    }
  }

  function bindDropzone(el, input, onFiles) {
    el.addEventListener('click', () => input.click());
    ['dragenter', 'dragover'].forEach(evt =>
      el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.add('drag'); })
    );
    ['dragleave', 'drop'].forEach(evt =>
      el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.remove('drag'); })
    );
    el.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) onFiles(files);
    });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (files.length) onFiles(files);
      input.value = '';
    });
  }

  function showError(container, msg) {
    const el = document.createElement('div');
    el.className = 'error';
    el.textContent = msg;
    container.innerHTML = '';
    container.appendChild(el);
  }

  function clearBox(container) {
    if (container) container.innerHTML = '';
  }

  async function readFileAsBytes(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  function setupPdfJs() {
    if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
    }
  }

  async function renderPageToCanvas(pdf, pageNum, scale) {
    const page = await pdf.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  return {
    fmtSize, download, safeFilename, bindDropzone,
    showError, clearBox, readFileAsBytes,
    setupPdfJs, renderPageToCanvas,
    isEncryptedSource, refuseIfEncrypted,
  };
})();

// Common helpers for all PDF tools
window.PDFApp = (function () {
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  // iOS Safari ignores `<a download="...">` — clicking the link just
  // navigates to the blob URL, which opens the PDF inline (often
  // sideways on landscape pages because iOS auto-rotates to fit the
  // screen). Web Share API with `{ files: [...] }` brings up the
  // system share sheet with "ファイルに保存", which is what users
  // expect when they tap "ダウンロード".
  //
  // Importantly we do NOT pass `title` here — when the user picked a
  // text-receiving share target (Notes / Messages / etc.) iOS treated
  // the title field as the message body and the resulting "saved
  // file" was a plain-text snippet containing the filename, not the
  // actual PDF. Files-only is unambiguous.
  function legacyAnchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // target=_blank lets iOS open the blob in a new tab → PDF viewer →
    // share button → ファイルに保存. Without it iOS replaces the current
    // page with the PDF inline and the user can't get back to the tool.
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 60 s — Safari/iOS may take a while to actually claim the URL after click().
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function download(blob, filename) {
    const file = (typeof File === 'function')
      ? new File([blob], filename, { type: blob.type })
      : null;
    if (navigator.canShare && file && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch((e) => {
        // AbortError = the user cancelled the share sheet. Anything else
        // is a real failure — fall back to the legacy download path so
        // the user still gets the file somehow.
        if (e && e.name !== 'AbortError') legacyAnchorDownload(blob, filename);
      });
      return;
    }
    legacyAnchorDownload(blob, filename);
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

  // Print is platform-split:
  //   • iOS Safari → open the blob in a new tab and let the user invoke
  //     Safari's native share sheet → "プリント". The hidden-iframe path
  //     used to throw "このウェブページより印刷することは禁止しています"
  //     on some iOS configurations, even though no such restriction is
  //     declared anywhere in our code — the prompt is iOS' generic
  //     reaction to a JS-driven print() against an iframe whose document
  //     it considers cross-origin (a blob: URL is, by iOS' rules).
  //     Punting to a new tab avoids that prompt entirely and gives the
  //     user the same Safari PDF UI they'd get via "ファイルに保存".
  //   • Desktop / Android → hidden iframe + iframe.print() works fine
  //     and is silent (no extra tab to close).
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function printPdfBlob(blob) {
    const url = URL.createObjectURL(blob);
    if (isIOS()) {
      window.open(url, '_blank');
      // Keep the URL alive long enough for the new tab to load + Safari
      // to render the PDF before the user reaches for the share sheet.
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      return;
    }
    const existing = document.getElementById('__tr_print_iframe');
    if (existing) { try { existing.parentNode.removeChild(existing); } catch (e) {} }
    const iframe = document.createElement('iframe');
    iframe.id = '__tr_print_iframe';
    iframe.style.cssText = 'position:fixed;right:-10000px;bottom:-10000px;width:1px;height:1px;border:0;opacity:0;';
    document.body.appendChild(iframe);
    let triggered = false;
    const go = () => {
      if (triggered) return;
      triggered = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        window.open(url, '_blank');
      }
    };
    iframe.addEventListener('load', go);
    // Safety: some PDF viewers never fire `load`; try after 1.2 s anyway.
    setTimeout(go, 1200);
    iframe.src = url;
    // Clean up well after the print dialog should be closed. URL is kept
    // alive until then so the viewer can still render.
    setTimeout(() => {
      try { iframe.parentNode.removeChild(iframe); } catch (e) {}
      URL.revokeObjectURL(url);
    }, 120000);
  }

  // Helper each tool calls after a successful generation: inserts a
  // 「🖨️ 印刷」 button into a message container so the user can print the
  // just-downloaded output without leaving the tool.
  function appendPrintButton(hostEl, blob, label) {
    if (!hostEl) return;
    // Drop any previous print button from earlier runs so it doesn't stack.
    hostEl.querySelectorAll('[data-print-btn="1"]').forEach(n => n.remove());
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.dataset.printBtn = '1';
    btn.style.marginTop = '0.55rem';
    btn.textContent = label || '🖨️ このPDFを印刷';
    btn.addEventListener('click', () => printPdfBlob(blob));
    hostEl.appendChild(btn);
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
    printPdfBlob, appendPrintButton,
  };
})();

/**
 * Content script for Full Page Screenshot & Scroll Capture.
 * Handles: full-page scroll capture, area selection, element picking, preview panel.
 * Does NOT send tabId — service worker uses sender.tab.id.
 */

(function () {
  'use strict';

  // Prevent duplicate listeners while still allowing repeated captures.
  if (window.__scrollScreenshotInstalled) return;
  window.__scrollScreenshotInstalled = {
    captureInProgress: false
  };

  const OVERLAP = 200;
  let captureMode = null;
  let settings = null;

  // State for area selection
  let areaOverlay = null;
  let selectionBox = null;
  let isDrawing = false;
  let startX = 0, startY = 0;

  // State for element selection
  let highlightedElement = null;

  // State for full-page capture
  let originalScrollX = 0, originalScrollY = 0;
  let hiddenElements = [];

  // ===== Message Listener =====

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'captureStart') {
      if (window.__scrollScreenshotInstalled.captureInProgress) {
        sendResponse({ error: 'A capture is already in progress' });
        return false;
      }

      settings = message.settings;
      captureMode = message.mode;
      removeExistingPreviewPanel();
      window.__scrollScreenshotInstalled.captureInProgress = true;
      handleCaptureStart(message.mode);
      sendResponse({ status: 'started' });
      return false;
    }

    return false;
  });

  // ===== Capture Start =====

  async function handleCaptureStart(mode) {
    try {
      switch (mode) {
        case 'fullpage':
          await fullPageCapture();
          break;
        case 'area':
          startAreaSelection();
          break;
        case 'element':
          startElementSelection();
          break;
        default:
          throw new Error('Unknown capture mode: ' + mode);
      }
    } catch (err) {
      showNotification('Capture failed: ' + err.message);
      cleanup();
    }
  }

  // ===== Full Page Capture =====

  async function fullPageCapture() {
    const scrollEl = document.scrollingElement || document.documentElement;
    const scrollTarget = getScrollTarget(scrollEl);
    const totalHeight = scrollTarget.totalHeight;
    const viewportHeight = scrollTarget.viewportHeight;
    const dpr = window.devicePixelRatio;
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let originalTargetScrollTop = 0;

    // Open keep-alive port FIRST (before any long operations)
    const port = chrome.runtime.connect({ name: 'capture' });
    const heartbeat = setInterval(() => port.postMessage({ type: 'heartbeat' }), 5000);

    // Register abort handlers
    const abortController = { aborted: false };
    const onVisibilityChange = () => {
      if (document.hidden) {
        abortController.aborted = true;
      }
    };
    const onBeforeUnload = () => {
      abortController.aborted = true;
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);

    try {
      // Warn for very long pages
      if (totalHeight > 50000) {
        showNotification('Page is long — capture may take a few seconds...');
      }

      // Save scroll position
      originalScrollX = window.scrollX;
      originalScrollY = window.scrollY;
      originalTargetScrollTop = scrollTarget.getScrollTop();

      // Pre-scroll to trigger lazy loading
      showNotification('Loading images...');
      await preScrollLazyLoad(scrollTarget, totalHeight, viewportHeight);

      // Hide fixed/sticky elements
      hideFixedElements(scrollTarget.element);

      const scrollStep = Math.max(1, viewportHeight - OVERLAP);
      const scrollPositions = buildScrollPositions(totalHeight, viewportHeight, scrollStep);
      const steps = scrollPositions.length;

      showNotification('Capturing... (0/' + steps + ')');

      for (let i = 0; i < steps; i++) {
        // Check for abort
        if (abortController.aborted) {
          throw new Error('Capture cancelled — tab lost focus or user navigated away');
        }

        const scrollY = scrollPositions[i];
        scrollTarget.setScrollTop(scrollY);
        await delay(settings.captureDelay || 100);

        // Capture this frame (service worker uses sender.tab.id)
        const response = await chrome.runtime.sendMessage({
          type: 'captureFrame',
          sessionId,
          scrollY,
          captureRect: scrollTarget.getCaptureRect()
        });

        if (response.error) throw new Error(response.error);

        showNotification('Capturing... (' + (i + 1) + '/' + steps + ')');
      }

      let fixedHeaderDataUrl = null;
      if (scrollTarget.type === 'window') {
        // Capture fixed elements frame at top
        restoreFixedElements();
        scrollTarget.setScrollTop(0);
        await delay(settings.captureDelay || 100);
        const fixedFrameResponse = await chrome.runtime.sendMessage({
          type: 'captureFrame'
        });

        // Use fixed header frame only if capture succeeded
        fixedHeaderDataUrl = (!fixedFrameResponse.error && fixedFrameResponse.dataUrl)
          ? fixedFrameResponse.dataUrl
          : null;
      } else {
        restoreFixedElements();
      }

      // Stitch frames (with fixed-header compositing info)
      showNotification('Stitching...');
      const stitchResponse = await chrome.runtime.sendMessage({
        type: 'stitchAndFinish',
        sessionId,
        fixedHeaderDataUrl,
        viewportHeight,
        totalHeight,
        dpr,
        domain: window.location.hostname,
        format: settings.format || 'png'
      });

      if (stitchResponse.error) throw new Error(stitchResponse.error);

      // Handle result based on default action setting
      await handleResult(stitchResponse.dataUrl);

    } finally {
      await chrome.runtime.sendMessage({
        type: 'discardCaptureSession',
        sessionId
      }).catch(() => {});
      clearInterval(heartbeat);
      port.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      restoreFixedElements();
      scrollTarget.setScrollTop(originalTargetScrollTop);
      window.scrollTo(originalScrollX, originalScrollY);
    }
  }

  async function preScrollLazyLoad(scrollTarget, totalHeight, viewportHeight) {
    const step = viewportHeight * 2;
    for (let y = 0; y < totalHeight; y += step) {
      scrollTarget.setScrollTop(y);
      await delay(50);
    }
    scrollTarget.setScrollTop(0);
    await delay(200);
  }

  function getScrollTarget(scrollEl) {
    const documentOverflow = Math.max(0, scrollEl.scrollHeight - window.innerHeight);
    if (documentOverflow > 1) {
      return createWindowScrollTarget(scrollEl);
    }

    const bodyOverflow = document.body
      ? Math.max(0, document.body.scrollHeight - window.innerHeight)
      : 0;
    if (bodyOverflow > 1) {
      return createBodyScrollTarget(document.body);
    }

    let bestElement = null;
    let bestScore = 0;
    const elements = document.querySelectorAll('body *');

    for (const el of elements) {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 1 || el.clientHeight < 120 || el.clientWidth < 120) continue;

      const style = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;

      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      if (visibleWidth <= 0 || visibleHeight <= 0) continue;

      const score = visibleWidth * visibleHeight * overflow;
      if (score > bestScore) {
        bestScore = score;
        bestElement = el;
      }
    }

    return bestElement
      ? createElementScrollTarget(bestElement)
      : createWindowScrollTarget(scrollEl);
  }

  function createWindowScrollTarget(scrollEl) {
    return {
      type: 'window',
      element: null,
      totalHeight: scrollEl.scrollHeight,
      viewportHeight: window.innerHeight,
      getScrollTop: () => window.scrollY,
      setScrollTop: (y) => window.scrollTo(0, y),
      getCaptureRect: () => null
    };
  }

  function createBodyScrollTarget(bodyEl) {
    return {
      type: 'window',
      element: null,
      totalHeight: bodyEl.scrollHeight,
      viewportHeight: window.innerHeight,
      getScrollTop: () => bodyEl.scrollTop,
      setScrollTop: (y) => { bodyEl.scrollTop = y; },
      getCaptureRect: () => null
    };
  }

  function createElementScrollTarget(el) {
    return {
      type: 'element',
      element: el,
      totalHeight: el.scrollHeight,
      viewportHeight: Math.min(el.clientHeight, getElementCaptureRect(el).height),
      getScrollTop: () => el.scrollTop,
      setScrollTop: (y) => { el.scrollTop = y; },
      getCaptureRect: () => getElementCaptureRect(el)
    };
  }

  function getElementCaptureRect(el) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y)
    };
  }

  function buildScrollPositions(totalHeight, viewportHeight, scrollStep) {
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    const positions = [];

    for (let y = 0; y < maxScrollY; y += scrollStep) {
      positions.push(y);
    }

    if (positions.length === 0 || positions[positions.length - 1] !== maxScrollY) {
      positions.push(maxScrollY);
    }

    return positions;
  }

  function hideFixedElements(exemptElement) {
    hiddenElements = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (exemptElement && (el === exemptElement || el.contains(exemptElement))) {
        continue;
      }

      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        hiddenElements.push({ el, prevVisibility: el.style.visibility });
        el.style.visibility = 'hidden';
      }
    }
  }

  function restoreFixedElements() {
    for (const item of hiddenElements) {
      item.el.style.visibility = item.prevVisibility;
    }
    hiddenElements = [];
  }

  // ===== Area Selection =====

  function startAreaSelection() {
    areaOverlay = document.createElement('div');
    areaOverlay.className = 'ss-overlay';
    document.body.appendChild(areaOverlay);

    areaOverlay.addEventListener('mousedown', onAreaMouseDown);
    areaOverlay.addEventListener('mousemove', onAreaMouseMove);
    areaOverlay.addEventListener('mouseup', onAreaMouseUp);
  }

  function onAreaMouseDown(e) {
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;

    selectionBox = document.createElement('div');
    selectionBox.className = 'ss-selection';
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    areaOverlay.appendChild(selectionBox);
  }

  function onAreaMouseMove(e) {
    if (!isDrawing || !selectionBox) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selectionBox.style.left = x + 'px';
    selectionBox.style.top = y + 'px';
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
  }

  async function onAreaMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = {
      x: Math.min(e.clientX, startX) + window.scrollX,
      y: Math.min(e.clientY, startY) + window.scrollY,
      width: Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY)
    };

    if (rect.width < 10 || rect.height < 10) {
      removeOverlay();
      cleanup();
      return;
    }

    // Show action bar
    showActionBar(rect);
  }

  function showActionBar(rect) {
    const bar = document.createElement('div');
    bar.className = 'ss-action-bar';
    bar.style.left = (rect.x - window.scrollX) + 'px';
    bar.style.top = (rect.y + rect.height - window.scrollY + 10) + 'px';
    ['mousedown', 'mousemove', 'mouseup', 'click'].forEach((eventName) => {
      bar.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'ss-action-btn-confirm';
    confirmBtn.textContent = '✓ Confirm';
    confirmBtn.addEventListener('click', async () => {
      try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Capturing...';
        await captureArea(rect);
      } catch (err) {
        showNotification('Capture failed: ' + err.message);
        cleanup();
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ss-action-btn-cancel';
    cancelBtn.textContent = '✗ Reselect';
    cancelBtn.addEventListener('click', () => {
      bar.remove();
      removeOverlay();
      startAreaSelection();
    });

    bar.appendChild(confirmBtn);
    bar.appendChild(cancelBtn);
    areaOverlay.appendChild(bar);
  }

  async function captureArea(rect) {
    removeOverlay();
    await nextFrame();
    showNotification('Capturing area...');

    // Convert page coords to viewport-relative for cropping
    const vpRect = {
      x: rect.x - window.scrollX,
      y: rect.y - window.scrollY,
      width: rect.width,
      height: rect.height
    };

    const dpr = window.devicePixelRatio;
    const response = await chrome.runtime.sendMessage({
      type: 'singleCapture',
      rect: vpRect,
      dpr,
      domain: window.location.hostname,
      format: settings.format || 'png'
    });

    if (response.error) throw new Error(response.error);

    await handleResult(response.dataUrl);
  }

  function removeOverlay() {
    if (areaOverlay) {
      areaOverlay.remove();
      areaOverlay = null;
    }
    selectionBox = null;
  }

  // ===== Element Selection =====

  function startElementSelection() {
    document.addEventListener('mousemove', onElementMouseMove, true);
    document.addEventListener('click', onElementClick, true);
    document.addEventListener('keydown', onElementEsc, true);
    showNotification('Click an element to capture. Press Esc to cancel.');
  }

  function onElementMouseMove(e) {
    if (highlightedElement) {
      highlightedElement.classList.remove('ss-element-highlight');
    }
    highlightedElement = e.target;
    if (highlightedElement.classList.contains('ss-notification') ||
        highlightedElement.closest('.ss-notification')) return;
    highlightedElement.classList.add('ss-element-highlight');
  }

  async function onElementClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (!highlightedElement) return;

    document.removeEventListener('mousemove', onElementMouseMove, true);
    document.removeEventListener('click', onElementClick, true);
    document.removeEventListener('keydown', onElementEsc, true);

    highlightedElement.classList.remove('ss-element-highlight');

    const el = highlightedElement;
    highlightedElement = null;

    // Scroll into view if needed
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    await delay(200);

    const domRect = el.getBoundingClientRect();
    const rect = {
      x: domRect.x + window.scrollX,
      y: domRect.y + window.scrollY,
      width: domRect.width,
      height: domRect.height
    };

    await captureArea(rect);
  }

  function onElementEsc(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('mousemove', onElementMouseMove, true);
      document.removeEventListener('click', onElementClick, true);
      document.removeEventListener('keydown', onElementEsc, true);
      if (highlightedElement) {
        highlightedElement.classList.remove('ss-element-highlight');
        highlightedElement = null;
      }
      cleanup();
    }
  }

  // ===== Preview Panel =====

  async function handleResult(dataUrl) {
    const action = settings.defaultAction || 'preview';

    if (action === 'download') {
      await downloadResult(dataUrl);
      cleanup();
    } else if (action === 'copy') {
      showPreviewPanel(dataUrl, 'Click Copy to place the screenshot on the clipboard.');
      showNotification('Capture complete. Click Copy in the preview panel.');
      cleanup();
    } else {
      showPreviewPanel(dataUrl);
      cleanup();
    }
  }

  function showPreviewPanel(dataUrl, message) {
    removeExistingPreviewPanel();

    // Create Shadow DOM container
    const host = document.createElement('div');
    host.id = 'ss-preview-host';
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);';
    const shadow = host.attachShadow({ mode: 'closed' });

    // Load image to get dimensions
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const format = settings.format || 'png';

      shadow.innerHTML = '<style>' +
        '.panel{display:flex;flex-direction:column;max-height:min(72vh,720px);background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.2);padding:12px;width:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif}' +
        '.header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;flex:0 0 auto}' +
        '.title{font-size:14px;font-weight:600}' +
        '.close-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:#f1f3f4;border:none;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;color:#444;padding:0;flex:0 0 auto}' +
        '.close-btn:hover{color:#333}' +
        '.preview-wrap{min-height:0;overflow:auto;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;flex:1 1 auto}' +
        '.preview-img{display:block;max-width:100%;max-height:42vh;margin:0 auto;border:0;object-fit:contain}' +
        '.info{margin:8px 0 8px;font-size:12px;color:#666;flex:0 0 auto}' +
        '.message{margin:0 0 10px;font-size:12px;color:#555;flex:0 0 auto}' +
        '.actions{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;flex:0 0 auto}' +
        '.btn{padding:8px 12px;border:none;border-radius:6px;font-size:13px;cursor:pointer;min-width:0}' +
        '.btn:disabled{opacity:.65;cursor:wait}' +
        '.btn-download{background:#1a73e8;color:#fff}' +
        '.btn-download:hover{background:#1557b0}' +
        '.btn-copy{background:#f1f3f4;color:#333}' +
        '.btn-copy:hover{background:#e0e0e0}' +
        '.btn-close{background:#f8f9fa;color:#444;border:1px solid #dadce0}' +
        '.btn-close:hover{background:#f1f3f4}' +
        '</style>' +
        '<div class="panel">' +
        '<div class="header"><span class="title">📸 Capture Complete</span><button class="close-btn" title="Close">✕</button></div>' +
        '<div class="preview-wrap"><img class="preview-img" src="' + dataUrl + '"></div>' +
        '<div class="info">' + w + ' × ' + h + ' | ' + format.toUpperCase() + '</div>' +
        (message ? '<div class="message">' + escapeHtml(message) + '</div>' : '') +
        '<div class="actions"><button class="btn btn-download">💾 Download</button><button class="btn btn-copy">📋 Copy</button><button class="btn btn-close">Close</button></div>' +
        '</div>';

      // Event listeners
      const closePreview = () => {
        host.remove();
        cleanup();
      };

      shadow.querySelector('.close-btn').addEventListener('click', closePreview);
      shadow.querySelector('.btn-close').addEventListener('click', closePreview);

      shadow.querySelector('.btn-download').addEventListener('click', async () => {
        await downloadResult(dataUrl);
      });

      const copyBtn = shadow.querySelector('.btn-copy');
      copyBtn.addEventListener('click', async () => {
        copyBtn.disabled = true;
        copyBtn.textContent = 'Copying...';
        const copied = await copyResult(dataUrl, copyBtn);
        copyBtn.disabled = false;
        copyBtn.textContent = copied ? 'Copied' : '📋 Copy';
      });
    };
    img.src = dataUrl;

    document.body.appendChild(host);
  }

  function removeExistingPreviewPanel() {
    const existingHost = document.getElementById('ss-preview-host');
    if (existingHost) {
      existingHost.remove();
    }
  }

  async function downloadResult(dataUrl) {
    const domain = window.location.hostname;
    const format = settings.format || 'png';
    await chrome.runtime.sendMessage({
      type: 'downloadImage',
      dataUrl,
      domain,
      format
    });
    showNotification('Downloaded!');
  }

  async function copyResult(dataUrl, focusTarget) {
    try {
      const response = await fetch(dataUrl);
      const sourceBlob = await response.blob();
      const blob = sourceBlob.type === 'image/png'
        ? sourceBlob
        : await convertImageBlobToPng(sourceBlob);

      if (ClipboardItem.supports && !ClipboardItem.supports('image/png')) {
        throw new Error('PNG clipboard write is not supported in this browser');
      }

      await ensureClipboardFocus(focusTarget);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      showNotification('Copied to clipboard!');
      return true;
    } catch (err) {
      showNotification('Copy failed: ' + err.message);
      return false;
    }
  }

  async function ensureClipboardFocus(focusTarget) {
    window.focus();
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
    await delay(0);

    if (document.hidden || !document.hasFocus()) {
      throw new Error('Page is not focused. Click the page or Copy button again.');
    }
  }

  function convertImageBlobToPng(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) {
            resolve(pngBlob);
          } else {
            reject(new Error('Failed to convert image to PNG'));
          }
        }, 'image/png');
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load captured image for clipboard copy'));
      };

      img.src = url;
    });
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ===== Utilities =====

  function showNotification(text, duration) {
    duration = duration || 3000;
    let notif = document.querySelector('.ss-notification');
    if (notif) notif.remove();

    notif = document.createElement('div');
    notif.className = 'ss-notification';
    notif.textContent = text;
    document.body.appendChild(notif);

    requestAnimationFrame(() => notif.classList.add('visible'));

    setTimeout(() => {
      notif.classList.remove('visible');
      setTimeout(() => notif.remove(), 300);
    }, duration);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function cleanup() {
    window.__scrollScreenshotInstalled.captureInProgress = false;
  }
})();

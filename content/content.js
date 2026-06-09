/**
 * Content script for Scroll Screenshot extension.
 * Handles: full-page scroll capture, area selection, element picking, preview panel.
 * Does NOT send tabId — service worker uses sender.tab.id.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__scrollScreenshotActive) return;
  window.__scrollScreenshotActive = true;

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
      settings = message.settings;
      captureMode = message.mode;
      handleCaptureStart(message.mode);
    }
    sendResponse({ status: 'received' });
    return true;
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
      }
    } catch (err) {
      showNotification('Capture failed: ' + err.message);
      cleanup();
    }
  }

  // ===== Full Page Capture =====

  async function fullPageCapture() {
    const scrollEl = document.scrollingElement || document.documentElement;
    const totalHeight = scrollEl.scrollHeight;
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio;

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

      // Pre-scroll to trigger lazy loading
      showNotification('Loading images...');
      await preScrollLazyLoad(scrollEl, totalHeight, viewportHeight);

      // Hide fixed/sticky elements
      hideFixedElements();

      // Calculate capture steps
      const scrollStep = viewportHeight - OVERLAP;
      const steps = Math.ceil(totalHeight / scrollStep);
      const frames = [];

      showNotification('Capturing... (0/' + steps + ')');

      for (let i = 0; i < steps; i++) {
        // Check for abort
        if (abortController.aborted) {
          throw new Error('Capture cancelled — tab lost focus or user navigated away');
        }

        const scrollY = Math.min(i * scrollStep, totalHeight - viewportHeight);
        window.scrollTo(0, scrollY);
        await delay(settings.captureDelay || 100);

        // Capture this frame (service worker uses sender.tab.id)
        const response = await chrome.runtime.sendMessage({
          type: 'captureFrame'
        });

        if (response.error) throw new Error(response.error);

        frames.push({
          dataUrl: response.dataUrl,
          scrollY: scrollY
        });

        showNotification('Capturing... (' + (i + 1) + '/' + steps + ')');
      }

      // Capture fixed elements frame at top
      restoreFixedElements();
      window.scrollTo(0, 0);
      await delay(settings.captureDelay || 100);
      const fixedFrameResponse = await chrome.runtime.sendMessage({
        type: 'captureFrame'
      });

      // Use fixed header frame only if capture succeeded
      const fixedHeaderDataUrl = (!fixedFrameResponse.error && fixedFrameResponse.dataUrl)
        ? fixedFrameResponse.dataUrl
        : null;

      // Stitch frames (with fixed-header compositing info)
      showNotification('Stitching...');
      const stitchResponse = await chrome.runtime.sendMessage({
        type: 'stitchAndFinish',
        frames,
        fixedHeaderDataUrl,
        viewportHeight,
        dpr,
        domain: window.location.hostname,
        format: settings.format || 'png'
      });

      if (stitchResponse.error) throw new Error(stitchResponse.error);

      // Handle result based on default action setting
      await handleResult(stitchResponse.dataUrl);

    } finally {
      clearInterval(heartbeat);
      port.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      restoreFixedElements();
      window.scrollTo(originalScrollX, originalScrollY);
    }
  }

  async function preScrollLazyLoad(scrollEl, totalHeight, viewportHeight) {
    const step = viewportHeight * 2;
    for (let y = 0; y < totalHeight; y += step) {
      window.scrollTo(0, y);
      await delay(50);
    }
    window.scrollTo(0, 0);
    await delay(200);
  }

  function hideFixedElements() {
    hiddenElements = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
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

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'ss-action-btn-confirm';
    confirmBtn.textContent = '✓ Confirm';
    confirmBtn.addEventListener('click', async () => {
      try {
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
      await copyResult(dataUrl);
      cleanup();
    } else {
      showPreviewPanel(dataUrl);
    }
  }

  function showPreviewPanel(dataUrl) {
    // Create Shadow DOM container
    const host = document.createElement('div');
    host.id = 'ss-preview-host';
    host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    // Load image to get dimensions
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const format = settings.format || 'png';

      shadow.innerHTML = '<style>' +
        '.panel{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.2);padding:16px;max-width:400px;font-family:-apple-system,BlinkMacSystemFont,sans-serif}' +
        '.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}' +
        '.title{font-size:14px;font-weight:600}' +
        '.close-btn{background:none;border:none;font-size:18px;cursor:pointer;color:#666;padding:4px}' +
        '.close-btn:hover{color:#333}' +
        '.preview-img{max-width:100%;border-radius:6px;border:1px solid #e0e0e0}' +
        '.info{margin:8px 0 12px;font-size:12px;color:#666}' +
        '.actions{display:flex;gap:8px}' +
        '.btn{padding:8px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer;flex:1}' +
        '.btn-download{background:#1a73e8;color:#fff}' +
        '.btn-download:hover{background:#1557b0}' +
        '.btn-copy{background:#f1f3f4;color:#333}' +
        '.btn-copy:hover{background:#e0e0e0}' +
        '</style>' +
        '<div class="panel">' +
        '<div class="header"><span class="title">📸 Capture Complete</span><button class="close-btn" title="Close">✕</button></div>' +
        '<img class="preview-img" src="' + dataUrl + '">' +
        '<div class="info">' + w + ' × ' + h + ' | ' + format.toUpperCase() + '</div>' +
        '<div class="actions"><button class="btn btn-download">💾 Download</button><button class="btn btn-copy">📋 Copy</button></div>' +
        '</div>';

      // Event listeners
      shadow.querySelector('.close-btn').addEventListener('click', () => {
        host.remove();
        cleanup();
      });

      shadow.querySelector('.btn-download').addEventListener('click', async () => {
        await downloadResult(dataUrl);
      });

      shadow.querySelector('.btn-copy').addEventListener('click', async () => {
        await copyResult(dataUrl);
      });
    };
    img.src = dataUrl;

    document.body.appendChild(host);
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

  async function copyResult(dataUrl) {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      showNotification('Copied to clipboard!');
    } catch (err) {
      showNotification('Copy failed: ' + err.message);
    }
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

  function cleanup() {
    window.__scrollScreenshotActive = false;
  }
})();

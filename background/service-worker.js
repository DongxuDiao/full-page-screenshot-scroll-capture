/**
 * Background service worker for Scroll Screenshot extension.
 * Handles context menu registration, message routing, and captureVisibleTab orchestration.
 * Uses sender.tab.id to identify tabs (content scripts don't know their own tabId).
 */

importScripts('../lib/image-utils.js');

// Context menu IDs
const MENU_FULL_PAGE = 'scroll-screenshot-full-page';
const MENU_AREA = 'scroll-screenshot-area';
const MENU_ELEMENT = 'scroll-screenshot-element';

// Register context menus on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_FULL_PAGE,
    title: '📸 Full Page Screenshot',
    contexts: ['page', 'image']
  });
  chrome.contextMenus.create({
    id: MENU_AREA,
    title: '📐 Area Screenshot',
    contexts: ['page', 'image']
  });
  chrome.contextMenus.create({
    id: MENU_ELEMENT,
    title: '🎯 Element Screenshot',
    contexts: ['page', 'image']
  });
});

// Keep-alive port for long captures
let keepAlivePort = null;
const captureSessions = new Map();
const CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS = 1200;
const CAPTURE_VISIBLE_TAB_MAX_RETRIES = 3;
const CAPTURE_SESSION_TTL_MS = 10 * 60 * 1000;
let lastVisibleTabCaptureAt = 0;
let visibleTabCaptureQueue = Promise.resolve();

chrome.runtime.onConnect.addListener((port) => {
  keepAlivePort = port;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'heartbeat') {
      // Keep alive — the message itself prevents idle
    }
  });
  port.onDisconnect.addListener(() => {
    keepAlivePort = null;
  });
});

// Handle messages from popup and content scripts
// IMPORTANT: uses sender.tab.id to identify the tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  const tabId = sender.tab ? sender.tab.id : message.tabId;
  const windowId = sender.tab ? sender.tab.windowId : undefined;

  switch (message.type) {
    case 'startCapture':
      return startCapture(message.tabId, message.mode);

    case 'captureFrame':
      return captureFrame(windowId, message);

    case 'stitchAndFinish':
      return stitchAndFinish(message);

    case 'discardCaptureSession':
      return discardCaptureSession(message.sessionId);

    case 'singleCapture':
      return singleCapture(windowId, message.rect, message.dpr, message.format);

    case 'downloadImage':
      return downloadImage(message.dataUrl, message.domain, message.format);

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const modeMap = {
    [MENU_FULL_PAGE]: 'fullpage',
    [MENU_AREA]: 'area',
    [MENU_ELEMENT]: 'element'
  };
  const mode = modeMap[info.menuItemId];
  if (mode && tab) {
    injectAndStart(tab.id, mode).catch((err) => {
      console.error('Scroll Screenshot context menu capture failed:', err);
    });
  }
});

// Handle popup trigger
async function startCapture(tabId, mode) {
  try {
    await injectAndStart(tabId, mode);
    return { status: 'started' };
  } catch (err) {
    return { error: 'Cannot capture this page: ' + err.message };
  }
}

async function injectAndStart(tabId, mode) {
  // Inject content script
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js']
  });
  // Inject CSS
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/content.css']
  });
  // Load settings and send start message to content script
  const settings = await getSettings();
  return await chrome.tabs.sendMessage(tabId, {
    type: 'captureStart',
    mode,
    settings
  });
}

async function captureFrame(windowId, message = {}) {
  const dataUrl = await captureVisibleTabThrottled(windowId);

  if (message.sessionId) {
    const session = getCaptureSession(message.sessionId);
    session.frames.push({
      dataUrl,
      scrollY: message.scrollY,
      captureRect: message.captureRect
    });
    return { status: 'captured', frameCount: session.frames.length };
  }

  return { dataUrl };
}

async function captureVisibleTabThrottled(windowId) {
  const captureTask = visibleTabCaptureQueue.then(async () => {
    const waitMs = Math.max(0, CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS - (Date.now() - lastVisibleTabCaptureAt));
    if (waitMs > 0) {
      await delay(waitMs);
    }

    return await captureVisibleTabWithRetry(windowId);
  });

  visibleTabCaptureQueue = captureTask.catch(() => {});
  return await captureTask;
}

async function captureVisibleTabWithRetry(windowId) {
  let lastError = null;

  for (let attempt = 0; attempt <= CAPTURE_VISIBLE_TAB_MAX_RETRIES; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'png'
      });
      lastVisibleTabCaptureAt = Date.now();
      return dataUrl;
    } catch (err) {
      lastError = err;
      if (!isCaptureQuotaError(err) || attempt === CAPTURE_VISIBLE_TAB_MAX_RETRIES) {
        throw err;
      }

      await delay(CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS * (attempt + 1));
    }
  }

  throw lastError;
}

function isCaptureQuotaError(err) {
  return err && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(err.message || '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCaptureSession(sessionId) {
  let session = captureSessions.get(sessionId);
  if (!session) {
    session = {
      frames: [],
      timeoutId: setTimeout(() => {
        captureSessions.delete(sessionId);
      }, CAPTURE_SESSION_TTL_MS)
    };
    captureSessions.set(sessionId, session);
  }
  return session;
}

function discardCaptureSession(sessionId) {
  if (!sessionId) {
    return { status: 'discarded' };
  }

  const session = captureSessions.get(sessionId);
  if (session && session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  captureSessions.delete(sessionId);
  return { status: 'discarded' };
}

async function stitchAndFinish(message) {
  const {
    sessionId,
    fixedHeaderDataUrl,
    viewportHeight,
    totalHeight,
    dpr,
    format
  } = message;
  const session = sessionId ? captureSessions.get(sessionId) : null;
  const frames = session ? session.frames : message.frames;
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

  try {
    if (!frames || frames.length === 0) {
      throw new Error('No captured frames to stitch');
    }

    if (frames.length === 1 && !fixedHeaderDataUrl) {
      return { dataUrl: frames[0].dataUrl };
    }

    const result = await ImageUtils.stitchFrames(frames, viewportHeight, 200, dpr, totalHeight);

    // Composite fixed header at the top if provided
    if (fixedHeaderDataUrl) {
      const headerImg = await ImageUtils.loadImage(fixedHeaderDataUrl);
      const ctx = result.canvas.getContext('2d');
      // Only draw the fixed-element region (top 200 CSS pixels), not the entire viewport
      const fixedRegionHeight = Math.min(200 * dpr, headerImg.height);
      ctx.drawImage(headerImg, 0, 0, result.width, fixedRegionHeight, 0, 0, result.width, fixedRegionHeight);
    }

    const dataUrl = await ImageUtils.toDataUrl(result.canvas, mimeType);
    return { dataUrl };
  } finally {
    discardCaptureSession(sessionId);
  }
}

async function singleCapture(windowId, rect, dpr, format) {
  const dataUrl = await captureVisibleTabThrottled(windowId);

  if (rect) {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const cropped = await ImageUtils.crop(dataUrl, rect.x, rect.y, rect.width, rect.height, dpr);
    const result = await ImageUtils.toDataUrl(cropped.canvas, mimeType);
    return { dataUrl: result };
  }

  return { dataUrl };
}

async function downloadImage(dataUrl, domain, format) {
  const filename = ImageUtils.generateFilename(domain, format);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
  return { status: 'downloaded' };
}

async function getSettings() {
  const defaults = {
    format: 'png',
    defaultAction: 'preview',
    captureDelay: 100
  };
  const stored = await chrome.storage.local.get('settings');
  return { ...defaults, ...(stored.settings || {}) };
}

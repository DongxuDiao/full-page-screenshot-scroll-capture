const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createChromeMock(overrides = {}) {
  const listeners = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.onInstalled = fn; } },
      onConnect: { addListener: (fn) => { listeners.onConnect = fn; } },
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } }
    },
    contextMenus: {
      create: () => {},
      onClicked: { addListener: (fn) => { listeners.onContextClicked = fn; } }
    },
    scripting: {
      executeScript: async () => {},
      insertCSS: async () => {}
    },
    tabs: {
      captureVisibleTab: async () => 'data:image/png;base64,frame',
      sendMessage: async () => ({ status: 'started' })
    },
    storage: {
      local: { get: async () => ({}) }
    },
    downloads: {
      download: async () => 1
    }
  };

  return {
    chrome: mergeDeep(chrome, overrides),
    listeners
  };
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function loadServiceWorker(overrides = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background', 'service-worker.js'),
    'utf8'
  );
  const { chrome, listeners } = createChromeMock(overrides.chrome || {});
  const errors = [];
  const sandbox = {
    chrome,
    console: {
      error: (...args) => errors.push(args),
      log: () => {},
      warn: () => {}
    },
    ImageUtils: {
      stitchFrames: async () => ({
        canvas: {},
        width: 10,
        height: 10
      }),
      toDataUrl: async () => 'data:image/png;base64,stitched',
      loadImage: async () => ({ width: 10, height: 10 }),
      crop: async () => ({ canvas: {} }),
      generateFilename: () => 'capture.png'
    },
    importScripts: () => {},
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(source, sandbox, { filename: 'service-worker.js' });
  return { sandbox, listeners, errors };
}

test('discardCaptureSession clears stored frames before stitching', async () => {
  const { sandbox } = loadServiceWorker();

  await sandbox.handleMessage({
    type: 'captureFrame',
    sessionId: 'session-1',
    scrollY: 0,
    captureRect: null
  }, { tab: { id: 1, windowId: 1 } });

  const discardResponse = await sandbox.handleMessage(
    { type: 'discardCaptureSession', sessionId: 'session-1' },
    {}
  );
  assert.equal(discardResponse.status, 'discarded');

  await assert.rejects(
    sandbox.handleMessage({
      type: 'stitchAndFinish',
      sessionId: 'session-1',
      viewportHeight: 100,
      totalHeight: 100,
      dpr: 1,
      format: 'png'
    }, {}),
    /No captured frames/
  );
});

test('context menu capture failures are caught and logged', async () => {
  const { listeners, errors } = loadServiceWorker({
    chrome: {
      scripting: {
        executeScript: async () => {
          throw new Error('Cannot access page');
        }
      }
    }
  });

  listeners.onContextClicked(
    { menuItemId: 'scroll-screenshot-full-page' },
    { id: 123 }
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /Cannot access page/);
});

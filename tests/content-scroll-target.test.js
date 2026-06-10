const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement({
  tagName = 'div',
  id = '',
  className = '',
  scrollHeight = 0,
  clientHeight = 0,
  clientWidth = 0,
  overflowY = 'visible',
  position = 'static',
  rect = { left: 0, top: 0, right: clientWidth, bottom: clientHeight }
} = {}) {
  return {
    tagName: tagName.toUpperCase(),
    id,
    className,
    scrollHeight,
    clientHeight,
    clientWidth,
    scrollTop: 0,
    style: { visibility: '' },
    _computedStyle: { overflowY, position },
    appendChild: () => {},
    remove: () => {},
    contains: (other) => other === this,
    getBoundingClientRect: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top
    }),
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false
    },
    closest: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

function loadContentScriptWithBodyScrollPage() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'content', 'content.js'),
    'utf8'
  );
  const messages = [];
  let messageListener = null;

  const html = createElement({
    tagName: 'html',
    scrollHeight: 600,
    clientHeight: 600,
    clientWidth: 1000,
    overflowY: 'auto'
  });
  const body = createElement({
    tagName: 'body',
    scrollHeight: 2400,
    clientHeight: 600,
    clientWidth: 1000,
    overflowY: 'auto'
  });
  const app = createElement({
    id: 'app',
    scrollHeight: 2400,
    clientHeight: 600,
    clientWidth: 1000,
    overflowY: 'visible',
    rect: { left: 0, top: 0, right: 1000, bottom: 600 }
  });
  const helper = createElement({
    className: 'helper-wrapper',
    scrollHeight: 510,
    clientHeight: 229,
    clientWidth: 259,
    overflowY: 'auto',
    rect: { left: 720, top: 300, right: 979, bottom: 529 }
  });

  body.appendChild = () => {};

  const document = {
    body,
    documentElement: html,
    scrollingElement: html,
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id) => {
      if (id === 'app') return app;
      if (id === 'ss-preview-host') return null;
      return null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'body *') return [app, helper];
      if (selector === '*') return [app, helper];
      return [];
    },
    createElement: () => createElement()
  };

  const chrome = {
    runtime: {
      onMessage: {
        addListener: (listener) => {
          messageListener = listener;
        }
      },
      connect: () => ({
        postMessage: () => {},
        disconnect: () => {}
      }),
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'stitchAndFinish') {
          return { dataUrl: 'data:image/png;base64,result' };
        }
        if (message.type === 'downloadImage' || message.type === 'discardCaptureSession') {
          return { status: 'ok' };
        }
        return { status: 'captured' };
      }
    }
  };

  const sandbox = {
    chrome,
    document,
    window: null,
    location: { hostname: 'example.test' },
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      queueMicrotask(fn);
      return 1;
    },
    requestAnimationFrame: (fn) => fn(),
    getComputedStyle: (el) => el._computedStyle,
    Math,
    Date
  };
  sandbox.window = {
    __scrollScreenshotInstalled: null,
    innerHeight: 600,
    innerWidth: 1000,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {}
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = document;
  sandbox.window.chrome = chrome;
  sandbox.window.location = sandbox.location;

  vm.runInNewContext(source, sandbox, { filename: 'content.js' });

  return {
    body,
    helper,
    messages,
    startCapture: () => {
      assert.equal(typeof messageListener, 'function');
      messageListener({
        type: 'captureStart',
        mode: 'fullpage',
        settings: {
          captureDelay: 0,
          defaultAction: 'download',
          format: 'png'
        }
      }, {}, () => {});
    }
  };
}

async function waitForMessage(messages, type) {
  for (let i = 0; i < 50; i++) {
    if (messages.some((message) => message.type === type)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

test('full-page capture uses body when body is the real scroll container', async () => {
  const { body, helper, messages, startCapture } = loadContentScriptWithBodyScrollPage();

  startCapture();
  await waitForMessage(messages, 'stitchAndFinish');

  const frameMessages = messages.filter((message) => message.type === 'captureFrame' && message.sessionId);
  assert.ok(frameMessages.length > 2);
  assert.ok(frameMessages.every((message) => message.captureRect === null));
  assert.equal(body.scrollTop, 0);
  assert.equal(helper.scrollTop, 0);
});

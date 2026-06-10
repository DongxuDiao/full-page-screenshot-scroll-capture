const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadImageUtils(overrides = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'image-utils.js'),
    'utf8'
  );
  const sandbox = {
    Blob,
    console,
    globalThis: null,
    ...overrides
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'image-utils.js' });
  return sandbox.ImageUtils;
}

function createCanvasRecorder() {
  const canvases = [];

  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.draws = [];
      canvases.push(this);
    }

    getContext() {
      return {
        drawImage: (...args) => this.draws.push(args),
        getImageData: () => ({ data: new Uint8ClampedArray(100 * 80 * 4) })
      };
    }

    async convertToBlob({ type }) {
      return new Blob(['canvas'], { type });
    }
  }

  return { FakeOffscreenCanvas, canvases };
}

test('loadImage works in a worker-like context without DOM Image', async () => {
  const bitmap = { width: 12, height: 8 };
  const ImageUtils = loadImageUtils({
    fetch: async (url) => {
      assert.equal(url, 'data:image/png;base64,AAA=');
      return { blob: async () => new Blob(['png'], { type: 'image/png' }) };
    },
    createImageBitmap: async (blob) => {
      assert.equal(blob.type, 'image/png');
      return bitmap;
    }
  });

  assert.equal(await ImageUtils.loadImage('data:image/png;base64,AAA='), bitmap);
});

test('toDataUrl works in a worker-like context without FileReader', async () => {
  const ImageUtils = loadImageUtils({
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  const canvas = {
    convertToBlob: async ({ type }) => new Blob(['ok'], { type })
  };

  assert.equal(await ImageUtils.toDataUrl(canvas, 'image/png'), 'data:image/png;base64,b2s=');
});

test('stitchFrames places captured frames by their scroll position', async () => {
  const { FakeOffscreenCanvas, canvases } = createCanvasRecorder();
  const ImageUtils = loadImageUtils({
    OffscreenCanvas: FakeOffscreenCanvas,
    fetch: async () => ({ blob: async () => new Blob(['png'], { type: 'image/png' }) }),
    createImageBitmap: async () => ({ width: 100, height: 50 })
  });

  const result = await ImageUtils.stitchFrames([
    { dataUrl: 'data:image/png;base64,AAA=', scrollY: 0 },
    { dataUrl: 'data:image/png;base64,BBB=', scrollY: 30 },
    { dataUrl: 'data:image/png;base64,CCC=', scrollY: 60 }
  ], 50, 20, 1, 110);

  assert.equal(result.width, 100);
  assert.equal(result.height, 110);
  assert.deepEqual(canvases[0].draws.map((args) => args[2]), [0, 30, 60]);
});

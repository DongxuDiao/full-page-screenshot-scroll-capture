/**
 * Image utility functions for screenshot stitching, cropping, and export.
 * All functions operate on ImageBitmap/HTMLImageElement/Canvas sources.
 * Works in both service worker (OffscreenCanvas) and content script contexts.
 */

const ImageUtils = (() => {

  const CANVAS_MAX_PIXELS = 268_000_000;

  /**
   * Stitch multiple screenshot frames into a single image using overlap-based
   * pixel correlation for alignment.
   *
   * @param {Array<{dataUrl: string, scrollY: number}>} frames - Captured frames in order
   * @param {number} viewportHeight - CSS pixel height of the viewport
   * @param {number} overlap - Overlap region in CSS pixels (default 200)
   * @param {number} dpr - Device pixel ratio
   * @returns {Promise<{canvas: OffscreenCanvas, width: number, height: number}>}
   */
  async function stitchFrames(frames, viewportHeight, overlap = 200, dpr = 1) {
    if (!frames || frames.length === 0) {
      throw new Error('No frames to stitch');
    }

    // Load all frame images
    const images = [];
    for (const frame of frames) {
      const img = await loadImage(frame.dataUrl);
      images.push(img);
    }

    const frameWidth = images[0].width;   // Already in device pixels
    const frameHeight = images[0].height;  // Already in device pixels
    const overlapPx = Math.round(overlap * dpr);

    // Calculate total height
    const totalHeightPx = Math.round(frames.length * frameHeight -
      (frames.length - 1) * overlapPx);

    // Check canvas size limit
    const totalPixels = frameWidth * totalHeightPx;
    if (totalPixels > CANVAS_MAX_PIXELS) {
      throw new Error(`Image too large: ${frameWidth}x${totalHeightPx} (${totalPixels} pixels). Maximum is ${CANVAS_MAX_PIXELS}.`);
    }

    const canvas = new OffscreenCanvas(frameWidth, totalHeightPx);
    const ctx = canvas.getContext('2d');

    // Draw first frame
    ctx.drawImage(images[0], 0, 0);

    let currentY = frameHeight - overlapPx;

    for (let i = 1; i < images.length; i++) {
      // Find best alignment in overlap region
      const alignedY = await findAlignment(
        ctx, canvas, images[i], currentY, overlapPx
      );

      // Draw frame at aligned position
      ctx.drawImage(images[i], 0, alignedY);
      currentY = alignedY + frameHeight;
    }

    return { canvas, width: frameWidth, height: totalHeightPx };
  }

  /**
   * Find the best vertical alignment for a new frame by comparing
   * the overlap region of the stitched image so far with the top of the new frame.
   * Uses downsampled pixel comparison for speed.
   */
  async function findAlignment(ctx, canvas, newFrame, approxY, overlapPx) {
    const sampleStep = 4;
    const searchRange = Math.round(overlapPx * 0.1);
    const sampleWidth = Math.min(100, Math.floor(newFrame.width / 10));

    let bestOffset = approxY;
    let bestDiff = Infinity;

    // Get existing image data from overlap region
    const existingData = ctx.getImageData(
      0, Math.max(0, approxY - searchRange),
      sampleWidth, overlapPx + 2 * searchRange
    );

    // Get top of new frame data
    const tempCanvas = new OffscreenCanvas(newFrame.width, newFrame.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(newFrame, 0, 0);
    const newData = tempCtx.getImageData(0, 0, sampleWidth, overlapPx + 2 * searchRange);

    for (let offset = -searchRange; offset <= searchRange; offset += sampleStep) {
      let diff = 0;
      const yStart = searchRange + offset;

      for (let row = 0; row < overlapPx; row += sampleStep) {
        for (let col = 0; col < sampleWidth; col += sampleStep) {
          const existingIdx = ((row + searchRange) * sampleWidth + col) * 4;
          const newIdx = ((row + yStart) * sampleWidth + col) * 4;

          if (newIdx >= 0 && newIdx < newData.data.length - 3 &&
              existingIdx >= 0 && existingIdx < existingData.data.length - 3) {
            diff += Math.abs(existingData.data[existingIdx] - newData.data[newIdx]);
            diff += Math.abs(existingData.data[existingIdx + 1] - newData.data[newIdx + 1]);
            diff += Math.abs(existingData.data[existingIdx + 2] - newData.data[newIdx + 2]);
          }
        }
      }

      if (diff < bestDiff) {
        bestDiff = diff;
        bestOffset = approxY + offset;
      }
    }

    return bestOffset;
  }

  /**
   * Crop a region from an image.
   *
   * @param {string} dataUrl - Source image as data URL
   * @param {number} x - Crop start X (CSS pixels)
   * @param {number} y - Crop start Y (CSS pixels)
   * @param {number} w - Crop width (CSS pixels)
   * @param {number} h - Crop height (CSS pixels)
   * @param {number} dpr - Device pixel ratio
   * @returns {Promise<{canvas: OffscreenCanvas, width: number, height: number}>}
   */
  async function crop(dataUrl, x, y, w, h, dpr = 1) {
    const img = await loadImage(dataUrl);
    const canvas = new OffscreenCanvas(Math.round(w * dpr), Math.round(h * dpr));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      img,
      Math.round(x * dpr), Math.round(y * dpr),
      Math.round(w * dpr), Math.round(h * dpr),
      0, 0,
      Math.round(w * dpr), Math.round(h * dpr)
    );
    return { canvas, width: Math.round(w * dpr), height: Math.round(h * dpr) };
  }

  /**
   * Export a canvas to a Blob.
   */
  async function toBlob(canvas, format = 'image/png', quality = 0.92) {
    return await canvas.convertToBlob({ type: format, quality });
  }

  /**
   * Export a canvas to a data URL.
   */
  async function toDataUrl(canvas, format = 'image/png', quality = 0.92) {
    const blob = await toBlob(canvas, format, quality);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Load an image from a data URL.
   */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * Generate a filename for the screenshot.
   */
  function generateFilename(domain, format = 'png') {
    const now = new Date();
    const ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    return `screenshot_${domain}_${ts}.${format}`;
  }

  return {
    stitchFrames,
    crop,
    toBlob,
    toDataUrl,
    loadImage,
    generateFilename,
    CANVAS_MAX_PIXELS
  };
})();

// Export for service worker context (importScripts)
if (typeof globalThis !== 'undefined') {
  globalThis.ImageUtils = ImageUtils;
}

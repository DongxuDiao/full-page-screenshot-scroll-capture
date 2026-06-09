# 📸 Scroll Screenshot

A lightweight Chrome extension for capturing full-page scrolling screenshots. Open source, zero dependencies.

## Features

- **Full Page Screenshot** — Automatically scrolls and stitches the entire page
- **Area Selection** — Drag to select any rectangular area
- **Element Pick** — Click on any element to capture it
- **Multiple Outputs** — Download, copy to clipboard, or preview before saving
- **Right-Click Menu** — Quick access from context menu

## Install

### From Source (Development)

1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `scroll-screenshot-extension/` directory

### From Chrome Web Store

_Coming soon_

## Usage

1. **Popup**: Click the extension icon and choose a capture mode
2. **Right-click**: Right-click anywhere and select a screenshot option
3. **Settings**: Configure format (PNG/JPEG), default action, and capture delay

## Tech Stack

- Chrome Extension Manifest V3
- Vanilla JavaScript (zero dependencies)
- Canvas API for image stitching

## License

MIT

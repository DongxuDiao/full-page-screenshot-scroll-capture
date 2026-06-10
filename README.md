# Scroll Screenshot

English | [中文](#中文)

A lightweight Chrome Extension for capturing scrolling screenshots, selected areas, and individual page elements. It runs locally in the browser, uses Manifest V3, and has no runtime dependencies.

## Features

- Full-page scrolling screenshots with automatic scrolling and stitching
- Area selection for capturing a custom rectangle
- Element selection for capturing a specific DOM element
- Preview, download, or copy screenshots to the clipboard
- PNG and JPEG output options
- Context menu shortcuts for quick access
- Local-only processing: screenshots are captured and stitched inside Chrome

## How It Works

Scroll Screenshot is split into three main pieces:

- `popup/`: the extension popup UI. It lets users choose capture mode, output format, default action, and capture delay.
- `content/`: the page-side capture controller. It handles scrolling, area selection, element picking, preview UI, and user notifications.
- `background/`: the Manifest V3 service worker. It injects the content script, calls `chrome.tabs.captureVisibleTab`, stores temporary frame data, throttles capture calls, and downloads files.

For full-page screenshots, the content script finds the best scroll target, scrolls through the page, and asks the service worker to capture each visible viewport. The service worker temporarily stores captured frames to avoid oversized extension messages. After all frames are collected, `lib/image-utils.js` stitches them together with Canvas/OffscreenCanvas and returns the final image.

For area and element screenshots, the content script computes the viewport-relative rectangle and the service worker captures and crops the visible tab.

## Installation

### Install From Source

1. Clone this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project directory.
6. Pin the extension if you want quick access from the toolbar.

### Package For Sharing

Create a zip file whose root contains `manifest.json` directly:

```bash
zip -r scroll-screenshot.zip \
  manifest.json background content lib popup icons README.md LICENSE \
  -x '*.DS_Store'
```

## Usage

### Capture From The Popup

1. Click the Scroll Screenshot extension icon.
2. Choose one of the capture modes:
   - **Full Page**: captures the whole scrollable page or main scroll container.
   - **Area Select**: drag to select a rectangle, then click **Confirm**.
   - **Element Select**: click a page element to capture it.
3. Configure optional settings:
   - **Format**: PNG or JPEG.
   - **Default Action**: preview, download, or copy.
   - **Capture Delay**: wait time between scrolling and frame capture.
4. Use the preview panel to download, copy, or close the result.

### Capture From The Context Menu

1. Right-click on a page.
2. Choose a Scroll Screenshot action from the context menu.
3. Follow the on-screen prompts if area or element selection is required.

## Permissions

The extension requests only the permissions needed for screenshot capture:

- `activeTab`: access the current tab after a user action.
- `scripting`: inject the content script and CSS into the active tab.
- `contextMenus`: add right-click capture actions.
- `downloads`: save screenshots to the local Downloads folder.
- `storage`: save user preferences locally.

The extension does not upload screenshots or browsing data to any server.

## Development

There is no build step. The extension is plain JavaScript, HTML, and CSS.

Run tests:

```bash
node --test tests/*.test.js
```

Check JavaScript syntax:

```bash
for f in background/service-worker.js content/content.js lib/image-utils.js popup/popup.js tests/*.test.js; do
  node --check "$f" || exit 1
done
```

## Known Limitations

- Chrome limits how frequently extensions can call `captureVisibleTab`, so very long pages may take a while.
- Some browser-internal pages, Chrome Web Store pages, and restricted pages cannot be captured by extensions.
- Complex pages with nested scroll containers, sticky headers, transforms, or virtualized content may require a longer capture delay.
- Clipboard copy depends on Chrome's focus and clipboard permissions. If copying fails, click the page or the preview panel and try again.

## Privacy

Scroll Screenshot processes screenshots locally in your browser. It does not collect analytics, does not send screenshots to remote servers, and does not sell or share user data.

## License

MIT

---

## 中文

[English](#scroll-screenshot) | 中文

Scroll Screenshot 是一个轻量级 Chrome 截图扩展，支持滚动长截图、区域截图和元素截图。它基于 Manifest V3 开发，无运行时依赖，截图和拼接过程都在本地浏览器中完成。

## 功能特性

- 自动滚动并拼接整页长截图
- 拖拽选择任意矩形区域截图
- 点击选择页面元素截图
- 支持预览、下载、复制到剪贴板
- 支持 PNG 和 JPEG 输出格式
- 支持右键菜单快速触发
- 本地处理：截图不会上传到服务器

## 实现思路

项目主要由三部分组成：

- `popup/`：扩展弹窗界面。用于选择截图模式、输出格式、默认动作和截图延迟。
- `content/`：注入到页面里的控制脚本。负责页面滚动、区域选择、元素选择、预览面板和提示信息。
- `background/`：Manifest V3 service worker。负责注入脚本、调用 `chrome.tabs.captureVisibleTab`、暂存截图帧、限制截图频率、触发下载。

整页截图的大致流程是：

1. content script 判断当前页面的主要滚动目标，优先使用页面自身滚动；如果页面主体不滚动，则尝试寻找主要的内部滚动容器。
2. content script 按视口高度分段滚动页面，并通知 background 捕获当前可见区域。
3. background 调用 `chrome.tabs.captureVisibleTab` 获取每一帧截图，并临时保存在 service worker 中，避免一次性传递过大的消息。
4. 所有帧捕获完成后，`lib/image-utils.js` 使用 Canvas/OffscreenCanvas 按滚动位置进行拼接。
5. 最终截图根据用户设置进入预览、下载或复制流程。

区域截图和元素截图的流程更短：content script 计算需要裁剪的视口坐标，background 捕获当前可见标签页，然后按矩形区域裁剪。

## 安装方式

### 从源码安装

1. 克隆本仓库。
2. 在 Chrome 中打开 `chrome://extensions/`。
3. 打开右上角 **Developer mode / 开发者模式**。
4. 点击 **Load unpacked / 加载已解压的扩展程序**。
5. 选择本项目目录。
6. 如果需要，可以把扩展固定到浏览器工具栏。

### 打包分享

打包时要确保 zip 根目录直接包含 `manifest.json`：

```bash
zip -r scroll-screenshot.zip \
  manifest.json background content lib popup icons README.md LICENSE \
  -x '*.DS_Store'
```

## 使用说明

### 通过弹窗截图

1. 点击浏览器工具栏里的 Scroll Screenshot 图标。
2. 选择截图模式：
   - **Full Page**：截取整页或主要滚动容器。
   - **Area Select**：拖拽选择区域，然后点击 **Confirm**。
   - **Element Select**：点击页面中的某个元素进行截图。
3. 可按需调整设置：
   - **Format**：PNG 或 JPEG。
   - **Default Action**：预览、下载或复制。
   - **Capture Delay**：滚动后等待多久再截图，页面懒加载较多时可以适当调大。
4. 在预览面板中选择下载、复制或关闭。

### 通过右键菜单截图

1. 在页面中右键点击。
2. 选择 Scroll Screenshot 对应的截图动作。
3. 如果选择区域截图或元素截图，根据页面提示继续操作。

## 权限说明

扩展只申请截图功能必要的权限：

- `activeTab`：用户主动触发后访问当前标签页。
- `scripting`：向当前标签页注入截图脚本和样式。
- `contextMenus`：添加右键菜单入口。
- `downloads`：把截图保存到本地下载目录。
- `storage`：在本地保存用户设置。

扩展不会把截图或浏览数据上传到任何服务器。

## 开发说明

本项目没有构建步骤，代码由原生 JavaScript、HTML 和 CSS 组成。

运行测试：

```bash
node --test tests/*.test.js
```

检查 JavaScript 语法：

```bash
for f in background/service-worker.js content/content.js lib/image-utils.js popup/popup.js tests/*.test.js; do
  node --check "$f" || exit 1
done
```

## 已知限制

- Chrome 对 `captureVisibleTab` 调用频率有限制，因此超长页面截图会比较慢。
- 浏览器内部页面、Chrome Web Store 页面以及部分受限制页面无法被扩展截图。
- 嵌套滚动容器、固定头部、CSS transform、虚拟列表等复杂页面可能需要增加截图延迟。
- 复制到剪贴板依赖页面焦点和浏览器权限。如果复制失败，可以点击页面或预览面板后重试。

## 隐私说明

Scroll Screenshot 在本地浏览器中处理截图。它不收集统计数据，不把截图上传到远程服务器，也不会出售或分享用户数据。

## 许可证

MIT

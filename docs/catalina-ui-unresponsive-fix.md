# macOS Catalina (Safari 13) 界面点击无响应修复记录

## 1. 问题背景
在 macOS Catalina (10.15) 上运行 InfloWave Tauri 桌面端时，主界面出现点击无响应、事件失效的问题。但在浏览器中直接访问本地服务 (http://127.0.0.1:14222/) 时一切正常。

## 2. 问题原因分析
Catalina 系统的 Tauri 默认使用系统自带的 WKWebView 渲染引擎，该版本等同于 Safari 13。Safari 13 存在以下严重的兼容性缺失，导致了界面崩溃和交互失效：

1. **缺失 Pointer Events API（导致卡死的根本原因）**
   - 项目中使用的 Radix UI 等现代组件库重度依赖 `PointerEvent`，以及 `Element.prototype.hasPointerCapture`、`setPointerCapture` 等方法。
   - Safari 13 原生不支持这些 API。当组件触发交互时，代码调用了不存在的方法从而引发致命的 `TypeError`，导致 React 事件循环中断，进而造成整个界面的交互事件全部卡死（点击无响应）。
   
2. **缺失 CSS `inset` 属性支持**
   - Tailwind CSS 的 `inset-0`、`inset-x-0` 等类名在 Safari 13 中会被浏览器直接忽略（Safari 14.1 才开始支持）。
   - 这导致 Dialog 弹窗遮罩、侧边栏、Drawer 等采用绝对/固定定位的组件无法正确铺满屏幕，甚至因定位错乱阻挡了下方底层元素的点击。

3. **旧版 User-Agent 嗅探失效**
   - 现有的 `safari13-compat.js` 原本通过检测 User-Agent 中是否包含 `Version/13.` 来判断是否为 Safari 13 并应用降级规则。
   - 但在 Tauri 桌面端封装的 WKWebView 中，其 UA 字符串并不包含标准的 `Version/13.` 或 `Safari` 标识，导致原有的兼容脚本完全未能命中生效。

---

## 3. 详细修复方案

### 3.1 升级环境检测逻辑 (Feature Detection)
修改了 `public/safari13-compat.js`，将脆弱的 UA 字符串匹配升级为基于 CSS 的**特性检测（Feature Detection）**。
```javascript
// 优先使用特性检测：如果浏览器不支持 inset 属性，则判定为需要兼容降级
var supportsInset = typeof CSS !== 'undefined' && 
                    typeof CSS.supports === 'function' && 
                    CSS.supports('inset', '0px');
```
这一改动使得应用无论是在 Safari 还是 Tauri WKWebView 中，只要引擎不支持新特性，就能 100% 准确命中降级策略。

### 3.2 注入 Pointer Events Polyfill 修复点击卡死
在 `index.html` 的 `<head>` 最前部，手动注入了完整的 Pointer API 兼容代码，从底层抹平 API 差异，防止 Radix UI 抛出异常：
- 伪造了 `window.PointerEvent` 构造函数，并在全局监听鼠标事件，将原生的 `mousedown`, `mouseup` 桥接转发为等价的 `pointerdown`, `pointerup` 事件。
- 为 `Element.prototype` 补充了安全的 `setPointerCapture`、`releasePointerCapture` 存根方法，并实现了基础的 `hasPointerCapture` 逻辑，满足了 Radix UI 内部调用的严苛校验逻辑。

### 3.3 全局 CSS `inset` 降级与内联兜底
- **样式表级修复**：在 `src/styles/safari13-compat.css` 中为 `.inset-0`, `.inset-x-0`, `.inset-y-0`, `.inset-auto`, `.inset-full` 等 Tailwind 类补充了显式的 `top/right/bottom/left` 强制覆盖规则 (`!important`)。
- **组件级修复**：在 `src/components/ui/dialog.tsx` 和 `src/components/common/UserGuideModal.tsx` 等关键模态框中，修复了 `isSafari13` 的判断逻辑，并直接应用内联的 `style={{ top: 0, right: 0, bottom: 0, left: 0 }}` 样式。
这确保了遮罩层能够 100% 覆盖可视区域，杜绝了遮罩层未展开而产生的视觉和点击穿透Bug。

---

## 4. 总结与后续建议
通过**特性检测**精准定位旧版 WebKit 环境，并在 **DOM API 层**（Pointer Events）和 **CSS 层**（Inset）进行双重 Polyfill 降级，彻底解决了 macOS Catalina 环境下因底层 API 缺失导致的组件库崩溃和事件卡死问题。

**建议：**
针对旧版 macOS 的 WebKit，后续在引入依赖了现代 Web API (如 `ResizeObserver`, `IntersectionObserver`) 的第三方组件时，应继续坚持“特性检测优先 + 注入 Polyfill 兜底”的原则，不要轻信 UA 嗅探。

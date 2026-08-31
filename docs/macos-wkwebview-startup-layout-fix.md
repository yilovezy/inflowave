# macOS WKWebView 启动白屏与尺寸滞后 Bug 修复记录

## 1. 问题现象

在 macOS 环境下启动 InfloWave 应用时，窗口首屏上半部分出现大面积白屏（空白区域），下方内容被挤压或偏下；当用户用鼠标拖动或微调缩放窗口边框后，界面立即恢复正常完整布局。

---

## 2. 根本原因分析 (Root Cause)

### 2.1 macOS Cocoa 坐标系与 WKWebView 尺寸不同步
1. **Cocoa 坐标系原点在左下角**：macOS Cocoa 视图系统的坐标系原点 `(0, 0)` 位于窗口的左下角。
2. **响应式尺寸调整的时序问题**：应用在 `tauri.conf.json` 中配置了初始尺寸（如 `1400x900`），但在 Rust 后端初始化阶段（`setup` 钩子中），调用了 [`setup_responsive_window_size`](file:///workspace/src-tauri/src/main.rs) 将窗口动态放大到屏幕逻辑尺寸的 95%（例如 `1600x1000`）。
3. **WKWebView 子视图 Frame 未同步**：在窗口创建和首屏 DOM 挂载期间，对原生 `NSWindow` 的尺寸调整未能及时触发 `WKWebView` 内部 `NSView` 的 `setFrame:` 重排。导致 `WKWebView` 仍然固定在左下角原有的高度区间渲染，新增的高出部分（上半部分）露出了原生窗口的默认背景色（白色）。
4. **手动拖拽恢复的原因**：当用户拖拽或改变窗口尺寸时，macOS WindowServer 向窗口派发原生 `windowDidResize:` / `viewDidMoveToWindow:` 事件，触发了 `autoresizesSubviews`，使得 `WKWebView` 重新撑满窗口。

### 2.2 既有前端 Hack 失效的原因 (Tauri v2 ACL 权限隔离)
项目中原有针对该问题的规避脚本（通过前端调用 `win.setSize` 或 `win.setPosition` 偏移 1px），但在 **Tauri v2** 环境下未能生效：
- Tauri v2 引入了严格的 Capabilities 权限管理体系。
- 配置文件 [`src-tauri/capabilities/default.json`](file:///workspace/src-tauri/capabilities/default.json) 中**未授权** `core:window:allow-set-size`、`core:window:allow-set-position` 等窗口操作权限，导致前端 IPC 交互被系统静默拦截拒绝。

---

## 3. 解决方案与具体实现

### 3.1 Rust 原生层自动重排（核心修复）
在 Rust 后端 `setup` 阶段设置窗口响应式尺寸后，启动轻量异步定时任务，在首屏完成渲染后自动对窗口进行 1px 原生伸缩并恢复，彻底强制 macOS 刷新 `WKWebView` 的 Frame：

- **文件**：[`src-tauri/src/main.rs`](file:///workspace/src-tauri/src/main.rs)
```rust
if let Err(e) = setup_responsive_window_size(&window) {
    error!("设置响应式窗口大小失败: {}", e);
}

// 针对 macOS / WKWebView 初始化尺寸滞后的自动刷新
let window_clone = window.clone();
tauri::async_runtime::spawn(async move {
    // 等待窗口完全挂载与首次绘制
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if let Ok(size) = window_clone.inner_size() {
        let _ = window_clone.set_size(tauri::PhysicalSize::new(size.width, size.height + 1));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = window_clone.set_size(tauri::PhysicalSize::new(size.width, size.height));
        info!("✅ 已在启动后自动完成原生 WKWebView 尺寸重绘 (200ms)");
    }
    // 二次确认，确保慢速机型/老系统也能正确重排
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    if let Ok(size) = window_clone.inner_size() {
        let _ = window_clone.set_size(tauri::PhysicalSize::new(size.width, size.height + 1));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = window_clone.set_size(tauri::PhysicalSize::new(size.width, size.height));
        info!("✅ 已在启动后自动完成原生 WKWebView 尺寸重绘 (600ms)");
    }
});
```

### 3.2 注册原生重排指令
在系统命令中实现专用的 `trigger_native_window_resize` 命令，使前端在必要时可显式请求后端以原生权限重绘窗口：

- **文件**：[`src-tauri/src/commands/system.rs`](file:///workspace/src-tauri/src/commands/system.rs)
```rust
/// 强制原生窗口重排与尺寸重绘（修复 macOS WKWebView 初始白屏/尺寸偏移）
#[tauri::command]
pub async fn trigger_native_window_resize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(size) = window.inner_size() {
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height + 1));
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
            debug!("成功执行原生窗口重绘/尺寸刷新命令");
        }
    }
    Ok(())
}
```

### 3.3 补全 Tauri v2 Capability 权限
在权限配置清单中补齐窗口调整相关权限：

- **文件**：[`src-tauri/capabilities/default.json`](file:///workspace/src-tauri/capabilities/default.json) & [`src-tauri/capabilities/linux.json`](file:///workspace/src-tauri/capabilities/linux.json)
```json
"permissions": [
  ...
  "core:window:allow-set-size",
  "core:window:allow-set-position",
  "core:window:allow-center",
  "core:window:allow-inner-size",
  "core:window:allow-outer-size",
  "core:window:allow-inner-position",
  "core:window:allow-outer-position",
  "core:webview:allow-set-webview-size",
  "core:webview:allow-set-webview-position"
]
```

### 3.4 前端调用封装与布局容器清理
1. 更新 [`src/utils/safariHack.ts`](file:///workspace/src/utils/safariHack.ts)，优先调用 `safeTauriInvokeVoid('trigger_native_window_resize')`。
2. 将全局基础布局组件 [`src/components/ui/Layout.tsx`](file:///workspace/src/components/ui/Layout.tsx) 中的硬编码 `min-h-screen` 调整为 `h-full w-full`，避免在 WebKit 初始视口计算错误时产生不必要的高宽挤压。

---

## 4. 验证结果
- 应用在 macOS 下直接启动后，首屏在 200ms 内自动重绘铺满整个窗口。
- 无需任何手动拖动或缩放窗口操作，顶部不再出现空白遮挡区域。

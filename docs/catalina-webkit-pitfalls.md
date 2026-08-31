# macOS Catalina 中 WebKit / WKWebView 的兼容性注意事项

适用范围：macOS 10.15 Catalina 上运行的 InfloWave 桌面端。该环境使用系统提供的 WebKit（Safari 13 同代）渲染 Tauri WebView；**不要用开发机上较新的 Chrome、Safari 或 WebKit 版本推断 Catalina 的实际行为**。

本文只记录与当前应用相关、且应在实现和排障时优先检查的问题。系统更新会改变 Safari/WebKit 的补丁版本，因此请以目标机器的系统版本和 Safari 版本为准。

## 先记住这几条

1. 将 Catalina 当作较旧的 Safari 环境测试，不把较新的 Web API、CSS 特性或编解码能力当作默认前提。
2. 视频优先使用 `MP4 (H.264 + AAC)`，通过标准 `https:` / `http://127.0.0.1:` URL 提供，并正确实现 Range 请求与 MIME 类型。
3. 播放失败时先区分“资源不可访问”“CSP/CORS 被拦截”“容器或编码不支持”；仅看 `.mp4` 后缀没有意义。
4. 未静音媒体不能假定会自动播放；由用户点击触发播放，并处理 `video.play()` 返回的 Promise。
5. 将 Safari Web Inspector、应用日志和最小化媒体样本作为排障基线。

## 典型问题与处理方式

| 场景 | 常见表现 | 原因 / 判断 | 建议 |
| --- | --- | --- | --- |
| 使用新 Web API 或 CSS | 页面空白、脚本报 `undefined is not a function`、样式失效 | Catalina 的系统 WebKit 版本固定在 Safari 13 同代，和现代 Chromium 的支持面不同 | 在目标机验证；用 feature detection（如 `typeof API !== 'undefined'`）和降级实现，避免只做 UA 判断。构建产物需保留 Safari 13 兼容的语法与 polyfill。 |
| WebSQL | 旧缓存/查询代码在启动时报错 | Safari 13 已移除 WebSQL | 使用 IndexedDB 或由 Tauri/Rust 提供的持久化能力；不要把 WebSQL 当作回退方案。 |
| 跨站 Cookie、嵌入页登录 | 登录循环、第三方 Cookie 丢失、回调无法保持会话 | Safari 的 ITP 与第三方 iframe 导航限制会影响跨站状态 | 尽量使用顶层窗口完成授权；将会话设计为同站、显式 token 或原生回调，并在 Catalina 上走完整登录流程验证。 |
| `<video>` / `<audio>` 自动播放 | `play()` 被拒绝或没有声音 | Safari 的自动播放策略要求无音轨或已 `muted`，而且受可见性与用户手势影响 | 首选用户操作后调用 `play()`；确需自动播放时加入 `muted playsinline`，并捕获 Promise rejection 后展示播放按钮。 |
| 视频“格式是 MP4 仍不能播放” | `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4） | 容器扩展名不是编码保证；目标系统未必支持其中的视频、音频编码或 profile | 交付 H.264 视频 + AAC 音频的 MP4 作为兼容基线；对 HEVC、AV1、MKV、AVI、WebM 等提供转码、明确提示或交给系统默认播放器。可用 `canPlayType()` 做提示，不能把它当作最终播放保证。 |
| Blob、asset 或自定义协议作为媒体 `src` | InfloWave 的 S3 视频预览无法加载 | 本项目曾观察到旧版 Tauri/WebKit 组合对这些非 HTTP 媒体 URL 的支持不可靠 | 不把这些方案作为 Catalina 的主路径。临时文件可由仅绑定 `127.0.0.1` 的本地 HTTP 服务提供；若仍失败，使用系统默认播放器。详见现有的 [v0.8.8 发布说明](release-notes/v0.8.8.md)。 |
| 本地 HTTP 视频无法拖动或只播开头 | seek 失败、时长未知、播放中断 | 服务端未返回正确 MIME，或不支持字节范围请求 | 对 `Range` 返回 `206 Partial Content`、`Content-Range`、`Accept-Ranges: bytes` 和正确的 `Content-Length`；MP4 返回 `video/mp4`。本项目的 `video_server.rs` 已承担此职责，修改时不要回退这些行为。 |
| 本地媒体被安全策略拦截 | 控制台出现 CSP 或 CORS 错误 | CSP 未允许本地源，或响应缺少与前端 origin 匹配的 CORS 头 | 在 Tauri CSP 中仅放行所需的 `media-src http://127.0.0.1:*`；本地服务只监听 loopback，严格校验可访问的缓存目录，避免放宽为任意来源或任意文件路径。 |
| 深色模式 / 原生控件差异 | 颜色、滚动条、表单控件与 Chrome 不同 | WebKit 对原生控件及系统外观的渲染不同 | 对关键控件显式设置背景、前景、边框和 focus 状态；不要依赖 Chromium 私有样式。必要时使用标准 `appearance` 并在浅色/深色模式下分别验收。 |
| 固定定位、滚动与视口 | 弹层错位、滚动容器表现不一致 | WebKit 的合成与滚动细节与 Chromium 不同 | 少用嵌套滚动和依赖私有 `-webkit-` 行为的布局；弹层用实际定位容器与 `getBoundingClientRect()` 计算，并在缩放、窗口 resize、滚动后复测。 |

## 媒体实现基线

```tsx
const play = async (video: HTMLVideoElement) => {
  try {
    await video.play();
  } catch (error) {
    // 例如未经过用户手势触发：保留播放按钮并提示用户点击。
    console.warn('Video playback was blocked or unsupported', error);
  }
};

<video controls playsInline preload="metadata" src={mediaUrl} />
```

- `preload="metadata"` 适合预览场景：先取得尺寸、时长和轨道信息，避免无条件下载完整文件。
- 服务端必须对 URL 路径做 decode 后的规范化和目录边界检查，拒绝 `..` 等目录遍历输入。
- 不要根据扩展名把所有文件声明为 `video/mp4`。无法准确识别时，宁可交给系统播放器或返回明确错误。
- 如果使用本地 HTTP 服务，端口必须仅绑定 `127.0.0.1`（或 `::1`），且 CSP/CORS 只开放给应用所需的来源。

## 排障顺序

1. 在 Catalina 真机上复现，并记录 macOS、Safari 与应用版本。
2. 打开 Safari Web Inspector，检查 Console、Network、Media：确认请求 URL、状态码、MIME、CSP/CORS 错误及 Range 响应。
3. 用同一资源分别验证系统默认播放器和 WebView：前者能播而后者不能播，通常是 WebKit 支持面、协议或安全策略问题，不应继续只改前端控件。
4. 将资源替换为已知可播放的 H.264/AAC MP4；若恢复正常，再检查原文件的实际编码、profile、音轨和服务端响应头。
5. 对非媒体问题，先在 Web Inspector 读取首个 JavaScript 异常；为不支持 API 加 feature detection 与可用的降级路径。

## 提交前检查清单

- [ ] 在 Catalina 真机或等效 Safari 13 环境完成核心流程冒烟测试。
- [ ] 新增 Web API 均有 feature detection 或明确的最低版本要求。
- [ ] 媒体 URL、MIME、CSP、CORS、`Range` / `206` 响应均已验证。
- [ ] 自动播放失败不会导致页面卡死或无提示；用户可手动开始播放。
- [ ] 本地媒体服务不暴露到局域网，且无法越过缓存目录访问任意文件。
- [ ] 核心深色/浅色、滚动、弹层和表单交互已在 WebKit 中复测。

## 参考资料

- Apple：[Safari 13 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-13-release-notes)（WebSQL 移除、ITP、媒体与 WebKit 变更）。
- Apple：[Delivering Video Content for Safari](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)（`preload`、自动播放、`playsinline`）。
- Apple：[Deploying a Basic HTTP Live Streaming Stream](https://developer.apple.com/documentation/http-live-streaming/deploying-a-basic-http-live-streaming-hls-stream)（媒体 MIME 类型配置）。
- 项目内：[InfloWave v0.8.8 发布说明](release-notes/v0.8.8.md)（本项目的 WebKit 媒体协议问题与既有实现）。

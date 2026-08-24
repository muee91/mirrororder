# Web / 原生工作台交接记录（2026-08-24）

## 本次已落地

- `MirrorOrderHTTPServer` 将静态资源接收队列扩大到 128，并启用地址复用和守护线程，降低浏览器启动时资源并发导致的连接重置。
- Team Web 的 `review.v1` 首屏加载改为先应用默认集数，再进入渲染；剧本候选、剧本状态和人工剧本范围增加按段/Take 的前端派生缓存。
- 原生场记的“已按剧本归位”和“待标记 · 保持 XML 顺序”改为 `VSplitView`，两个区域可上下拖动调整高度。
- 原生场记右侧检查器默认宽度收窄，并保留隐藏检查器入口。
- 原生视频预览根据 `AVPlayerItem.presentationSize` 调整显示区域，竖屏素材不再强制塞进固定横屏黑框。
- 原生“精确剧本”增加“全集”，全集模式下精确归集使用被拖入剧本块自身的集数，不依赖当前集数按钮。

## 已验证

- `python3 macos-app/prebuild_check.py` 通过。
- 最近一次完整回归测试通过：`333 passed`。
- `node --check web/app.js`、`node --check web/review_model.js` 和 `git diff --check` 通过。
- 使用 `/Applications/Xcode-beta.app/Contents/Developer` 构建过 App；构建日志确认打包仓库内 `vendor/multicam-audio-sync` 和自包含 `llama-server`。
- 8765 网关的 `/api/v1/ping` 返回 `{"status":"ok","service":"mirrororder-gateway"}`；`review-model` 当前实测响应约 1.2–1.5 秒，响应体约 4.1MB。

## 已知问题 / 下一步

- Team Web 仍存在首屏主线程卡顿回归：接口能返回，但真实浏览器在首屏绘制后可能无法及时完成截图/脚本响应。重点排查最近新增的启动门控、可选扩展脚本和 `renderContent` 调用链；不要把问题继续归因到 8765 单纯接口超时。
- 需要在独立环境逐个禁用/延迟 `material_card_ui.js`、`placement_drag_ui.js`、`semantic_search_ui.js`、`assistant_*` 等可选扩展，确认具体循环或同步渲染热点。
- 最后一轮在加入“启动保护”后重新执行 `build_ready.sh`，Python 测试已通过，但 App 构建阶段被用户中断；因此最后一轮前端保护尚未得到最终 App 包真机确认。远端代码以当前工作区为准，继续修改前应重新构建。
- 原生竖屏视频已完成代码路径和 Swift 构建验证，但仍需在真实竖屏文件上确认 `presentationSize` 回调和布局高度；如果 AVKit 不回调尺寸，改为在播放器加载前读取 `AVAssetTrack.naturalSize`。

## 继续修改时的边界

- 不回滚当前工作区中已有的场记、协作链接、任务状态和 Team Web 改动。
- 自动归集、人工审核、`review.json`、`auto_decisions.json` 和审计链继续保持分离。
- Web 首屏修复应优先保持“默认第一集快速可用”，“全集”只能由用户明确选择或明确配置后渲染。

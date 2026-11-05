# 小程序移植路径（platform 接缝）

> 2026-10-24 起，前端所有宿主 API 调用收口到 [`apps/web/src/platform/platform.ts`](../../apps/web/src/platform/platform.ts) 的 `AppPlatform` 接口。目标：未来做微信小程序（或其他宿主）时**只新增、不改造**——复用域包、逻辑层、状态与引擎，重写宿主实现与视图。

## 结论速查

| 层 | 位置 | 小程序里 |
|---|---|---|
| 域逻辑 | `packages/motion-core`（纯，无 DOM/node） | 原样复用 |
| 应用逻辑 | `apps/web/src/workshop/{library,pose-library,keyframes,history,mirror}.ts`（纯 TS） | 原样复用 |
| UI 状态 | `apps/web/src/{lab/store,workshop/ui-store}.ts`（zustand，无 DOM） | 原样复用（Taro 支持 React） |
| 3D 引擎 | `apps/web/src/{lab,workshop}/engine.ts`（three + OrbitControls + 指针事件） | 复用，three 换 `three-platformize`，宿主经构造参数注入 platform |
| 宿主 API | `apps/web/src/platform/platform.ts` | **重写** `miniPlatform`（wx.* 实现 `AppPlatform`） |
| 视图 | `apps/web/src/{lab,workshop}/*.tsx` + CSS | **重写**（Taro 组件；CSS 变量可搬到 WXSS） |

技术选型（2025-10 调研）：React → 小程序用 **Taro 4**（运行时方案、Vite 构建）；three.js 用 **three-platformize**（适配微信/淘宝/字节，three 版本新；官方 threejs-miniprogram 停在 three 0.108，不选）。

## AppPlatform 覆盖的六类耦合

1. **资产加载**：`assetUrl(path)` / `fetchAsset(path)`。两页引导、两个引擎、生成 worker、GLB 导出、解剖皮肤、动力学记录的 `fetch('/models/…'|'/dynamics/…')` 与 `GLTFLoader.loadAsync(...)` 全部经此（引擎吃构造参数默认 `webPlatform`，叶子库直接 import）。
2. **导出/下载**：`download(name,blob)`（web: `<a download>` + `URL.createObjectURL`）、`canvasToBlob(canvas)`（静帧/拼图）。
3. **剪贴板**：`clipboardWrite(text)`（web 失败回落下载，语义保留在调用方）。
4. **持久化**：`storage: StorageLike|null`——`MotionLibrary`/`PoseLibrary` 本就是注入式，组件侧改传 `platform.storage`。
5. **Worker**：`createWorker(url)`（web: module worker；生成器 worker 内部同样走 platform，宿主换 `wx.createWorker`）。
6. **其它宿主探针**：`coarse`（引擎渲染档位）、`cssVar(name)`（场景背景读 token，`bindSceneBackground` 接受 platform）、`navigate(to)`、`confirm/prompt`、`now()`。
7. **解码注入**：`loadAnatomyAtlas(platform, decoder)`——decoder 直接返回 RGBA 像素（`MaskImageDecoder`），web 默认实现包掉 `<img>` + 2D 读回；`anatomy-skin.ts` 的 atlas 路径本身无 DOM，小程序自备像素解码即可。

## 边界要如实：传 miniPlatform ≠ 自动可移植

引擎吃 platform 参数 + 叶子库走 platform 之后，仍然明确依赖宿主适配的点（移植第 2 步，缺一不可）：

- `WebGLRenderer` 需要宿主 canvas（three-platformize），`devicePixelRatio`/`ResizeObserver` 按宿主读取；
- `theme/anatomy-selection.ts` 的命令式 DOM 覆盖层（肌肉点选）是视图层，宿主重写或裁剪；
- 生成 worker 的**创建调用点**在视图层（`new URL(...,import.meta.url)` 是打包器行为）：web 由 `createWorker` 承接，miniapp 在自己的启动代码里改用 `wx.createWorker('workers/generate.js')` 并自备打包产物；
- `crypto.subtle`（包导出已拒绝降级路径）；
- 解剖贴图的像素解码已通过 `MaskImageDecoder` 注入——web 实现内部的 `<img>` + 2D 读回随宿主整体替换。

## 故意不做接缝（视图层，宿主各自实现）

- 组件内响应式 `matchMedia` 钩子（compact 判定）——Taro 有自己的响应式 API；
- 键盘快捷键、原生 `<dialog>`、`confirm/prompt` 的 UI 呈现；
- `theme/anatomy-selection.ts` 的命令式 DOM 覆盖层（肌肉点选）；
- DEV 专用 `window.__LAB__/__WS__` 调试全局；
- `crypto.subtle`（motion-core `Digest` 可注入，包导出在无 https 环境本就拒绝）。

## 移植步骤（未来做时照此执行）

1. 新建 `apps/miniapp`（Taro React），`AppPlatform` 实现 `mini-platform.ts`：`fetchAsset` → `wx.request`/本地包资源，`storage` → `wx.setStorageSync`，`download` → `wx.getFileSystemManager` + 分享，`createWorker` → `wx.createWorker`，`canvasToBlob` → canvas `wx.canvasToTempFilePath`。
2. three 换 `three-platformize`；engine 的 `WebGLRenderer` 换平台 canvas，`ResizeObserver`/`devicePixelRatio` 按宿主适配（两个构造点）。
3. 视图按页重写：移动端形态即现状 compact 布局（workshop 底部抽屉 + lab 抽屉，`m1-b`），桌面布局不移植。
4. 资产（`public/models`、`public/dynamics`）随包分发或 CDN + `assetUrl` 指向。

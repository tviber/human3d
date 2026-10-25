# AGENTS — @human3d/web

浏览器端：实验室（`src/lab/`）、统一播放源（`src/playback/`）、动作工作台（`src/workshop/`）与两个入口页。

## 边界（自动强制）

- 可 import `@human3d/motion-core`；生产代码**不得** import `@human3d/server`（测试可用其 devDependency）。
- Vite `publicDir`/`outDir` 指向仓库根 `public/`/`dist/`；相对路径不得越出本包。

## 定向测试

- `npm test -- apps/web/src/workshop/workshop.test.ts`（或 `mirror.test.ts`）、`apps/web/src/playback/motion-source.test.ts`
- 移动端 / 语义控件验收：`node scripts/workshop-mobile-qa.mjs`（需 dev server；Playwright 模拟，不等于真机）
- 真实交互验收：`npm run qa`（需 dev server；`QA_BROWSER_CHANNEL=chrome` 走系统 Chrome；未进 CI）；动作库备份恢复与跨页签并发由 `npm run qa:library` 覆盖，CI 的 `browser-qa` workflow 跑同一入口

## 界面

实验室与工作台共用 Magpie 色板（`src/theme/tokens.css`：浅色默认，`prefers-color-scheme: dark` 或 `data-theme="dark"` 切暗色）。控件走 shadcn Nova 形态（`@base-ui/react` + `cva`，`src/components/ui/`），图标 Lucide，进场与对话框用 `motion/react`，桌面三栏用 `react-resizable-panels`（实验室窄于 760px 仍堆叠；工作台在 `COMPACT_QUERY` 下用同一 DOM 改为三维视图 + 底部抽屉，见 `WorkshopApp.tsx`/`workshop.css` 的 `.ws-compact`），工作台动作库排序与时间轴拖键用 `@dnd-kit`，实验室与工作台的界面状态用 Zustand（`src/lab/store.ts`、`src/workshop/ui-store.ts`）。三维画布、求解与播放源不走这套控件。

## 检索指针

- 工作台不变量（真实写路径、显示/编辑分离、撤销/隔离）：[`docs/domain/workshop.md`](../../docs/domain/workshop.md)
- 姿态包导入/信封派生：[`docs/domain/pose-package.md`](../../docs/domain/pose-package.md)
- 功能与验收：[`docs/WORKSHOP.md`](../../docs/WORKSHOP.md)、[`docs/QA.md`](../../docs/QA.md)

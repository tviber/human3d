# AGENTS

## 硬规则

- **包边界单向**：`apps/web`、`apps/server` → `packages/motion-core`；core 是纯域（无 DOM/node，three 只作数学库）；跨包一律包名导入，不写深路径。由 `tests/architecture.test.ts` 自动强制，随 `npm test` 与 CI 运行。
- **求解运动语义变化必须 bump `SERVICE_VERSION`**（`packages/motion-core/src/protocol.ts`；裁决见 `docs/decisions/` ADR-0002）。
- 测试走**真实实现路径**，不用 mock/旁路替身验证协议或交互（learning [4][10]）。
- 声明的契约必须兑现：README/OpenAPI/文档里每条行为声明都要能找到实现与测试；资源上限同时切断内存与 CPU 路径（learning [9]）。
- 未执行的验证不得写为「通过」；交付报告必须列出已执行/未执行/移交项（见下「验证策略」）。
- 领域关键不变量——接触区间与摆动中点、`timestamps.at(-1) === duration`、`gripSide`/`mirrorDoc` 左右镜像、artifact id 内容哈希、Web/Server 字节对等、真实 UI 写路径——在 [`docs/domain/`](docs/domain/) 快速定位；改对应代码前必查，本文件只留指针。

## 模块地图（npm workspaces，依赖方向单向）

| 包 | 拥有 | 边界规则 | 本包细则 |
|---|---|---|---|
| `packages/motion-core`（`@human3d/motion-core`） | `document.ts` 采样器、`solver.ts` FK/IK、`kinematics/rig/racket`、`protocol/pose-package/package-inspect/package-const`、`motion-file(s)/motions`、`validate.ts`（交付包语义校验）、`quality-probe/generate/random-document`、`package-export`、`glb-export`（子路径 `@human3d/motion-core/glb`） | **纯**：不得 import DOM/node 模块 | [AGENTS.md](packages/motion-core/AGENTS.md) |
| `apps/web`（`@human3d/web`） | `src/lab/`（实验室引擎、动力学回放、面板）、`src/playback/`（统一播放源 + `PoseFade`）、`src/workshop/`（场景、`WorkshopApp.tsx`、库、撤销书）、两个入口页与 `vite.config.ts` | 可 import motion-core；生产代码不得 import `@human3d/server` | [AGENTS.md](apps/web/AGENTS.md) |
| `apps/server`（`@human3d/server`） | `serve.ts` 传输、`service.ts` 编排、`contract.ts` Ajv 契约、`rig-manifest.ts` 身份哈希 | 可 import motion-core；不得 import web | [AGENTS.md](apps/server/AGENTS.md) |
| `spec/` | 发布契约：JSON Schema、OpenAPI、golden 样例 | 改动 = 协议变更；golden 保持明文 | [AGENTS.md](spec/AGENTS.md) |

- 路径不变：`assets/motions/*.json` 仍是工具链与文档共用的信封注册表（motion-core 相对路径静态导入）；`public/`、`dist/` 在仓库根。
- 命令入口：`npm run dev|build|preview|test|spec:check|docs:check|service|qa` 都在仓库根执行（`docs:check` 为本切片新增的文档链接检查），`dev` 委派给 `@human3d/web`。
- 完整设计记录（迁移裁决、被否备选、维护规则）：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 任务与审查入口

- **知识索引**（按任务/模块找文档，新任务从这里进）：[`docs/README.md`](docs/README.md)
- **审查协议**：task brief、Fast/Final Review verdict 字段、交接 → [`docs/engineering/review-protocol.md`](docs/engineering/review-protocol.md)（模板：task-brief-template.md、review-record-template.md、examples/）
- **验证生命周期**：Level 0–3 最小验证 + 合并门禁现状 → [`docs/engineering/review-gates.md`](docs/engineering/review-gates.md)；CI Draft/Ready 事件矩阵 → [`docs/engineering/ci-lifecycle.md`](docs/engineering/ci-lifecycle.md)
- **owner lane 与 ledger**：任务切片/热文件归属 → [`docs/engineering/task-protocol.md`](docs/engineering/task-protocol.md)
- **最小验证集**：改动面 → 定向测试映射 → [`docs/engineering/test-matrix.md`](docs/engineering/test-matrix.md)
- **worktree 隔离**：依赖/端口/测试发现防串线 → [`docs/engineering/worktree-policy.md`](docs/engineering/worktree-policy.md)；`npm run worktree:check` 实查
- **规划/待实现**（不是已存在命令，勿直接使用）：`check:full`（CI 侧全集封装）、`.agents/skills/` 规范 skill（PR-11A 遗留）。

## 项目验证命令

- `npx tsc -b` — 类型检查（CI 门禁）
- `npm test` — vitest 全量（CI 门禁；含 `tests/architecture.test.ts` 包边界检查）；定向：`npm test -- <test-file>`
- `npm run spec:check` — 契约测试：Ajv 严格编译、OpenAPI 与服务一致、golden 样例（CI 门禁）
- `npm run docs:check` — Markdown 相对链接存在性检查（CI 门禁）
- `npm run build` — 生产构建（CI 门禁，已含 `tsc -b`）
- `npm run qa` / `npm run qa:dynamics` — 浏览器 E2E（需 dev server；`QA_BROWSER_CHANNEL=chrome` 走系统 Chrome；**未进 CI**，状态单独记录）
- `npm run protocol:example` — 重生成 `spec/examples/idle.pose.json`
- `npm run package-to-glb -- <in.pose.json> [out.glb]` — 姿态包转 GLB（与浏览器「导出 GLB」共用 `glb-export.ts`）
- `npm run service` — 本地 Motion Protocol v1 服务（127.0.0.1:8788）
- `npm run dynamics:validate` / `dynamics:test` — 动力学资产与记录校验（需 Python 3.13 + `scripts/requirements-dynamics.txt`；CI 门禁）
- `npx tsx scripts/measure-motions.mts` — 内置动作语义峰值测量，阈值校准用（见 `docs/validation.md`）
- `npx tsx scripts/measure-quality-probe.mts [fps=240] [motion|all]` — 高帧率质量探针；度量共享 `quality-probe.ts`，基线在 `evidence/quality-probe-*.json`
- `npx tsx scripts/generate-motion.mts [forehand|squat|forehand-detuned|squat-detuned|all]` — 确定性约束轨迹优化器；实现在 `generate.ts`，输出 `evidence/generate-*.json`
- `node scripts/workshop-capture.mjs <doc.json> [--times …] [--views front,side,back,threeQuarter]` — 经工作台真实 UI 导入 + `captureStill` 固定相机路径把任意动作文档渲染成 PNG，并逐帧记录求解后的肘角、大臂仰角/方位角、腕目标残差与拍头位置，供视觉判定（`scripts/workshop-capture.mjs`）
- `npm run qa:pose-validity` / `node scripts/pose-visual-qa.mjs [动作名…]` — 姿态有效性浏览器验收 / 多方位纯渲染截图（需 dev server；未进 CI）
- `npm run bench` — workshop 管线性能基线（`--quick` 冒烟 / `--compare` 对比；基线 `evidence/bench-workshop.json`，仅同机可比，GC 趋势需 `NODE_OPTIONS=--expose-gc`）
- `npm run worktree:check -- --source-root <源 checkout> [--worktree-root <worktree>]` — worktree 隔离检查：workspace link 解析、端口冲突、路径边界（不进 CI，任务并行前自跑）
- `npm run check:affected -- --base <sha> [--head <sha>] [--run]` — affected-check 选择器（PR-11B）：plan-only 出选择回执（轻量快照，`single-collected-boundary-git-visible`），`--run` 顺序执行选中检查并出完整一致性回执；类别映射以 `docs/engineering/test-matrix.md` 为唯一权威（与 `CATEGORY_CHECKS` 有测试钉死）

## 验证策略（Level 0–3 × Review/Verify 生命周期）

- 按改动范围、失败风险与机器资源选验证级别；优先最小定向集合；测试通过 ≠ 整个项目通过，必须准确报告范围；不允许以节省资源为由忽略已发现的失败。
- **生命周期**：worktree 实现（可做最小 Red→Green/定向测试）→ **Fast Review**（只找确定 blocker，禁跑全仓测试/build/E2E/bench）→ `REWORK` 只复审差异与新风险 / `ESCALATE` 回规划 → `PROCEED` → affected checks → **Final Review** → Ready PR → 完整必需 CI → Merge。细则与 verdict 契约见 [review-gates.md](docs/engineering/review-gates.md)。
- **何时可跳过昂贵测试**：Level 0（纯文档/注释）只需 diff + `docs:check`；Level 1–2 按 test-matrix 跑受影响模块；REWORK 轮不重复未变区域的完整验证。
- **何时不可跳过**：Level 3（协议、运动语义、IK、动力学、持久化、关键交互路径）必须验证真实路径，不得用 mock 替代；合并前的完整必需 CI 与高风险真实路径验收不可省。
- 资源不足可把重型验证移交 CI/其他机器，但必须记录为未执行项。
- 失败先查根因再决定重试，不无限重试；不反复执行未受影响的全量集合。

## 经验与历史

- [`docs/learning.md`](docs/learning.md) —— 工程规则 Orders，顶部有类别索引，改代码前按类别查。
- [`docs/decisions/`](docs/decisions/) —— ADR：已确认方案、被否方案与依据。
- [`docs/history/investigate.md`](docs/history/investigate.md) —— 冻结的完整调查史（PR #1–#9、issue #10 各轮 review 与验证证据）；**非默认必读**，需要「为什么这么设计/当时的实测数字」时查阅。

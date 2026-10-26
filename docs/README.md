# docs 索引 —— 按任务/模块检索

新任务默认从这里入口；不需要读完整历史档案。全部 Markdown 相对链接由 `npm run docs:check` 保证存在。

## 按任务类型入口

| 你要做的事 | 先读 | 关键约束速查 |
|---|---|---|
| 改求解/文档采样/镜像（solver/document/mirrorDoc/gripSide） | [domain/motion-model.md](domain/motion-model.md) → [domain/solver.md](domain/solver.md) | 接触区间、坐标系一致性、SERVICE_VERSION bump；learning [1][8][16] |
| 改协议/姿态包/导出/服务端 | [domain/pose-package.md](domain/pose-package.md) → [validation.md](validation.md) → `spec/` | 字节对等、身份哈希、密度上限、两道校验门 |
| 改工作台 UI/交互/持久化 | [domain/workshop.md](domain/workshop.md) → [WORKSHOP.md](WORKSHOP.md) → [QA.md](QA.md) | 真实 UI 写路径、显示/编辑分离、隔离区、撤销语义 |
| 改包结构/依赖方向/构建 | [ARCHITECTURE.md](ARCHITECTURE.md) → `tests/architecture.test.ts` | 单向依赖、core 纯度、边界自动强制 |
| 改宿主耦合/移植小程序 | [engineering/miniapp-port.md](engineering/miniapp-port.md) → `apps/web/src/platform/platform.ts` | 宿主 API 全走 `AppPlatform`，单点替换 |
| 新增/改肌肉驱动动作 | [ACTION-TEMPLATE.md](ACTION-TEMPLATE.md) → [DYNAMICS.md](DYNAMICS.md) | 信封注册表、dynamics-motion kind、Python 工具链 |
| 接任务/提交流程本身 | [engineering/review-protocol.md](engineering/review-protocol.md) → [engineering/task-protocol.md](engineering/task-protocol.md) → [engineering/review-gates.md](engineering/review-gates.md) | task brief、Fast/Final Review、Level 0–3 |
| 以 agent 身份制作/审阅一个新动作 | [agent/motion-review.md](agent/motion-review.md) | 先自校准视觉坐标、坐标条件核对、审阅包 + ≤3 轮有界返工、不编造 3D |
| 选最小验证集 | [engineering/test-matrix.md](engineering/test-matrix.md) | 改动面 → 定向测试映射 |
| 开 worktree/并行任务 | [engineering/worktree-policy.md](engineering/worktree-policy.md) | 依赖/端口/测试发现防串线 |
| 协议设计动机 | [ANIMATION-PROTOCOL-PLAN.md](ANIMATION-PROTOCOL-PLAN.md) | v1 MVP 边界、未实现项 |
| 改肌肉显示/解剖数据 | [肌肉分区来源与构建](../assets/anatomy/README.md) | 原始网格身份、跨模型近似、16 位分区、数据许可 |
| 技术选型依据 | [RESEARCH.md](RESEARCH.md)、[LICENSES.md](LICENSES.md) | 资产来源与许可 |

## 目录结构

| 路径 | 内容 | 什么时候读 |
|---|---|---|
| [engineering/](engineering/) | 流程约定：review-protocol（审查协议 + 模板）、task-protocol（owner lane/ledger）、review-gates（验证生命周期）、ci-lifecycle（Draft/Ready CI 矩阵）、test-matrix、worktree-policy | 接任务/提交前 |
| [agent/](agent/) | agent 动作审阅环：视觉坐标自校准、坐标约定速查、review bundle 与结构化 review.json、有界返工（issue #32 A+B） | agent 制作/审阅新动作前 |
| [domain/](domain/) | 领域不变量：motion-model / solver / pose-package / workshop | 改对应代码前按需读 |
| [decisions/](decisions/) | ADR：已确认方案、被否方案与依据（0001–0010） | 要改某个设计前提时 |
| [history/](history/) | 冻结的完整调查史（investigate.md）与 PR 审查记录（issue-11-pr13-16-review.md） | 只在需要历史证据时，非默认必读 |
| [learning.md](learning.md) | 17 条工程规则（Orders）+ 类别索引 | 改核心代码前 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | npm workspaces 三包结构、迁移裁决、维护规则 | 改结构/边界前 |
| [validation.md](validation.md) | `POST /v1/motions` 语义校验阈值与校准 | 改校验/协议前 |
| [WORKSHOP.md](WORKSHOP.md) / [QA.md](QA.md) | 工作台功能与验收记录 | 改工作台前 |
| [DYNAMICS.md](DYNAMICS.md) / [ACTION-TEMPLATE.md](ACTION-TEMPLATE.md) | 肌肉驱动动作与新增模板 | 动力学任务 |
| [ANIMATION-PROTOCOL-PLAN.md](ANIMATION-PROTOCOL-PLAN.md) | 跨项目动作协议方案与优先级 | 协议演进 |
| [RESEARCH.md](RESEARCH.md) / [LICENSES.md](LICENSES.md) | 技术选择依据、资产许可 | 改资产/引用外部资料 |
| [templates/](templates/) | `muscle-action.template.json`（`scripts/new-muscle-action.py` 读） | 新增肌肉动作 |

17 球员研究链的仓外备份、checksum 与恢复说明：[归档记录](archives/forehand-17.md)。

## 常用命令速查

- 门禁：`sh scripts/check-process-limit.sh --npx && npx tsc -b`、`npm test`、`npm run spec:check`、`npm run build`、`npm run docs:check`（CI 的 `full` job 全部执行；Draft PR 只跑 `fast` bounded 检查，矩阵见 [engineering/ci-lifecycle.md](engineering/ci-lifecycle.md)；浏览器 `npm run qa`/`qa:dynamics` 未进 CI）
- 定向：`npm test -- <test-file>`（低资源 `--maxWorkers=1 --no-file-parallelism`）
- 测量/工具：`scripts/measure-motions.mts`、`measure-quality-probe.mts`、`generate-motion.mts`、`bench-workshop.mts`、`package-to-glb.mts`——用途见根 `AGENTS.md`「项目验证命令」与 [engineering/test-matrix.md](engineering/test-matrix.md)
- 动力学：`npm run dynamics:validate` / `dynamics:test` / `dynamics:new` / `dynamics:build`（需 `.venv-dynamics`，CI 门禁）

## 已知死链与阻塞项

`assets/source/` 下 5 条相对链接指向未 vendor 的上游素材（MakeHuman 许可文本 2 条、MyoSim 模型配图 3 张 PNG）；来源/许可未核实，按任务规则不得引入，也未推定上游 URL 改写。当前以 `scripts/check-docs-links.mjs` 中带理由的 allowlist 豁免；**解除阻塞 = 核实上游来源后 vendor 素材或改写链接**。决策记录：[decisions/0009-knowledge-layout.md](decisions/0009-knowledge-layout.md)。

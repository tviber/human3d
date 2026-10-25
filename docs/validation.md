# 语义校验与阈值（Motion Protocol v1）

本文记录 `POST /v1/motions` 在返回姿态包之前的校验：检查什么、阈值从哪里来、如何复现校准，以及已知限制。

校验只针对**运动学连续性与关节范围**，不是动力学、临床或职业运动分析的验证。阈值是工程判断，用于阻止跳变与越界，不代表人体生理或运动表现的上限。

## 1. 检查顺序与状态码

| 门 | 失败含义 | HTTP |
|---|---|---|
| 请求 schema（`spec/motion-request.schema.json`）与动作参数 schema（由动作描述生成，Ajv 2020 strict 编译） | 调用方输入错误 | 400 `invalid_request`，`details` 给出错误路径与原因 |
| 姿态包 schema（`spec/pose-package.schema.json`） | 服务生成了不合规的包，属于服务缺陷 | 500 `internal` |
| 结构与语义校验（`validatePosePackage`，`packages/motion-core/src/validate.ts`） | 动作不合规或运动学上不连续 | 422 `motion_rejected`，`details` 列出全部失败项 |

- 422 与 200 一样写入 `Idempotency-Key` 缓存：同键同体重放同一结果，同键不同体返回 409。
- 求解器质量检查（`quality.checks`，如 `foot-depth-*`、`ankle-dorsiflexion-*`、`com-support`）**不改变状态码**：失败项以 `ok: false` 随 200 返回，属于信息性结果。语义校验只检查这些条目的格式，以及"通过但数值超过自身上限"的自相矛盾记录。
- 通过语义校验不等于质量合格。客户端应读取 `quality.checks`。

## 2. 结构检查（无阈值）

任一项失败即返回，不再计算语义阈值：

- `schemaVersion` 为 2，`kind` 为 `pose-package`；`poseMode` 为 `local-trs`，`quaternionOrder` 为 `xyzw`。
- `timestamps` 长度等于 `count`，且至少 2 个采样点；时间严格递增；`fps` ∈ (0, 240]；末帧时间恰好等于 `duration`。
- rig 哈希与骨数与 manifest 一致；根平移轨道长度为 3·count 且全部有限；每条旋转轨道长度为 4·count。
- 每个四元数满足 |q| − 1 ≤ 1e−3，相邻帧点积不小于 −1e−9（无半球翻转）。
- 事件时间落在 [0, duration]；`support-start` / `support-end` 必须带 `side`（L 或 R）。
- 质量条目具备 `code`、`ok`、`label`；`ok` 为真时数值不得超过自身上限。

结构检查通过后，校验器用 manifest 层级重新做一遍正向运动学（不复用求解器代码），段长漂移须不超过 1e−6 m（取首、中、末三帧）。

## 3. 语义阈值与校准

阈值定义在 `VALIDATION_LIMITS`。下表由 `sh scripts/check-process-limit.sh --npx && npx tsx scripts/measure-motions.mts`（默认 40 fps，当前代码）得到，取整个包的最坏值。WP-C 求解语义变更（Catmull-Rom 切线限界 + 手部朝向 SO(3) 三次，`SERVICE_VERSION` 0.3.0）后重测；WP-D `gripSide` 升版（0.4.0）只镜像缺省 `'R'` 之外的求解路径，全部内置动作的轨迹逐位不变，阈值沿用。0.5.0 的骨盆位移日程对内置动作是 passthrough（期望位移已落在根速率 / 根加速度阈值内），这些峰值沿用；只改变会跳变的文档，见第 5 节。

| 动作（40 fps） | 骨骼角速率 rad/s | 根速率 m/s | 根加速度 m/s² | 膝屈曲 ° | 肘屈曲 ° | 支撑脚滑移 |
|---|---|---|---|---|---|---|
| idle | 0.06（lowerarm01_L，3.13 s） | 0.00 | 0.00 | 10.1 | 27.8 | 0.00 cm |
| reach | 2.47（lowerarm01_R，0.55 s） | 0.00 | 0.00 | 10.2 | 128.4 | 0.00 cm |
| squat | 2.59（lowerleg01_L，4.65 s） | 0.40 | 9.07 | 90.7 | 72.4 | 0.00 cm |
| ready | 0.09（lowerleg01_L，1.52 s） | 0.01 | 0.08 | 42.8 | 88.2 | 0.00 cm |
| forehand | 9.63（wrist_L，0.75 s） | 0.12 | 0.50 | 52.2 | 133.2 | 0.00 cm |
| 工坊默认文档 | 32.98（lowerarm02_R，0.60 s） | 0.28 | 3.79 | 49.8 | 125.8 | 0.00 cm |
| **阈值** | **40** | **4** | **40** | **135（容差 0.5）** | **145（容差 0.5）** | **1 cm** |

各项的依据与余量：

- **骨骼角速率（40 rad/s）**：内置动作峰值为 9.6（forehand 引拍时非持拍手从掌心向上转到掌心向前的腕部旋转；2026-10-20 双臂编舞前为 7.0）；修复前的正手曾出现 60–72 rad/s 的跳变。默认工坊文档为 33.0，占阈值的 82%（WP-C 前为 29.2/73%——手部三次插值让共享键切线把真实角速度带过键时刻，不再被逐段 slerp 的键时刻阶跃吃掉），作者做更快的挥拍时可能被拒。
- **根速率（4 m/s）**：内置动作最大 0.39 m/s，余量充足。
- **根加速度（40 m/s²，约 4 g）**：内置动作峰值为 9.1。它能捕捉速率检查在低帧率下漏掉的单帧骨盆跳变，见第 4、5 节。
- **膝、肘屈曲**：与求解器上限 135° 和 145° 对应，容差 0.5° 只吸收 FK 与求解器之间的残差。
- **支撑脚滑移（1 cm）**：只对带 `support-start` / `support-end` 的包计算。内置动作的信封文档双足全程支撑（`plantL/plantR`），因此现在都带支撑区间、实测滑移为 0。

## 4. 负对照与随机文档

- **负对照**：一根骨骼每帧独立取随机单位四元数（符号连续化，因此只触发速率检查），被骨骼角速率检查拒绝。`validate.test.ts` 固定了这一结果，说明检查确实能区分跳变的姿态数据。
- **随机工坊文档**：`sh scripts/check-process-limit.sh --npx && npx tsx scripts/random-document-stats.mts <seed> 8` 按种子生成随机关键帧文档并提交服务。种子 1–3 各 8 个，共 24 个：
  - 14 个通过语义校验；这 14 个都至少有一项求解器质量检查失败（踝背屈、COM 支撑或足部深度）。
  - 10 个被 422 拒绝，共 22 条消息：根速率 5.81–6.36 m/s（6 条）、根加速度 83.4–259.0 m/s²（7 条）、支撑脚滑移 3.8–11.9 cm（9 条）。
- 随机文档的关键帧在 ±20 cm、±30° 量级上独立随机，很多并不可行，因此这组拒绝率不代表用户手工编辑文档的拒绝率。上面 10 个拒绝的计数是 0.5.0 之前的测量：当时根跳变和支撑滑移一起被拒。0.5.0 压掉骨盆位移自身造成的根跳变；腿长不够的支撑滑移仍然拒绝。不要把这组计数当成当前求解器的拒绝分布。机制见第 5 节。
- 加 `saveDir` 参数可导出被拒文档的请求，例如 `sh scripts/check-process-limit.sh --npx && npx tsx scripts/random-document-stats.mts 1 8 /tmp/rejected`。

## 5. 已知限制：骨盆折叠（pelvis fold）

样例：[`spec/examples/rejected-pelvis-fold.request.json`](../spec/examples/rejected-pelvis-fold.request.json)，即种子 1 的第 3 个随机文档（40 fps）。

**机制**：`pelvisDorsiCorrection` 逐帧独立求骨盆后移，只有一个后验 z 自由度。当某条带接触权重的腿在零位移时背屈超过 20°，且可行修正集合不连通时，最小可行位移会在相邻采样之间跳变。样例中，期望位移在约 0.30 s 从 0 跳到约 8.8 cm。在 `SERVICE_VERSION` 0.4.0 及更早，该跳变直接写进根轨迹，服务返回 422：

- 根速率 6.25 m/s（t = 1.32 s）；
- 根加速度 240.3 m/s²（t = 1.32 s）；
- 左支撑脚滑移 9.3 cm（t = 1.32 s）。

**0.5.0 的跨帧连续化**（`packages/motion-core/src/pelvis-schedule.ts`）：姿态包求解、质量探针、实验室文档回放与工作台视口共用 `buildPelvisSchedule`。它在 120 Hz 网格上采样期望位移。若该标量序列的根速率与根加速度已落在 `VALIDATION_LIMITS` 内，`passthrough` 为真，求解省略覆盖参数，以保持历史浮点路径（内置动作走这条路径）。否则先 `holdShift`：大于一个速度步（1.5 m/s × dt）的盆地跳变被丢掉，位移停在跳变前的值，直到期望值回到可连续跟随的邻域。把位移斜坡拉过不可达区间会拖着支撑脚滑移。剩下的连续变化再由 `followShift` 限制在 1.5 m/s 与 16 m/s² 以内。

**当前行为**：同一份样例不再因根速率或根加速度被拒。它仍返回 422，只剩支撑脚滑移。左踝目标被接触锁在固定点，而髋到该点的距离超过腿长，缺口主要在竖直方向。后移或侧移 0.15 m 补不上这个竖直缺口，最近的 IK 点会随髋部运动漂移。`apps/server/src/validate.test.ts` 固定：状态 422，`details` 不含 `root acceleration` / `root speed`，且包含 `support foot slips`。

**仍开放**：

1. 第二个修正自由度（侧向或俯仰）补不上竖直方向够不着的踝目标；
2. 文档级可行性检查，在编辑时指出具体的关键帧。

## 6. 输入上限

| 位置 | 上限 |
|---|---|
| 工坊 `WORKSHOP_LIMITS`（`packages/motion-core/src/limits.ts`） | 时长 0.2–10 s，关键帧 ≤ 120，循环接缝间隔 0.01 s。UI 钳制输入；越界文档被隔离（quarantine）而不是静默丢弃 |
| 服务 `LIMITS_SVC`（`apps/server/src/service.ts`） | fps ≤ 60（默认 40）；工坊文档时长 ≤ 10 s，关键帧 ≤ 120；请求体 ≤ 1 MiB（gzip 解压后计算） |
| 幂等缓存 | 最多 256 个键，32 MiB，保留 900 s |

## 7. 修改阈值的流程

1. 修改 `VALIDATION_LIMITS`（`packages/motion-core/src/validate.ts`）。
2. 运行 `sh scripts/check-process-limit.sh --npx && npx tsx scripts/measure-motions.mts`，更新第 3 节的表格和依据。
3. 运行 `npm test`。`validate.test.ts` 要求内置动作通过、负对照与一帧采样包被拒绝。
4. 若改变了内置动作或契约，再运行 `npm run spec:check`，并视情况运行 `npm run protocol:example`。

## 8. 边界

- 只检查运动学：不检查力、力矩、地面反力，也不证明肌肉驱动可行。动力学资产与校验见 [DYNAMICS.md](DYNAMICS.md)，对应 `npm run dynamics:validate` 与 `npm run dynamics:test`。
- 阈值只在 40 fps 下校准；其它采样率（最高 60 fps）未逐一校准。
- 语义校验只看姿态包本身，不知道动作的意图。合法的快速动作与错误数据可能有相似的峰值，因此拒绝结果需要结合 `details` 中的时间点判断。

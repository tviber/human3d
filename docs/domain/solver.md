# 领域不变量：求解器（FK/IK）与质量门

改 `solver.ts`、`kinematics.ts`、`rig.ts`、`props/racket.ts`、`grip.ts`、`generate.ts` 或质量阈值前必读本文。历史证据见 [../history/investigate.md](../history/investigate.md)。

## 求解路径

- `frameAt → solveEffectiveFrame` 是唯一的真实求解路径：测试、质量探针（`quality-probe.ts`）、优化器（`generate.ts` 经 `probeFrames → analyzeProbeFrames → evalDetail`）、工作台渲染共用同一路径——测试/度量不得另写一套求解（learning [4]）。
- 骨盆后移（`SERVICE_VERSION` 0.5.0）：`pelvisDorsiCorrection` 仍是逐帧 argmin。会断开可行集的文档由 `buildPelvisSchedule`（`pelvis-schedule.ts`）先持住盆地跳变，再按速度 / 加速度上限跟随；`solveEffectiveFrame` 的可选第三参是这一帧实际使用的后移。`passthrough === true` 时调用方必须省略该参数，以保持历史浮点路径。姿态包求解（`solveWorkshop`）、质量探针（`probeFrames`）、`DocumentSource` 与工作台 `WorkshopEngine` 都走这一条。竖直方向够不着的踝目标不是这条日程能修的，见 [../validation.md](../validation.md) 第 5 节。
- IK 为双骨解析解（肩–肘–腕、髋–膝–踝定长链），含弯曲提示方向；不是迭代 CCD。
- 脚俯仰按脚底最低点约束地面：脚模型没有后跟骨，因此后跟接触点以脚踝后方的虚拟点表示；求解时把穿地脚踝目标抬到地面。正 pitch（脚尖向下）是踮脚，支撑脚带动 root 平滑上升，身体升幅不超过 25mm；负 pitch（脚尖向上）是后跟支撑，只抬脚踝目标，root 高度不变。`measurePelvisCorrection` 与正式 `solvePose` 使用相同的脚目标、先计算基准姿态下的骨盆后移，再单独加踮脚高度，避免高度变化扭曲后移日程。
- 求解是确定性的：同一文档 + 同一 rig 逐位重解（`property.test.ts`/`solver-baseline.test.ts` 钉死）。

## 限位与合理性

- 缺省腕锥限位 `WRIST_BEND_LIMIT_DEG` = 59.8°（WP-C 裁决）。显式 `WorkshopDoc.freeArms=true` 为手动创作提供自由手臂：肘最大屈曲与腕部弯曲限位均为 180°；缺省文档保持原行为。质量检查与姿态包交付校验仍按人体参考阈值报告（肘屈曲 145°）；工作台会提示超出该阈值的姿态无法导出。
- `rotateArmJoint` 是关节旋转编辑器：围绕肩或肘旋转真实求解骨段，将肘、腕目标和手部方向写回既有任务空间字段，再由同一 FK/IK 路径重解。大臂旋转携带小臂与手部；小臂旋转保持肘位。肘部 pole 只是固定末端条件下的弯曲方向提示，不能代替肩关节自由旋转。
- 大臂旋转将真实大臂骨的参考平面一同旋转，并存为偏离骨轴的 pole；肘点位于轴上，单存肘点不能保留共线状态下的轴向角度。共线链的骨骼朝向优先从 pole 与肩—腕轴恢复，避免只留下手腕朝向变化。
- 求解器合理性检查与服务端语义校验（422 `motion_rejected`）的阈值与校准流程见 [../validation.md](../validation.md)；阈值用 `scripts/measure-motions.mts` / `measure-quality-probe.mts` 实测校准，不凭感觉调。
- 骨盆后移修正（`pelvisDorsiCorrection`）对每条腿取 `weight × max(0, 所需位移)` 再求 max。所需位移经过零时在采样间隔内形成斜率拐点，根加速度尖峰随采样率变化：服务端默认 40 Hz 下正手 Frances 预设曾测得 42 m/s²（门限 40，`POST /v1/motions` 返回 422）。正手预设的后脚蹬地脚跟抬起因此限制在 8°（12° 时出现该拐点）。修改脚部目标或骨盆高度后，须用服务端默认采样率与 240 fps 两种口径复测根加速度，以及后脚踝背屈峰值（≤ 20.1°）。

## gripSide 与镜像求解

- `EffectiveFrame.gripSide` 由 `frameAt` 从文档拍平；`solveEffectiveFrame`/`solvePose` 按侧路由 `blendGrip`/手指/腕锥/锁骨/球拍挂载；非握拍手保持松弛。
- 左挂载 = 右挂载的精确 x 镜像（M·q·M，x 反射）；`grip-side.test.ts` 在真实求解路径上逐骨断言（163 骨位置 + 世界朝向）。这是**求解语义**变化——任何改变求解输出的改动都必须 bump `SERVICE_VERSION`（[../decisions/0002-package-identity-service-version.md](../decisions/0002-package-identity-service-version.md)）。

## 变更探测与性能口径

- `spec/solver-baseline/*.golden.json` 是求解器变更探测器（重捕获容差 1e-3°/1e-3mm，只盖平台浮点抖动）；golden 明文不哈希化（[../decisions/0007-golden-plaintext.md](../decisions/0007-golden-plaintext.md)）。
- `evidence/quality-probe-*.json` 是当前求解器的 240fps 探针基线；语义变更后全量重跑并如实记录 delta。
- 优化器（`generate.ts`）：搜索只有「合法区间重排非锁定键时间」与「有界相位偏移重采样」两类操作；候选必须硬约束门禁通过且报告代价严格下降才产出；不产候选 ≠ 失败，门禁拒绝是正常结果。评价口径：数值代理改善 ≠ 动作自然。
- 性能测试先分离算法成本、并行竞争与测试预算，再收紧单测工作量（learning [17]）；生产默认预算由确定性 CLI evidence 覆盖，测试里降预算的结果不能当生产性能证明。

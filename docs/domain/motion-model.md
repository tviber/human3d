# 领域不变量：WorkshopDoc 文档模型与采样

改 `document.ts`、工作台写路径、文档 schema 或 `mirrorDoc`/`normalizeDoc` 前必读本文与 [../learning.md](../learning.md) 相关条目。实现细节的历史证据见 [../history/investigate.md](../history/investigate.md)。

## 关键帧与支撑脚

- 支撑脚是**接触区间**：`plant=true` 连续 run **首帧**的存储脚位定义接触点，run 内后续锁定帧的存储脚位被采样器忽略（决策见 [../decisions/0001-contact-interval-swing-waypoint.md](../decisions/0001-contact-interval-swing-waypoint.md)）。例外：携带 `replant` 的支撑帧在 run 内仍锚定**自身**存储脚位、断开上一条区间——「复制帧」用它让副本拥有自己的接触（复制时刻采样逐位不变）；归一化会折叠不可能生效的 `replant`。
- 离地帧（`plant=false` 紧跟支撑）时刻脚仍在接触点；其存储脚位是**后续区间的摆动中点**。贴地存储 = 有意拖步，不是抬脚。
- 「此帧存储是否生效」必须精确匹配采样器 override 条件（锁定 run 键与释放键两类）；近似的归属规则会把活数据误判成死数据（learning [15]）。

## 插值

- 每个关键帧的 `interpolation` 控制它到下一帧的区间，缺省为 `hermite`。Hermite 标量通道使用非均匀 Catmull-Rom 中心差分切线，限界 `|m| ≤ 2·min(相邻割线)`；loop 幽灵链每侧两个周期拷贝（[../decisions/0004-interpolation-tangent-cap-squad.md](../decisions/0004-interpolation-tangent-cap-squad.md)）。`linear` 使用标量线性插值；相邻区间选不同曲线时，关键帧处速度可以改变。
- Hermite 区间的手部朝向（`hand.forward`/`hand.normal`）使用 corrected-slerp 形式 SO(3) 三次；过键逐位精确、Hermite 区间共享切线时角速度 C¹；线性区间使用最短弧 SLERP。整条四元数链先做半球符号连续。
- release-swing 两段式有独立 chord/end 切线逻辑，不经 `tan()`，不做二次钳制。

## 坐标系与归一化

- `handFrames`（`world`/`pelvis`）决定手部目标的插值坐标系；`frameAt(doc,t,origin)` 的 `origin` 是 pelvis 系原点——所有采样/写入口必须显式传与显示路径一致的值（`restRoot`），默认 `(0,0,0)` 会造成静默偏移（learning [16]，实测 ~4mm）。
- `gripSide`：缺省 = 右手且为规范形态，显式 `'R'` 被 `normalizeDoc` 折叠回缺省（同义写法共享指纹与制品 id）；`'L'` 把指节包裹、腕锥限位、抬肩辅助、球拍挂载镜像到左手。侧别改变求解轨迹 → 属于文档并进入请求指纹。
- 可选 `freeArms` 是整段动作的手臂限位策略：`true` 允许肘、腕完整旋转，缺省保留人体参考限位；随存储、镜像、编译快照与子采样保留，并进入文档指纹。
- `mirrorDoc` 以 x=0 平面整档镜像：侧别字段 L↔R 对调，位置/方向向量 x→−x，yaw 类（骨盆 yaw、chest/side、脚 yaw）取反而 lean/脚 pitch 保持，`gripSide` 翻转、`handFrames` 随手换侧；id/name/english 用可回切后缀（`.mirrored` / `· 镜像` / `· MIRRORED`）。**不变量**：`mirror∘mirror` 对规范字段序文档逐字节相等；逐字段约定表见 history「WP-D(补)— 文档镜像」——新增文档字段必须在 `mirrorDoc` 显式裁决，防静默保留源值。

## 事件

- `support-start`/`support-end` 只按状态转换发射（含起始即支撑），持续支撑不重复（learning [3]）；事件对即接触区间。

## 文档完整性

- `maxKeys`：写入入口（`ensureKey`、拖动自动建帧）先拒绝并提示，校验器隔离只是兜底——可写路径不得产出会被隔离的文档（learning [11]）。
- `retimeKeys` 等值域变换在合法区间内整体缩放（loop 按 `[0, duration−loopGap]`），不能只夹边界端点——后者会把边界问题转移成内部一致性问题（learning [12]）。
- 键时间随整个规范化文档进请求指纹与制品哈希；`normalizeDoc` 只折叠 `gripSide` 同义写法与 `canonicalizeHands`，不改写键时间（一次性迁移器曾按 `Math.round(t*1e6)/1e6` 归一，非现行行为——见 [../history/investigate.md](../history/investigate.md)）。

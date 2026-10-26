# ADR-0010：拍柄棱面是手掌相对编号的创作字段；手指开合是追加的采样通道

状态：已确认（bevel + hand-shape 特性切片）。实现：`packages/motion-core/src/props/racket.ts`（棱面）、`packages/motion-core/src/hand-shape.ts`（手型）、`packages/motion-core/src/document.ts`（通道布局）。

## 决定

**棱面（bevel）——文档级字段 `gripBevel?:number`（1–8），不是求解输入。**

- 编号是**手掌相对**的：1 = 默认挂载下贴住手掌的棱面，2–8 沿拍柄每 45° 一面。同一号码在任何一只手上都是同一种握法。
- 左手编号方向是右手的镜像（`bevelSign`：右 +1 / 左 −1），因此 `mirrorDoc` **原样保留** `gripBevel`——镜像后的球拍是源球拍的精确 x 镜像，号码跟着几何走（grip-side.test.ts 逐点钉死）。
- 缺省（1）是规范形态：`normalizeDoc` 折叠显式 1，未写棱面的旧文档序列化字节不变。
- 转动只改变拍面朝向，不改变握拍位置：拍头在柄轴上（位置不动）、手指绕圆柱柄包裹、没有任何骨骼读取拍面朝向——所以 `bevelRoll` 是挂载后的 LOCAL 后旋转，求解轨迹与 SERVICE_VERSION 的运动语义无关。
- 作为文档字段它照常进入请求指纹与定义哈希（`canonical({schema,document})`）：改棱面 = 新 artifact id、同一条轨迹。这是接受的开销，不为它开「仅展示不入指纹」的旁路。
- 展示链路：导出时进 `action.parameters.presentation.bevel`（仅当非 1），`package-inspect` 映射回 `MotionCapabilities.prop.bevel`，播放源 `propBevel` 驱动实验室重挂载；工作台「显示 → 拍柄棱面编号」在拍柄八面上叠数字 sprite（canvas 属 web 层，core 无 DOM）。

**手指开合（handSpread）——每键姿态字段 `pose.handSpread?:{L?:number;R?:number}`（0 握拳 / 0.5 自然 / 1 张开），是采样通道与求解输入。**

- 追加为 `flattenPose` 尾部通道（L=47、R=48），所有旧通道索引不动；`unflattenPose` 恰好重省略自然值。
- **自然（0.5）是缺省规范形态**：写 0.5 = 删通道；`applyHandShape` 在 0.5 走与旧 `relaxHand` 逐位相同的快速路径（articulateHand 的轴角乘法会引入 −0 分量，泄漏进包字节），未写通道的旧文档求解与序列化字节均不变。
- 单标量而非逐关节角：它必须像其他通道一样过同一 Hermite 采样器可插值，握拳→张开恰好是一段数轴。锚点实测：握拳取自 rig 自己的 punch 拳型，自然 = 旧 relaxHand，张开带外展；外展与拇指对掌轴左右手取反。
- 握拍手的包裹从该手型插值（`blendGrip` 的 `base`），握拳仍握住拍柄；非握拍手直接采用。
- 运动语义变化（手指骨骼随通道移动）→ `SERVICE_VERSION` 0.8.0→0.9.0；schema 追加字段 → `WORKSHOP_REVISION` workshop-doc/v4→v5。
- 生成器（generate.ts）：handL/handR 相位移动各自捎带自己的 spread 通道（`EXTRAS`），foot 组区间止于 47 不吸收尾部通道。

## 被否方案

- **棱面顶层化进 pose-package schema**：沿 ADR-0006 的裁决走 `parameters.presentation` 开放通道，不为展示 hint 升 schemaVersion 强制全部消费者重校验。
- **bevel 作为逐帧/逐键求解输入**：没有任何求解路径读取拍面朝向，让它进求解只会放大指纹噪声。
- **`handSpread` 逐关节角度字典**：不可过标量 Hermite 采样器，且与「算法能力必须有真实 UI 写入路径」冲突（没有控件能写 15 个手指角）。
- **在 articulateHand 里做 0 角度乘法跳过**：会改动已交付 punch 动作的指节数值位模式，为省一个分支不值得。

## 关联

- 编号方向、镜像与挂载数学的实测证据：`packages/motion-core/src/grip-side.test.ts`（bevel rolls mirror / mounts nondefault bevels as the exact left/right mirror）。
- 逐位等价契约：`packages/motion-core/src/hand-shape.test.ts`；通道布局与折叠：`document.ts` 及其测试。
- UI 入口：工作台「动作属性 → 棱面（贴掌面）」「左右调整 → 手指开合」「显示 → 拍柄棱面编号」（docs/WORKSHOP.md）。

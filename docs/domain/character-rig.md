# 外部角色骨架档案

`CharacterRigProfile` 描述导入角色的骨架、Humanoid 映射、蒙皮绑定和初步姿势检查。纯数据类型与校验器位于 `packages/motion-core/src/character-rig.ts`；`packages/motion-core/src/character-rig-adapter.ts` 将已求解的 canonical `HumanRig` 世界朝向增量写入目标层级，并按目标高度/hips 朝向转换根位移和末端任务点。GLB/VRM 文件读取和 Three.js 对象检查位于 `apps/web/src/workshop/character-import.ts`。

## 身份和映射

- 角色源身份是 GLB 文件字节的 SHA-256。文件名后缀只记录来源格式，不能证明资产是 VRM。
- 只有 GLB JSON 中 `extensionsUsed` 声明 `VRMC_vrm`，且 `extensions.VRMC_vrm` 提供有效的 `specVersion` 和 `humanoid.humanBones` 节点映射，才识别为 VRM。映射中的无效节点会令扩展无效。
- 缺少 VRM 扩展时，可由调用方提供人工映射或名称注册表映射；角色名或骨骼名本身不会自动获得 VRM 身份。
- 档案按 glTF 约定记录右手系、Y 轴向上和米单位，并保存每个 glTF 节点的父节点索引、本地 TRS、世界位置、到父节点的世界距离和 skin-joint 标记；每个蒙皮记录保存 joint 列表、inverse-bind 数量、属性布局、权重诊断和 bind-pose 结果。

## 准入结果

`validateCharacterRigProfile` 返回以下状态：

- `supported`：必需映射与结构检查通过，没有待处理警告。
- `warning`：可继续检查，但有能力缺失或姿势信息不完整等警告。
- `needs-mapping`：没有 VRM 或其他映射来源，必需语义骨骼尚未映射。
- `unsupported`：存在无效映射、断裂层级、缺失蒙皮关节或无效蒙皮数据等错误。

当前必需语义包括 hips、spine、head，以及左右手臂和腿部链。手指、脚趾、肩、neck、chest 和 upperChest 作为能力项报告；upperChest 存在时必须有 chest。每个问题保留独立 issue code 和严重级别，调用方不应将 `warning` 与 `unsupported` 合并为同一结果。

导入器在 GLTFLoader 解析前检查 GLB chunk 顺序、对齐与文件范围，并拒绝外部 buffer/image URI。它限制文件为 64 MiB、节点和 skin/mesh 各 16,384 个、accessor 131,072 个、primitive 65,536 个、顶点 2,000,000 个、索引 12,000,000 个、skin joints 总数 8,192 个，以及解码 accessor 数据 64,000,000 个标量。预算覆盖未被节点引用的 mesh 与 accessor，避免大属性或索引在解析时绕过顶点上限。蒙皮检查要求每顶点 JOINTS/WEIGHTS 属性为 vec4、属性顶点数与 position 数相同、joint 索引在范围内、权重有限且非负并在 0.02 容差内归一化。存在 inverse-bind 数据时会检查其与当前 bind pose 的矩阵一致性；缺少可验证数据会报告 warning。

姿势评估在 hips 的世界朝向坐标框架内计算，以避免角色整体 yaw 影响左右判断。当前启发式识别 T pose 或 A pose、左右骨骼顺序和由头/髋/脚估算的高度；这些结果用于诊断，不代表外部动作相似度或解剖学 ground truth。

## 重定向适配

`CharacterRigAdapter` 只接受 `supported` 或 `warning` 档案。每帧先恢复目标节点的导入 rest TRS，再按实际父子拓扑顺序写入语义骨骼。它使用 canonical world quaternion delta 与目标 rest world quaternion 合成目标朝向，然后通过目标实际父节点反算 local quaternion；目标的 local axes、骨长和中间节点由目标 rig 保留。MakeHuman 的 `spine05..spine01`、`neck01..neck02`、clavicle/shoulder 和 lower-arm twist 会按目标已有语义节点数选择累计 source world frame。

根位移按目标/源身高比缩放并转入目标 hips 朝向；hand/foot target 与 pole 同样按 hips 框架和身高比转换，hand forward/normal 随 hips 朝向转换，foot yaw/pitch 转成目标朝向下的角度。PoseParams 的 pelvis/spine/head 角度保留为相对目标 rest pose 的语义关节控制值；位置、方向和 foot yaw/pitch 等世界任务量则转换到目标框架。报告包含映射语义、身高比例、档案 warning 和四个末端的目标残差，供后续约束阶段消费。

当前使用 rest-relative world-delta：源 reset 姿态会精确回到目标自身 rest pose。目标 A/T rest 方向差异仍会保留在目标姿态中；适配器不运行目标 IK、地面接触修正、手指/球拍适配，也没有接入工作台角色切换。因此目前不能据此声称不同 rest pose 的动作已经匹配。

## 当前边界

角色档案和适配状态不属于 `WorkshopDoc`、`MotionLibrary`、撤销历史或现有 MakeHuman Pose Package manifest。适配器新增不改变 `RIG_ID`、协议 schema 或 `SERVICE_VERSION`。本仓库目前只有 MakeHuman 人体资产，没有第二种带来源与许可信息的角色资产；跨体型效果与真实工作台写路径仍待资产和后续接线验收。

## 验证

- Core 档案校验：`packages/motion-core/src/character-rig.test.ts`
- Core 目标适配：`packages/motion-core/src/character-rig-adapter.test.ts`，真实 MakeHuman `GLTFLoader → frameAt → solveEffectiveFrame → CharacterRigAdapter` 路径
- Web GLB 提取：`apps/web/src/workshop/character-import.test.ts`
- 最小验证命令：`npm test -- packages/motion-core/src/character-rig.test.ts packages/motion-core/src/character-rig-adapter.test.ts apps/web/src/workshop/character-import.test.ts tests/architecture.test.ts --maxWorkers=1 --no-file-parallelism`，以及 `sh scripts/check-process-limit.sh --npx && npx tsc -b`

# ADR-0011：拍柄倾角是文档级握拍属性

状态：已确认。工作台实现：`packages/motion-core/src/props/racket.ts`、`apps/web/src/workshop/WorkshopApp.tsx`。

## 决定

新增 `WorkshopDoc.gripTilt?: number`，单位为度，范围 −45°..45°，缺省为 0°。工作台「动作属性 → 拍柄倾斜」滑块写入此字段。正值绕球拍局部 +X 轴转动球拍，使拍头朝局部 +Z（掌面前方）倾斜；随后再按 `gripBevel` 绕球拍自身 +Y 轴转动贴掌棱面。

- 倾角围绕拍柄握持中心旋转：手腕位置、手腕姿态与握拍手指的求解不变；球拍拍头位置和方向随角度改变，因此拍头接触标记、`analyzePose` 的 tip readout 以及生成器传入球拍时的接触/拍头度量也会改变。
- 同一动作采用固定倾角，不逐关键帧变化。握拍中需要的手腕姿势仍由关键帧控制，用户无需把腕屈伸用作拍柄校正。
- 局部 X 轴旋转在 x 镜像下保持同号，因此 `mirrorDoc` 原样保留 `gripTilt`，左右球拍姿态仍是精确镜像。
- 缺省 0° 是规范形态：`normalizeDoc` 折叠显式零值；姿态包只在非零时输出 `presentation.gripTilt`，外部播放端通过 prop capability 还原。
- 倾角作为文档字段参与请求指纹和定义哈希，变更得到新的 artifact id。它不改求解出的骨骼轨迹，所以只 bump `WORKSHOP_REVISION`（v7→v8），不 bump `SERVICE_VERSION`。

## 验收

- `grip-side.test.ts` 验证范围、序列化、非零挂载改变拍头、骨骼姿态不变及左右镜像。
- `workshop-preset-qa.mjs` 经真实滑块输入，验证文档写入、球拍变化、手腕与姿态不变和保存重载。
- 姿态包 presentation 测试验证倾角导出、读取和 `PosePackageSource` 暴露。

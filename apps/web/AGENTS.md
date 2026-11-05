# Web 编辑器

- 唯一产品路径是 `src/manual/ManualEditor.tsx` 与 `src/manual/editor-engine.ts`。
- 姿势以模型自身的局部关节旋转记录；变换必须直接进入 `Bone.quaternion`，不得引入人体逆运动学、动力链推算或预生成动作。
- `src/manual/document.ts` 是动作 JSON 的唯一格式和采样实现；导入处必须调用 `parseMotion`。
- 视觉交互应保留时间轴、逐关节旋转、本机动作库和 JSON 导入/导出。
- 静态资源位于仓库根 `public/`；Vite 从 `apps/web` 读取入口。

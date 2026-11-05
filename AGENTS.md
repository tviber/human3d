# AGENTS

## 项目目标

h3d 只支持手工逐关键帧姿势创作。编辑器把用户保存的局部关节四元数直接应用到 GLB 自带的蒙皮骨骼，并在关键帧间做球面插值。

- 不新增 IK、FK 链、接触约束、动作生成、肌肉/动力学、远程服务或预设动作。
- GLB 内的关节仅供 Three.js 蒙皮和直接姿势编辑；不构建另一套人体 rig。
- 动作格式定义在 `apps/web/src/manual/document.ts`，只存根节点位移、局部关节旋转和关键帧时间。
- `public/models/chibi-sports-avatar.glb` 是唯一运行时模型。
- 包边界固定为单个 `apps/web` workspace；跨包导入约定已移除。

## 资源与验证

- 仓库内 Node 与 ffmpeg 进程总数最多 4 个。启动开发服务器或构建前由 npm 生命周期调用 `scripts/check-process-limit.sh`。
- `npm run build` 是 CI 与交付的唯一自动验证：TypeScript 检查后构建网页。
- 不要恢复已删除的动力学、协议服务、预设动作或旧 solver 测试流水线。
- 修改动作格式时，更新 `docs/manual-authoring.md` 与 `parseMotion` 的校验。

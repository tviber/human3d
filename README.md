# h3d · 手作间

一个只做手工动作创作的 3D 关节编辑器。选择关节、调整旋转、添加关键帧，再播放、保存到本机或导出动作文件。

## 启动

需要 Node.js 22.12 或更高版本。

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。角色模型随项目提供，动作只保存在浏览器本机；导出的 JSON 可以在另一台设备导入。

```sh
npm run build
npm run preview
```

## 编辑方式

- 用右侧关节面板直接调整模型的局部旋转；也可以移动整个人物。
- 时间轴关键帧之间按四元数插值，直接驱动模型自带的关节。
- 动作库自动保存在浏览器，可复制、导入和导出。
- 动作文件不含求解器、动作预设或服务端依赖。

## 项目结构

- `apps/web/src/manual/`：动作格式、时间采样、Three.js 场景和编辑界面。
- `public/models/chibi-sports-avatar.glb`：唯一运行时角色模型。
- `scripts/check-process-limit.sh`：开发服务器和构建的进程数保护。
- [编辑器说明](docs/manual-authoring.md)

CI 只安装依赖并运行 `npm run build`（TypeScript 类型检查与 Vite 构建）。

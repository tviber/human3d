# 运动数据集可行性审计

这是一次独立调研，用来判断五个公开运动数据集能不能帮 human3d 处理现在的正手下蹲、脚接触和视频姿态问题。生产求解器、Motion Protocol 和界面都没有改。

报告：[REPORT.md](REPORT.md)

离线脚本：[audit_pose.py](audit_pose.py)。`python3 audit_pose.py selftest` 不需要数据。`npy` 子命令可用 `--skeleton {auto,h36m17,coco17}` 指定关节布局；只支持 17 个关节，布局不明确时 auto 会拒绝。COCO 文件只有带 `frame_index` 或 `timestamp_s` 时才做连续运动分析。

真实样本的统计和棍图在 [evidence/](evidence/)。每个输入的来源、版本、哈希和生成命令在 [evidence/manifest.json](evidence/manifest.json)。下载的数据集文件被 [.gitignore](.gitignore) 排除，不进仓库。

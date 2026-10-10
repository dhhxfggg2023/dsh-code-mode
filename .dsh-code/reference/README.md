# 引擎参照副本（不是产品代码）

这个目录放的是**从 app.asar 里抽出来的宿主引擎源码**，用途只有一个：
`probes/gate-ahead-of-engine.mjs` 的 A10 判据拿它当参照，证明
`lib/compact-policy.js` 里镜像的那两个常数（`ENGINE_THRESHOLD_RATIO`、
`ENGINE_HEADROOM_TOKENS`）和引擎真实的算术**没有漂移**。

- 来源：`app.asar → node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`
- 抽取：
  `$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' probes/asar-read.mjs to node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js .dsh-code/reference/dsh-compaction-basic.index.js`
- **DSH 升级后要重新抽一次**：抽完 A10 若变红，说明引擎改了口径，闸门的镜像必须跟着改。
  这正是 A10 存在的理由——2026-10-10 那次事故就是"两个子系统各拿一个数、无人比对"。

目录内文件不进产品、不进 `files` 字段，只是判据的参照物。

# Changelog

本项目的所有显著变更都将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-07-26

### Added

- `dv <cmd> [--path] [--mode]`：检测目标目录 package.json 的 npm scripts，按 mode 过滤（名为 mode 或以 `mode:` 开头）并透传执行；包管理器按 lock 文件自动检测（pnpm/npm/yarn/bun）
- 最简输入解析链：全名精确 > 缩写精确 > 全名前缀唯一 > 歧义报错列候选表；缩写由各 `:` 分段首字母拼接，冲突时按声明顺序先占最短、后声明者从末段逐字符加长（如 dev:web → `dw`、dev:website → `dwe`）
- 插件架构（runtime hooks）：scripts:loaded / command:resolved / command:before / command:after / command:error 五个生命周期钩子
- 内置 killport 插件（kp）：dev script 执行前清场目标端口上的监听进程（SIGTERM 并等待端口实际释放）；端口来源为 script 显式声明（`--port` > `PORT=` > 框架上下文 `-p`）或框架 config 静态提取（vite/astro/rsbuild 的 `server.port`、nuxt 的 `devServer.port`），解析不到时跳过
- `dv plugins list/enable/disable` 插件管理，启用状态持久化于用户级 `~/.config/dv/config.json`
- pnpm monorepo 支持：script 为 `pnpm -C`/`--dir`/`--filter` 时 config 搜索目录穿透到子包（`--filter` 经 pnpm-workspace.yaml 包名映射）

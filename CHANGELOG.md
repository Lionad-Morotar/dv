# Changelog

本项目的所有显著变更都将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- bind 检测系统代理并自动注入例外：系统代理（如 Clash Verge 全量接管 HTTPS）会用自身 DNS 解析绑定域并因公网解析不存在而掐断隧道（浏览器表现为 `ERR_CONNECTION_CLOSED`），bind 启动时自动把绑定域加入 macOS 系统代理例外列表（免 sudo），退出时移除，崩溃残留由下次绑定清扫；注入失败仅警告不阻断绑定。限制：PAC 模式例外不生效（会提示手动绕过）；Clash Verge 等工具重设系统代理时以自身配置覆盖，长期使用请把绑定域加进代理工具的绕过设置

## [0.2.1] - 2026-09-28

### Added

- bind 支持 https：绑定域（含一级泛子域）浏览器可直接 `https://` 免端口访问，`.dev`、`.app` 等强制 https 的域名不再被排除在外。首次绑定自动创建本地 CA 并装入系统信任链（Chrome/Safari 直接受信，Firefox 需手动信任 CA 证书文件），证书材料用后即删；信任安装失败仅提示，不影响 http 绑定主路径

### Changed

- bind 成功提示从 `http://<域名>` 改为 `http(s)://<域名>` 形态

## [0.2.0] - 2026-09-26

### Added

- `dv dev --bind <domain>` 域名绑定：dev script 启动时把域名（含全部子域）绑到本地 dev server，浏览器直接访问 `http://<domain>` 免端口直达。机制为 `/etc/resolver` 按域解析路由 + 内嵌 DNS 应答器 + 一次性 sudo 拉起的 root 哑管道接管 `:80` + 内嵌代理重写 Host/Origin 后转发——vite 系框架的 Host 与 WebSocket Origin 校验零配置通过。绑定随 dv 进程生死：正常退出显式清理，崩溃或强杀由 helper watchdog 自清，孤儿残留凭自属标记由下次绑定清扫。解析未生效时自动降级 `/etc/hosts` 逐名绑定并警告（降级模式无泛子域）；可重复传参绑多个域。限制：HSTS 预加载域（如 `*.dev`、`*.app`）浏览器强制 https 不适用；绑定期间真实站点在本机不可达（绑定时有提示）

### Changed

- Node 版本要求抬升至 >= 22（DNS 应答器依赖的引擎要求），Node 20 及以下请留在 0.1.x

## [0.1.4] - 2026-07-30

### Added

- kp 端口解析链新增项目级显式声明来源：package.json `dv.killport.<scriptName>` 直接声明端口，覆盖命令行无端口、无框架 config 的 script（如 `cd backend && air`，端口藏在运行时 env 里，此前 kp 只能报「no port detected, skipping」）。解析链优先级：根 script 显式端口 > 委托 script 显式端口 > 项目声明 > 框架 config——命令行 runtime 真相恒优先于一切静态来源；声明按解析后的全 script 名匹配，畸形值 warn 并视为未声明、不阻断 script 启动；委托失败（`--filter` 无匹配）时声明同样不查，整链跳过

## [0.1.3] - 2026-07-30

### Added

- 解析链新增模糊子序列（subsequence）兜底匹配：前三级（全名 / 缩写 / 前缀）落空后，输入字符按顺序出现在 script 名中即命中，不必连续、不区分大小写——凭名字记忆即可寻址（如 `dv room`、`dv dplr` 命中 `dev:260728-pure-line-room-tour`），无需记住缩写或日期前缀。命中多个时按词首 / 连续命中加分择唯一最高分执行；最高分并列（如 `shine` 之于 `shine-cards` / `shine-cards-kimi`）则报歧义列候选，绝不静默猜错。既有缩写（如 `d2`）走原解析链不受影响

## [0.1.2] - 2026-07-28

### Fixed

- kp 端口解析穿透 pnpm monorepo 委托链，失败委托不再回落根包：script 为 `pnpm -C/--filter` 委托命令时，穿透到目标包读取被委托 script 的命令文本并解析显式端口（如 `pnpm --filter web dev` → 子包 `nuxt dev --port 2350` → 2350；此前只查框架 config，端口仅声明在命令行时 kp 误报「no port detected, skipping」）。解析链优先级：根 script 显式端口 > 委托 script 显式端口 > 框架 config；`--filter` 包名无匹配时整链跳过、不回落根包 config 搜索，杜绝错杀无关进程

## [0.1.1] - 2026-07-27

### Fixed

- `dv` 启动的子进程现在能正确继承终端色彩：修复 `run()` 用兜底流（pipe）传给 `spawnScript` 导致 `stdio: 'inherit'` 判定恒为 false、子进程 stdout 沦为管道（isTTY=false）进而被颜色库禁色的问题；TTY 场景额外注入 `FORCE_COLOR=1` 并尊重既有 `NO_COLOR`

## [0.1.0] - 2026-07-26

### Added

- `dv <cmd> [--path] [--mode]`：检测目标目录 package.json 的 npm scripts，按 mode 过滤（名为 mode 或以 `mode:` 开头）并透传执行；包管理器按 lock 文件自动检测（pnpm/npm/yarn/bun）
- 最简输入解析链：全名精确 > 缩写精确 > 全名前缀唯一 > 歧义报错列候选表；缩写由各 `:` 分段首字母拼接，冲突时按声明顺序先占最短、后声明者从末段逐字符加长（如 dev:web → `dw`、dev:website → `dwe`）
- 插件架构（runtime hooks）：scripts:loaded / command:resolved / command:before / command:after / command:error 五个生命周期钩子
- 内置 killport 插件（kp）：dev script 执行前清场目标端口上的监听进程（SIGTERM 并等待端口实际释放）；端口来源为 script 显式声明（`--port` > `PORT=` > 框架上下文 `-p`）或框架 config 静态提取（vite/astro/rsbuild 的 `server.port`、nuxt 的 `devServer.port`），解析不到时跳过
- `dv plugins list/enable/disable` 插件管理，启用状态持久化于用户级 `~/.config/dv/config.json`
- pnpm monorepo 支持：script 为 `pnpm -C`/`--dir`/`--filter` 时 config 搜索目录穿透到子包（`--filter` 经 pnpm-workspace.yaml 包名映射）

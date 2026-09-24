# @lionad/dv

`dv` 是一个 dev 命令运行器：读取项目 package.json 的 npm scripts，按 mode 过滤，用最简输入执行。支持缩写、插件化端口清场与 pnpm monorepo。

## 安装

```bash
npm install -g @lionad/dv
```

要求 Node.js >= 20.19，目前仅支持 macOS。

## 用法

```bash
dv <cmd> [--path <dir>] [--mode <mode>]
```

- `<cmd>`：script 名、缩写、唯一前缀或凭名字记忆的模糊把手（详见下文解析规则）
- `--path`：目标项目目录，默认当前目录
- `--mode`：script 域过滤，默认 `dev`——候选为名为 `dev` 或以 `dev:` 开头的 scripts；`--mode build` 则匹配 `build` / `build:*`

```bash
dv dev              # 等价于 pnpm dev（包管理器按 lock 文件自动检测）
dv dw               # dev:web 的缩写
dv website          # 模糊子序列命中 dev:website（凭名字记忆即可）
dv dev:web --path ../other-project
dv build --mode build
```

包管理器检测顺序：`pnpm-lock.yaml` → pnpm，`package-lock.json` → npm，`yarn.lock` → yarn，`bun.lock(b)` → bun，无 lock 默认 pnpm。

### 域名绑定（--bind）

```bash
dv dev --bind app.example.com
```

把域名绑到 dev server：`/etc/resolver/<domain>` 把该域（含全部子域）的解析引到 dv 内嵌的 DNS 应答器（答 `127.0.0.1`），root helper 在 `:80` 起哑管道接到 dv 内嵌代理，代理把 `Host`/`Origin` 重写为 `127.0.0.1:<port>` 后转发——浏览器直接访问 `http://app.example.com`，免端口、过框架 Host 校验。

- 需要一次 sudo（`/etc/resolver` 与 `:80` 是特权资源）；helper 只做哑管道与文件写入，不含任何 HTTP/DNS 解析逻辑
- 绑定随 dv 进程生死：正常退出显式清理；dv 崩溃或被 `SIGKILL` 时 helper 的 watchdog（父进程心跳 + pid 复用钉 + stdin EOF）自清；helper 被强杀的残留由下一次绑定的孤儿清扫回收（凭 `# dv:bind pid=N` 标记）
- 自验证失败（如系统 DNS 策略拦截 resolver）自动降级为 `/etc/hosts` 逐名绑定并警告——降级模式不支持泛子域
- 可重复传参绑多个域：`dv dev --bind a.example.com --bind b.example.com`
- 注意 HSTS：只对没开 HSTS 的域做 http 绑定；预加载 HSTS 的域（如 `*.dev`、`*.app` 全域）浏览器强制 https，本功能不适用

## 命令解析规则

按优先级：全名精确匹配 > 缩写精确匹配 > 全名前缀唯一匹配 > 模糊子序列唯一匹配 > 歧义报错（列出候选表）。

缩写由各 `:` 分段的首字母拼接而成。冲突时按 scripts 声明顺序先占最短，后声明者从最后一段起逐字符加长直到唯一：

```jsonc
{
  "scripts": {
    "dev": "...",          // d
    "dev:web": "...",      // dw
    "dev:website": "...",  // dwe（dw 已被占，加长末段）
    "dev:webapp": "...",   // dweb（dwe 已被占，继续加长）
  }
}
```

中间形态前缀（如 `dv dev:w`）在唯一时同样可用。

前三级都落空时进入模糊子序列（subsequence）匹配：输入字符按顺序出现在 script 名中即算命中，不必连续、不区分大小写。这让你凭名字记忆敲入把手，无需记住缩写或日期前缀：

```bash
dv room             # 唯一含 room → dev:260728-pure-line-room-tour
dv dplr             # 首字母式把手，词首命中得分更高 → pure-line-room-tour
```

命中多个时按匹配质量择优：词首命中（分隔符之后的字符）与连续命中加分，唯一最高分直接执行；最高分并列（如 `shine` 之于 `shine-cards` / `shine-cards-kimi`）则与全名前缀一样报歧义、列出候选表，
绝不因细微分差静默猜错。

## 插件

```bash
dv plugins              # 列出插件与启用状态
dv plugins list         # 同上
dv plugins enable kp    # 启用
dv plugins disable kp   # 禁用
```

启用状态存于用户级配置 `~/.config/dv/config.json`（遵循 `XDG_CONFIG_HOME`）。禁用的插件完全不挂载，不会在 hook 链中留下痕迹。

### kp（killport，内置）

dev script 执行前清场目标端口上的监听进程（SIGTERM，不升级 SIGKILL，等待端口实际释放后才执行 script）。解析不到端口时跳过，绝不用框架默认端口兜底。

端口来源按优先级：

1. script 文本显式端口：`--port 3001` > `PORT=3001` > 框架上下文 `-p 3001`（仅当 script 含 nuxt/vite/astro/next 等框架命令时，`-p` 才解释为端口）
2. 委托 script 显式端口：script 为 `pnpm -C <dir>` / `pnpm --filter <pkg>` 委托命令时，穿透到目标包读取被委托 script 的命令文本，按第 1 条规则解析（
   如根 script `pnpm --filter web dev` → 子包 `dev: nuxt dev --port 2350` → 2350）
3. 项目级显式声明：package.json 的 `dv.killport.<scriptName>`。为命令行无端口、无框架 config 的 script（如 `cd backend && air`——端口藏在运行时 env 里）
   提供可信来源；按解析后的全 script 名匹配，畸形值 warn 并视为未声明
4. 框架 config 静态提取：`vite.config.*` / `astro.config.*` / `rsbuild.config.*` 的 `server.port`，
   `nuxt.config.*` 的 `devServer.port`。只认对象直接子级的数字字面量；变量引用与表达式提取不到，按跳过处理

```jsonc
{
  "scripts": {
    "dev:go": "cd backend && air"  // 端口在 backend/.env，命令行不可见
  },
  "dv": {
    "killport": {
      "dev:go": 8889  // kp 执行 dev:go 前清场 8889
    }
  }
}
```

monorepo 支持：script 为 `pnpm -C <dir>` / `pnpm --filter <pkg>` 时，委托 script 与 config 的搜索目录均穿透到子包（
`--filter` 经 pnpm-workspace.yaml 包名映射）。`--filter` 包名无匹配视为委托失败，整条解析链跳过（不回落根包搜索），杜绝从无关实体提取端口而错杀。

### bind（内置）

`--bind` 传入时激活：dev script 启动前完成域名绑定（机制见上文「域名绑定」），script 退出后清理。与 kp 共用同一条端口解析链；解析不到端口时报错而非跳过——`--bind` 是显式诉求，静默失效不可接受。可用 `dv plugins disable bind` 关闭。

## 开发

```bash
pnpm install
pnpm test        # vitest 全量
pnpm typecheck   # tsc --noEmit
pnpm build       # vp pack → dist/cli.mjs + dist/plugins/bind/privileged.mjs
```

## License

MIT

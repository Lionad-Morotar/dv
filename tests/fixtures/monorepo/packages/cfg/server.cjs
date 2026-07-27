// fixture：模拟框架 CLI——命令行 --port 53997 与 vite.config.ts 的 53996 冲突，
// 运行时命令行覆盖 config，kp 必须取 53997
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
require('http')
  .createServer()
  .listen(port, '127.0.0.1', () => {
    console.log('CFG_RAN')
    process.exit(0)
  })
  .on('error', () => {
    console.error('CFG_FAIL')
    process.exit(1)
  })

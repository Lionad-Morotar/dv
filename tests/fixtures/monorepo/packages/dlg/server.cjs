// fixture：委托优先级验证——命令行 --port（runtime 真相）应压过根包 dv.killport 声明。
// 端口刻意独占 54005：与 killport-config.test.ts 的 5399x 段错开，避免 vitest 文件并行撞车
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
require('http')
  .createServer()
  .listen(port, '127.0.0.1', () => {
    console.log('DLG_RAN')
    process.exit(0)
  })
  .on('error', () => {
    console.error('DLG_FAIL')
    process.exit(1)
  })

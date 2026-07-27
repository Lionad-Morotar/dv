// fixture：模拟框架 CLI——端口声明在命令行 --port 上（如 nuxt dev --port 2350），
// 包内无任何框架 config 文件，端口只能来自 script 文本穿透
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
require('http')
  .createServer()
  .listen(port, '127.0.0.1', () => {
    console.log('APP_RAN')
    process.exit(0)
  })
  .on('error', () => {
    console.error('APP_FAIL')
    process.exit(1)
  })

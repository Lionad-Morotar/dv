// fixture：干扰项 config——端口 53996 与 script 命令行 53997 冲突。
// 若 kp 误取 config 端口，集成测试会杀错端口导致 server.cjs 绑定 53997 撞上占用进程而失败
export default {
  server: {
    port: 53996,
  },
}

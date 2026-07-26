import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** lsof 单次查询上限：慢盘/NFS/容器挂载点下首次扫描可能秒级，超时按"查不到"跳过而非拖住冷启动 */
const LSOF_TIMEOUT_MS = 3000
/** 等待端口释放的上限：被杀进程的 SIGTERM 清理（如 nuxt 释放目录锁）可能耗时，超时尽力返回 */
const PORT_FREE_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 100

/**
 * 查询监听指定端口的 PID。判定依据是 stdout 内容而非 exit code——
 * lsof 无匹配 exit 1、权限/沙箱异常 exit ≥2、超时被中断，这些都不该阻断主流程：
 * kp 是尽力清场，查不到等价于端口空闲。
 */
async function pidsOnPort(port: number): Promise<number[]> {
  let stdout: string
  try {
    const result = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      timeout: LSOF_TIMEOUT_MS,
    })
    stdout = result.stdout
  } catch (error) {
    // execFile 失败时 error 上仍挂 stdout（exit 非 0 场景）；无 stdout 说明 spawn 本身失败（如 lsof 缺失）
    const errStdout = (error as { stdout?: unknown }).stdout
    if (typeof errStdout !== 'string') return []
    stdout = errStdout
  }
  return [
    ...new Set(
      stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ]
}

/**
 * 查杀监听指定端口的进程（SIGTERM），返回成功发送信号的 PID 列表。
 * 不升级 SIGKILL：dev server 需要 SIGTERM 做清理（如 nuxt 释放目录锁），强杀会留下脏状态。
 * 返回前等待端口实际释放（上限尽力而为）：调用方拿到结果即可安全 listen。
 */
export async function killProcessOnPort(port: number): Promise<number[]> {
  const pids = await pidsOnPort(port)
  const killed: number[] = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {
      // ESRCH：查到后进程已自行退出（竞态，无害）；EPERM：无权操作的进程，跳过
    }
  }
  if (killed.length === 0) return killed

  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS
  while ((await pidsOnPort(port)).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return killed
}

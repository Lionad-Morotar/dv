import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

/** 收集流：测试注入以断言 dv 的输出，替代直接读 process.stdout */
export class CaptureStream extends Writable {
  text = ''
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.text += chunk.toString()
    cb()
  }
}

/**
 * 用独立子进程占用端口并等待其就绪。
 * 必须在独立进程占用——测试进程内 listen 会让 lsof 查到测试进程自身 PID，kill 会误杀自己。
 */
export function occupyPort(port: number): Promise<ChildProcess> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      '-e',
      `require('http').createServer(() => {}).listen(${port}, '127.0.0.1', () => console.log('READY'))`,
    ])
    const timer = setTimeout(() => rejectPromise(new Error('occupy timeout')), 8000)
    child.stdout?.on('data', (d) => {
      if (String(d).includes('READY')) {
        clearTimeout(timer)
        resolvePromise(child)
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      rejectPromise(new Error('occupy process exited early'))
    })
  })
}

export function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // 被信号杀死时 code 为 null、signal 非空——不能用 code 判死
  return new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
}

/** 不存在的 config 路径：readConfig 回退默认（全部插件启用） */
export async function freshConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dv-kp-'))
  return join(dir, 'config.json')
}

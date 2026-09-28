import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPublicKey, X509Certificate } from 'node:crypto'

import { generate } from 'selfsigned'

import { DvError } from '../../core/pkg.ts'

export interface CaMaterial {
  /** PEM 正文（加载或新建后回读，调用方无须再读文件） */
  cert: string
  key: string
  /** 持久化路径：cert 交给 helper 装系统信任链用 */
  certPath: string
  created: boolean
}

export interface LeafMaterial {
  cert: string
  key: string
  certPath: string
  keyPath: string
  /** 删除 staging 目录（含 cert/key 两个文件） */
  cleanup: () => void
}

export interface CertModuleDeps {
  /** 默认 ~/Library/Application Support/dv/ca（macOS 惯例，mkcert CAROOT 同款风格） */
  caDir?: string
  /** 默认 os.tmpdir()；测试注入隔离 */
  tmpDir?: string
}

const DAY_MS = 86_400_000

/** notBefore 统一回拨 1h：本机与受信校验方时钟有秒级偏差时证书仍有效（mkcert 同款处理） */
const NOT_BEFORE_SLACK_MS = 3_600_000

const CA_VALID_DAYS = 10 * 365
const LEAF_VALID_DAYS = 365

/** defaultCaDir 只在 darwin 有意义，工具本身 os: darwin */
export function defaultCaDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'dv', 'ca')
}

function caPaths(caDir: string): { certPath: string; keyPath: string } {
  return { certPath: join(caDir, 'ca.crt'), keyPath: join(caDir, 'ca.key') }
}

/**
 * 加载或创建 dv 自管 CA（EC P-256，十年期）。
 * 持久 CA 是 mkcert 模式的信任基座：浏览器信任的是 CA 而非每次的 leaf，重建 CA 等于
 * 信任链悬空，所以已存在的 CA 只加载并校验配对，绝不静默重建。
 */
export async function loadOrCreateCa(deps: CertModuleDeps = {}): Promise<CaMaterial> {
  const caDir = deps.caDir ?? defaultCaDir()
  const { certPath, keyPath } = caPaths(caDir)

  if (existsSync(certPath) || existsSync(keyPath)) {
    // 半残状态显式报错：半残时静默重建会生成新的未受信 CA，用户面对的是"看似生效实际不可信"
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new DvError(`bind: CA 存储不完整（${certPath} 与 ${keyPath} 应成对存在）——请手动清理后重试`)
    }
    const cert = readFileSync(certPath, 'utf8')
    const key = readFileSync(keyPath, 'utf8')
    // 内容损坏（截断/非 PEM）同样按显式报错处理：原生 crypto 错误会绕过 run.ts 的统一错误契约
    let certX: X509Certificate
    let keyObj: ReturnType<typeof createPublicKey>
    try {
      certX = new X509Certificate(cert)
      keyObj = createPublicKey(key)
    } catch (error) {
      throw new DvError(`bind: CA 存储损坏（${(error as Error).message}）——请手动清理后重试`)
    }
    if (!certX.publicKey.equals(keyObj)) {
      throw new DvError('bind: CA 证书与私钥不配对——请手动清理后重试')
    }
    return { cert, key, certPath, created: false }
  }

  mkdirSync(caDir, { recursive: true, mode: 0o700 })
  chmodSync(caDir, 0o700)
  const pem = await generate([{ name: 'commonName', value: 'dv dev CA' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - NOT_BEFORE_SLACK_MS),
    notAfterDate: new Date(Date.now() + CA_VALID_DAYS * DAY_MS),
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  // key 用 wx 独占写：并发首跑时只有一个赢家，输家改读磁盘上的 CA——
  // 覆盖写会让先启动进程的内存 CA 与磁盘 CA 分叉，信任链静默悬空
  try {
    writeFileSync(keyPath, pem.private, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateCa(deps)
    throw error
  }
  writeFileSync(certPath, pem.cert, { mode: 0o644 })
  return { cert: pem.cert, key: pem.private, certPath, created: true }
}

/**
 * 按绑定域现签 leaf 证书（SAN = 域 + 一级泛子域），材料落 staging 目录交给 helper。
 * 有效期取一年：Chrome 对受信 CA 签发的 leaf 有 ≤398 天上限；每次 bind 现签（毫秒级）
 * 使 SAN 始终贴合本次绑定域，无须长有效期。
 */
export async function issueLeafCertificate(
  ca: CaMaterial,
  domains: string[],
  deps: CertModuleDeps = {},
): Promise<LeafMaterial> {
  const normalized = domains.map((d) => d.toLowerCase().replace(/\.$/, ''))
  const altNames = normalized.flatMap((domain) => [
    { type: 2 as const, value: domain },
    { type: 2 as const, value: `*.${domain}` },
  ])
  const pem = await generate([{ name: 'commonName', value: normalized[0] ?? '' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - NOT_BEFORE_SLACK_MS),
    notAfterDate: new Date(Date.now() + LEAF_VALID_DAYS * DAY_MS),
    ca: { key: ca.key, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  })

  // staging 目录仅本用户可进（700），key 文件 600：helper 读取后即删，泄露窗口压到最短
  const stageDir = mkdtempSync(join(deps.tmpDir ?? tmpdir(), 'dv-bind-'))
  chmodSync(stageDir, 0o700)
  const certPath = join(stageDir, 'leaf.crt')
  const keyPath = join(stageDir, 'leaf.key')
  writeFileSync(certPath, pem.cert, { mode: 0o644 })
  writeFileSync(keyPath, pem.private, { mode: 0o600 })

  return {
    cert: pem.cert,
    key: pem.private,
    certPath,
    keyPath,
    cleanup: () => rmSync(stageDir, { recursive: true, force: true }),
  }
}
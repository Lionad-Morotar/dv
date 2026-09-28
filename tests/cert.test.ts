import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { X509Certificate, createPublicKey } from 'node:crypto'

import { DvError } from '../src/core/pkg.ts'
import { issueLeafCertificate, loadOrCreateCa } from '../src/plugins/bind/cert.ts'

/** 每 it 独立的临时目录，互不串扰 */
function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dv-cert-test-'))
}

describe('loadOrCreateCa', () => {
  it('creates the CA on first run with ec key, ca constraints and 10-year validity', async () => {
    const dir = makeTempRoot()
    try {
      const ca = await loadOrCreateCa({ caDir: dir })
      expect(ca.created).toBe(true)
      const cert = new X509Certificate(readFileSync(join(dir, 'ca.crt')))
      expect(cert.subject).toContain('dv dev CA')
      // CA 身份自签名：issuer 即 subject
      expect(cert.issuer).toBe(cert.subject)
      // 有效期约 10 年（容忍秒级时钟差），notBefore 回拨防时钟偏差
      const validFrom = new Date(cert.validFrom)
      const validTo = new Date(cert.validTo)
      expect(validTo.getTime() - validFrom.getTime()).toBeGreaterThan(9 * 365 * 86400_000)
      expect(validFrom.getTime()).toBeLessThan(Date.now() - 3500_000)

      // key 600、cert 644、目录 700
      const keyMode = statSync(join(dir, 'ca.key')).mode & 0o777
      const certMode = statSync(join(dir, 'ca.crt')).mode & 0o777
      expect(keyMode).toBe(0o600)
      expect(certMode).toBe(0o644)
      const dirMode = statSync(dir).mode & 0o777
      expect(dirMode).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses the existing CA verbatim on later runs (idempotent)', async () => {
    const dir = makeTempRoot()
    try {
      const first = await loadOrCreateCa({ caDir: dir })
      expect(first.created).toBe(true)
      const second = await loadOrCreateCa({ caDir: dir })
      expect(second.created).toBe(false)
      expect(second.cert).toBe(first.cert)
      expect(second.key).toBe(first.key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unpaired or incomplete CA store instead of silently regenerating', async () => {
    const dir = makeTempRoot()
    try {
      await loadOrCreateCa({ caDir: dir })
      // cert 原样、只剩 key 缺失：不完整即报错
      rmSync(join(dir, 'ca.key'))
      await expect(loadOrCreateCa({ caDir: dir })).rejects.toThrow(DvError)
      // key 与 cert 不配对：静默重建会让已装进信任链的 CA 悬空
      const otherDir = makeTempRoot()
      try {
        const otherCa = await loadOrCreateCa({ caDir: otherDir })
        writeCaKey(dir, otherCa.key)
        await expect(loadOrCreateCa({ caDir: dir })).rejects.toThrow(DvError)
      } finally {
        rmSync(otherDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports corrupted CA contents as DvError instead of a raw crypto error', async () => {
    const dir = makeTempRoot()
    try {
      await loadOrCreateCa({ caDir: dir })
      writeFileSync(join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\ntruncated\n')
      await expect(loadOrCreateCa({ caDir: dir })).rejects.toThrow(DvError)
      await expect(loadOrCreateCa({ caDir: dir })).rejects.toThrow(/损坏/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives concurrent first runs with a single winning CA', async () => {
    const dir = makeTempRoot()
    try {
      const [a, b] = await Promise.all([
        loadOrCreateCa({ caDir: dir }),
        loadOrCreateCa({ caDir: dir }),
      ])
      // 无论谁赢，磁盘上的 CA 只有一套且与两次返回一致
      expect(a.cert).toBe(b.cert)
      const onDisk = new X509Certificate(readFileSync(join(dir, 'ca.crt')))
      expect(onDisk.publicKey.equals(createPublicKey(a.key))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('issueLeafCertificate', () => {
  it('issues a leaf SANned to domains plus one-level wildcards and chain-verifies against the CA', async () => {
    const dir = makeTempRoot()
    try {
      const ca = await loadOrCreateCa({ caDir: dir })
      const leaf = await issueLeafCertificate(ca, ['AI.86links.dev', 'app.test'], { tmpDir: dir })
      try {
        const leafCert = new X509Certificate(leaf.cert)
        // 大小写归一
        expect(leafCert.subjectAltName).toContain('DNS:ai.86links.dev')
        expect(leafCert.subjectAltName).toContain('DNS:*.ai.86links.dev')
        expect(leafCert.subjectAltName).toContain('DNS:app.test')
        expect(leafCert.subjectAltName).toContain('DNS:*.app.test')
        // 签发链闭合：CA 私钥可验 leaf 签名
        const caCert = new X509Certificate(ca.cert)
        expect(leafCert.verify(createPublicKey(ca.key))).toBe(true)
        expect(leafCert.issuer).toBe(caCert.subject)
        // leaf 一年有效期（避开受信 leaf 的 398 天上限）
        const validity = new Date(leafCert.validTo).getTime() - new Date(leafCert.validFrom).getTime()
        expect(validity).toBeGreaterThan(360 * 86400_000)
        expect(validity).toBeLessThanOrEqual(366 * 86400_000)
      } finally {
        leaf.cleanup()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stages material in a 700 tmp dir with 600 key and cleans up on demand', async () => {
    const dir = makeTempRoot()
    try {
      const ca = await loadOrCreateCa({ caDir: dir })
      const leaf = await issueLeafCertificate(ca, ['app.test'], { tmpDir: dir })
      const keyMode = statSync(leaf.keyPath).mode & 0o777
      const certMode = statSync(leaf.certPath).mode & 0o777
      expect(keyMode).toBe(0o600)
      expect(certMode).toBe(0o644)
      expect(readFileSync(leaf.certPath, 'utf8')).toContain('BEGIN CERTIFICATE')
      expect(readFileSync(leaf.keyPath, 'utf8')).toContain('BEGIN PRIVATE KEY')

      leaf.cleanup()
      expect(() => statSync(leaf.certPath)).toThrow()
      expect(() => statSync(leaf.keyPath)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 便捷写入：把任意 key 内容塞进给定 caDir（配对校验用例需要） */
function writeCaKey(dir: string, pem: string): void {
  rmSync(join(dir, 'ca.key'), { force: true })
  writeFileSync(join(dir, 'ca.key'), pem, { mode: 0o600 })
}
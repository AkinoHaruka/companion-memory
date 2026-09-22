import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageDirectory, '../../..')

describe('baseline execution contract', () => {
  it('runs the package TypeScript build and reconciles the current test report', () => {
    const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    expect(() => execFileSync(packageManager, [
      'exec',
      'tsc',
      '-b',
      'packages/bundle/riko-memory/tsconfig.json',
      '--pretty',
      'false',
    ], { cwd: repositoryRoot, stdio: 'pipe', timeout: 30_000, shell: process.platform === 'win32' })).not.toThrow()

    const progress = readFileSync(join(packageDirectory, 'docs', 'memory-v3-progress.md'), 'utf8')
    const report = JSON.parse(readFileSync(join(packageDirectory, 'docs', 'spec-execution-report.json'), 'utf8')) as {
      readonly suite: { readonly files: number; readonly failed: number; readonly success: boolean }
    }
    expect(progress).toContain('pnpm exec tsc -p tsconfig.host.json --noEmit')
    expect(progress).toContain('pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot')
    expect(progress).toContain('Any mandatory item with `FAIL` makes `Overall = FAIL`')
    for (const dimension of [
      'Runtime Wiring',
      'Persistence / Migration',
      'Unit Tests',
      'Integration Tests',
      'Behavior Acceptance',
      'Failure Fallback',
      'Rollback',
      'Docs',
    ]) expect(progress).toContain(dimension)
    expect(report.suite.files).toBeGreaterThan(40)
    expect(report.suite.failed).toBe(0)
    expect(report.suite.success).toBe(true)
  })
})

/**
 * Two policies the corpus runner owes its own evidence: a bounded artifacts directory, and an
 * outcome reason that names the cause of a failure instead of only the stack of its symptom.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RETAINED_RUNS, campaignCheckpointKey, describeError, isCompletedCampaignOutcome, pruneCompanionRuns } from './support/companion-runner.ts'

const roots: string[] = []

/** Create one artifacts directory holding the described entries, each stamped with its age. */
async function artifacts(entries: ReadonlyArray<{ name: string; ageSeconds: number; kind?: 'file' | 'directory' }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'riko-artifact-retention-'))
  roots.push(root)
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.kind === 'file') await writeFile(path, 'not a run\n')
    else {
      await mkdir(path)
      await writeFile(join(path, 'raw-results.json'), '{}\n')
    }
    const stamp = new Date(Date.now() - entry.ageSeconds * 1000)
    await utimes(path, stamp, stamp)
  }
  return root
}

/** The artifacts directory's entry names, sorted so a comparison is order-independent. */
async function listing(root: string): Promise<string[]> {
  return (await readdir(root)).sort()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('companion artifact retention', () => {
  it('keeps the newest runs and deletes every older one', async () => {
    const root = await artifacts([
      { name: 'companion-oldest', ageSeconds: 500 },
      { name: 'companion-older', ageSeconds: 400 },
      { name: 'companion-mid', ageSeconds: 300 },
      { name: 'companion-newer', ageSeconds: 200 },
      { name: 'companion-newest', ageSeconds: 100 },
    ])
    const removed = await pruneCompanionRuns(root, 2)
    expect(removed).toEqual(['companion-oldest', 'companion-older', 'companion-mid'].map(name => join(root, name)))
    expect(await listing(root)).toEqual(['companion-newer', 'companion-newest'])
  })

  it('leaves entries that are not corpus runs untouched', async () => {
    const root = await artifacts([
      { name: '.gitignore', ageSeconds: 900, kind: 'file' },
      { name: 'unrelated-directory', ageSeconds: 800 },
      { name: 'companion-older', ageSeconds: 200 },
      { name: 'companion-newest', ageSeconds: 100 },
    ])
    const removed = await pruneCompanionRuns(root, 1)
    expect(removed).toEqual([join(root, 'companion-older')])
    expect(await listing(root)).toEqual(['.gitignore', 'companion-newest', 'unrelated-directory'])
  })

  it('deletes nothing while fewer runs exist than the retained bound', async () => {
    const root = await artifacts([{ name: 'companion-only', ageSeconds: 100 }])
    expect(await pruneCompanionRuns(root, 2)).toEqual([])
    expect(await listing(root)).toEqual(['companion-only'])
  })

  it('bounds one round at the retained count, the round directory included', async () => {
    const root = await artifacts([1, 2, 3, 4, 5].map(index => ({ name: `companion-${String(index)}`, ageSeconds: 100 * index })))
    // Mirrors `runCompanionCorpus`: prune down to the bound minus the directory this round adds.
    expect(await pruneCompanionRuns(root, RETAINED_RUNS - 1)).toHaveLength(5 - (RETAINED_RUNS - 1))
    await mkdir(join(root, 'companion-this-round'))
    expect((await listing(root)).length).toBe(RETAINED_RUNS)
  })

  /**
   * A directory another process is still writing into is not retention's to reclaim.
   *
   * Recency describes the whole directory, so a second corpus process starting newer runs pushes a
   * still-open one past the bound; deleting it fails that run's next write with ENOENT. The pid that
   * claimed the directory is what separates a live run from an abandoned one.
   */
  it('never reclaims a run directory whose claiming process is still running', async () => {
    const root = await artifacts([
      { name: 'companion-live', ageSeconds: 500 },
      { name: 'companion-abandoned', ageSeconds: 400 },
      { name: 'companion-newest', ageSeconds: 100 },
    ])
    // Claiming a directory writes into it, which is the very thing that makes it look recent, so the
    // claim has to be re-stamped to its own age to keep this fixture about ownership and not recency.
    const live = join(root, 'companion-live')
    await writeFile(join(live, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`)
    const stamp = new Date(Date.now() - 500 * 1000)
    await utimes(live, stamp, stamp)
    const removed = await pruneCompanionRuns(root, 1)
    expect(removed).toEqual([join(root, 'companion-abandoned')])
    expect(await listing(root)).toEqual(['companion-live', 'companion-newest'])
  })
})

describe('transport error diagnostics', () => {
  it('names the cause that classifies a fetch failure', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' })
    expect(describeError(new TypeError('fetch failed', { cause: refused })))
      .toBe('TypeError: fetch failed <- caused by Error: connect ECONNREFUSED 127.0.0.1:8080 [code=ECONNREFUSED]')
  })

  it('walks a chain longer than one link and stops at a cycle', () => {
    const socket = new Error('socket hang up')
    const transport = new TypeError('fetch failed', { cause: socket })
    Object.defineProperty(socket, 'cause', { value: transport })
    expect(describeError(transport)).toBe('TypeError: fetch failed <- caused by Error: socket hang up')
  })

  it('renders a thrown value that is not an Error', () => {
    expect(describeError('fixture refused the connection')).toBe('thrown string: fixture refused the connection')
  })
})

describe('campaign checkpoint identity', () => {
  it('reuses only completed or explicitly unsupported outcomes', () => {
    expect(isCompletedCampaignOutcome({ status: 'executed' })).toBe(true)
    expect(isCompletedCampaignOutcome({ status: 'unsupported' })).toBe(true)
    expect(isCompletedCampaignOutcome({ status: 'error' })).toBe(false)
  })

  it('does not make a credential change invalidate the non-secret provider identity', () => {
    const previous = process.env.DSH_MEMORY_DREAM_KEY
    process.env.DSH_MEMORY_DREAM_KEY = 'checkpoint-secret-one'
    const first = campaignCheckpointKey()
    process.env.DSH_MEMORY_DREAM_KEY = 'checkpoint-secret-two'
    const second = campaignCheckpointKey()
    if (previous === undefined) delete process.env.DSH_MEMORY_DREAM_KEY
    else process.env.DSH_MEMORY_DREAM_KEY = previous
    expect(second).toBe(first)
  })
})

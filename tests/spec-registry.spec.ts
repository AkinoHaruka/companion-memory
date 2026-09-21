/**
 * Contract test for the spec execution registry.
 *
 * The registry is the only place that records which specs run by default and which need external configuration.
 * This test fails whenever the tests directory and the registry disagree, so a spec cannot stop executing without
 * a recorded reason and a named owner. A registry that no test reads is a claim, not a gate.
 *
 * It checks discovery and registration, not measured execution: reconciling these entries against what a runner
 * actually executed is a separate step, and the `observed` block in the registry stays a record until then.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(testDirectory, '..')
const registryFile = join(packageDirectory, 'docs', 'spec-execution-registry.json')
const registryText = readFileSync(registryFile, 'utf8')

type DefaultEntry = { mode: 'default' }
type OptInEntry = {
  mode: 'opt-in'
  reason: string
  envGate: string[]
  coveredBy: string
  acceptedGap?: boolean
}
type Registry = {
  package: string
  specDirectory: string
  specs: Record<string, DefaultEntry | OptInEntry>
}

const registry = JSON.parse(registryText) as Registry

function walk(directory: string, accept: (name: string) => boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, accept))
    else if (accept(entry.name)) found.push(full)
  }
  return found.sort()
}

const specFiles = walk(testDirectory, name => name.endsWith('.spec.ts')).map(file =>
  relative(testDirectory, file).split('\\').join('/'))
const registered = Object.keys(registry.specs).sort()
const optIn = Object.entries(registry.specs).filter(
  (pair): pair is [string, OptInEntry] => pair[1].mode === 'opt-in')
const defaultSpecs = Object.entries(registry.specs).filter(([, entry]) => entry.mode === 'default')

// Assembled from fragments so this file never reads as a spec that skips itself.
const markerBases = ['describe', 'it', 'test']
const markerSuffixes = ['skip', 'skipIf', 'todo', 'runIf']
const dottedMarkers = markerBases.flatMap(base => markerSuffixes.map(suffix => [base, suffix].join('.')))
const bareMarkers = ['x' + 'it(', 'x' + 'describe(']

const packageSources = walk(testDirectory, name => name.endsWith('.ts')).map(file => readFileSync(file, 'utf8')).join('\n')

describe('spec execution registry', () => {
  it('discovers a spec corpus that is neither empty nor narrowed', () => {
    expect(specFiles.length).toBeGreaterThan(40)
    expect(registered.length).toBeGreaterThan(40)
  })

  it('registers every spec that exists on disk', () => {
    expect(specFiles.filter(file => registry.specs[file] === undefined)).toEqual([])
  })

  it('registers nothing that does not exist on disk', () => {
    expect(registered.filter(file => !specFiles.includes(file))).toEqual([])
  })

  it('declares each spec once, so a repeated key cannot swallow its predecessor', () => {
    const start = registryText.indexOf('"specs"')
    const end = registryText.indexOf('"observed"')
    expect(start, 'the registry declares a specs object').toBeGreaterThan(-1)
    expect(end, 'the observed block follows the specs object').toBeGreaterThan(start)
    const declared = registryText.slice(start, end).match(/"[^"]+\.spec\.ts":/g) ?? []
    expect(declared.length).toBe(registered.length)
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('records a reason and a covering owner for every spec that does not run by default', () => {
    expect(optIn.length).toBeGreaterThan(0)
    for (const [file, entry] of optIn) {
      expect(entry.reason.trim().length, file).toBeGreaterThan(80)
      expect(entry.envGate.length, file).toBeGreaterThan(0)
      expect(entry.envGate.every(name => name.startsWith('DSH_MEMORY_')), file).toBe(true)
      expect(entry.coveredBy, file).toMatch(/^(?:none|ci-[a-z0-9-]+|manual:[a-z0-9-]+)$/)
      if (entry.coveredBy === 'none') expect(entry.acceptedGap, file).toBe(true)
      else expect(entry.acceptedGap, file).toBeUndefined()
    }
  })

  it('keeps every declared environment variable present in the package test sources', () => {
    expect(packageSources.length).toBeGreaterThan(10000)
    for (const [file, entry] of optIn) {
      for (const name of entry.envGate) expect(packageSources.includes(name), `${file} declares ${name}`).toBe(true)
    }
  })

  it('keeps skipped, todo and conditional tests out of the specs that run by default', () => {
    expect(defaultSpecs.length).toBeGreaterThan(30)
    for (const [file] of defaultSpecs) {
      const source = readFileSync(join(testDirectory, file), 'utf8')
      const markers = [...dottedMarkers, ...bareMarkers].filter(marker => source.includes(marker))
      expect(markers, file).toEqual([])
    }
  })
})

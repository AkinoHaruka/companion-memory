import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const packageRelativeDirectory = 'packages/bundle/riko-memory'
const fixedInputs = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
  'vitest.shared.ts',
  'scripts/test-proxy-environment.ts',
  'scripts/test-invariants.ts',
  'scripts/update-riko-memory-spec-report.ts',
  'packages/util/http-proxy/src/policy.ts',
  'packages/runtime-diagnostics/invariants/package.json',
  'packages/runtime-diagnostics/invariants/src/index.ts',
  `${packageRelativeDirectory}/package.json`,
  `${packageRelativeDirectory}/tsconfig.json`,
  `${packageRelativeDirectory}/cordis.patch.yml`,
  `${packageRelativeDirectory}/docs/memory-v3-requirements.yml`,
  `${packageRelativeDirectory}/docs/spec-execution-registry.json`,
  `${packageRelativeDirectory}/docs/spec-evidence-registry.json`,
]

function walkFiles(directory: string, rootDirectory: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    const normalizedPath = relative(rootDirectory, fullPath).split(sep).join('/')
    if (normalizedPath === `${packageRelativeDirectory}/tests/artifacts`) continue
    if (entry.isDirectory()) paths.push(...walkFiles(fullPath, rootDirectory))
    else if (entry.isFile()) paths.push(relative(rootDirectory, fullPath))
  }
  return paths
}

function walkInvariantFiles(directory: string, rootDirectory: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...walkInvariantFiles(fullPath, rootDirectory))
    else if (entry.isFile() && entry.name === 'invariant.ts') paths.push(relative(rootDirectory, fullPath))
  }
  return paths
}

function expandWorkspacePattern(rootDirectory: string, pattern: string): string[] {
  let candidates = [rootDirectory]
  for (const segment of pattern.replace(/\\/g, '/').split('/')) {
    if (segment === '*') {
      candidates = candidates.flatMap(directory => readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(directory, entry.name)))
    } else {
      candidates = candidates.map(directory => join(directory, segment))
    }
  }
  return candidates.filter(directory => existsSync(join(directory, 'package.json')))
}

function workspaceDependencyInputs(rootDirectory: string, packageDirectory: string): string[] {
  const rootManifest = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] }
  }
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages
  if (workspacePatterns === undefined) throw new Error('root package.json has no workspace package patterns')

  const workspacePackages = workspacePatterns
    .filter(pattern => !pattern.startsWith('!'))
    .flatMap(pattern => expandWorkspacePattern(rootDirectory, pattern))
    .map(directory => ({
      directory,
      relativeDirectory: relative(rootDirectory, directory),
      manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      },
    }))
  const packagesByName = new Map(workspacePackages
    .filter(pkg => pkg.manifest.name !== undefined)
    .map(pkg => [pkg.manifest.name as string, pkg] as const))
  const sourcePackage = workspacePackages.find(pkg => pkg.directory === packageDirectory)
  if (sourcePackage?.manifest.name === undefined) {
    throw new Error(`workspace package manifest is missing at ${packageDirectory}`)
  }

  const pending = [sourcePackage.manifest.name]
  const visited = new Set<string>()
  const inputs = new Set<string>()
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    const pkg = packagesByName.get(name)
    if (pkg === undefined) continue
    const manifestPath = join(pkg.directory, 'package.json')
    inputs.add(relative(rootDirectory, manifestPath))
    const tsconfigPath = join(pkg.directory, 'tsconfig.json')
    if (existsSync(tsconfigPath)) inputs.add(relative(rootDirectory, tsconfigPath))
    const sourceDirectory = join(pkg.directory, 'src')
    if (existsSync(sourceDirectory)) {
      for (const path of walkFiles(sourceDirectory, rootDirectory)) inputs.add(path)
    }

    const dependencySections = [
      pkg.manifest.dependencies,
      pkg.manifest.optionalDependencies,
      pkg.manifest.peerDependencies,
      ...(pkg.directory === packageDirectory ? [pkg.manifest.devDependencies] : []),
    ]
    for (const section of dependencySections) {
      for (const dependency of Object.keys(section ?? {})) {
        if (!visited.has(dependency) && packagesByName.has(dependency)) pending.push(dependency)
      }
    }
  }
  return [...inputs]
}

/** Hashes the current package code, test corpus, runner configuration, and traceability inputs. */
export function computeSpecReportInputFingerprint(rootDirectory: string): string {
  const packageDirectory = join(rootDirectory, packageRelativeDirectory)
  const dynamicInputs = [
    ...walkFiles(join(packageDirectory, 'src'), rootDirectory),
    ...walkFiles(join(packageDirectory, 'tests'), rootDirectory),
    ...walkInvariantFiles(join(rootDirectory, 'packages'), rootDirectory),
    ...workspaceDependencyInputs(rootDirectory, packageDirectory),
  ]
  const inputPaths = [...new Set([...fixedInputs, ...dynamicInputs])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const entries = inputPaths.map((path) => {
    const contentHash = createHash('sha256').update(readFileSync(join(rootDirectory, path))).digest('hex')
    return `${path.split(sep).join('/')}\0${contentHash}`
  })
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

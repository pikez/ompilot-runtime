import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'
import { create } from 'tar'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : null
}

function requiredOption(name) {
  const value = option(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

const sequence = Number(requiredOption('sequence'))
const outputPath = path.resolve(requiredOption('output'))
const runtimeVersion = requiredOption('runtime-version')
const artifactBaseUrl = requiredOption('artifact-base-url').replace(/\/+$/, '')
const runtimeId =
  option('id') ?? `runtime-${sequence}-${process.platform}-${process.arch}`

if (!Number.isSafeInteger(sequence) || sequence <= 0) {
  throw new Error('--sequence must be a positive integer')
}
if (!valid(runtimeVersion)) throw new Error('--runtime-version must be valid SemVer')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(runtimeId)) {
  throw new Error('--id contains unsupported characters')
}
const baseUrl = new URL(artifactBaseUrl)
if (baseUrl.protocol !== 'https:') throw new Error('--artifact-base-url must use HTTPS')

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const sdkVersion =
  option('sdk-version') ?? rootPackage.dependencies?.['@oh-my-pi/pi-coding-agent']
const minAppVersion = option('min-app-version') ?? rootPackage.version
const bunVersionSource = await readFile(path.join(root, 'src/main/bun.ts'), 'utf8')
const bunVersion = bunVersionSource.match(/BUN_VERSION = '([^']+)'/)?.[1]
if (
  typeof sdkVersion !== 'string' ||
  !valid(sdkVersion) ||
  typeof bunVersion !== 'string' ||
  typeof minAppVersion !== 'string' ||
  !valid(minAppVersion)
) {
  throw new Error('Unable to resolve pinned SDK or Bun version')
}
const nativePackage = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`
const supportedNativePackages = new Set([
  '@oh-my-pi/pi-natives-darwin-arm64',
  '@oh-my-pi/pi-natives-darwin-x64',
  '@oh-my-pi/pi-natives-linux-arm64',
  '@oh-my-pi/pi-natives-linux-x64',
  '@oh-my-pi/pi-natives-win32-x64'
])
if (!supportedNativePackages.has(nativePackage)) {
  throw new Error(`Unsupported Runtime target: ${process.platform}-${process.arch}`)
}

const workPath = await mkdtemp(path.join(tmpdir(), 'ompilot-runtime-build-'))
const packagePath = path.join(workPath, 'package')
const artifactName = `${runtimeId}.tgz`
const artifactPath = path.join(outputPath, artifactName)

try {
  await mkdir(path.join(packagePath, 'bin'), { recursive: true })
  await mkdir(path.join(packagePath, 'workers'), { recursive: true })
  await mkdir(path.join(packagePath, 'extensions'), { recursive: true })
  await mkdir(outputPath, { recursive: true })

  const runtimePackage = {
    private: true,
    dependencies: {
      '@oh-my-pi/pi-agent-core': sdkVersion,
      '@oh-my-pi/pi-ai': sdkVersion,
      '@oh-my-pi/pi-coding-agent': sdkVersion,
      [nativePackage]: sdkVersion,
      '@oh-my-pi/pi-utils': sdkVersion
    }
  }
  await writeFile(
    path.join(packagePath, 'package.json'),
    JSON.stringify(runtimePackage, null, 2) + '\n'
  )
  await run(
    'npm',
    [
      'install',
      '--omit=dev',
      '--omit=optional',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false'
    ],
    { cwd: packagePath, maxBuffer: 10 * 1024 * 1024 }
  )

  const bunSource = path.join(
    root,
    'node_modules',
    '.cache',
    'bun',
    bunVersion,
    'bun'
  )
  const bunTarget = path.join(packagePath, 'bin', 'bun')
  await copyFile(bunSource, bunTarget)
  await chmod(bunTarget, 0o755)

  const workerFiles = [
    'sdk-worker.ts',
    'config-worker.ts',
    'runtime-probe.ts',
    'frame-interceptor.ts',
    'mcp-status.ts'
  ]
  await Promise.all(
    workerFiles.map((file) =>
      copyFile(path.join(root, 'src', 'worker', file), path.join(packagePath, 'workers', file))
    )
  )
  await cp(
    path.join(root, 'src', 'main', 'ompilot-tree-extension.mjs'),
    path.join(packagePath, 'extensions', 'session-tree.mjs')
  )

  const manifest = {
    schemaVersion: 1,
    id: runtimeId,
    sequence,
    runtimeVersion,
    sdkVersion,
    bunVersion,
    platform: process.platform,
    arch: process.arch,
    hostProtocol: { min: 1, max: 1 },
    entrypoints: {
      bun: 'bin/bun',
      agentWorker: 'workers/sdk-worker.ts',
      configWorker: 'workers/config-worker.ts',
      probe: 'workers/runtime-probe.ts',
      interceptor: 'workers/frame-interceptor.ts',
      mcpStatus: 'workers/mcp-status.ts',
      treeExtension: 'extensions/session-tree.mjs'
    }
  }
  await writeFile(
    path.join(packagePath, 'runtime.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  )

  await create(
    {
      cwd: packagePath,
      file: artifactPath,
      gzip: true,
      portable: true
    },
    ['runtime.json', 'bin', 'workers', 'extensions', 'node_modules']
  )
  const artifact = await readFile(artifactPath)
  const artifactInfo = await stat(artifactPath)
  const release = {
    id: runtimeId,
    sequence,
    runtimeVersion,
    sdkVersion,
    bunVersion,
    platform: process.platform,
    arch: process.arch,
    minAppVersion,
    publishedAt: new Date().toISOString(),
    hostProtocol: manifest.hostProtocol,
    artifact: {
      url: `${artifactBaseUrl}/${artifactName}`,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      size: artifactInfo.size
    }
  }
  const releasePath = path.join(outputPath, `${runtimeId}.release.json`)
  await writeFile(releasePath, JSON.stringify(release, null, 2) + '\n')
  process.stdout.write(`${artifactPath}\n${releasePath}\n`)
} finally {
  await rm(workPath, { recursive: true, force: true })
}

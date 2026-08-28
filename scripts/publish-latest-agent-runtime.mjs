import { execFile } from 'node:child_process'
import {
  createPrivateKey,
  createPublicKey,
  verify
} from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const packageName = '@oh-my-pi/pi-coding-agent'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : null
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function publicKeysFromPackage(pkg) {
  const config = object(pkg.ompilotRuntimeUpdates)
  const values = Array.isArray(config?.trustedKeys) ? config.trustedKeys : []
  return values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) =>
      createPublicKey({
        key: Buffer.from(value, 'base64'),
        format: 'der',
        type: 'spki'
      })
    )
}

function verifyIndex(raw, trustedKeys) {
  const envelope = object(JSON.parse(raw))
  if (
    envelope?.schemaVersion !== 1 ||
    typeof envelope.payload !== 'string' ||
    !Array.isArray(envelope.signatures)
  ) {
    throw new Error('Published Runtime index has an invalid envelope')
  }
  const payload = Buffer.from(envelope.payload, 'base64')
  const signatures = envelope.signatures
    .filter((value) => typeof value === 'string')
    .map((value) => Buffer.from(value, 'base64'))
  if (
    !trustedKeys.some((key) =>
      signatures.some((signature) => verify(null, payload, key, signature))
    )
  ) {
    throw new Error('Published Runtime index signature is not trusted')
  }
  const index = object(JSON.parse(payload.toString('utf8')))
  if (index?.schemaVersion !== 1 || !Array.isArray(index.releases)) {
    throw new Error('Published Runtime index payload is invalid')
  }
  return index.releases
}

async function readPublishedReleases(indexUrl, trustedKeys) {
  const response = await fetch(indexUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Unable to download current Runtime index: HTTP ${response.status}`)
  }
  return verifyIndex(await response.text(), trustedKeys)
}

async function command(command, args, options = {}) {
  const result = await run(command, args, {
    cwd: root,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    ...options
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const updateConfig = object(pkg.ompilotRuntimeUpdates)
const indexUrl = option('index-url') ?? updateConfig?.indexUrl
const releaseRepo = option('repo') ?? 'pikez/ompilot-runtime'
const npmTag = option('npm-tag') ?? 'latest'
const dryRun = flag('dry-run')
const force = flag('force')
if (typeof indexUrl !== 'string' || !indexUrl.startsWith('https://')) {
  throw new Error('A trusted HTTPS Runtime index URL is required')
}

const trustedKeys = publicKeysFromPackage(pkg)
if (trustedKeys.length === 0) throw new Error('No trusted Runtime public keys are configured')

const npmResult = await run(
  'npm',
  ['view', packageName, `dist-tags.${npmTag}`, '--json'],
  { cwd: root, maxBuffer: 1024 * 1024 }
)
const sdkVersion = JSON.parse(npmResult.stdout)
if (typeof sdkVersion !== 'string' || !valid(sdkVersion)) {
  throw new Error(`npm returned an invalid ${packageName} version`)
}

const existingReleases = await readPublishedReleases(indexUrl, trustedKeys)
const alreadyPublished = existingReleases.some(
  (release) =>
    object(release)?.sdkVersion === sdkVersion &&
    object(release)?.platform === process.platform &&
    object(release)?.arch === process.arch
)
if (alreadyPublished && !force) {
  process.stdout.write(
    `No release needed: ${packageName}@${sdkVersion} is already published for ${process.platform}-${process.arch}\n`
  )
  process.exit(0)
}

const encodedPrivateKey = process.env['OMPILOT_RUNTIME_SIGNING_KEY']
if (!encodedPrivateKey) {
  throw new Error('OMPILOT_RUNTIME_SIGNING_KEY is required')
}
const privateKey = createPrivateKey({
  key: Buffer.from(encodedPrivateKey, 'base64'),
  format: 'der',
  type: 'pkcs8'
})
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('OMPILOT_RUNTIME_SIGNING_KEY must be an Ed25519 key')
}
const signingPublicKey = createPublicKey(privateKey).export({
  format: 'der',
  type: 'spki'
})
if (
  !trustedKeys.some((key) =>
    key.export({ format: 'der', type: 'spki' }).equals(signingPublicKey)
  )
) {
  throw new Error('The signing key does not match any public key trusted by Ompilot')
}

const highestSequence = existingReleases.reduce((highest, release) => {
  const sequence = object(release)?.sequence
  return typeof sequence === 'number' && Number.isSafeInteger(sequence)
    ? Math.max(highest, sequence)
    : highest
}, 0)
const sequence = highestSequence + 1
const runtimeId = `runtime-${sequence}-${process.platform}-${process.arch}`
const releaseTag = option('release-tag') ?? `runtime-v${sequence}`
const artifactBaseUrl = `https://github.com/${releaseRepo}/releases/download/${releaseTag}`
const workPath = await mkdtemp(path.join(tmpdir(), 'ompilot-runtime-publish-'))

try {
  await command('node', [
    'scripts/build-agent-runtime.mjs',
    '--sequence',
    String(sequence),
    '--runtime-version',
    sdkVersion,
    '--sdk-version',
    sdkVersion,
    '--artifact-base-url',
    artifactBaseUrl,
    '--output',
    workPath,
    '--id',
    runtimeId
  ])

  const artifactPath = path.join(workPath, `${runtimeId}.tgz`)
  const releasePath = path.join(workPath, `${runtimeId}.release.json`)
  await command('node', [
    'scripts/test-agent-runtime-artifact.mjs',
    '--archive',
    artifactPath
  ])

  const existingPaths = []
  for (const releaseValue of existingReleases) {
    const release = object(releaseValue)
    if (!release || release.id === runtimeId) continue
    const existingPath = path.join(workPath, `existing-${existingPaths.length}.release.json`)
    await writeFile(existingPath, JSON.stringify(release, null, 2) + '\n')
    existingPaths.push(existingPath)
  }
  const indexPath = path.join(workPath, 'runtime-index.json')
  await command('node', [
    'scripts/sign-agent-runtime-index.mjs',
    indexPath,
    ...existingPaths,
    releasePath
  ])

  const signedIndex = await readFile(indexPath, 'utf8')
  const signedReleases = verifyIndex(signedIndex, trustedKeys)
  if (!signedReleases.some((release) => object(release)?.id === runtimeId)) {
    throw new Error('Signed Runtime index does not contain the candidate release')
  }

  if (dryRun) {
    process.stdout.write(
      `DRY RUN: ${runtimeId} (${sdkVersion}) passed build, probe, RPC contract, and signature verification\n`
    )
  } else {
    await command('gh', ['auth', 'status'])
    await command('gh', [
      'release',
      'create',
      releaseTag,
      '--repo',
      releaseRepo,
      artifactPath,
      indexPath,
      '--title',
      `Ompilot Agent Runtime ${sdkVersion}`,
      '--notes',
      [
        `Automated Agent Runtime release.`,
        ``,
        `- Runtime sequence: ${sequence}`,
        `- OMP SDK: ${sdkVersion}`,
        `- Platform: ${process.platform} ${process.arch}`,
        `- Host protocol: 1`
      ].join('\n'),
      '--latest'
    ])

    const publishedReleases = await readPublishedReleases(
      `${artifactBaseUrl}/runtime-index.json`,
      trustedKeys
    )
    if (!publishedReleases.some((release) => object(release)?.id === runtimeId)) {
      throw new Error('Published latest Runtime index does not contain the new release')
    }
    process.stdout.write(
      `Published ${runtimeId}: https://github.com/${releaseRepo}/releases/tag/${releaseTag}\n`
    )
  }
} finally {
  await rm(workPath, { recursive: true, force: true })
}

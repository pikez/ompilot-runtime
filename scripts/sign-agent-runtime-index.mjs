import { createPrivateKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputIndex = process.argv[2]
const releasePaths = process.argv.slice(3)
if (!outputIndex || releasePaths.length === 0) {
  throw new Error(
    'usage: node scripts/sign-agent-runtime-index.mjs <index.json> <release.json>...'
  )
}

const encodedPrivateKey = process.env['OMPILOT_RUNTIME_SIGNING_KEY']
if (!encodedPrivateKey) {
  throw new Error('OMPILOT_RUNTIME_SIGNING_KEY must contain a Base64 PKCS8 Ed25519 private key')
}

let privateKey
try {
  privateKey = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
} catch {
  throw new Error('OMPILOT_RUNTIME_SIGNING_KEY is not a valid PKCS8 private key')
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('OMPILOT_RUNTIME_SIGNING_KEY must be an Ed25519 key')
}

const releases = await Promise.all(
  releasePaths.map(async (releasePath) => {
    const raw = await readFile(path.resolve(releasePath), 'utf8')
    return JSON.parse(raw)
  })
)
releases.sort((left, right) => Number(right.sequence) - Number(left.sequence))

const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releases
  })
)
const envelope = {
  schemaVersion: 1,
  payload: payload.toString('base64'),
  signatures: [sign(null, payload, privateKey).toString('base64')]
}
await writeFile(path.resolve(outputIndex), JSON.stringify(envelope, null, 2) + '\n')
process.stdout.write(`${path.resolve(outputIndex)}\n`)

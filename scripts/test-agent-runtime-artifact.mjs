import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extract } from 'tar'

const archiveArgIndex = process.argv.indexOf('--archive')
const archivePath =
  archiveArgIndex >= 0 && process.argv[archiveArgIndex + 1]
    ? path.resolve(process.argv[archiveArgIndex + 1])
    : null
if (!archivePath) {
  throw new Error('usage: node scripts/test-agent-runtime-artifact.mjs --archive <runtime.tgz>')
}

const root = await mkdtemp(path.join(tmpdir(), 'ompilot-runtime-contract-'))
const runtimePath = path.join(root, 'runtime')
const homePath = path.join(root, 'home')
const cwdPath = path.join(root, 'workspace')

class JsonLineClient {
  constructor(command, args, options) {
    this.buffer = ''
    this.frames = []
    this.waiters = []
    this.stderr = ''
    this.child = spawn(command, args, options)
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-64 * 1024)
    })
    this.exit = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        const result = { code, signal }
        for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(JSON.stringify(result)))
        resolve(result)
      })
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trimEnd()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        throw new Error(`Runtime stdout contained a non-JSON line: ${line.slice(0, 200)}`)
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame))
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      } else {
        this.frames.push(frame)
      }
    }
  }

  waitFor(predicate, timeoutMs = 60_000) {
    const queuedIndex = this.frames.findIndex(predicate)
    if (queuedIndex >= 0) return Promise.resolve(this.frames.splice(queuedIndex, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error(`Runtime frame timeout: ${this.stderr.slice(-500)}`))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  send(frame) {
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  async command(type, data = {}) {
    const id = `contract_${Date.now()}_${Math.random()}`
    this.send({ id, type, ...data })
    const response = await this.waitFor((frame) => frame.type === 'response' && frame.id === id)
    assert.equal(response.success, true, `${type} failed: ${response.error ?? this.stderr}`)
    return response.data
  }

  async close() {
    this.child.stdin.end()
    const result = await Promise.race([
      this.exit,
      new Promise((resolve) =>
        setTimeout(() => {
          this.child.kill('SIGTERM')
          resolve({ code: null, signal: 'timeout' })
        }, 10_000)
      )
    ])
    assert.notEqual(result.signal, 'timeout', `Runtime did not stop after stdin EOF: ${this.stderr}`)
  }
}

try {
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
    mkdir(cwdPath, { recursive: true })
  ])
  await extract({ cwd: runtimePath, file: archivePath, gzip: true })
  const manifest = JSON.parse(await readFile(path.join(runtimePath, 'runtime.json'), 'utf8'))
  const entrypoints = manifest.entrypoints
  const bunPath = path.join(runtimePath, entrypoints.bun)
  await chmod(bunPath, 0o755)
  const env = {
    ...process.env,
    HOME: homePath,
    PI_NOTIFICATIONS: 'off',
    OMP_WORKER_INTERCEPTOR: path.join(runtimePath, entrypoints.interceptor),
    OMP_WORKER_MCP_STATUS: path.join(runtimePath, entrypoints.mcpStatus)
  }

  const probe = new JsonLineClient(
    bunPath,
    [path.join(runtimePath, entrypoints.probe)],
    { cwd: runtimePath, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const probeLine = await probe.waitFor((frame) => frame.ok === true)
  assert.equal(probeLine.bunVersion, manifest.bunVersion)
  await probe.exit

  const agent = new JsonLineClient(
    bunPath,
    [
      path.join(runtimePath, entrypoints.agentWorker),
      '--mode',
      'ephemeral',
      '--extension',
      path.join(runtimePath, entrypoints.treeExtension)
    ],
    { cwd: cwdPath, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const ready = await agent.waitFor((frame) => frame.type === 'ready')
  assert.ok(ready.supportedProtocolVersions.includes(2), 'Runtime must support RPC v2')
  await agent.command('negotiate_protocol', { protocolVersion: 2 })
  const state = await agent.command('get_state')
  assert.ok(state && typeof state === 'object', 'get_state must return an object')
  const commands = await agent.command('get_available_commands')
  assert.ok(Array.isArray(commands?.commands), 'get_available_commands must return commands')
  await agent.command('get_session_stats')
  await agent.command('get_queued_messages')
  await agent.command('get_runs_snapshot')
  await agent.command('set_configured_thinking_level', { level: 'low' })
  await agent.close()

  const config = new JsonLineClient(
    bunPath,
    [path.join(runtimePath, entrypoints.configWorker)],
    { cwd: runtimePath, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  await config.waitFor((frame) => frame.type === 'ready')
  const overview = await config.command('command', {
    command: 'overview',
    data: null
  })
  assert.ok(overview && typeof overview === 'object', 'config overview must return an object')
  config.child.kill('SIGTERM')
  await config.exit

  process.stdout.write(
    `PASS Agent Runtime artifact contract (${manifest.sdkVersion}, ${manifest.platform}-${manifest.arch})\n`
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

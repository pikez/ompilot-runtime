/**
 * Ompilot config worker — Bun SDK 直驱 provider 凭证管理(设置页「提供商」区块)。
 *
 * 与 agent worker 分开:凭证操作不应进入 AgentSession 回合,也不需要
 * runRpcMode 的 RPC wire。本 worker 是独立进程,stdin/stdout 走 JSON-lines
 * 帧协议,进程生命周期由 src/main/config-worker.ts 负责(懒启动 + 5 分钟
 * 空闲回收 + 崩溃 failAll)。
 *
 * 帧协议:
 *  - worker → main:`{type:'ready'}`;`{id, type:'response', success, data|error, code?}`
 *    (命令响应);`{type:'event', event, flowId, provider, ...}`(OAuth 流程事件)。
 *  - main → worker:`{id, type:'command', command, data}`;`{type:'prompt_response', flowId, value}`;
 *    `{type:'oauth_cancel', flowId}`。
 *
 * 日志只走 stderr;stdout 除帧外不得有任何输出。
 */

// 1. 先关终端通知:它们写 BEL/OSC 到 stdout 会污染帧流。
process.env.PI_NOTIFICATIONS = 'off'

import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { getAgentDbPath, getAgentDir } from '@oh-my-pi/pi-utils'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
  getOAuthProviders,
  listProvidersWithEnvKey
} from '@oh-my-pi/pi-ai'
import { ModelRegistry, Settings, discoverAuthStorage } from '@oh-my-pi/pi-coding-agent'
import type { ThinkingEffort } from '../shared/types'

function emitFrame(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function emitResponse(id: string, data: unknown): void {
  emitFrame({ id, type: 'response', success: true, data })
}

function emitError(id: string, error: unknown, code?: string): void {
  const frame: Record<string, unknown> = {
    id,
    type: 'response',
    success: false,
    error: error instanceof Error ? error.message : String(error)
  }
  if (code) frame.code = code
  emitFrame(frame)
}

/** OAuth 流程事件统一出口(flowId 让 main 侧把事件路由回对应对话框)。 */
function emitEvent(event: string, flowId: string, provider: string, data: Record<string, unknown>): void {
  emitFrame({ type: 'event', event, flowId, provider, ...data })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** prompt 等待表(oauth_prompt 事件发出后,等 main 侧 prompt_response 帧)。 */
const pendingPrompts = new Map<string, (value: string) => void>()
/** 进行中的 OAuth 登录流(oauth_cancel 帧 abort 对应 controller)。 */
const activeFlows = new Map<string, AbortController>()
/** 启动时的后台目录刷新;overview 在目录为空时 await 它,让重试真正生效。 */
let refreshPromise: Promise<void> | null = null

interface OverviewProviderEntry {
  id: string
  name: string
  supportsApiKey: boolean
  supportsOAuth: boolean
  oauthAvailable: boolean
  origin: { kind: string; envVar?: string } | null
  stored: Array<{ id: number; type: string; identity: string | null; source?: string }>
}

interface OverviewModelEntry {
  provider: string
  id: string
  name: string
  reasoning: boolean
  thinking: { efforts: ThinkingEffort[] } | null
  input: string[]
}

function toOverviewModelEntry(model: {
  provider: string
  id: string
  name?: string
  reasoning?: boolean
  thinking?: unknown
  input?: unknown
}): OverviewModelEntry {
  const efforts: ThinkingEffort[] = []
  if (model.thinking && typeof model.thinking === 'object' && 'efforts' in model.thinking) {
    const values = model.thinking.efforts
    if (Array.isArray(values)) {
      for (const value of values) {
        if (
          (value === 'minimal' ||
            value === 'low' ||
            value === 'medium' ||
            value === 'high' ||
            value === 'xhigh' ||
            value === 'max') &&
          !efforts.includes(value)
        ) {
          efforts.push(value)
        }
      }
    }
  }
  const input: string[] = []
  if (Array.isArray(model.input)) {
    for (const value of model.input) {
      if (typeof value === 'string') input.push(value)
    }
  }
  if (input.length === 0) input.push('text')
  const reasoning = model.reasoning === true
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning,
    thinking: reasoning && efforts.length > 0 ? { efforts } : null,
    input
  }
}

async function buildOverview(
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry
): Promise<{ providers: OverviewProviderEntry[]; models: OverviewModelEntry[] }> {
  // 首次 overview 可能早于后台 refresh 完成:空目录时等待刷新结果再读一次。
  if (modelRegistry.getAvailable().length === 0 && refreshPromise) {
    await refreshPromise.catch(() => {})
  }
  const oauthProviders = getOAuthProviders()
  const envKeyProviders = new Set(listProvidersWithEnvKey())
  const catalogProviders = modelRegistry.getDiscoverableProviders()
  // disabledCause 非 null 的行已被生态禁用,不展示。
  const stored = authStorage.listStoredCredentials().filter((row) => row.disabledCause === null)

  // provider 并集;display id 以 storeCredentialsAs 归一(凭证存于该 id 下)。
  const providers = new Map<string, OverviewProviderEntry>()
  for (const p of oauthProviders) {
    const id = p.storeCredentialsAs ?? p.id
    providers.set(id, {
      id,
      name: p.name,
      supportsApiKey: false,
      supportsOAuth: true,
      oauthAvailable: p.available,
      origin: null,
      stored: []
    })
  }
  for (const id of envKeyProviders) {
    const existing = providers.get(id)
    if (existing) {
      existing.supportsApiKey = true
    } else {
      providers.set(id, {
        id,
        name: id,
        supportsApiKey: true,
        supportsOAuth: false,
        oauthAvailable: false,
        origin: null,
        stored: []
      })
    }
  }
  for (const id of catalogProviders) {
    if (!providers.has(id)) {
      providers.set(id, {
        id,
        name: id,
        supportsApiKey: false,
        supportsOAuth: false,
        oauthAvailable: false,
        origin: null,
        stored: []
      })
    }
  }

  for (const entry of providers.values()) {
    const origin = authStorage.getCredentialOrigin(entry.id)
    if (origin) {
      entry.origin = { kind: origin.kind, ...(origin.envVar ? { envVar: origin.envVar } : {}) }
    }
    entry.stored = stored
      .filter((row) => row.provider === entry.id)
      .map((row) => {
        const credential = row.credential
        if (credential.type === 'api_key') {
          return {
            id: row.id,
            type: 'api_key' as const,
            identity: null,
            ...(credential.source ? { source: credential.source } : {})
          }
        }
        let identity: string | null = null
        try {
          const account = authStorage.getOAuthAccountIdentity(entry.id)
          if (account) {
            const parts = [account.orgName, account.email, account.accountId].filter(
              (part): part is string => typeof part === 'string' && part.length > 0
            )
            if (parts.length > 0) identity = parts.join(' · ')
          }
        } catch {
          identity = null
        }
        if (!identity) {
          const parts = [credential.orgName, credential.email, credential.accountId].filter(
            (part): part is string => typeof part === 'string' && part.length > 0
          )
          identity = parts.length > 0 ? parts.join(' · ') : null
        }
        return { id: row.id, type: 'oauth' as const, identity }
      })
  }

  const models = modelRegistry.getAvailable().map((model) => toOverviewModelEntry(model))
  return { providers: [...providers.values()], models }
}

async function addApiKey(
  authStorage: AuthStorage,
  settings: Settings,
  agentDir: string,
  data: unknown
): Promise<unknown> {
  if (!isRecord(data) || typeof data.provider !== 'string' || data.provider.length === 0) {
    throw new Error('无效参数')
  }
  if (typeof data.key !== 'string' || data.key.length === 0) {
    throw new Error('API Key 不能为空')
  }
  const brokerUrl = process.env.OMP_AUTH_BROKER_URL || settings.get('auth.broker.url')
  if (typeof brokerUrl === 'string' && brokerUrl.length > 0) {
    // broker 模式:远端存储,AuthStorage.set 走 remote store(防御性路径,默认不用)。
    await authStorage.set(data.provider, { type: 'api_key', key: data.key, source: 'login' })
  } else {
    // 本地模式:直接写 agent.db(与 omp CLI login 同源同语义),再刷新进程内快照。
    const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir))
    store.upsertAuthCredentialForProvider(data.provider, { type: 'api_key', key: data.key, source: 'login' })
    await authStorage.reload()
  }
  return { provider: data.provider }
}

function formatLoginIdentity(identity: { type: 'oauth' | 'api_key'; email?: string; accountId?: string; orgId?: string; orgName?: string }): string | null {
  const parts = [identity.orgName, identity.email, identity.accountId, identity.orgId].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  )
  return parts.length > 0 ? parts.join(' · ') : null
}

async function oauthLogin(authStorage: AuthStorage, data: unknown): Promise<unknown> {
  if (!isRecord(data) || typeof data.provider !== 'string' || data.provider.length === 0) {
    throw new Error('无效参数')
  }
  const provider = data.provider
  const flowId = randomUUID()
  const ctrl = new AbortController()
  activeFlows.set(flowId, ctrl)
  try {
    emitEvent('oauth_progress', flowId, provider, { message: '正在准备登录流程...' })
    const identity = await authStorage.login(provider, {
      onAuth: (info) =>
        emitEvent('oauth_url', flowId, provider, {
          url: info.url,
          ...(info.launchUrl ? { launchUrl: info.launchUrl } : {}),
          ...(info.instructions ? { instructions: info.instructions } : {})
        }),
      onProgress: (message) => emitEvent('oauth_progress', flowId, provider, { message }),
      onPrompt: (prompt) => {
        emitEvent('oauth_prompt', flowId, provider, {
          message: prompt.message,
          ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})
        })
        return new Promise<string>((resolve) => {
          pendingPrompts.set(flowId, resolve)
        })
      },
      signal: ctrl.signal
    })
    emitEvent('oauth_done', flowId, provider, { identity: identity ? formatLoginIdentity(identity) : null })
    return { provider }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw Object.assign(new Error('已取消'), { code: 'cancelled' })
    }
    throw err
  } finally {
    activeFlows.delete(flowId)
    pendingPrompts.delete(flowId)
  }
}

async function removeCredential(authStorage: AuthStorage, data: unknown): Promise<unknown> {
  if (!isRecord(data) || typeof data.provider !== 'string' || data.provider.length === 0) {
    throw new Error('无效参数')
  }
  if (typeof data.credentialId === 'number') {
    const removed = await authStorage.removeCredential(data.provider, data.credentialId)
    if (!removed) throw new Error('凭证不存在')
  } else if (data.credentialId === undefined || data.credentialId === null) {
    // 登出 = 删除该 provider 全部凭证。
    await authStorage.logout(data.provider)
  } else {
    throw new Error('无效参数')
  }
  return {}
}

async function handleCommand(
  authStorage: AuthStorage,
  settings: Settings,
  modelRegistry: ModelRegistry,
  agentDir: string,
  command: string,
  data: unknown
): Promise<unknown> {
  switch (command) {
    case 'overview':
      return buildOverview(authStorage, modelRegistry)
    case 'add_api_key':
      return addApiKey(authStorage, settings, agentDir, data)
    case 'oauth_login':
      return oauthLogin(authStorage, data)
    case 'remove_credential':
      return removeCredential(authStorage, data)
    default:
      throw new Error(`未知命令: ${command}`)
  }
}

async function main(): Promise<void> {
  const agentDir = getAgentDir()
  const settings = await Settings.init({ cwd: agentDir, agentDir })
  const authStorage = await discoverAuthStorage(agentDir)
  const modelRegistry = new ModelRegistry(authStorage)
  // 后台刷新目录(与 sdk-worker 一致);首次可能未完成,overview 返回空目录,UI 可重试。
  refreshPromise = modelRegistry.refresh('online-if-uncached').catch(() => {})

  emitFrame({ type: 'ready' })

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(frame)) continue
    if (frame.type === 'command') {
      if (
        typeof frame.id !== 'string' ||
        typeof frame.command !== 'string'
      ) {
        continue
      }
      const id = frame.id
      const command = frame.command
      const data = frame.data
      void handleCommand(authStorage, settings, modelRegistry, agentDir, command, data)
        .then((result) => emitResponse(id, result))
        .catch((err: unknown) => {
          const code = isRecord(err) && typeof err.code === 'string' ? err.code : undefined
          emitError(id, err, code)
        })
      continue
    }
    if (frame.type === 'prompt_response') {
      if (typeof frame.flowId === 'string' && typeof frame.value === 'string') {
        const resolve = pendingPrompts.get(frame.flowId)
        if (resolve) {
          pendingPrompts.delete(frame.flowId)
          resolve(frame.value)
        }
      }
      continue
    }
    if (frame.type === 'oauth_cancel') {
      if (typeof frame.flowId === 'string') {
        activeFlows.get(frame.flowId)?.abort()
      }
    }
  }
}

main().catch((err) => {
  console.error('[config-worker] fatal:', err)
  process.exit(1)
})

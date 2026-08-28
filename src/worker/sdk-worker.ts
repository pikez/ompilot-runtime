/**
 * Ompilot agent worker — Bun SDK 直驱(`@oh-my-pi/pi-coding-agent`)。
 *
 * Per-session Bun SDK worker: createAgentSession + runRpcMode 输出 OMP RPC
 * wire 帧(main 的 framing/池/回收/reconnect 骨架复用该 wire 契约)。
 * runRpcMode 内部完成 v2 协商、`ready` 帧、RpcFrameEncoder 大帧分块、全部 RPC
 * 命令 dispatch 与事件转发。
 *
 * 契约:
 * - stdout 只允许帧;一切日志走 stderr。
 * - stdin EOF(main stopGracefully 的 stdin.end())→ runRpcMode 返回 →
 *   内部 dispose + exit 0(见 rpc-mode.ts stdin-EOF 收尾)。
 * - Worker CLI:`--mode <draft|resume|fork|ephemeral|side-chat> [--session <path>]
 *   [--system-prompt <text>] [--extension <path>...]`;未知参数 exit 2。
 *
 * 初始化顺序是关键:先关通知、先声称 stdin,再组装运行时,防止扩展发现等模块抢 stdin。
 */

// 1. 先关终端通知:它们写 BEL/OSC 到 stdout 会污染帧流(runRpcMode 自己也会设,
//    但必须在此尽早设,避免任何早期模块写通知)。
process.env.PI_NOTIFICATIONS = 'off'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { claimRpcInput } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input'
import { runRpcMode } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode'
import { computeContextBreakdown } from '@oh-my-pi/pi-coding-agent/modes/utils/context-usage'
import { EventBus } from '@oh-my-pi/pi-coding-agent/utils/event-bus'
import {
  AgentRegistry,
  createAgentSession,
  discoverAuthStorage,
  getAgentDir,
  MAIN_AGENT_ID,
  ModelRegistry,
  SessionManager,
  Settings,
  type CreateAgentSessionOptions
} from '@oh-my-pi/pi-coding-agent'
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from '@oh-my-pi/pi-coding-agent/session/messages'
import { readPlanFile } from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import { createMCPProxyTools, createSubagentSettings } from '@oh-my-pi/pi-coding-agent/task/executor'
import { USER_TODO_EDIT_CUSTOM_TYPE } from '@oh-my-pi/pi-coding-agent/tools/todo'
import {
  isHiddenUserCompanion,
  isUserQueuedMessage,
  queueChipText
} from '@oh-my-pi/pi-coding-agent/session/queued-messages'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { PlanApprovalDetails } from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import { ThinkingLevel as AgentThinkingLevel, type AgentMessage, type AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { FrameInterceptor } from './frame-interceptor.ts'
import type {
  McpServerStatusEntry,
  SessionQueueMessage,
  SessionQueueSnapshot,
  SessionContextBreakdown,
  SessionContextCategoryId,
  RunListItem,
  RunMetrics,
  RunStatus
} from '../shared/types'

// 2. 立刻声称 stdin 单例(先于扩展发现等任何可能抢 stdin 的模块)。
const claimedInput = claimRpcInput()

const VALID_MODES = ['draft', 'resume', 'fork', 'ephemeral', 'side-chat'] as const
type WorkerMode = (typeof VALID_MODES)[number]

interface WorkerArgs {
  mode: WorkerMode | null
  session: string | null
  systemPrompt: string | null
  extensions: string[]
}

function failUsage(message: string): never {
  process.stderr.write(`[sdk-worker] ${message}\n`)
  process.stderr.write(
    '[sdk-worker] usage: --mode <draft|resume|fork|ephemeral|side-chat> ' +
      '[--session <path>] [--system-prompt <text>] [--extension <path>...]\n'
  )
  process.exit(2)
}


const queuedMessageIds = new WeakMap<object, string>()
let nextQueuedMessageId = 0

function queueIdFor(message: AgentMessage): string {
  const existing = queuedMessageIds.get(message)
  if (existing) return existing
  const id = `queue_${++nextQueuedMessageId}`
  queuedMessageIds.set(message, id)
  return id
}

function imageCountFor(message: AgentMessage): number {
  if (!('content' in message) || typeof message.content === 'string') return 0
  return message.content.filter((part) => part.type === 'image').length
}

function queueEntries(session: AgentSession, mode: SessionQueueMessage['mode']): SessionQueueMessage[] {
  const messages = mode === 'steer' ? session.agent.peekSteeringQueue() : session.agent.peekFollowUpQueue()
  const entries: SessionQueueMessage[] = []
  for (const message of messages) {
    if (!isUserQueuedMessage(message)) continue
    entries.push({
      id: queueIdFor(message),
      mode,
      text: queueChipText(message),
      imageCount: imageCountFor(message)
    })
  }
  return entries
}

function readSessionQueue(session: AgentSession): SessionQueueSnapshot {
  return {
    steering: queueEntries(session, 'steer'),
    followUp: queueEntries(session, 'followUp')
  }
}

function queueError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function promoteQueuedMessage(session: AgentSession, queueId: string): SessionQueueSnapshot {
  if (!session.isStreaming) {
    throw queueError('会话当前没有运行中的回合', 'queue_not_active')
  }
  const steering = [...session.agent.peekSteeringQueue()]
  const followUp = [...session.agent.peekFollowUpQueue()]
  const targetIndex = followUp.findIndex(
    (message) => isUserQueuedMessage(message) && queueIdFor(message) === queueId
  )
  if (targetIndex < 0) {
    throw queueError('排队消息已不存在,请刷新后重试', 'queue_message_not_found')
  }

  // OMP places hidden keyword/image companions immediately before their user
  // message. Move them together so the promoted prompt keeps its semantics.
  let start = targetIndex
  while (start > 0 && isHiddenUserCompanion(followUp[start - 1])) start -= 1
  const promoted = followUp.slice(start, targetIndex + 1)
  const remaining = [...followUp.slice(0, start), ...followUp.slice(targetIndex + 1)]
  session.agent.replaceQueues([...steering, ...promoted], remaining)
  return readSessionQueue(session)
}

function branchError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function canSwitchSessionBranch(session: AgentSession, entryId: string): boolean {
  const entry = session.sessionManager.getEntry(entryId)
  if (!entry) return false
  if (entry.type === 'branch_summary' || entry.type === 'compaction') return true
  if (entry.type !== 'message' || entry.message.role === 'user') return false
  return !(entry.message.role === 'toolResult' && entry.message.toolName === 'ask')
}

// ---- Native plan review gate -----------------------------------------------

const PLAN_REVIEW_TIMEOUT_MS = 5 * 60_000
const PLAN_CONTENT_MAX_BYTES = 512 * 1024
const DEFAULT_PLAN_FILE_PATH = 'local://PLAN.md'
const SESSION_TREE_CURSOR_TYPE = 'com.ompilot.session-tree-cursor'
const SESSION_ENTRY_ID_PATTERN = /^[a-f0-9]{8}$/i
const TAN_CONTEXT_SWITCH_PROMPT = `<system-notice cause="fork">
Above conversation: parent session.
Fork solely handles user's request below.
Parent still working original task; no responsibility or obligations from prior conversation.

- MUST focus EXCLUSIVELY on immediate user request; nothing else.
- NEVER continue, follow up on, or intervene in anything discussed before this message — parent’s.
- Parent concurrently edits this working directory. Files MAY change between reads, appear mid-refactor, or fail to compile. Parent's live work: NEVER fix, audit, or build on it, even if broken.
- Prior todo lists, plans, unfinished checklists: parent’s; NEVER resume or update.
- After request: STOP. NEVER work on ANY OTHER TASK.
</system-notice>`
const SDK_THINKING_LEVELS = {
  minimal: AgentThinkingLevel.Minimal,
  low: AgentThinkingLevel.Low,
  medium: AgentThinkingLevel.Medium,
  high: AgentThinkingLevel.High,
  xhigh: AgentThinkingLevel.XHigh,
  max: AgentThinkingLevel.Max
} as const

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}

function contextCategoryId(value: string): SessionContextCategoryId | null {
  if (
    value === 'systemPrompt' ||
    value === 'systemTools' ||
    value === 'systemContext' ||
    value === 'skills' ||
    value === 'messages'
  ) {
    return value
  }
  return null
}

function readSessionContextBreakdown(session: AgentSession): SessionContextBreakdown {
  const breakdown = computeContextBreakdown(session)
  const contextWindow = finiteNumber(breakdown.contextWindow)
  const usedTokens = finiteNumber(breakdown.usedTokens)
  const freeTokens = finiteNumber(breakdown.freeTokens)
  const autoCompactBufferTokens = finiteNumber(breakdown.autoCompactBufferTokens)
  const model = breakdown.model
  return {
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: typeof model.name === 'string' ? model.name : null
        }
      : null,
    contextWindow,
    usedTokens,
    percent: percent(usedTokens, contextWindow),
    freeTokens,
    freePercent: percent(freeTokens, contextWindow),
    autoCompactBufferTokens,
    autoCompactBufferPercent: percent(autoCompactBufferTokens, contextWindow),
    categories: breakdown.categories.flatMap((category) => {
      const id = contextCategoryId(category.id)
      if (!id) return []
      const tokens = finiteNumber(category.tokens)
      return [{ id, label: category.label, tokens, percent: percent(tokens, contextWindow) }]
    }),
    updatedAt: Date.now()
  }
}

/** 自定义事件帧直接写 stdout(仅帧;日志走 stderr)。 */
function emitFrame(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function localProtocolOptions(session: AgentSession): {
  getArtifactsDir: () => string | null
  getSessionId: () => string | null
} {
  return {
    getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
    getSessionId: () => session.sessionManager.getSessionId()
  }
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function previewWork(work: string): string {
  const singleLine = work.trim().replace(/\s+/g, ' ')
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 79)}…`
}

function extractAssistantText(message: ReturnType<AgentSession['getLastAssistantMessage']>): string {
  if (!message) return ''
  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
    .trim()
}

async function removeCloneSession(cloneFile: string): Promise<void> {
  await Promise.allSettled([
    fs.rm(cloneFile, { force: true }),
    fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true })
  ])
}

function runStatus(value: string): RunStatus {
  if (value === 'started') return 'running'
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'idle' ||
    value === 'parked' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'aborted'
  ) {
    return value
  }
  return 'unknown'
}

function runMetrics(value: unknown): RunMetrics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: RunMetrics = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    if (
      key === 'tokens' ||
      key === 'cost' ||
      key === 'requests' ||
      key === 'toolCalls' ||
      key === 'activeMs' ||
      key === 'elapsedMs'
    ) {
      out[key] = raw
    } else if (key === 'tools') {
      out.toolCalls = raw
    } else if (key === 'durationMs') {
      out.elapsedMs = raw
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function agentRunItems(): RunListItem[] {
  return AgentRegistry.global()
    .list()
    .filter((ref) => ref.id !== MAIN_AGENT_ID)
    .map((ref): RunListItem => {
      const sessionFile = ref.sessionFile ?? ref.session?.sessionManager.getSessionFile() ?? undefined
      const metrics = runMetrics(ref.history?.metrics)
      const kind =
        ref.kind === 'advisor'
          ? 'advisor'
          : ref.id.startsWith('Tan-') || ref.displayName === 'tan'
            ? 'tangent'
            : 'task'
      return {
        id: `agent:${ref.id}`,
        kind,
        status: runStatus(ref.status),
        title: ref.activity || ref.history?.agent || ref.displayName || ref.id,
        source: 'live-agent',
        createdAt: ref.createdAt,
        updatedAt: ref.lastActivity,
        ...(ref.parentId ? { parentId: ref.parentId } : {}),
        agentId: ref.id,
        ...(sessionFile ? { sessionFile } : {}),
        ...(ref.history?.resolvedModel ? { model: ref.history.resolvedModel } : {}),
        ...(ref.activity ? { activity: ref.activity } : {}),
        ...(metrics ? { metrics } : {}),
        actions: {
          canCancel: ref.status === 'running',
          canOpenTranscript: !!sessionFile,
          canCopyResult: false,
          canInsertResult: false
        }
      }
    })
}

function jobRunItems(session: AgentSession): RunListItem[] {
  const manager = session.asyncJobManager
  if (!manager) return []
  const ownerId = session.getAgentId()
  const jobs = manager.getAllJobs(ownerId ? { ownerId } : undefined)
  return jobs.map((job): RunListItem => {
    const status = job.queued && job.status === 'running' ? 'queued' : job.status
    const isTangent = job.agentId?.startsWith('Tan-') || job.label.startsWith('/tan ')
    return {
      id: `job:${job.id}`,
      kind: isTangent ? 'tangent' : job.type === 'task' ? 'task' : 'job',
      status,
      title: job.label,
      source: 'live-job',
      createdAt: job.startTime,
      updatedAt: Date.now(),
      jobId: job.id,
      ...(job.agentId ? { agentId: job.agentId } : {}),
      ...(job.resultText ? { resultPreview: job.resultText.slice(0, 4_000) } : {}),
      ...(job.errorText ? { errorPreview: job.errorText.slice(0, 4_000) } : {}),
      metrics: { elapsedMs: Date.now() - job.startTime },
      actions: {
        canCancel: job.status === 'running',
        canOpenTranscript: false,
        canCopyResult: !!job.resultText,
        canInsertResult: !!job.resultText
      }
    }
  })
}

function readRunsSnapshot(session: AgentSession): { runs: RunListItem[] } {
  return { runs: [...agentRunItems(), ...jobRunItems(session)] }
}

async function createTangentRun(
  session: AgentSession,
  cwd: string,
  settings: Settings,
  mcpManager: Awaited<ReturnType<typeof createAgentSession>>['mcpManager'],
  work: string
): Promise<{ jobId: string; agentId: string; sessionFile: string }> {
  const trimmedWork = work.trim()
  if (!trimmedWork) throw codedError('tan 任务不能为空', 'invalid_run_request')
  if (session.isCompacting) throw codedError('会话正在压缩,暂时不能创建 tangent run', 'session_busy')

  const model = session.model
  if (!model) throw codedError('当前会话没有可用模型', 'tangent_run_failed')
  const manager = session.asyncJobManager
  if (!manager) throw codedError('后台任务不可用', 'tangent_run_failed')
  const parentFile = session.sessionManager.getSessionFile()
  if (!parentFile) throw codedError('/tan 需要已持久化的会话', 'tangent_run_failed')

  const parentSessionId = session.sessionId
  const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId
  const thinkingLevel = session.configuredThinkingLevel()
  const systemPrompt = [...session.systemPrompt]
  const toolNames = session.getEnabledToolNames()
  const modelRegistry = session.modelRegistry
  const ownerId = session.getAgentId() ?? MAIN_AGENT_ID
  const parentArtifactsDir = session.sessionManager.getArtifactsDir()
  const parentLocalSessionId = session.sessionManager.getSessionId()
  const parentLeafId = session.sessionManager.getLeafId()
  const sessionDir = parentFile.slice(0, -6)
  const subagentSettings = createSubagentSettings(settings)
  const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined
  const enableLsp = settings.get('task.enableLsp') !== false
  const agentRegistry = AgentRegistry.global()
  const agentId = `Tan-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  const sessionFile = path.join(sessionDir, `${agentId}.jsonl`)
  const label = `/tan ${previewWork(trimmedWork)}`

  await session.sessionManager.ensureOnDisk()
  await session.sessionManager.flush()

  let jobId = ''
  try {
    const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
      copyArtifacts: false,
      suppressBreadcrumb: true,
      sessionFile
    })

    jobId = manager.register(
      'task',
      label,
      async ({ signal }) => {
        if (signal.aborted) throw new Error('Aborted before execution')
        let clone: AgentSession | undefined
        try {
          const created = await createAgentSession({
            cwd,
            sessionManager: cloneManager,
            model,
            thinkingLevel,
            systemPrompt,
            toolNames,
            providerSessionId: `${parentSessionId}:tan:${crypto.randomUUID()}`,
            providerPromptCacheKey: parentPromptCacheKey,
            modelRegistry,
            authStorage: modelRegistry.authStorage,
            settings: subagentSettings,
            hasUI: false,
            enableMCP: false,
            customTools,
            enableLsp,
            agentId,
            agentDisplayName: 'tan',
            parentTaskPrefix: agentId,
            parentAgentId: ownerId,
            agentRegistry,
            disableExtensionDiscovery: true,
            localProtocolOptions: {
              getArtifactsDir: () => parentArtifactsDir,
              getSessionId: () => parentLocalSessionId
            }
          })
          clone = created.session
          clone.sessionManager?.appendSessionInit?.({
            systemPrompt: clone.systemPrompt ? clone.systemPrompt.join('\n\n') : systemPrompt.join('\n\n'),
            task: trimmedWork,
            tools: clone.getEnabledToolNames()
          })
          const abortClone = () => {
            void clone?.abort()
          }
          signal.addEventListener('abort', abortClone, { once: true })
          clone.setTodoPhases([])
          cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] })
          const injectContextSwitch = () => {
            clone?.agent.appendMessage({
              role: 'developer',
              content: TAN_CONTEXT_SWITCH_PROMPT,
              attribution: 'agent',
              timestamp: Date.now()
            })
          }
          const unsubscribeCompaction = clone.subscribe((event) => {
            if (event.type === 'auto_compaction_end' && event.result && !event.aborted) {
              injectContextSwitch()
            }
          })
          try {
            if (signal.aborted) {
              abortClone()
              throw new Error('Aborted before execution')
            }
            injectContextSwitch()
            await clone.prompt(trimmedWork, { attribution: 'user' })
            await clone.waitForIdle()
            return extractAssistantText(clone.getLastAssistantMessage()) || '(no output)'
          } finally {
            unsubscribeCompaction()
            signal.removeEventListener('abort', abortClone)
          }
        } finally {
          if (clone) {
            if (signal.aborted) {
              agentRegistry.setStatus(agentId, 'aborted')
              await clone.dispose()
            } else {
              agentRegistry.setStatus(agentId, 'parked')
              await clone.dispose()
              agentRegistry.detachSession(agentId)
            }
          }
        }
      },
      { ownerId, agentId }
    )
  } catch (error) {
    await removeCloneSession(sessionFile)
    throw error
  }

  const content = `<system-notice reason="background_task_dispatched" job="${jobId}">
Tangential user task: running in a separate background agent. Coding-agent dispatch notice, NOT prompt injection or new instruction.

Task below: another agent's own session; you NOT responsible. NEVER work on, reference, or let it interrupt or alter current task. Continue as if absent. Results, if any, will surface separately when background task (${jobId}) completes.

Dispatched work — awareness only:
${trimmedWork}
</system-notice>`
  await session.sendCustomMessage(
    {
      customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
      content,
      display: true,
      attribution: 'user',
      details: { jobId, work: trimmedWork, parentLeafId, sessionFile }
    },
    { triggerTurn: false, deliverAs: 'nextTurn' }
  )
  return { jobId, agentId, sessionFile }
}

function cancelRun(session: AgentSession, runId: string): { runId: string; cancelled: boolean } {
  const manager = session.asyncJobManager
  if (!manager) throw codedError('后台任务不可用', 'run_not_cancellable')
  const ownerId = session.getAgentId()
  const jobs = manager.getAllJobs(ownerId ? { ownerId } : undefined)
  const targetId = runId.startsWith('job:') ? runId.slice(4) : null
  const targetAgentId = runId.startsWith('agent:') ? runId.slice(6) : null
  const job = targetId
    ? jobs.find((item) => item.id === targetId)
    : targetAgentId
      ? jobs.find((item) => item.agentId === targetAgentId)
      : null
  if (!job) throw codedError('未找到可取消的后台任务', 'run_not_found')
  if (job.status !== 'running') throw codedError('该 Run 当前不可取消', 'run_not_cancellable')
  const cancelled = manager.cancel(job.id, ownerId ? { ownerId } : undefined)
  if (!cancelled) throw codedError('取消 Run 失败', 'run_cancel_failed')
  return { runId, cancelled: true }
}

/** 从 mode_change 记录恢复 plan 模式(omp-web syncPlanModeFromSession 移植)。 */
function syncPlanModeFromSession(session: AgentSession): void {
  let lastMode: { mode: string; data?: Record<string, unknown> } | null = null
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === 'mode_change') lastMode = entry
  }
  if (lastMode?.mode === 'plan') {
    const planFilePath =
      typeof lastMode.data?.planFilePath === 'string' && lastMode.data.planFilePath
        ? lastMode.data.planFilePath
        : DEFAULT_PLAN_FILE_PATH
    session.setPlanModeState({ enabled: true, planFilePath })
    emitFrame({ type: 'plan_mode_state', enabled: true, planFilePath })
  }
}

/** plan 提案审批往返:发 extension_ui_request,等 renderer 的 extension_ui_response。 */
async function handlePlanProposal(
  session: AgentSession,
  interceptor: FrameInterceptor,
  cwd: string,
  title: string
): Promise<AgentToolResult<PlanApprovalDetails>> {
  const review = await session.preparePlanForReview(title)
  const details = review.details as PlanApprovalDetails
  const { planFilePath, title: planTitle } = details

  if (!details.planExists) {
    return {
      content: [{ type: 'text', text: `计划文件不存在:${planFilePath},无法进入审批。` }],
      details
    }
  }

  let planContent = await readPlanFile(planFilePath, {
    localProtocolOptions: localProtocolOptions(session),
    cwd
  })
  planContent = planContent ?? ''
  if (new TextEncoder().encode(planContent).length > PLAN_CONTENT_MAX_BYTES) {
    planContent = planContent.slice(0, PLAN_CONTENT_MAX_BYTES) + '\n<!-- truncated -->'
  }

  const id = crypto.randomUUID()
  emitFrame({
    type: 'extension_ui_request',
    id,
    method: 'plan_review',
    title: planTitle,
    planFilePath,
    planContent
  })
  const response = await new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => {
      interceptor.pending.delete(id)
      resolve(null)
    }, PLAN_REVIEW_TIMEOUT_MS)
    interceptor.pending.set(id, {
      resolve: (frame) => {
        clearTimeout(timer)
        resolve(frame)
      },
      reject: () => {}
    })
  })

  const currentState = session.getPlanModeState()
  const stateBase = currentState ?? { enabled: true, planFilePath }

  if (!response) {
    // 超时/EOF:按 refine 空反馈处理,保持 plan 模式。
    session.setPlanModeState({ ...stateBase, planFilePath })
    session.sessionManager.appendModeChange('plan', { planFilePath })
    emitFrame({ type: 'plan_mode_state', enabled: true, planFilePath })
    return {
      content: [
        {
          type: 'text',
          text: '计划审批等待超时,请根据已有反馈更新计划内容,然后重新调用 xd://propose 提交更新后的计划。'
        }
      ],
      details
    }
  }

  if (response['action'] === 'approve') {
    session.setPlanReferencePath(planFilePath)
    session.setPlanProposalHandler(null)
    session.setPlanModeState(undefined)
    session.sessionManager.appendModeChange('none')
    emitFrame({ type: 'plan_mode_state', enabled: false })
    return {
      content: [{ type: 'text', text: '计划已批准,开始执行。' }],
      details: { planFilePath, title: planTitle, planExists: true }
    }
  }

  // refine:保持 plan 模式,要求模型按反馈更新后重新 propose。
  const feedback = typeof response['feedback'] === 'string' ? response['feedback'] : ''
  session.setPlanModeState({ ...stateBase, planFilePath })
  session.sessionManager.appendModeChange('plan', { planFilePath })
  emitFrame({ type: 'plan_mode_state', enabled: true, planFilePath })
  return {
    content: [
      {
        type: 'text',
        text: `用户要求修改计划:${feedback || '(未提供具体反馈)'}。请根据反馈更新计划内容,然后重新调用 xd://propose 提交更新后的计划。`
      }
    ],
    details
  }
}

/** Register Ompilot-only commands by domain on top of the SDK RPC protocol. */
async function installCustomCommandHandlers(
  session: AgentSession,
  interceptor: FrameInterceptor,
  cwd: string,
  settings: Settings,
  mcpManager: Awaited<ReturnType<typeof createAgentSession>>['mcpManager']
): Promise<void> {
  syncPlanModeFromSession(session)

  // approve 会清空 proposal handler(setPlanProposalHandler(null)),重新启用
  // plan 模式时必须重装,否则 xd://propose 报 "No plan is awaiting approval"。
  const installProposalHandler = (): void => {
    session.setPlanProposalHandler((title) => handlePlanProposal(session, interceptor, cwd, title))
  }

  type CommandHandler = (frame: Record<string, unknown>) => Promise<void> | void
  const handlers = new Map<string, CommandHandler>()
  const emitCommandError = (
    frame: Record<string, unknown>,
    command: string,
    error: unknown
  ): void => {
    emitFrame({
      id: frame['id'],
      type: 'response',
      command,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? { code: error.code }
          : {}
      )
    })
  }

  handlers.set('get_context_breakdown', (frame) => {
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'get_context_breakdown',
        success: true,
        data: readSessionContextBreakdown(session)
      })
  })

  handlers.set('set_approval_mode', (frame) => {
      const mode = frame['mode']
      if (mode !== 'always-ask' && mode !== 'write' && mode !== 'yolo') {
        throw new Error(`invalid approval mode: ${String(mode)}`)
      }
      settings.override('tools.approvalMode', mode)
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'set_approval_mode',
        success: true,
        data: { mode }
      })
  })

  handlers.set('set_configured_thinking_level', (frame) => {
      const level = frame['level']
      if (
        level !== 'auto' &&
        level !== 'minimal' &&
        level !== 'low' &&
        level !== 'medium' &&
        level !== 'high' &&
        level !== 'xhigh' &&
        level !== 'max'
      ) {
        emitFrame({
          id: frame['id'],
          type: 'response',
          command: 'set_configured_thinking_level',
          success: false,
          error: `invalid configured thinking level: ${String(level)}`
        })
        return
      }
      session.setThinkingLevel(level === 'auto' ? level : SDK_THINKING_LEVELS[level])
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'set_configured_thinking_level',
        success: true,
        data: {
          configured: session.configuredThinkingLevel() ?? null,
          effective: session.thinkingLevel ?? null
        }
      })
  })

  handlers.set('refresh_models', async (frame) => {
      const provider = typeof frame['provider'] === 'string' && frame['provider'] ? frame['provider'] : null
      if (provider) {
        await session.modelRegistry.refreshProvider(provider, 'online')
      } else {
        await session.modelRegistry.refresh('online')
      }
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'refresh_models',
        success: true,
        data: {}
      })
  })

  handlers.set('get_queued_messages', (frame) => {
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'get_queued_messages',
        success: true,
        data: readSessionQueue(session)
      })
  })

  handlers.set('promote_queued_message', (frame) => {
      const queueId =
        typeof frame['queueId'] === 'string' && frame['queueId'].trim()
          ? frame['queueId']
          : null
      if (!queueId) throw queueError('无效的排队消息', 'invalid_queue_message')
      const queue = promoteQueuedMessage(session, queueId)
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'promote_queued_message',
        success: true,
        data: queue
      })
  })

  handlers.set('get_runs_snapshot', (frame) => {
      emitFrame({
        id: frame['id'],
        type: 'response',
        command: 'get_runs_snapshot',
        success: true,
        data: readRunsSnapshot(session)
      })
  })

  handlers.set('create_tangent_run', async (frame) => {
      try {
        const work = typeof frame['work'] === 'string' ? frame['work'] : ''
        const created = await createTangentRun(session, cwd, settings, mcpManager, work)
        emitFrame({
          id: frame['id'],
          type: 'response',
          command: 'create_tangent_run',
          success: true,
          data: { ...created, ...readRunsSnapshot(session) }
        })
      } catch (error) {
        emitCommandError(frame, 'create_tangent_run', error)
      }
  })

  handlers.set('cancel_run', (frame) => {
      try {
        const runId = typeof frame['runId'] === 'string' ? frame['runId'] : ''
        const result = cancelRun(session, runId)
        emitFrame({
          id: frame['id'],
          type: 'response',
          command: 'cancel_run',
          success: true,
          data: { ...result, ...readRunsSnapshot(session) }
        })
      } catch (error) {
        emitCommandError(frame, 'cancel_run', error)
      }
  })

  handlers.set('switch_session_branch', async (frame) => {
      try {
        const entryId =
          typeof frame['entryId'] === 'string' && SESSION_ENTRY_ID_PATTERN.test(frame['entryId'])
            ? frame['entryId']
            : null
        const expectedLeafId =
          frame['expectedLeafId'] === null ||
          (typeof frame['expectedLeafId'] === 'string' &&
            SESSION_ENTRY_ID_PATTERN.test(frame['expectedLeafId']))
            ? frame['expectedLeafId']
            : undefined
        if (!entryId || expectedLeafId === undefined) {
          throw branchError('无效的会话分支位置', 'invalid_tree_target')
        }
        if (session.isStreaming || session.isCompacting) {
          throw branchError('会话正在运行,暂时不能切换分支', 'session_busy')
        }
        const oldLeafId = session.sessionManager.getLeafId()
        if (oldLeafId !== expectedLeafId) {
          throw branchError('会话分支已变化,请刷新后重试', 'stale_tree')
        }
        if (!canSwitchSessionBranch(session, entryId)) {
          throw branchError('该节点不支持直接切换', 'invalid_tree_target')
        }
        const result = await session.navigateTree(entryId, { summarize: false })
        if (result.cancelled) {
          throw branchError('会话分支切换已取消', 'tree_switch_cancelled')
        }
        const cursorEntryId = session.sessionManager.appendCustomEntry(
          SESSION_TREE_CURSOR_TYPE,
          { version: 1, targetEntryId: entryId, previousLeafId: oldLeafId }
        )
        await session.sessionManager.flush()
        emitFrame({
          id: frame['id'],
          type: 'response',
          command: 'switch_session_branch',
          success: true,
          data: { oldLeafId, newLeafId: cursorEntryId, targetEntryId: entryId }
        })
      } catch (error) {
        emitCommandError(frame, 'switch_session_branch', error)
      }
  })

  handlers.set('set_plan_mode', (frame) => {
    const enabled = frame['enabled'] === true
    if (enabled) {
      const current = session.getPlanModeState()
      const planFilePath = current?.planFilePath || DEFAULT_PLAN_FILE_PATH
      session.setPlanModeState({
        enabled: true,
        planFilePath
      })
      session.sessionManager.appendModeChange('plan', { planFilePath })
      installProposalHandler()
    } else {
      session.setPlanProposalHandler(null)
      session.setPlanModeState(undefined)
      session.sessionManager.appendModeChange('none')
    }
    const state = session.getPlanModeState()
    // 事件与响应都直接写 stdout:拦截器输出流是 runRpcMode 的输入,响应帧
    // 若经拦截器 enqueue 会被 SDK 当作入站命令(Unknown command: response)。
    emitFrame({
      type: 'plan_mode_state',
      enabled: state?.enabled === true,
      ...(state?.planFilePath ? { planFilePath: state.planFilePath } : {})
    })
    emitFrame({
      id: frame['id'],
      type: 'response',
      command: 'set_plan_mode',
      success: true,
      data: { enabled: state?.enabled === true }
    })
  })

  interceptor.setCustomHandler(async (frame) => {
    const type = typeof frame['type'] === 'string' ? frame['type'] : ''
    const handler = handlers.get(type)
    if (!handler) {
      emitCommandError(frame, type || 'unknown', new Error(`unknown custom command: ${String(frame['type'])}`))
      return
    }
    try {
      await handler(frame)
    } catch (error) {
      emitCommandError(frame, type, error)
    }
  })

  if (session.getPlanModeState()?.enabled) installProposalHandler()
}

// -----------------------------------------------------------------------------

/** 手写 argv 解析(无依赖);未知参数报错 exit 2;--mode 必填。 */
function parseArgs(argv: string[]): WorkerArgs {
  const out: WorkerArgs = { mode: null, session: null, systemPrompt: null, extensions: [] }
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    const value = (): string => {
      const v = argv[i + 1]
      if (v === undefined) failUsage(`missing value for ${arg}`)
      i += 1
      return v
    }
    if (arg === '--mode') {
      const v = value()
      if (!(VALID_MODES as readonly string[]).includes(v)) failUsage(`unknown mode: ${v}`)
      out.mode = v as WorkerMode
    } else if (arg === '--session') {
      out.session = value()
    } else if (arg === '--system-prompt') {
      out.systemPrompt = value()
    } else if (arg === '--extension') {
      out.extensions.push(value())
    } else {
      failUsage(`unknown argument: ${arg}`)
    }
    i += 1
  }
  if (!out.mode) failUsage('--mode is required')
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()

  // 3. 运行时组装(per-process 单例:一个 worker 进程只服务一个 cwd)。
  const agentDir = getAgentDir()
  const settings = await Settings.init({ cwd, agentDir })
  const authStorage = await discoverAuthStorage(agentDir)
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh('online-if-uncached')

  // 4. 同一个 eventBus 传给 createAgentSession 与 runRpcMode(子代理帧依赖此接线)。
  const eventBus = new EventBus()

  // 5. 拦截器:stdin 帧按行拦截 plan_review 响应与 worker 自定义命令。
  //    dev/直跑:相对本文件;build 后 worker 被拷到 out/main/chunks,main 传绝对路径。
  const interceptorSpecifier = process.env.OMP_WORKER_INTERCEPTOR ?? './frame-interceptor.ts'
  const { createFrameInterceptor: makeInterceptor } = await import(interceptorSpecifier)
  const interceptor = makeInterceptor(claimedInput)

  // 6. SessionManager 按 mode。
  let sessionManager: SessionManager | undefined
  if (args.mode === 'resume' || args.mode === 'fork') {
    if (!args.session) failUsage(`--mode ${args.mode} requires --session`)
    sessionManager = await SessionManager.open(args.session)
  } else if (args.mode === 'ephemeral' || args.mode === 'side-chat') {
    sessionManager = SessionManager.inMemory(cwd)
  }
  // draft:不传 sessionManager → SDK 默认 SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir)),
  // 与 CLI 裸 spawn 语义一致。

  // 7. createAgentSession。
  const options: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    settings,
    modelRegistry,
    hasUI: true,
    eventBus
  }
  if (sessionManager) options.sessionManager = sessionManager
  if (args.mode === 'side-chat') {
    // 对齐 --no-session --no-tools --no-extensions --no-skills --no-rules。
    options.toolNames = []
    options.restrictToolNames = true
    options.disableExtensionDiscovery = true
    options.skills = []
    options.slashCommands = []
    options.rules = []
    options.systemPrompt = args.systemPrompt ?? ''
  } else if (args.extensions.length > 0) {
    options.additionalExtensionPaths = args.extensions
  }

  const { session, setToolUIContext, mcpManager } = await createAgentSession(options)

  // 8. fork:先分叉再进 runRpcMode,使首个 get_state 就返回分叉后的 sessionFile。
  if (args.mode === 'fork') {
    const ok = await session.fork()
    if (!ok) {
      process.stderr.write('[sdk-worker] session.fork() returned false\n')
      process.exit(1)
    }
  }

  // Install Ompilot commands and the plan proposal handler.
  if (args.mode !== 'side-chat') {
    await installCustomCommandHandlers(session, interceptor, cwd, settings, mcpManager)
    // MCP 状态推送:连接状态只存在于 worker 进程内,以 mcp_status_event 帧
    // 推给 main(侧边栏徽标)。side-chat 是临时进程,不装。
    const mcpStatusSpecifier = process.env.OMP_WORKER_MCP_STATUS ?? './mcp-status.ts'
    const { installMcpStatus } = await import(mcpStatusSpecifier)
    installMcpStatus(mcpManager, (servers: McpServerStatusEntry[]) =>
      emitFrame({ type: 'mcp_status_event', servers })
    )
  }
  interceptor.markSessionReady()

  // 10. runRpcMode —— setToolUIContext 一律传(rpc-ui 超集:ask 工具 UI 与扩展 UI
  //     都走 extension_ui_request 帧);拦截后的 stream 作为输入。
  await runRpcMode(session, setToolUIContext, eventBus, interceptor.stream)
}

main().catch((err) => {
  process.stderr.write(
    `[sdk-worker] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})

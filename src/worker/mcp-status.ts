/**
 * MCP 连接状态快照与推送(worker 侧)。
 *
 * SDK 的 MCPManager 只把状态存在进程内:没有 wire 通道,也没有 status 订阅
 * API(仅 setOnToolsChanged / addNotificationListener,覆盖不了纯连接状态
 * 变化)。这里用三类时机覆盖:
 * 1. 安装后立即快照(此时多为 connecting);
 * 2. 每个已知服务器 waitForConnection settle 后重发(启动连接完成/失败);
 * 3. 轻量轮询(纯内存,状态 JSON 不变则不 emit)——覆盖自动重连、熔断等
 *    后续无事件可订阅的变化。
 *
 * 帧契约由调用方决定(emit 回调),本模块不 import SDK 以外的运行时依赖。
 */

import type { MCPManager } from '@oh-my-pi/pi-coding-agent'
import type { McpServerStatusEntry } from '../shared/types'

/** 状态推送回调(worker 侧实现为 emitFrame({type:'mcp_status_event', servers}))。 */
export type McpStatusEmitter = (servers: McpServerStatusEntry[]) => void

const MCP_STATUS_POLL_MS = 10_000
/** discovery 完成前补挂 waitForConnection 的时点(250ms 延迟连接门之后)。 */
const MCP_STATUS_WATCH_DELAYS_MS = [400, 1600]

export function snapshotMcpServers(mcpManager: MCPManager): McpServerStatusEntry[] {
  const tools = mcpManager.getTools()
  return mcpManager.getAllServerNames().map((name) => {
    const source = mcpManager.getSource(name)
    return {
      name,
      status: mcpManager.getConnectionStatus(name),
      source: source
        ? {
            provider: source.provider,
            providerName: source.providerName,
            path: source.path,
            level: source.level
          }
        : null,
      toolCount: tools.filter((t) => t.mcpServerName === name).length
    }
  })
}

/**
 * 安装 MCP 状态推送。无 MCP(如 side-chat)时为空操作。
 * 返回清理函数(worker 退出路径上调用,避免定时器阻止进程自然退出)。
 */
export function installMcpStatus(
  mcpManager: MCPManager | undefined,
  emit: McpStatusEmitter
): () => void {
  if (!mcpManager) return () => {}
  let lastJson = ''
  const watched = new Set<string>()
  const emitOnce = (): void => {
    const servers = snapshotMcpServers(mcpManager)
    const json = JSON.stringify(servers)
    if (json === lastJson) return
    lastJson = json
    emit(servers)
  }
  const watch = (): void => {
    for (const name of mcpManager.getAllServerNames()) {
      if (watched.has(name)) continue
      watched.add(name)
      // 连接完成或失败都会 settle;两种结果都要重发快照。
      void mcpManager.waitForConnection(name).then(emitOnce, emitOnce)
    }
  }
  watch()
  emitOnce()
  const settleTimers = MCP_STATUS_WATCH_DELAYS_MS.map((ms) =>
    setTimeout(() => {
      watch()
      emitOnce()
    }, ms)
  )
  const poll = setInterval(() => {
    watch()
    emitOnce()
  }, MCP_STATUS_POLL_MS)
  poll.unref?.()
  return () => {
    clearInterval(poll)
    for (const timer of settleTimers) clearTimeout(timer)
  }
}

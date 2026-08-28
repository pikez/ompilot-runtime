/**
 * Import-only Runtime probe. It verifies the exact internal SDK entry points
 * used by Ompilot without opening a session, reading user config, or running an
 * agent turn.
 */
export {}

const modules = await Promise.all([
  import('@oh-my-pi/pi-coding-agent'),
  import('@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input'),
  import('@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode'),
  import('@oh-my-pi/pi-coding-agent/modes/utils/context-usage'),
  import('@oh-my-pi/pi-coding-agent/plan-mode/plan-files'),
  import('@oh-my-pi/pi-coding-agent/session/messages'),
  import('@oh-my-pi/pi-coding-agent/session/queued-messages'),
  import('@oh-my-pi/pi-coding-agent/task/executor'),
  import('@oh-my-pi/pi-coding-agent/tools/todo'),
  import('@oh-my-pi/pi-coding-agent/utils/event-bus'),
  import('@oh-my-pi/pi-agent-core'),
  import('@oh-my-pi/pi-ai'),
  import('@oh-my-pi/pi-utils')
])

if (modules.some((module) => !module || typeof module !== 'object')) {
  throw new Error('Agent Runtime module import failed')
}

process.stdout.write(JSON.stringify({ ok: true, bunVersion: Bun.version }) + '\n')

/**
 * 行级 RPC 帧拦截器(worker 侧)。
 *
 * 包装 stdin 字节流:按 `\n` 切行,仅拦截两类帧——
 * 1. `extension_ui_response` 且 id 命中自有 pending(plan_review 等 UI 响应)→ resolve 该 pending,不透传;
 * 2. Ompilot 自定义命令(plan、权限、context)→ 交给注入的 custom handler,
 *    handler 返回的 response 帧写入输出流,原帧不透传。
 *
 * 其余(含 runRpcMode 自己的 extension_ui_response)→ 原样透传(行 + `\n`,字节保真)。
 * sessionReady 前到达的自定义命令暂存队列,ready 后按序处理。
 *
 * 不 import 任何 SDK:纯 Web Streams(global),Node 测试脚本可直接 import。
 */

type Frame = Record<string, unknown>

export interface PendingEntry {
  resolve: (frame: Frame) => void
  reject: (err: Error) => void
}

export type CustomFrameHandler = (frame: Frame) => Frame | void | Promise<Frame | void>

export interface FrameInterceptor {
  /** 拦截后的输出流(喂给 runRpcMode 的输入) */
  stream: ReadableStream<Uint8Array>
  /** 自有 pending 集合(plan_review 等 UI 响应帧按 id 命中) */
  pending: Map<string, PendingEntry>
  /** 注入自定义命令 handler;null = 未注入 */
  setCustomHandler(handler: CustomFrameHandler | null): void
  /** 标记 session 就绪;就绪前暂存的自定义命令按序处理 */
  markSessionReady(): void
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const LF = 10
const CUSTOM_FRAME_TYPES: Record<string, true> = {
  set_plan_mode: true,
  set_approval_mode: true,
  set_configured_thinking_level: true,
  get_context_breakdown: true,
  refresh_models: true,
  get_queued_messages: true,
  promote_queued_message: true,
  switch_session_branch: true,
  get_runs_snapshot: true,
  create_tangent_run: true,
  cancel_run: true
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function createFrameInterceptor(input: ReadableStream<Uint8Array>): FrameInterceptor {
  const pending = new Map<string, PendingEntry>()
  let customHandler: CustomFrameHandler | null = null
  let ready = false
  const queued: Frame[] = []
  let lineBuffer = new Uint8Array(0)

  const passThrough = (controller: TransformStreamDefaultController<Uint8Array>, line: Uint8Array): void => {
    const out = new Uint8Array(line.length + 1)
    out.set(line)
    out[line.length] = LF
    controller.enqueue(out)
  }

  const enqueueFrame = (
    controller: TransformStreamDefaultController<Uint8Array>,
    frame: Frame
  ): void => {
    controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'))
  }

  const runCustom = async (
    frame: Frame,
    controller: TransformStreamDefaultController<Uint8Array>
  ): Promise<void> => {
    if (!customHandler) {
      enqueueFrame(controller, {
        id: frame['id'],
        type: 'response',
        command: String(frame['type']),
        success: false,
        error: 'no custom handler registered',
        code: 'no_handler'
      })
      return
    }
    try {
      const result = await customHandler(frame)
      if (result) enqueueFrame(controller, result)
    } catch (err) {
      enqueueFrame(controller, {
        id: frame['id'],
        type: 'response',
        command: String(frame['type']),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        ...(errorCode(err) ? { code: errorCode(err) } : {})
      })
    }
  }

  const handleLine = async (
    line: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>
  ): Promise<void> => {
    // ready 后先按序处理暂存的自定义命令,再处理当前行。
    if (ready && queued.length > 0) {
      const batch = queued.splice(0)
      for (const f of batch) await runCustom(f, controller)
    }
    let frame: Frame
    try {
      frame = JSON.parse(decoder.decode(line)) as Frame
    } catch {
      passThrough(controller, line)
      return
    }
    if (frame['type'] === 'extension_ui_response') {
      const id = frame['id']
      if (typeof id === 'string') {
        const entry = pending.get(id)
        if (entry) {
          pending.delete(id)
          entry.resolve(frame)
          return
        }
      }
      // runRpcMode 自己的 extension_ui_response(ask 工具 UI 等)→ 原样透传
      passThrough(controller, line)
      return
    }
    const frameType = typeof frame['type'] === 'string' ? frame['type'] : ''
    if (CUSTOM_FRAME_TYPES[frameType]) {
      if (!ready) {
        queued.push(frame)
        return
      }
      await runCustom(frame, controller)
      return
    }
    passThrough(controller, line)
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const merged = new Uint8Array(lineBuffer.length + chunk.length)
      merged.set(lineBuffer)
      merged.set(chunk, lineBuffer.length)
      lineBuffer = merged
      let idx: number
      while ((idx = lineBuffer.indexOf(LF)) >= 0) {
        const line = lineBuffer.slice(0, idx)
        lineBuffer = lineBuffer.slice(idx + 1)
        await handleLine(line, controller)
      }
    },
    async flush(controller) {
      if (ready && queued.length > 0) {
        const batch = queued.splice(0)
        for (const f of batch) await runCustom(f, controller)
      }
      if (lineBuffer.length > 0) {
        // EOF 前的残行(无 \n)按字节透传,保持保真
        passThrough(controller, lineBuffer)
        lineBuffer = new Uint8Array(0)
      }
    }
  })

  return {
    stream: input.pipeThrough(transform),
    pending,
    setCustomHandler(handler: CustomFrameHandler | null) {
      customHandler = handler
    },
    markSessionReady() {
      if (ready) return
      ready = true
    }
  }
}

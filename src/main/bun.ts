import { existsSync } from 'node:fs'
import path from 'node:path'

/** 固定 Bun 版本,与 scripts/ensure-bun.mjs 保持一致。 */
export const BUN_VERSION = '1.3.14'

/**
 * 解析 Bun 可执行路径:OMP_BUN env 覆盖 → 仓库缓存(ensure-bun 自愈产物)→ PATH 兜底。
 * PATH 兜底 spawn 失败按现有 omp spawn 错误路径浮出,不在此校验。
 */
export function resolveBunPath(appPath: string): string {
  const fromEnv = process.env['OMP_BUN']
  if (fromEnv) return fromEnv

  const cached = path.join(appPath, 'node_modules', '.cache', 'bun', BUN_VERSION, 'bun')
  if (existsSync(cached)) return cached

  return 'bun'
}

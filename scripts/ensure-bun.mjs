// `npm run dev` / `npm run build` / `npm run start` 的前置自愈:Bun 运行时。
// agent worker 以 Bun 运行 @oh-my-pi SDK(import bun:sqlite,只跑在 Bun),需要本机有 bun 二进制。
// 优先用 OMP_BUN 指定的路径(跳过下载);否则下载固定版本到 node_modules/.cache/bun/<ver>/bun。
// 幂等:目标存在即跳过;--force 强制重新下载。失败打印清晰指引。
import { spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BUN_VERSION = '1.3.14';

const TRIPLES = {
  darwin: { arm64: 'darwin-aarch64', x64: 'darwin-x64' },
  win32: { x64: 'windows-x64' },
  linux: { x64: 'linux-x64' },
};

function triple() {
  const t = TRIPLES[process.platform]?.[process.arch];
  if (!t) {
    console.error(
      `[ensure-bun] 不支持的平台/架构: ${process.platform}/${process.arch}(支持 darwin-aarch64/darwin-x64/windows-x64/linux-x64)。请自行安装 bun 并用 OMP_BUN 指定路径。`,
    );
    process.exit(1);
  }
  return t;
}

function cacheBunPath() {
  return path.join('node_modules', '.cache', 'bun', BUN_VERSION, 'bun');
}

async function main() {
  if (process.env.OMP_BUN) {
    console.log(`[ensure-bun] OMP_BUN 已设置(${process.env.OMP_BUN}),跳过下载。`);
    process.exit(0);
  }

  const force = process.argv.includes('--force');
  const target = cacheBunPath();

  if (!force && existsSync(target)) {
    console.log(`[ensure-bun] ${target} 已存在,跳过。`);
    process.exit(0);
  }

  const t = triple();
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${t}.zip`;
  const zipPath = path.join(tmpdir(), `bun-${BUN_VERSION}-${t}.zip`);

  console.log(`[ensure-bun] 下载 ${url}`);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
  } catch (err) {
    console.error(`[ensure-bun] 下载失败: ${err.message}`);
    console.error(
      `[ensure-bun] 修复指引: 先执行 npm install,再重跑 node scripts/ensure-bun.mjs;` +
        `或手动安装 bun 后用环境变量 OMP_BUN=<bun 路径> 覆盖(跳过下载)。`,
    );
    process.exit(1);
  }

  const extractDir = path.join(tmpdir(), `bun-extract-${BUN_VERSION}-${t}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -Force '${zipPath}' '${extractDir}'`],
      { stdio: 'inherit' },
    );
    if (ps.status !== 0) {
      console.error(`[ensure-bun] 解压失败(Expand-Archive exit ${ps.status})。`);
      process.exit(1);
    }
  } else {
    const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
    if (unzip.status !== 0) {
      console.error(`[ensure-bun] 解压失败(unzip exit ${unzip.status})。`);
      process.exit(1);
    }
  }

  const extracted = path.join(extractDir, `bun-${t}`, process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (!existsSync(extracted)) {
    console.error(`[ensure-bun] 压缩包内未找到 ${extracted},解压产物异常。`);
    process.exit(1);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { force: true });
  await import('node:fs/promises').then(({ copyFile }) => copyFile(extracted, target));
  if (process.platform !== 'win32') chmodSync(target, 0o755);

  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[ensure-bun] 就绪: ${target}`);
  process.exit(0);
}

main();

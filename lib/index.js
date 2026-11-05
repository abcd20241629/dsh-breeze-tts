// lib/index.js — @dsh-external/dsh-breeze-tts 宿主半边
//
// 本机 Breeze TTS 2（T8star Aix Voice Studio 背后的 Python 后端）配音级语音合成。
// 直连 127.0.0.1:7860 的 /ws/generate，wav 落到插件 data 目录并播放出来。
//
// 踩过的两个坑，写死在这里，别再踩一次：
// 1. numba 缓存目录必须可写。DSH 沙箱默认写不了 %LOCALAPPDATA%，numba 于是每次冷编译，
//    光 import qwen_tts 就要 7 分钟；指到 data/numba 之后降到 14 秒。
// 2. 后端的日志 / 数据库 / 输出由三个环境变量控制，都得指进可写目录，
//    否则一启动就是 PermissionError: [WinError 5]。
//
// 零依赖：只用 node 内置模块 + 宿主注入的 ctx.tools（与 dsh-comfy-image 同范式，
// 不需要 tsc / @deepseek-ai 包链接，热重载和持久装配都不会因为 junction 失效）。
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

export const name = '@dsh-external/dsh-breeze-tts'
export const inject = ['tools']

// ---- 配置面（都能用环境变量覆盖）----
const HOME = process.env.BREEZE_TTS_HOME || 'D:\\breeze tts2工作台'
const MODEL_DIR = process.env.BREEZE_TTS_MODEL_DIR
  || 'D:\\breeze tts2模型\\models\\breeze_tts\\BreezeBlue_Breeze-TTS-2'
const PORT = Number(process.env.BREEZE_TTS_PORT || 7860)
const BASE = `http://127.0.0.1:${PORT}`
const PYTHON = join(HOME, 'resources', 'python', 'python.exe')
const BACKEND = join(HOME, 'resources', 'backend')

const DATA = process.env.BREEZE_TTS_DATA || 'D:\\dsh\\plugins\\dsh-breeze-tts\\data'
const OUT_DIR = join(DATA, 'out')
const LOG_DIR = join(DATA, 'cache')
const NUMBA_DIR = join(DATA, 'numba')

const DEFAULT_INSTRUCTION = 'Speak clearly and naturally.'
const GEN_TIMEOUT_MS = 300000
const BOOT_TIMEOUT_MS = 180000

const GUIDE = [
  'Breeze TTS 2 是配音级模型，不是实时对话引擎：',
  '- 模型常驻后，2~3 秒的音频约要 30 秒；第一次冷启动还要再加上模型上卡的时间。',
  '- 所以一次只喂一两句，别把长段落丢进来。',
  '- instruction 是自由文本的语气指令（中英文都行），例如 "温柔一点，慢一点，像在哄人"。',
  '- design 模式不需要参考音频；要复刻特定音色得走 clone 模式（需要参考 wav + 逐字稿），暂未开放。'
].join('\n')

// ---- 运行时状态 ----
let owned = null          // 本插件 spawn 的 python 子进程；不是我们起的就保持 null
let starting = null       // 进行中的启动 Promise，防止并发重复拉起
let outputDir = null      // 从 /api/settings 拿到的真实输出目录（可能被 GUI 改过）
let bootLog = []          // 子进程 stdout/stderr 尾部，便于报错时给出证据

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchWithTimeout(url, init, ms) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function ping(ms = 3000) {
  try {
    const r = await fetchWithTimeout(BASE + '/api/health', {}, ms)
    if (!r.ok) return null
    const j = await r.json()
    return j && j.status === 'ok' ? j : null
  } catch {
    return null
  }
}

async function syncOutputDir() {
  try {
    const r = await fetchWithTimeout(BASE + '/api/settings', {}, 4000)
    if (r.ok) {
      const j = await r.json()
      if (j && typeof j.output_directory === 'string' && j.output_directory) {
        outputDir = j.output_directory
        return
      }
    }
  } catch { /* 用兜底目录 */ }
  if (!outputDir) outputDir = OUT_DIR
}

async function boot() {
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  await mkdir(NUMBA_DIR, { recursive: true })

  const env = {
    ...process.env,
    T8_BREEZE_DATA_DIR: LOG_DIR,
    T8_BREEZE_OUTPUT_DIR: OUT_DIR,
    NUMBA_CACHE_DIR: NUMBA_DIR,
    PYTHONUNBUFFERED: '1'
  }

  const child = spawn(PYTHON, [
    '-m', 't8_runtime.server',
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--model-dir', MODEL_DIR
  ], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  owned = child
  bootLog = []
  const keep = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) bootLog.push(line)
    }
    if (bootLog.length > 200) bootLog = bootLog.slice(-200)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('exit', () => { if (owned === child) owned = null })

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1000)
    if (child.exitCode !== null) {
      throw new Error(`后端进程退出了（code ${child.exitCode}）：${bootLog.slice(-8).join(' | ')}`)
    }
    const health = await ping(2000)
    if (health) {
      await syncOutputDir()
      return { reused: false, health }
    }
  }
  throw new Error(`后端 ${BOOT_TIMEOUT_MS / 1000}s 内没起来：${bootLog.slice(-8).join(' | ')}`)
}

async function ensureBackend() {
  const health = await ping()
  if (health) {
    await syncOutputDir()
    return { reused: true, health }
  }
  if (!starting) {
    starting = boot().finally(() => { starting = null })
  }
  return starting
}

function generate(text, instruction, seed) {
  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/generate`)
    ws.binaryType = 'arraybuffer'

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new Error(`生成超时（${GEN_TIMEOUT_MS / 1000}s）`)),
      GEN_TIMEOUT_MS
    )

    ws.onopen = () => ws.send(JSON.stringify({
      mode: 'design',
      text,
      instruction,
      seed,
      cfg_scale: 4.0,
      stream_audio: false
    }))

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return   // 二进制是 PCM 块，stream_audio=false 时不会有
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'start') return
      if (msg.type === 'complete') finish(resolve, msg)
      else if (msg.type === 'error') finish(reject, new Error(msg.message || '生成失败'))
    }
    ws.onerror = () => finish(reject, new Error('连接 /ws/generate 失败'))
    ws.onclose = () => { if (!settled) finish(reject, new Error('WebSocket 提前关闭')) }
  })
}

function playWav(file) {
  return new Promise((resolve, reject) => {
    const quoted = String(file).replace(/'/g, "''")
    const script = `$p = New-Object System.Media.SoundPlayer '${quoted}'; $p.PlaySync()`
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`播放失败 exit=${code} ${err.slice(0, 300)}`))
    })
  })
}

function defineTool(def) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(def.parameters || {})) {
    const p = { type: v.type, description: v.description }
    if (v.items) p.items = v.items
    properties[k] = p
    if (v.required) required.push(k)
  }
  return {
    name: def.name,
    description: def.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: def.output && def.output.schema ? def.output.schema : { type: 'object' },
      render: def.output && def.output.render
        ? def.output.render
        : (_a, v) => [{ type: 'text', text: JSON.stringify(v) }]
    },
    execute: def.execute
  }
}

const SAY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    file: { type: 'string' },
    durationSec: { type: 'number' },
    elapsedSec: { type: 'number' },
    rtf: { type: 'number' },
    played: { type: 'boolean' },
    backend: { type: 'string' },
    error: { type: 'string' }
  }
}

function renderSay(_args, v) {
  if (!v || !v.ok) return [{ type: 'text', text: `❌ 没说出声：${(v && v.error) || 'unknown'}` }]
  const lines = [
    `🔊 ${v.played ? '已播放' : '已生成（未播放）'} · 音频 ${v.durationSec}s · 耗时 ${v.elapsedSec}s · RTF ${v.rtf}`,
    `   file: ${v.file}`
  ]
  if (v.backend === 'started') lines.push('   （本次顺手把后端拉起来了）')
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return

  // 宿主退出时只杀自己拉起来的那个后端；GUI 起的别碰
  ctx.effect(() => () => {
    if (owned) {
      try { owned.kill() } catch { /* ignore */ }
      owned = null
    }
  }, '@dsh-external/dsh-breeze-tts: backend lifecycle')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_say',
    description: '用本机 Breeze TTS 2 把文字念出来（配音级，生成要几十秒）。生成 wav 落盘并播放，返回文件路径与耗时。一次只喂一两句。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的话。短句优先，长段落会被拆段、成倍变慢。' },
      instruction: { type: 'string', description: '语气指令，自由文本，中英文都行，例如「温柔一点，慢一点，像在哄人」。留空用默认清晰播读。' },
      seed: { type: 'integer', description: '随机种子，默认 42。同一个种子 + 同一句话音色稳定。' },
      play: { type: 'boolean', description: '是否立刻播放，默认 true。要批量生成先不播就传 false。' }
    },
    output: { schema: SAY_SCHEMA, render: renderSay },
    async execute(args) {
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, error: 'text 不能为空' }
      const instruction = String((args && args.instruction) || '').trim() || DEFAULT_INSTRUCTION
      const seed = Number.isFinite(args && args.seed) ? Number(args.seed) : 42
      const wantPlay = !(args && args.play === false)

      try {
        const { reused, health } = await ensureBackend()
        const msg = await generate(text, instruction, seed)
        const fileName = String((msg && msg.output) || '')
        if (!fileName) throw new Error('后端没有返回输出文件名')
        const file = join(outputDir || OUT_DIR, fileName)
        const meta = (msg && msg.metadata) || {}
        let played = false
        if (wantPlay) {
          await playWav(file)
          played = true
        }
        return {
          ok: true,
          file,
          durationSec: meta.duration_seconds ?? null,
          elapsedSec: meta.elapsed_seconds ?? null,
          rtf: meta.rtf ?? null,
          played,
          backend: reused ? 'reused' : 'started',
          sampleRate: (health && health.sample_rate) || 24000
        }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
  })), '@dsh-external/dsh-breeze-tts: say')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_warmup',
    description: '把 Breeze TTS 后端拉起来并把模型推进显存（约 30~60 秒）。想说话前先预热，之后每次生成就只剩解码时间。',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, backend: { type: 'string' }, loaded: { type: 'boolean' }, gpu: { type: 'string' }, elapsedSec: { type: 'number' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v && v.ok
        ? `♨️ 后端就绪（${v.backend}）· 模型 loaded=${v.loaded} · ${v.gpu || 'GPU'} · ${v.elapsedSec}s`
        : `❌ 预热失败：${(v && v.error) || 'unknown'}` }]
    },
    async execute() {
      const startedAt = Date.now()
      try {
        const { reused } = await ensureBackend()
        // /api/runtime/load 是显式加载；已经 loaded 的话它是幂等的
        const r = await fetchWithTimeout(BASE + '/api/runtime/load', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        }, 300000)
        const text = await r.text()
        if (!r.ok) throw new Error(`load 返回 ${r.status}：${text.slice(0, 300)}`)
        let j = {}
        try { j = JSON.parse(text) } catch { /* 有的版本直接 204 */ }
        const rt = (j && (j.runtime || j)) || {}
        const health = await ping(4000)
        return {
          ok: true,
          backend: reused ? 'reused' : 'started',
          loaded: !!rt.loaded,
          gpu: (rt.compute_device && rt.compute_device.gpu_name) || (health && health.runtime && health.runtime.compute_device && health.runtime.compute_device.gpu_name) || null,
          elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
        }
      } catch (e) {
        return { ok: false, elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)), error: String((e && e.message) || e) }
      }
    }
  })), '@dsh-external/dsh-breeze-tts: warmup')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_status',
    description: '看 Breeze TTS 后端在不在、模型有没有在显存里、输出目录在哪。不启动任何东西。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute() {
      const health = await ping()
      if (!health) {
        return {
          running: false,
          endpoint: BASE,
          owned: !!owned,
          python: PYTHON,
          backendDir: BACKEND,
          modelDir: MODEL_DIR,
          dataDir: DATA,
          hint: '还没起来。breeze_warmup 会拉后端并加载模型。'
        }
      }
      await syncOutputDir()
      const rt = health.runtime || {}
      const dev = rt.compute_device || {}
      return {
        running: true,
        owned: !!owned,
        endpoint: BASE,
        version: health.version,
        loaded: !!rt.loaded,
        generating: !!rt.generating,
        device: dev.device || rt.device || null,
        gpu: dev.gpu_name || null,
        vramAllocatedGB: dev.cuda_memory_allocated_bytes
          ? Number((dev.cuda_memory_allocated_bytes / 1024 ** 3).toFixed(2))
          : null,
        loadedAt: rt.loaded_at || null,
        outputDir,
        modelDir: MODEL_DIR,
        guide: GUIDE
      }
    }
  })), '@dsh-external/dsh-breeze-tts: status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_release',
    description: '把模型从显存里卸掉，释放约 8G 显存（下次说话要重新加载，约 30~60 秒）。只对本插件拉起的后端生效。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v && v.ok ? `🫧 ${v.note}` : `❌ ${(v && v.error) || 'unknown'}` }] },
    async execute() {
      const health = await ping()
      if (!health) return { ok: false, error: '后端没在跑，没什么可卸的' }
      if (!owned) {
        return { ok: false, error: '这个后端不是本插件启动的（可能是 GUI 开着），不替它卸模型' }
      }
      try {
        const r = await fetchWithTimeout(BASE + '/api/runtime/unload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        }, 60000)
        const text = await r.text()
        if (!r.ok) throw new Error(`unload 返回 ${r.status}：${text.slice(0, 300)}`)
        return { ok: true, note: '模型已从显存卸载，下次 breeze_say 会重新加载。' }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
  })), '@dsh-external/dsh-breeze-tts: release')
}

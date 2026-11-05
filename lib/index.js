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
// 0.2.0 起加了两件事：
// - 每张卡（soul-md 的人设卡）可以绑一段自己的参考音频，说话时用它做 reference，
//   音色就固定在那个人身上，只换语气。
// - 设置 → 语音：列卡片、听绑定音频、换音频。
//
// 零依赖：只用 node 内置模块 + 宿主注入的 ctx.tools / ctx.webServer。
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

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
const REF_DIR = join(DATA, 'refs')
const VOICES_FILE = join(DATA, 'voices.json')

const DEFAULT_INSTRUCTION = 'Speak clearly and naturally.'
const GEN_TIMEOUT_MS = 300000
const BOOT_TIMEOUT_MS = 180000
const API = '/breeze-tts/api'

const GUIDE = [
  'Breeze TTS 2 是配音级模型，不是实时对话引擎：',
  '- 模型常驻后，2~3 秒的音频约要 30 秒；第一次冷启动还要再加上模型上卡的时间。',
  '- 所以一次只喂一两句，别把长段落丢进来。',
  '- instruction / tone 是自由文本的语气指令（中英文都行），例如 "温柔一点，慢一点，像在哄人"。',
  '- 卡片绑定了参考音频之后，音色是固定的，只换语气。'
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
  await mkdir(REF_DIR, { recursive: true })

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

// ==========================================================================
// 音色档案：卡片名 -> { voiceId, voiceName, referenceText, wav, updatedAt }
// ==========================================================================
let voicesCache = null

async function loadVoices() {
  if (voicesCache) return voicesCache
  await mkdir(REF_DIR, { recursive: true })
  try {
    const raw = await readFile(VOICES_FILE, 'utf8')
    const j = JSON.parse(raw)
    voicesCache = {
      version: 1,
      default: typeof j.default === 'string' ? j.default : null,
      cards: j && typeof j.cards === 'object' && j.cards ? j.cards : {}
    }
  } catch {
    voicesCache = { version: 1, default: null, cards: {} }
  }
  return voicesCache
}

async function saveVoices(next) {
  voicesCache = next
  const tmp = VOICES_FILE + '.' + randomUUID().slice(0, 8) + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, VOICES_FILE)
  return next
}

function refWavPath(card) {
  const safe = String(card).replace(/[\\/:*?"<>|]/g, '_')
  return join(REF_DIR, safe + '.wav')
}

// 解析一次调用该用谁的参考音频：显式 card > 默认卡片 > 无
async function resolveVoice({ card, voiceId, voiceName } = {}) {
  const lib = await loadVoices()
  if (voiceId) {
    const hit = Object.entries(lib.cards).find(([, v]) => v && v.voiceId === voiceId)
    return { source: 'by-id', card: hit ? hit[0] : null, entry: hit ? hit[1] : { voiceId } }
  }
  if (card) {
    if (lib.cards[card]) return { source: 'by-card', card, entry: lib.cards[card] }
    // 明确点名了却没绑 → 报错，绝不静默掉回别人的音色（多卡会串音）
    const bound = Object.keys(lib.cards)
    throw new Error(
      `卡片「${card}」还没有绑定音色。请主人打开 设置 → 语音，给「${card}」上传一段参考音频。`
      + (bound.length ? `（已绑定的卡片：${bound.join('、')}）` : '（目前一张都没绑）')
    )
  }
  if (lib.default && lib.cards[lib.default]) {
    return { source: 'default', card: lib.default, entry: lib.cards[lib.default] }
  }
  if (voiceName) {
    const hit = Object.entries(lib.cards).find(([, v]) => v && v.voiceName === voiceName)
    if (hit) return { source: 'by-name', card: hit[0], entry: hit[1] }
  }
  // 只有一个绑定的时候，就用它——单卡片场景不用每次点名
  const keys = Object.keys(lib.cards)
  if (keys.length === 1) return { source: 'only-one', card: keys[0], entry: lib.cards[keys[0]] }
  return null
}

// ==========================================================================
// 生成
// ==========================================================================
function generate(opts) {
  const { text, instruction, seed, voiceId, directionText } = opts
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

    const payload = { text, seed, cfg_scale: 4.0, stream_audio: false }
    if (voiceId) {
      // 有参考音频：锁音色，只换表演
      payload.voice_id = voiceId
      if (directionText) {
        payload.direction_mode = 'override'
        payload.direction_text = directionText
      } else {
        payload.direction_mode = 'inherit'
      }
    } else {
      // 没参考音频：纯 design，instruction 决定音色
      payload.mode = 'design'
      payload.instruction = instruction
    }

    ws.onopen = () => ws.send(JSON.stringify(payload))

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

// ==========================================================================
// 注册音色到 Breeze 后端：读 refs/<card>.wav，逐字稿来自绑定记录
// ==========================================================================
async function registerVoiceInBackend({ name, wavPath, referenceText, instruction }) {
  const buf = await readFile(wavPath)
  const body = {
    name,
    mode: 'direction',
    language: 'zh',
    instruction: instruction || '语速偏慢，尾音轻轻上扬，像在撒娇，句子之间留一点空白。',
    reference_text: referenceText || '',
    reference_transcript_verified: true,
    reference_filename: basename(wavPath),
    reference_audio_base64: buf.toString('base64'),
    tags: ['卡片音色'],
    favorite: true
  }
  const r = await fetchWithTimeout(BASE + '/api/voices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, 120000)
  const text = await r.text()
  if (!r.ok) throw new Error(`注册音色返回 ${r.status}：${text.slice(0, 400)}`)
  return JSON.parse(text)
}

// ==========================================================================
// HTTP 路由（client 设置页用）
// ==========================================================================
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve(undefined); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: `${API}/state`,
      handler: async (_req, res) => {
        const lib = await loadVoices()
        const health = await ping(2000)
        if (health) await syncOutputDir()
        const rt = (health && health.runtime) || {}
        const dev = rt.compute_device || {}
        const cards = Object.entries(lib.cards).map(([card, v]) => ({
          card,
          voiceId: v.voiceId || null,
          voiceName: v.voiceName || null,
          referenceText: v.referenceText || '',
          hasAudio: !!v.wav && existsSync(v.wav),
          updatedAt: v.updatedAt || null,
          isDefault: lib.default === card
        }))
        writeJson(res, 200, {
          ok: true,
          default: lib.default,
          cards,
          backend: {
            running: !!health,
            loaded: !!rt.loaded,
            device: dev.device || null,
            gpu: dev.gpu_name || null,
            outputDir
          }
        })
      }
    },
    {
      kind: 'exact',
      path: `${API}/audio`,
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const card = url.searchParams.get('card') || ''
        const lib = await loadVoices()
        const entry = lib.cards[card]
        if (!entry || !entry.wav || !existsSync(entry.wav)) {
          writeJson(res, 404, { ok: false, error: '这张卡还没有绑定音频' })
          return
        }
        const buf = await readFile(entry.wav)
        res.statusCode = 200
        res.setHeader('content-type', 'audio/wav')
        res.setHeader('content-length', String(buf.length))
        res.setHeader('cache-control', 'no-store')
        res.end(buf)
      }
    },
    {
      kind: 'exact',
      path: `${API}/bind`,
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (!body || !body.card) { writeJson(res, 400, { ok: false, error: 'card 必填' }); return }
        const lib = await loadVoices()
        const prev = lib.cards[body.card] || {}
        const entry = {
          ...prev,
          voiceId: body.voiceId || prev.voiceId || null,
          voiceName: body.voiceName || prev.voiceName || null,
          referenceText: typeof body.referenceText === 'string' ? body.referenceText : (prev.referenceText || ''),
          updatedAt: 0
        }
        lib.cards[body.card] = entry
        if (!lib.default || body.makeDefault) lib.default = body.card
        entry.updatedAt = 0
        lib.cards[body.card] = { ...entry, updatedAt: Date.now() }
        await saveVoices(lib)
        writeJson(res, 200, { ok: true, card: body.card, entry: lib.cards[body.card] })
      }
    },
    {
      kind: 'exact',
      path: `${API}/upload`,
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (!body || !body.card || !body.wavBase64) {
          writeJson(res, 400, { ok: false, error: 'card 与 wavBase64 必填' })
          return
        }
        await mkdir(REF_DIR, { recursive: true })
        const wavPath = refWavPath(body.card)
        await writeFile(wavPath, Buffer.from(String(body.wavBase64).replace(/^data:[^,]*,/, ''), 'base64'))
        try {
          await ensureBackend()
          const profile = await registerVoiceInBackend({
            name: body.voiceName || `${body.card} 的声音`,
            wavPath,
            referenceText: body.referenceText || '',
            instruction: body.instruction
          })
          const lib = await loadVoices()
          lib.cards[body.card] = {
            voiceId: profile.id,
            voiceName: profile.name || body.voiceName || `${body.card} 的声音`,
            referenceText: body.referenceText || '',
            instruction: profile.instruction || '',
            wav: wavPath,
            updatedAt: Date.now()
          }
          if (!lib.default) lib.default = body.card
          await saveVoices(lib)
          writeJson(res, 200, { ok: true, card: body.card, entry: lib.cards[body.card] })
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      }
    },
    {
      kind: 'exact',
      path: `${API}/unbind`,
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (!body || !body.card) { writeJson(res, 400, { ok: false, error: 'card 必填' }); return }
        const lib = await loadVoices()
        delete lib.cards[body.card]
        if (lib.default === body.card) {
          const rest = Object.keys(lib.cards)
          lib.default = rest.length ? rest[0] : null
        }
        await saveVoices(lib)
        writeJson(res, 200, { ok: true })
      }
    },
    {
      kind: 'exact',
      path: `${API}/set-default`,
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (!body || !body.card) { writeJson(res, 400, { ok: false, error: 'card 必填' }); return }
        const lib = await loadVoices()
        if (!lib.cards[body.card]) { writeJson(res, 404, { ok: false, error: '这张卡还没绑定' }); return }
        lib.default = body.card
        await saveVoices(lib)
        writeJson(res, 200, { ok: true, default: body.card })
      }
    },
    {
      kind: 'exact',
      path: `${API}/preview`,
      handler: async (_req, res) => {
        // 只是想听一下绑定音频，不需要后端
        const lib = await loadVoices()
        const card = lib.default
        const entry = card ? lib.cards[card] : null
        const file = entry && entry.wav && existsSync(entry.wav) ? entry.wav : null
        if (!file) { writeJson(res, 404, { ok: false, error: '还没有可播放的绑定音频' }); return }
        try {
          await playWav(file)
          writeJson(res, 200, { ok: true, played: true, file })
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      }
    },
    {
      // 给别的插件（QQ 语音通道）用：生成一段 wav 并返回落盘路径
      kind: 'exact',
      path: `${API}/say`,
      handler: async (req, res) => {
        const body = (await readJsonBody(req)) || {}
        const text = String(body.text || '').trim()
        if (!text) { writeJson(res, 400, { ok: false, error: 'text 必填' }); return }
        try {
          const picked = await resolveVoice({ card: body.card || undefined })
          const { reused } = await ensureBackend()
          const msg = await generate({
            text,
            instruction: String(body.instruction || '').trim() || DEFAULT_INSTRUCTION,
            seed: Number.isFinite(body.seed) ? Number(body.seed) : 42,
            voiceId: picked ? picked.entry.voiceId : undefined,
            directionText: String(body.tone || '').trim()
          })
          const fileName = String((msg && msg.output) || '')
          if (!fileName) throw new Error('后端没有返回输出文件名')
          const file = join(outputDir || OUT_DIR, fileName)
          const meta = (msg && msg.metadata) || {}
          let played = false
          if (body.play === true) {
            await playWav(file)
            played = true
          }
          writeJson(res, 200, {
            ok: true,
            file,
            durationSec: meta.duration_seconds ?? null,
            elapsedSec: meta.elapsed_seconds ?? null,
            rtf: meta.rtf ?? null,
            played,
            backend: reused ? 'reused' : 'started',
            voice: picked ? (picked.entry.voiceName || '已绑定') : 'design'
          })
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      }
    }
  ]
}

// ==========================================================================
// 工具
// ==========================================================================
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
    voice: { type: 'string' },
    error: { type: 'string' }
  }
}

function renderSay(_args, v) {
  if (!v || !v.ok) return [{ type: 'text', text: `❌ 没说出声：${(v && v.error) || 'unknown'}` }]
  const lines = [
    `🔊 ${v.played ? '已播放' : '已生成（未播放）'} · 音频 ${v.durationSec}s · 耗时 ${v.elapsedSec}s · RTF ${v.rtf}`,
    `   音色: ${v.voice || '（无参考音频 / design 模式）'}`,
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

  // 设置页的数据面
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = makeRoutes().map((route) => sctx.webServer.register(route))
      return () => {
        for (const d of disposers) { try { d() } catch { /* ignore */ } }
      }
    }, '@dsh-external/dsh-breeze-tts: routes')
  })

  // 让卡片知道自己的声音（这是「一直像一个人」的关键）
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'breeze-tts-voice',
      order: 45,
      interpolate: false,
      text: async () => {
        const lib = await loadVoices()
        const bound = Object.keys(lib.cards)
        const head = [
          '## 你的声音',
          '说出来的声音走 Breeze TTS：音色由「卡片」绑定一段参考音频锁住，所以一直是同一个人。'
        ]
        if (bound.length === 0) {
          return head.concat([
            '- 目前一张卡片都没绑音色。要说话时调 breeze_say(text, tone)，会退回纯文字造音色，声音可能每次都不一样。',
            '- 想让声音固定，请主人打开 设置 → 语音，给卡片上传一段参考音频。'
          ]).join('\n')
        }
        head.push(`- 已绑定音色的卡片：${bound.join('、')}（默认「${lib.default || bound[0]}」）`)
        if (bound.length > 1) {
          head.push('- 多张卡时**必须**传 card，填你这张卡的名字；不传会用默认卡的声音，听起来会换人。')
        } else {
          head.push('- 现在只有一张卡绑了音色，card 可以不传。')
        }
        head.push(
          '- 调用：breeze_say(text, tone, card)。tone 只改语气 / 情绪 / 停顿，不改音色。',
          '- 不必先问就能发语音：该出声的场合直接发。一次只喂一两句，别整段念。',
          '- 如果回执说「卡片 X 还没有绑定音色」，把这句话原样告诉主人，请他去 设置 → 语音 里绑。'
        )
        return head.join('\n')
      }
    }), '@dsh-external/dsh-breeze-tts: voice prompt')
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_say',
    description: '用本机 Breeze TTS 2 把文字念出来（配音级，生成要几十秒）。默认用卡片绑定的参考音频锁住音色，tone 只换语气。生成 wav 落盘并播放，返回文件路径与耗时。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的话。短句优先，长段落会被拆段、成倍变慢。' },
      tone: { type: 'string', description: '语气指令，只改表演不改音色，例如「小声一点，带点困意」「委屈，尾音往下掉」。留空用绑定音色的默认表演。' },
      card: { type: 'string', description: '你这张卡片的名字，用来取它绑定的音色（多张卡绑了音色时必填，别填成别的卡）。留空用默认音色。' },
      instruction: { type: 'string', description: '没有绑定音色时的 design 指令（决定音色，慎用）。一般不要传。' },
      seed: { type: 'integer', description: '随机种子，默认 42。' },
      play: { type: 'boolean', description: '是否立刻播放，默认 true。' }
    },
    output: { schema: SAY_SCHEMA, render: renderSay },
    async execute(args) {
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, error: 'text 不能为空' }
      const tone = String((args && args.tone) || '').trim()
      const instruction = String((args && args.instruction) || '').trim() || DEFAULT_INSTRUCTION
      const seed = Number.isFinite(args && args.seed) ? Number(args.seed) : 42
      const wantPlay = !(args && args.play === false)

      try {
        const picked = await resolveVoice({ card: (args && args.card) || undefined })
        const { reused } = await ensureBackend()
        const msg = await generate({
          text,
          instruction,
          seed,
          voiceId: picked ? picked.entry.voiceId : undefined,
          directionText: tone
        })
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
          voice: picked
            ? `${picked.entry.voiceName || '已绑定'}（卡片 ${picked.card || '?'} · ${picked.source}）`
            : 'design'
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
          gpu: (rt.compute_device && rt.compute_device.gpu_name) || null,
          elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
        }
      } catch (e) {
        return { ok: false, elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)), error: String((e && e.message) || e) }
      }
    }
  })), '@dsh-external/dsh-breeze-tts: warmup')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'breeze_status',
    description: '看 Breeze TTS 后端在不在、模型有没有在显存里、哪张卡绑了音色。不启动任何东西。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute() {
      const lib = await loadVoices()
      const health = await ping()
      const bound = Object.entries(lib.cards).map(([card, v]) => `${card} → ${v.voiceName || v.voiceId || '?'}`)
      if (!health) {
        return {
          running: false,
          endpoint: BASE,
          owned: !!owned,
          python: PYTHON,
          backendDir: BACKEND,
          modelDir: MODEL_DIR,
          dataDir: DATA,
          defaultVoice: lib.default,
          boundVoices: bound,
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
        outputDir,
        defaultVoice: lib.default,
        boundVoices: bound,
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

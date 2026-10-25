import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'

const MODEL_REPO = 'Smirnov75/GigaAM-v3-sherpa-onnx/resolve/main'
const RESOURCE = 'GigaAM v3 e2e CTC (int8)'
const FILES = [
  {
    key: 'model',
    name: 'gigaam_v3_e2e_ctc_int8.onnx',
    bytes: 319869121,
    sha256: '0aacb41f70f0f5aaac4b45dd430337b9e16b180f22c72af04db8516e7609c3c0',
  },
  {
    key: 'tokens',
    name: 'gigaam_v3_e2e_ctc_tokens.txt',
    bytes: 2006,
    sha256: 'f8eb9b115e2748db9c40a5897cae11dd0678cc0b40fd7e25f8c43b3bf28715e4',
  },
]

export const name = 'dsh-gigaam-stt'
export const inject = ['speechToText']

const DEFAULT_ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com']
const WAVE_ERROR = 'Audio must be a canonical 16 kHz mono PCM16 WAV recording'

/** The linked plugin cannot import DSH packages, so its patch config is validated here. */
function settings(config) {
  const dataRoot = config?.dataRoot
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot))
    throw new Error('dsh-gigaam-stt: dataRoot must be an absolute path')
  const origins = config.modelOrigins ?? DEFAULT_ORIGINS
  if (!Array.isArray(origins) || origins.length === 0) throw new Error('dsh-gigaam-stt: modelOrigins is empty')
  for (const origin of origins) new URL(origin)
  const maxSegmentSeconds = config.maxSegmentSeconds ?? 20
  if (!Number.isInteger(maxSegmentSeconds) || maxSegmentSeconds < 5 || maxSegmentSeconds > 180)
    throw new Error('dsh-gigaam-stt: maxSegmentSeconds must be an integer between 5 and 180')
  const numbers = config.numbers ?? 'digits'
  if (numbers !== 'digits' && numbers !== 'words')
    throw new Error("dsh-gigaam-stt: numbers must be 'digits' or 'words'")
  return {
    providerId: config.providerId ?? 'gigaam-local',
    dataRoot,
    modelOrigins: origins,
    threads: config.threads ?? 4,
    idleTimeoutMs: config.idleTimeoutMs ?? 300000,
    maxAudioSeconds: config.maxAudioSeconds ?? 600,
    maxSegmentSeconds,
    numbers,
    progressIntervalMs: config.progressIntervalMs ?? 100,
  }
}

/** Same canonical-WAV contract the browser recorder produces: PCM16, mono, 16 kHz, no extra chunks. */
function parseWave(audio, maxSeconds) {
  const buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (
    buffer.byteLength < 44 ||
    buffer.toString('latin1', 0, 4) !== 'RIFF' ||
    buffer.readUInt32LE(4) !== buffer.byteLength - 8 ||
    buffer.toString('latin1', 8, 12) !== 'WAVE' ||
    buffer.toString('latin1', 12, 16) !== 'fmt ' ||
    buffer.readUInt32LE(16) !== 16 ||
    buffer.readUInt16LE(20) !== 1 ||
    buffer.readUInt16LE(22) !== 1 ||
    buffer.readUInt32LE(24) !== 16000 ||
    buffer.readUInt32LE(28) !== 32000 ||
    buffer.readUInt16LE(32) !== 2 ||
    buffer.readUInt16LE(34) !== 16 ||
    buffer.toString('latin1', 36, 40) !== 'data' ||
    buffer.readUInt32LE(40) !== buffer.byteLength - 44 ||
    (buffer.byteLength - 44) % 2 !== 0
  )
    throw new Error(WAVE_ERROR)
  const audioSeconds = (buffer.byteLength - 44) / 32000
  if (audioSeconds > maxSeconds) throw new Error(`Audio exceeds ${maxSeconds} seconds`)
  return audioSeconds
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Locate the sherpa-onnx native addon. This plugin is linked into a profile and imports no
 * DSH package, so the addon is resolved from the DSH launcher itself and can be overridden.
 */
let sherpaPath
function resolveSherpa() {
  if (sherpaPath) return sherpaPath
  if (process.env.GIGAAM_SHERPA_PATH) return (sherpaPath = process.env.GIGAAM_SHERPA_PATH)
  const tried = []
  for (const anchor of resolveAnchors()) {
    try {
      return (sherpaPath = createRequire(anchor).resolve('sherpa-onnx-node'))
    } catch (error) {
      tried.push(`${anchor} (${error?.code ?? 'error'})`)
    }
  }
  const found = searchSherpa()
  if (found) {
    process.stderr.write(`[gigaam-stt] sherpa найден обходом резолвера: ${found}\n`)
    return (sherpaPath = found)
  }
  throw new Error(
    `sherpa-onnx-node не найден. Проверено: ${tried.join(', ') || 'нет якорей'}; обход каталогов не дал результата. ` +
      'Укажите GIGAAM_SHERPA_PATH=/абс/путь/sherpa-onnx-node/sherpa-onnx.js',
  )
}

function resolveAnchors() {
  const anchors = [import.meta.url]
  for (const path of [process.argv[1], process.execPath]) {
    if (!path) continue
    try {
      anchors.push(realpathSync(path))
    } catch {}
  }
  return anchors
}

function searchSherpa() {
  const seeds = [dirname(fileURLToPath(import.meta.url)), process.cwd()]
  for (const path of [process.argv[1], process.execPath]) {
    if (!path) continue
    try {
      seeds.push(dirname(realpathSync(path)))
    } catch {}
  }
  for (const seed of seeds) {
    let dir = seed
    for (let depth = 0; depth < 12; depth += 1) {
      for (const candidate of [
        join(dir, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
        join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
      ])
        if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

class GigaamProvider {
  #config
  #paths
  #listeners = new Set()
  #state = { phase: 'unprepared' }
  #chain = Promise.resolve()
  #preparing
  #downloadSource
  #abort = new AbortController()
  #worker
  #loaded = false
  #pending = new Map()
  #nextId = 0
  #idle
  #lastProgress = 0

  constructor(config) {
    this.#config = config
    this.#paths = Object.fromEntries(FILES.map((file) => [file.key, join(config.dataRoot, file.name)]))
  }

  get info() {
    return {
      id: this.#config.providerId,
      name: 'GigaAM v3 (локально, CPU)',
      location: 'host-local',
      languages: ['ru'],
      setupEstimate: {
        recommendedDiskBytes: 330000000,
        expectedMemoryBytes: 520000000,
        minimumMinutes: 1,
        maximumMinutes: 10,
      },
      downloadSources: this.#config.modelOrigins,
    }
  }

  get preparation() {
    return this
  }

  snapshot() {
    return this.#state
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #publish(state) {
    this.#state = state
    for (const listener of [...this.#listeners]) listener()
  }

  /** Activation does no I/O beyond checking whether the pinned files are already complete. */
  async inspect() {
    if (this.#state.phase !== 'unprepared') return
    for (const file of FILES) if (!(await this.#matches(file))) return false
    this.#publish({ phase: 'standby' })
    return true
  }

  prepare(options) {
    const phase = this.#state.phase
    if (phase === 'ready' || phase === 'waking' || phase === 'loading' || phase === 'checking' || phase === 'downloading') return
    const source = options?.downloadSource
    if (source !== undefined && !this.#config.modelOrigins.includes(source))
      throw new Error(`Неизвестный источник загрузки: ${source}`)
    this.#downloadSource = source
    this.#abort = new AbortController()
    this.#preparing = this.#runPrepare(source)
    this.#preparing.catch(() => {}).finally(() => {
      this.#preparing = undefined
    })
  }

  async cancel() {
    if (!this.#preparing) return
    this.#abort.abort(new Error('Download cancelled'))
    this.#publish({ phase: 'cancelling', startedAt: Date.now() })
    await this.#preparing
    await this.stop()
    this.#publish({ phase: 'cancelled' })
  }

  async transcribe(input, signal) {
    const audioSeconds = parseWave(input.audio, this.#config.maxAudioSeconds)
    return await this.#serial(async () => {
      signal?.throwIfAborted?.()
      await this.#ensureReady()
      const wav = new Uint8Array(input.audio)
      const result = await this.#request((this.#nextId += 1), wav, signal)
      return { text: result.text, audioSeconds, inferenceSeconds: result.inferenceSeconds }
    })
  }

  async stop() {
    clearTimeout(this.#idle)
    const worker = this.#worker
    this.#worker = undefined
    this.#loaded = false
    worker?.handle.terminate()
    if (this.#state.phase === 'ready') this.#publish({ phase: 'standby' })
  }

  async dispose() {
    this.#listeners.clear()
    this.#abort.abort(new Error('GigaAM provider disposed'))
    clearTimeout(this.#idle)
    try {
      await this.#preparing
    } catch {}
    await this.stop()
  }

  async #runPrepare(source) {
    try {
      this.#publish({ phase: 'checking', startedAt: Date.now() })
      await this.#ensureFiles(source)
      this.#publish({ phase: 'loading', startedAt: Date.now() })
      await this.#start()
      this.#publish({ phase: 'ready' })
      this.#touchIdle()
    } catch (error) {
      if (this.#abort.signal.aborted) return
      this.#publish({ phase: 'failed', message: messageOf(error) })
    }
  }

  async #ensureFiles(source) {
    const origins = source === undefined ? this.#config.modelOrigins : [source]
    await mkdir(this.#config.dataRoot, { recursive: true })
    const total = FILES.reduce((sum, file) => sum + file.bytes, 0)
    let done = 0
    for (const file of FILES) {
      if (await this.#matches(file)) {
        done += file.bytes
        continue
      }
      const targets = origins.map((origin) => new URL(`${MODEL_REPO}/${file.name}`, origin))
      let failure
      for (const url of targets) {
        try {
          await this.#download(file, url, done, total)
          failure = undefined
          break
        } catch (error) {
          if (this.#abort.signal.aborted) throw error
          failure = error
        }
      }
      if (failure) throw failure
      done += file.bytes
    }
  }

  async #download(file, url, done, total) {
    const target = this.#paths[file.key]
    const part = `${target}.part`
    const response = await fetch(url, { signal: this.#abort.signal })
    if (!response.ok) throw new Error(`Не удалось скачать ${file.name}: HTTP ${response.status} (${url.href})`)
    const hash = createHash('sha256')
    const handle = await open(part, 'w')
    let bytes = 0
    try {
      for await (const chunk of response.body) {
        hash.update(chunk)
        await handle.write(chunk)
        bytes += chunk.length
        this.#progress(done + bytes, total)
      }
    } finally {
      await handle.close()
    }
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) {
      await rm(part, { force: true })
      throw new Error(`Файл ${file.name} повреждён: ${bytes} байт вместо ${file.bytes}`)
    }
    await rename(part, target)
  }

  #progress(completedBytes, totalBytes) {
    const now = Date.now()
    if (this.#state.phase === 'downloading' && now - this.#lastProgress < this.#config.progressIntervalMs) return
    this.#lastProgress = now
    this.#publish({ phase: 'downloading', resource: RESOURCE, completedBytes, totalBytes })
  }

  async #matches(file) {
    try {
      return (await stat(this.#paths[file.key])).size === file.bytes
    } catch {
      return false
    }
  }

  async #ensureReady() {
    const phase = this.#state.phase
    if (phase === 'ready') return
    if (phase === 'cancelled') throw new Error('Подготовка отменена — запустите загрузку модели заново')
    this.#publish({ phase: 'waking', startedAt: Date.now() })
    try {
      await this.#start()
    } catch (error) {
      this.#publish({ phase: 'failed', message: messageOf(error) })
      throw error
    }
    this.#publish({ phase: 'ready' })
  }

  async #start() {
    if (this.#loaded) return
    if (!this.#worker) this.#worker = this.#spawn()
    await this.#worker.ready
  }

  #spawn() {
    const handle = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: {
        sherpaPath: resolveSherpa(),
        model: this.#paths.model,
        tokens: this.#paths.tokens,
        threads: this.#config.threads,
        maxSegmentSeconds: this.#config.maxSegmentSeconds,
        numbers: this.#config.numbers,
      },
    })
    const entry = { handle, ready: undefined, resolveReady: undefined, rejectReady: undefined }
    entry.ready = new Promise((resolve, reject) => {
      entry.resolveReady = resolve
      entry.rejectReady = reject
    })
    entry.ready.catch(() => {})
    handle.on('message', (message) => this.#onMessage(entry, message))
    handle.on('error', (error) => this.#fail(error))
    handle.on('exit', (code) => {
      if (this.#worker !== entry) return
      this.#fail(new Error(`Распознаватель завершился с кодом ${code}`))
    })
    handle.postMessage({ type: 'load' })
    return entry
  }

  #onMessage(entry, message) {
    if (message.type === 'loaded') {
      this.#loaded = true
      entry.resolveReady()
      return
    }
    if (message.type === 'load-failed') {
      entry.rejectReady(new Error(`Не удалось загрузить модель: ${message.message}`))
      this.#fail(new Error(message.message))
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if (message.type === 'result') pending.resolve(message)
    else pending.reject(new Error(`Ошибка распознавания: ${message.message}`))
  }

  #fail(error) {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#loaded = false
    const worker = this.#worker
    this.#worker = undefined
    worker?.handle.terminate()
    if (this.#state.phase === 'ready' || this.#state.phase === 'waking')
      this.#publish({ phase: 'failed', message: messageOf(error) })
  }

  #request(id, wav, signal) {
    const worker = this.#worker
    if (!worker) return Promise.reject(new Error('Распознаватель не запущен'))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id)
        reject(signal.reason ?? new Error('Transcription aborted'))
      }
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          this.#touchIdle()
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.handle.postMessage({ type: 'transcribe', id, wav }, [wav.buffer])
    })
  }

  #serial(task) {
    const run = this.#chain.then(task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  #touchIdle() {
    clearTimeout(this.#idle)
    const ms = this.#config.idleTimeoutMs
    if (ms === 0) return
    this.#idle = setTimeout(() => {
      if (this.#pending.size > 0) {
        this.#touchIdle()
        return
      }
      void this.stop()
    }, ms)
    this.#idle.unref?.()
  }
}

export function apply(ctx, config) {
  const provider = new GigaamProvider(settings(config))
  ctx.effect(() => {
    const unregister = ctx.speechToText.register(provider)
    try {
      process.stderr.write(`[gigaam-stt] провайдер зарегистрирован, sherpa: ${resolveSherpa()}\n`)
    } catch (error) {
      process.stderr.write(`[gigaam-stt] провайдер зарегистрирован, sherpa НЕ найден: ${error.message}\n`)
    }
    void provider.inspect()
    return async () => {
      const removing = unregister()
      await provider.dispose()
      await removing
    }
  })
}

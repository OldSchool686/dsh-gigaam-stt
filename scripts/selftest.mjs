import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { normalizeNumbers } from '../itn.js'
import { splitAtPauses } from '../segment.js'

// Checks the worker contract only (protocol + PCM handling), so it runs without DSH.
// Usage: node scripts/selftest.mjs   [GIGAAM_SAMPLE=path/to.wav GIGAAM_LONG=1 GIGAAM_MODEL_DIR=dir SHERPA_PATH=...]

const modelDir = process.env.GIGAAM_MODEL_DIR ?? join(homedir(), '.dsh', 'speech-to-text', 'gigaam')

function sherpaPath() {
  if (process.env.SHERPA_PATH) return process.env.SHERPA_PATH
  for (const anchor of ['/usr/lib/node_modules/@deepseek-ai/dsh/package.json', process.argv[1]]) {
    try {
      return createRequire(anchor).resolve('sherpa-onnx-node')
    } catch {}
  }
  throw new Error('sherpa-onnx-node is not installed; point SHERPA_PATH at it')
}

function wavFrom(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(Math.round(samples[index] * 32767), 44 + index * 2)
  return new Uint8Array(buffer)
}

function silenceWav(seconds = 1) {
  return wavFrom(new Float32Array(16000 * seconds))
}

function tone(seconds, amplitude = 0.25) {
  const samples = new Float32Array(16000 * seconds)
  for (let index = 0; index < samples.length; index += 1) samples[index] = amplitude * Math.sin((2 * Math.PI * 180 * index) / 16000)
  return samples
}

function concatenate(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}

function nextMessage(worker, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out')), timeoutMs)
    worker.once('message', (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

// Numbers: only unambiguous runs and single words from two upward are rewritten.
assert.equal(normalizeNumbers('у меня двадцать пять яблок'), 'у меня 25 яблок')
assert.equal(normalizeNumbers('в две тысячи двадцать пятом году'), 'в 2025 году')
assert.equal(normalizeNumbers('сто двадцать три рубля'), '123 рубля')
assert.equal(normalizeNumbers('два миллиона триста тысяч'), '2300000')
assert.equal(normalizeNumbers('три раза'), '3 раза')
assert.equal(normalizeNumbers('пять,'), '5,')
assert.equal(normalizeNumbers('ни один не пришёл'), 'ни один не пришёл')
assert.equal(normalizeNumbers('один в один'), 'один в один')
assert.equal(normalizeNumbers('полтора часа'), 'полтора часа')
assert.equal(normalizeNumbers('ни одна не пришла'), 'ни одна не пришла')
assert.equal(normalizeNumbers('ноль градусов'), 'ноль градусов')
console.log('numbers ok')

// Segmentation: speech windows stay under the limit and are cut inside pauses.
const speech = concatenate(tone(5), new Float32Array(16000), tone(5))
assert.equal(splitAtPauses(speech, 20).length, 1, 'a short utterance is one window')
const short = splitAtPauses(speech, 8)
assert.equal(short.length, 2, 'an 8 s limit splits the 5+1+5 s utterance in the pause')
assert.ok(short[0].end <= 5 * 16000 + 16000, 'the first window ends inside the pause')
assert.equal(splitAtPauses(new Float32Array(16000 * 2), 20).length, 0, 'silence has no windows')
console.log('segmentation ok')

const worker = new Worker(new URL('../worker.js', import.meta.url), {
  workerData: {
    sherpaPath: sherpaPath(),
    model: join(modelDir, 'gigaam_v3_e2e_ctc_int8.onnx'),
    tokens: join(modelDir, 'gigaam_v3_e2e_ctc_tokens.txt'),
    threads: 4,
    maxSegmentSeconds: 20,
    numbers: 'digits',
  },
})

try {
  worker.postMessage({ type: 'load' })
  const loaded = await nextMessage(worker)
  assert.equal(loaded.type, 'loaded', `model load failed: ${loaded.message}`)

  const silence = silenceWav(1)
  worker.postMessage({ type: 'transcribe', id: 1, wav: silence }, [silence.buffer])
  const quiet = await nextMessage(worker)
  assert.equal(quiet.type, 'result', `transcription failed: ${quiet.message}`)
  assert.equal(quiet.id, 1)
  assert.equal(typeof quiet.text, 'string')
  assert.equal(typeof quiet.inferenceSeconds, 'number')
  console.log(`silence ok (${quiet.inferenceSeconds.toFixed(2)}s)`)

  if (process.env.GIGAAM_SAMPLE) {
    const sample = new Uint8Array(await readFile(process.env.GIGAAM_SAMPLE))
    worker.postMessage({ type: 'transcribe', id: 2, wav: sample }, [sample.buffer])
    const result = await nextMessage(worker)
    assert.equal(result.type, 'result', `transcription failed: ${result.message}`)
    assert.match(result.text, /[а-яё]/i, `expected Cyrillic speech, got ${JSON.stringify(result.text)}`)
    console.log(`sample ok (${result.inferenceSeconds.toFixed(2)}s): ${result.text}`)

    if (process.env.GIGAAM_LONG) {
      // 19 copies exceed the ~200 s single-pass ceiling that used to abort the worker.
      const again = new Uint8Array(await readFile(process.env.GIGAAM_SAMPLE))
      const pcm = Buffer.from(again.subarray(44))
      const data = Buffer.alloc(pcm.length * 19)
      for (let copy = 0; copy < 19; copy += 1) pcm.copy(data, copy * pcm.length)
      const wav = Buffer.concat([Buffer.from(again.subarray(0, 44)), data])
      wav.writeUInt32LE(wav.byteLength - 8, 4)
      wav.writeUInt32LE(wav.byteLength - 44, 40)
      const long = new Uint8Array(wav)
      worker.postMessage({ type: 'transcribe', id: 3, wav: long }, [long.buffer])
      const longResult = await nextMessage(worker, 300000)
      assert.equal(longResult.type, 'result', `long transcription failed: ${longResult.message}`)
      const words = longResult.text.split(/\s+/).filter(Boolean).length
      assert.ok(words > 450, `expected the full long transcript, got ${words} words`)
      console.log(`long ok (${((wav.byteLength - 44) / 32000).toFixed(1)}s audio, ${words} words, ${longResult.inferenceSeconds.toFixed(2)}s)`)
    }
  }

  console.log('ok')
} finally {
  await worker.terminate()
}

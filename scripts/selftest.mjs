import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

// Checks the worker contract only (protocol + PCM handling), so it runs without DSH.
// Usage: node scripts/selftest.mjs   [GIGAAM_SAMPLE=path/to.wav GIGAAM_MODEL_DIR=dir SHERPA_PATH=...]

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

function silenceWav(seconds = 1) {
  const samples = 16000 * seconds
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
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
  buffer.writeUInt32LE(samples * 2, 40)
  return new Uint8Array(buffer)
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

const worker = new Worker(new URL('../worker.js', import.meta.url), {
  workerData: {
    sherpaPath: sherpaPath(),
    model: join(modelDir, 'gigaam_v3_e2e_ctc_int8.onnx'),
    tokens: join(modelDir, 'gigaam_v3_e2e_ctc_tokens.txt'),
    threads: 4,
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
  }

  console.log('ok')
} finally {
  await worker.terminate()
}

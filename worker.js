import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { normalizeNumbers } from './itn.js'
import { splitAtPauses } from './segment.js'

const { sherpaPath, model, tokens, threads, maxSegmentSeconds, numbers } = workerData

let recognizer

function load() {
  const sherpa = createRequire(sherpaPath)(sherpaPath)
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 64 },
    modelConfig: { nemoCtc: { model }, tokens, numThreads: threads, provider: 'cpu', debug: 0 },
  })
}

/** Skip the canonical 44-byte WAV header and convert PCM16 LE to float samples. */
function pcm16(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44)
  const samples = new Float32Array(view.byteLength >> 1)
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index << 1, true) / 32768
  return samples
}

/**
 * Decode the recording in pause-aligned windows. One pass over anything longer than ~200 s crashes
 * the recognizer (5 000 encoder frames) and costs memory linearly, while cutting mid-word loses it.
 */
function transcribe(samples) {
  const parts = []
  for (const range of splitAtPauses(samples, maxSegmentSeconds)) {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: samples.subarray(range.start, range.end) })
    recognizer.decode(stream)
    const text = String(recognizer.getResult(stream).text ?? '').trim()
    if (text) parts.push(text)
  }
  const joined = parts.join(' ')
  return numbers === 'digits' ? normalizeNumbers(joined) : joined
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

parentPort.on('message', (message) => {
  if (message.type === 'load') {
    try {
      load()
      parentPort.postMessage({ type: 'loaded' })
    } catch (error) {
      parentPort.postMessage({ type: 'load-failed', message: messageOf(error) })
    }
    return
  }
  if (message.type !== 'transcribe') return
  const started = Date.now()
  try {
    const text = transcribe(pcm16(message.wav))
    parentPort.postMessage({ type: 'result', id: message.id, text, inferenceSeconds: (Date.now() - started) / 1000 })
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.id, message: messageOf(error) })
  }
})

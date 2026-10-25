import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const { sherpaPath, model, tokens, threads } = workerData

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
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: pcm16(message.wav) })
    recognizer.decode(stream)
    const text = String(recognizer.getResult(stream).text ?? '').trim()
    parentPort.postMessage({ type: 'result', id: message.id, text, inferenceSeconds: (Date.now() - started) / 1000 })
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.id, message: messageOf(error) })
  }
})

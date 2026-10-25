/**
 * Split one utterance into windows that meet the model's ~200 s limit (5 000 encoder frames) and
 * that prefer cutting inside a pause: a hard cut in the middle of a word loses it, a cut in silence
 * does not.
 *
 * ponytail: energy VAD (RMS threshold), not a model — swap in sherpa's Silero VAD if a noisy room splits
 * mid-word and the ~0.5 MB model download becomes acceptable.
 */
const FRAME = 160 // 10 ms at 16 kHz
const MIN_PAUSE_FRAMES = 25 // 0.25 s of silence is enough to cut
const SEARCH_FRAMES = 300 // look for that pause inside the last 3 s of the window
const FLOOR = 0.008 // absolute RMS floor under which a frame is silence
const CEILING = 0.03 // never treat quieter-than-this speech as silence

/** Per-frame RMS, then an adaptive silence threshold from the recording's own noise floor. */
function frameRms(samples) {
  const count = Math.floor(samples.length / FRAME)
  const rms = new Float32Array(count)
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0
    const start = frame * FRAME
    for (let index = 0; index < FRAME; index += 1) {
      const sample = samples[start + index]
      sum += sample * sample
    }
    rms[frame] = Math.sqrt(sum / FRAME)
  }
  return rms
}

function silenceThreshold(rms) {
  const sorted = Float32Array.from(rms).sort()
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  return Math.min(CEILING, Math.max(FLOOR, floor * 2.5))
}

/** Longest run of silent frames inside [from, to), returned as its centre frame or -1. */
function pauseCentre(rms, from, to, threshold) {
  let best = -1
  let bestLength = 0
  let runStart = -1
  for (let frame = from; frame < to; frame += 1) {
    if (rms[frame] < threshold) {
      if (runStart < 0) runStart = frame
      continue
    }
    if (runStart >= 0) {
      const length = frame - runStart
      if (length > bestLength) {
        bestLength = length
        best = runStart + (length >> 1)
      }
      runStart = -1
    }
  }
  if (runStart >= 0) {
    const length = to - runStart
    if (length > bestLength) {
      bestLength = length
      best = runStart + (length >> 1)
    }
  }
  return bestLength >= MIN_PAUSE_FRAMES ? best : -1
}

/**
 * Returns sample ranges `{start, end}` covering the speech. Silence before the first word and after
 * the last one is dropped; each range stays under `maxSeconds`.
 */
export function splitAtPauses(samples, maxSeconds = 20) {
  const rms = frameRms(samples)
  if (rms.length === 0) return []
  const threshold = silenceThreshold(rms)
  const maxFrames = Math.max(MIN_PAUSE_FRAMES * 4, Math.floor(maxSeconds * 100))

  let first = 0
  while (first < rms.length && rms[first] < threshold) first += 1
  if (first >= rms.length) return []

  const ranges = []
  let start = first
  while (start < rms.length) {
    const limit = start + maxFrames
    if (limit >= rms.length) {
      ranges.push({ start: start * FRAME, end: samples.length })
      break
    }
    const searchFrom = Math.max(start + MIN_PAUSE_FRAMES, limit - SEARCH_FRAMES)
    const cut = pauseCentre(rms, searchFrom, limit, threshold)
    const endFrame = cut >= 0 ? cut : limit
    ranges.push({ start: start * FRAME, end: endFrame * FRAME })
    let next = endFrame
    while (next < rms.length && rms[next] < threshold) next += 1
    if (next >= rms.length) break
    start = next
  }
  return ranges.filter((range) => range.end - range.start >= FRAME * 5)
}

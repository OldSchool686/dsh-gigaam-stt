# Changelog

## Unreleased

- **Opt-in diagnostics.** `GIGAAM_DEBUG=1` makes the worker log each window's raw transcript and the normalised
  result, which tells an ASR mishearing apart from a number-normalisation bug without re-plumbing the plugin.

## 1.1.0 — 2026-10-25

Long recordings and numbers.

- **Pause-aligned windowing.** The worker now cuts speech into windows of at most `maxSegmentSeconds` (20 s default),
  cutting inside pauses detected with an adaptive RMS threshold and dropping leading/trailing silence. This fixes a
  hard crash: a single pass over more than ~200 s (5 000 encoder frames) aborted sherpa-onnx (`Mul ... 5000 by 8468`).
  It also cuts memory from ~2 GB to ~520 MB on a 3-minute recording and makes decoding ~30 % faster (RTF 0.043).
- **Inverse text normalisation.** Russian number words become digits, including inflected ordinals:
  "двадцать пять" → "25", "в две тысячи двадцать пятом году" → "в 2025 году". Conservative by design — single words
  below two are left alone. New `numbers: digits | words` setting (default `digits`).
- New `maxSegmentSeconds` setting (5–180, default 20).
- Self-test additions: unit checks for normalisation and segmentation, plus an opt-in long-audio case
  (`GIGAAM_LONG=1`) that decodes 214 s instead of crashing.
- README: long-recording and numbers sections; measured memory and RTF for long input.

## 1.0.0 — 2026-10-25

First release.

- `speechToText` provider `gigaam-local` for Russian, running GigaAM v3 (`e2e_ctc`, int8 ONNX) on CPU through
  sherpa-onnx inside a `worker_threads` worker.
- One-time model download from Hugging Face with SHA-256 verification, mirror fallback (`hf-mirror.com`) and
  resumable `.part` files; progress reported through the standard preparation state.
- Lazy load on first recording, automatic unload after `idleTimeoutMs`; serialised requests; abort support.
- Configuration through the profile patch: `providerId`, `dataRoot`, `modelOrigins`, `threads`, `idleTimeoutMs`,
  `maxAudioSeconds`, `progressIntervalMs`.
- Resolver-independent discovery of the `sherpa-onnx-node` addon (walk-up search) with `GIGAAM_SHERPA_PATH`
  override.
- Bundle patch sets the provider as default for the `ru` language and disables the bundled SenseVoice provider.
- `scripts/selftest.mjs` for checking the worker without the UI.

# Changelog

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

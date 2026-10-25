# dsh-gigaam-stt

**Local Russian speech-to-text for the DeepSeek Harness chat.** Dictate Russian, get Cyrillic text — with
capitalisation and punctuation — transcribed on your CPU, offline, with no API keys and no cloud calls.

The engine is [GigaAM v3](https://huggingface.co/ai-sage/GigaAM-v3) (220M Conformer, MIT) exported to ONNX
(`e2e_ctc`, int8) and run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The plugin plugs into DSH's
existing voice-input pipeline: it registers a `speechToText` provider, so the microphone button in the chat
composer starts working with Russian.

```
mic → 16 kHz mono PCM16 WAV → this provider → worker thread → sherpa-onnx → "Привет, как дела?"
```

## Features

- **Russian only, properly.** Per ai-sage's benchmark, GigaAM v3 reports ~8.4 % WER on Russian against ~19 % for
  T-One and ~25 % for Whisper-large-v3 — and its `e2e` variants emit capitalisation and punctuation directly.
- **CPU-first and small.** 320 MB int8 model, ~420 MB RSS while loaded, ~0.04 RTF — 11 s of speech is transcribed
  in about 0.45 s on four threads.
- **Lazy and self-cleaning.** The model downloads on first use, loads on first recording (~1 s), unloads after five
  idle minutes. Nothing runs in the background.
- **No dependencies.** The plugin itself imports only Node built-ins; sherpa-onnx is reused from your DSH
  installation. No build step, no native compilation, no Python.
- **Long recordings work.** Audio is cut into pause-aligned windows of 20 s before decoding: a single pass over
  anything past ~200 s aborts sherpa-onnx (5 000 encoder frames), while pause-aligned windows keep memory at
  ~520 MB and stay within the model's trained length. 214 s of audio decodes in 8.7 s.
- **Numbers as digits.** "двадцать пять" → "25", "в две тысячи двадцать пятом году" → "в 2025 году". Conservative:
  single words below two stay as words, so "ни один" and "один в один" survive. Switch off with `numbers: words`.
- **Non-blocking.** Recognition runs in a `worker_threads` worker, so the chat never stalls while decoding.
- **Safe downloads.** Pinned URL, size and SHA-256 for every asset; interrupted downloads resume from `.part` files.

## Requirements

- DeepSeek Harness with the voice-input stack — `@deepseek-ai/dsh-experimental-voice-input-bundle`
  (speech service, mic UI and Remote API). It ships with DSH's experimental voice input; without it this bundle
  installs but has no microphone to attach to.
- Node.js 22+ (DSH itself needs a modern Node), x86-64 or arm64 Linux/macOS/Windows.
- ~350 MB free disk for the model, ~450 MB RAM while it is loaded.
- A browser with microphone access to `DSH Web` (the mic permission prompt appears on first recording).

## Install

Ask your DSH agent to install the bundle, or use the Plugin Manager panel in the DSH Web UI — the install target
accepts any spec `pnpm` accepts:

| Source | Install target |
| --- | --- |
| npm registry | `dsh-gigaam-stt` |
| GitHub repository | `github:OldSchool686/dsh-gigaam-stt` |
| Local checkout | absolute path, e.g. `/home/me/dsh-gigaam-stt` |
| Tarball | `/home/me/dsh-gigaam-stt-1.1.0.tgz` |

The bundle's patch does three things: it makes `gigaam-local` the default speech provider with language `ru`,
disables the bundled SenseVoice provider (its languages are zh/en/yue/ja/ko, so it would only add noise), and mounts
this provider with `dataRoot: !!js dshHomePath('speech-to-text', 'gigaam')`.

If your profile has no voice-input bundle, the two row overrides are reported as warnings and skipped — install
`@deepseek-ai/dsh-experimental-voice-input-bundle` first, then re-apply this bundle.

## First run

Press the microphone button in the chat composer. The preparation card shows a one-time download of two files
(~320 MB) from Hugging Face, verified by SHA-256, and the state changes `downloading → loading → ready`.

Assets are stored in `~/.dsh/speech-to-text/gigaam/`:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `gigaam_v3_e2e_ctc_int8.onnx` | 319869121 | `0aacb41f70f0f5aaac4b45dd430337b9e16b180f22c72af04db8516e7609c3c0` |
| `gigaam_v3_e2e_ctc_tokens.txt` | 2006 | `f8eb9b115e2748db9c40a5897cae11dd0678cc0b40fd7e25f8c43b3bf28715e4` |

To pre-seed them (air-gapped machine, CI image, shared cache), put the two files there with those names and sizes —
an already-present, correctly-sized file is used as is:

```bash
mkdir -p ~/.dsh/speech-to-text/gigaam
curl -L -o ~/.dsh/speech-to-text/gigaam/gigaam_v3_e2e_ctc_int8.onnx \
  https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx/resolve/main/gigaam_v3_e2e_ctc_int8.onnx
curl -L -o ~/.dsh/speech-to-text/gigaam/gigaam_v3_e2e_ctc_tokens.txt \
  https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx/resolve/main/gigaam_v3_e2e_ctc_tokens.txt
```

`modelOrigins` defaults to `https://huggingface.co` first and `https://hf-mirror.com` second; the UI shows an origin
picker when both are reachable.

## Settings

Configure the `speech-to-text-gigaam` row in your profile patch (or via the plugin's settings UI):

| Option | Default | Meaning |
| --- | --- | --- |
| `providerId` | `gigaam-local` | id under which the provider registers; `speech-to-text.defaultProvider` must match it. |
| `dataRoot` | required | absolute directory for the model files. |
| `modelOrigins` | `["https://huggingface.co", "https://hf-mirror.com"]` | download mirrors, probed in order. |
| `threads` | `4` | sherpa-onnx intra-op threads. Lower it on small CPUs, raise it for throughput. |
| `idleTimeoutMs` | `300000` | unload the model after this much inactivity. |
| `maxAudioSeconds` | `600` | reject longer recordings before decoding. |
| `maxSegmentSeconds` | `20` | decode in pause-aligned windows of at most this length (5–180). Longer audio is split, not rejected. |
| `numbers` | `digits` | `digits` rewrites Russian number words to digits; `words` leaves them as spoken. |
| `progressIntervalMs` | `100` | download progress publication interval. |

Example override:

```yaml
- id: speech-to-text-gigaam
  config:
    dataRoot: !!js dshHomePath('speech-to-text', 'gigaam')
    threads: 2
```

## How it works

1. The DSH speech service validates that the recording is a canonical 16 kHz mono PCM16 WAV and hands the bytes to
   the provider.
2. The provider serialises requests, wakes the worker if needed, and transfers the audio buffer.
3. The worker strips the 44-byte WAV header, converts PCM16 to float32, and splits the speech into windows of at
   most `maxSegmentSeconds`, cutting inside pauses (adaptive RMS threshold over 10 ms frames) and dropping leading and
   trailing silence. Each window goes through `OfflineRecognizer` with `modelConfig.nemoCtc` (GigaAM `e2e_ctc` emits
   punctuation and casing directly).
4. Windows are joined, number words are normalised (unless `numbers: words`), and the text comes back with
   `audioSeconds` and `inferenceSeconds`; the model unloads after the idle timeout.

Measured on an 8-vCPU box (Node 24, int8, 4 threads): model load 0.84 s, decode 0.44–0.46 s for 11.29 s of audio,
RTF ~0.043 for long input (214 s in 8.7 s), RSS ~420 MB with the model resident and ~520 MB during a long
transcription. One pass over 214 s without windowing used ~2 GB and aborted the process.

## Self-test without the UI

```bash
cd dsh-gigaam-stt
node scripts/selftest.mjs                                     # 1 s of silence must decode to ""
GIGAAM_SAMPLE=/path/to/speech.wav node scripts/selftest.mjs   # expect Cyrillic
```

The script talks to `worker.js` directly; it resolves sherpa from your DSH install (override with
`GIGAAM_SHERPA_PATH`) and reads the model from `~/.dsh/speech-to-text/gigaam`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `sherpa-onnx-node не найден` | The plugin could not find the addon. It searches `node_modules/sherpa-onnx-node` upward from `argv[1]`, `process.execPath`, the plugin directory and cwd. Point it explicitly: `GIGAAM_SHERPA_PATH=/abs/path/sherpa-onnx-node/sherpa-onnx.js` in the DSH process environment. |
| No microphone button / no provider in the list | The voice-input bundle is missing or disabled; install `@deepseek-ai/dsh-experimental-voice-input-bundle`. |
| Download fails behind a firewall | The second origin `https://hf-mirror.com` is tried automatically; otherwise pre-seed `dataRoot` manually (see above). |
| `Audio must be a canonical 16 kHz mono PCM16 WAV recording` | The client sent another format; this provider accepts only that one. |
| First recording shows “Разбужаем локальный голос…” | The model was unloaded after `idleTimeoutMs`; loading takes ~1 s. |
| Numbers stay as words (or an odd rewrite) | `numbers: digits` is the default; set `numbers: words` to keep them spoken, or raise `maxSegmentSeconds` if a phrase was split mid-number. |
| Preparation stuck in `failed` | Fix the reported cause and record again — the next recording retries the worker automatically. |

## Uninstall

Remove the bundle through the Plugin Manager (or ask your agent). The model stays in
`~/.dsh/speech-to-text/gigaam` — delete that directory to reclaim ~320 MB.

## Privacy

- **No credentials.** The plugin reads one environment variable, `GIGAAM_SHERPA_PATH` (a local filesystem path). It
  never touches DSH credentials, API keys, cookies or the settings store.
- **No telemetry**, no analytics, no update checks, no accounts.
- **The only network access** is the one-time model download over HTTPS from `modelOrigins`: a plain GET with no
  authorization header. It can be skipped entirely by pre-seeding `dataRoot`.
- **Audio never leaves the machine.** The recording goes to a local worker thread, is decoded on the CPU, and is
  dropped afterwards.
- **Nothing is written outside `dataRoot`** (plus `.part` files inside it while a download is in progress).

## License and credits

- This bundle: MIT (see [LICENSE](./LICENSE)).
- [GigaAM v3](https://huggingface.co/ai-sage/GigaAM-v3) by ai-sage — MIT; the ONNX conversion used here comes from
  the community repo [Smirnov75/GigaAM-v3-sherpa-onnx](https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx).
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) by k2-fsa — Apache-2.0.
- The voice-input UI and the `speechToText` service are part of DeepSeek Harness.

---

## Кратко по-русски

Плагин добавляет в чат DeepSeek Harness локальное распознавание русской речи: жмёте микрофон, говорите, в поле
ввода появляется текст с пунктуацией и заглавными буквами. Всё считается на процессоре, без интернета после
первой загрузки модели (320 МБ), память ~450 МБ пока модель загружена, выгрузка через 5 минут простоя.

Установка: попросите агента установить бандл `dsh-gigaam-stt` (или `github:OldSchool686/dsh-gigaam-stt`), либо укажите
абсолютный путь к этому каталогу в Plugin Manager. Нужен установленный голосовой ввод DSH
(`@deepseek-ai/dsh-experimental-voice-input-bundle`). Первый клик по микрофону скачивает модель в
`~/.dsh/speech-to-text/gigaam`. Настройки: `threads`, `idleTimeoutMs`, `modelOrigins`, `dataRoot`.

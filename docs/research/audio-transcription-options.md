# Audio/video transcription — Workers AI and BYOK options

**Date**: 17 September 2026

**Scope**: how Surveyor should turn audio and video evidence into gated mirror text. Covers (1) Workers AI speech-to-text as offered today, (2) large-media handling on Workers and R2, (3) external BYOK options that fit the provider registry (`src/lib/serve.ts`), (4) video demux/extraction, and (5) the provenance metadata a transcript must carry for the evidence chain.

**Method**: primary sources only — Cloudflare's own documentation (`developers.cloudflare.com`), model input/output schemas fetched from the model catalogue, OpenAI platform docs, Deepgram developer docs and pricing page, AssemblyAI docs and pricing page, Groq console docs, and the Vercel AI SDK transcription reference. Model pages, schemas, pricing pages and limits pages were fetched between 17 September 2026 and the dates shown on each page. Anything that could not be verified from a primary source is marked **[unverified]**.

**Status**: research note for a decision not yet made; no production code changes.

**Companions**: `docs/adr/0002-corpus-ingestion-and-ocr.md`, `docs/adr/0011-ingestion-browser-rasterisation.md`, `docs/research/parallel-ai-api.md` (method/style precedent). Relevant code: `src/lib/drain.ts` (lane state machine), `src/lib/lanes.ts` (provider assembly), `src/lib/serve.ts:171-268` (registry client).

**Conventions**: "Workers AI" means `env.AI` via the AI binding. "Registry" means the operator's ordered chain of BYOK entries (`ChainEntry` in `src/lib/serve.ts:176`). "Inline" means bytes carried in the request payload (binary body, base64 string, or byte array) — as opposed to a URL the provider fetches itself. "One-shot" means a single request returns the full transcript; "streaming" means partial results arrive before the audio finishes. Australian English throughout.

---

## 0. What matters first

1. **Workers AI has five ASR entries today**: `@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo`, `@cf/openai/whisper-tiny-en` (beta), `@cf/deepgram/nova-3`, and `@cf/deepgram/flux` (WebSocket-only) — all listed under Automatic Speech Recognition on the model catalogue (`https://developers.cloudflare.com/workers-ai/models/`).
2. **Audio must be passed inline to Workers AI.** Every input schema is a binary body, a base64 string, or a byte/`{body, contentType}` object; no URL source parameter exists on any model page or schema. Cloudflare's own long-audio tutorial fetches the file, base64-encodes it, and sends it through `env.AI.run()` (`https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/`).
3. **The cheapest viable default is `whisper-large-v3-turbo` at $0.0005 per audio minute** (46.63 neurons), with a 10,000-neuron/day free allocation — roughly 3.5 hours of audio per day at zero marginal cost (derived; both figures cited in §1.5).
4. **Cloudflare publishes no per-request duration or size limit for its ASR models.** The only documented long-audio pattern is client-side chunking, and Cloudflare's example chunks by *bytes* (1 MB), with no overlap or stitching (`https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/`). Chunk boundaries that fall mid-utterance will cut words.
5. **Media Transformations can extract audio from video inside a Worker** (`env.MEDIA.input(stream).output({mode: "audio"})`), and Cloudflare's own example feeds the result directly to Workers AI Whisper. But the input must be under 100 MB and no longer than 10 minutes, and an audio output slice is 1–60 seconds (`https://developers.cloudflare.com/stream/transform-videos/bindings/`, `https://developers.cloudflare.com/stream/transform-videos/`).
6. **The registry as built is chat-only** (`createOpenAICompatible(...).chatModel(...)` at `src/lib/serve.ts:262`), but the AI SDK v7 that the registry already pins supports `transcribe()` with OpenAI, Groq, Deepgram, AssemblyAI and other providers (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`). A transcription lane needs a new method and an `audio` capability tag, mirroring the vision lane.
7. **The external providers split cleanly into "OpenAI-compatible" (Groq) and "own API" (Deepgram, AssemblyAI).** Groq's `/openai/v1/audio/transcriptions` matches the registry's existing transport; Deepgram and AssemblyAI need either the AI SDK's own providers or a small adapter. Deepgram and AssemblyAI also accept a **URL** rather than requiring an upload, which is the only practical route past 25 MB without chunking.
8. **Retention is a provenance question, not just a compliance one.** Deepgram does not store transcripts; OpenAI's `/v1/audio/transcriptions` has no abuse-monitoring retention and is ZDR-eligible; Groq retains nothing by default; AssemblyAI stores final transcripts for 30 days by default unless a TTL, BAA or deletion is configured (`§3.6`).

---

## 1. Workers AI speech-to-text

### 1.1 The catalogue today

All five entries below are classified **Automatic Speech Recognition** on `https://developers.cloudflare.com/workers-ai/models/` (last updated 12 August 2026). The ASR task carries a rate limit of 720 requests per minute (`https://developers.cloudflare.com/workers-ai/platform/limits/`).

| Model id | Vendor | Streaming? | Languages | Unit price (pricing page) |
|---|---|---|---|---|
| `@cf/openai/whisper` | OpenAI | One-shot | Multilingual + language identification | $0.0005/audio min |
| `@cf/openai/whisper-large-v3-turbo` | OpenAI | One-shot; Batch tagged | Multilingual | $0.0005/audio min |
| `@cf/openai/whisper-tiny-en` | OpenAI (Beta) | One-shot | English only | Not listed |
| `@cf/deepgram/nova-3` | Deepgram (Partner) | One-shot HTTP + real-time WebSocket | 45+ languages (Deepgram's count) plus region codes | $0.0052/min HTTP; $0.0092/min WebSocket |
| `@cf/deepgram/flux` | Deepgram (Partner) | Real-time WebSocket only | English or 10-language multilingual | $0.0077/min WebSocket |

Prices above are from the Audio model pricing table on `https://developers.cloudflare.com/workers-ai/platform/pricing/` (last updated 28 August 2026). The individual model pages sometimes quote a more granular figure — `whisper` says $0.000453/audio min and `whisper-large-v3-turbo` says $0.000513/audio min (`https://developers.cloudflare.com/workers-ai/models/whisper/`, `https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/`). **The two Cloudflare pages disagree; treat the per-model pages as the finer-grained authority and flag the discrepancy.**

`@cf/pipecat-ai/smart-turn-v2` is also in the ASR filter but is a turn-detection model ("Dumb Pipe"), not a transcriber (`https://developers.cloudflare.com/workers-ai/models/smart-turn-v2/`). It is out of scope here.

**Model sizes.** Cloudflare does not publish parameter counts or checkpoint versions for any of these entries **[unverified]**. The underlying OpenAI Whisper family sizes are published by OpenAI: tiny 39 M, base 74 M, small 244 M, medium 769 M, large 1550 M, turbo 809 M parameters (`https://github.com/openai/whisper#available-models-and-languages`). `whisper-tiny-en` therefore maps to the 39 M English-only checkpoint; the other two are assumed to be large-family checkpoints but Cloudflare does not say which **[unverified]**.

### 1.2 Per-model detail

**`@cf/openai/whisper`** — input is `oneOf` a binary string or an object whose `audio` is an array of 8-bit unsigned integers (PCM-style byte values); output is `{text, word_count, words[{word,start,end}], vtt}` (`https://developers.cloudflare.com/workers-ai/models/whisper/schema-input.json`, `.../schema-output.json`). Cloudflare's own Media Transformations example passes a plain byte array to this model: `audio: [...new Uint8Array(await audio.arrayBuffer())]` (`https://developers.cloudflare.com/stream/transform-videos/bindings/`). Note that a byte array is JSON-encoded as decimal numbers — roughly 3–4× the raw size before base64's 4/3× inflation.

**`@cf/openai/whisper-large-v3-turbo`** — input `audio` is a base64 string **or** an object `{body, contentType}` (`https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-input.json`). Parameters include `task` (`transcribe`/`translate`), `language`, `vad_filter`, `initial_prompt`, `prefix`, `beam_size`, `condition_on_previous_text`, `no_speech_threshold`, `compression_ratio_threshold`, `log_prob_threshold`, `hallucination_silence_threshold` (`https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/`). Output is the richest provenance surface on Workers AI: `transcription_info{language, language_probability, duration, duration_after_vad}`, `text`, `word_count`, `segments[{start,end,text,temperature,avg_logprob,compression_ratio,no_speech_prob,words[{word,start,end}]}]`, `vtt` (`.../schema-output.json`). **This is the recommended default (§6).**

**`@cf/openai/whisper-tiny-en`** — Beta, English-only, input shape identical to `whisper`, output `{text, word_count, words, vtt}`; no pricing is listed on the model page (`https://developers.cloudflare.com/workers-ai/models/whisper-tiny-en/`).

**`@cf/deepgram/nova-3`** — input `audio` is required and shaped `{body, contentType}`; parameters include `language` (BCP-47), `detect_language`, `diarize`, `smart_format`, `punctuate`, `utterances`, `paragraphs`, `keyterm`/`keywords`, `redact`, `multichannel`, and WebSocket-only controls (`https://developers.cloudflare.com/workers-ai/models/nova-3/`). Output carries `results.channels[].alternatives[].confidence` and word-level `{word, start, end, confidence}` (`.../schema-output.json`). This is the keyless route to **diarisation and confidence**, at $0.0052/min HTTP. Cloudflare hosts inference, but the model is Deepgram's and the page links Deepgram's terms (`https://deepgram.com/terms`); the data-processing arrangement between Cloudflare and Deepgram is not documented on the page **[unverified]**.

**`@cf/deepgram/flux`** — WebSocket-only, priced at $0.0077/min, inputs include `encoding: linear16`, `sample_rate`, `eager_eot_threshold`, `eot_threshold`, `keyterm`; output is turn-structured with `transcript`, `words[]`, `end_of_turn_confidence` (`https://developers.cloudflare.com/workers-ai/models/flux/`). It is built for live voice agents, not file transcription; Deepgram's own model table defines `flux-general-en` and `flux-general-multi` (10 languages) (`https://developers.deepgram.com/docs/models-languages-overview`). Not a batch-ingest candidate.

### 1.3 How audio reaches the model: inline only

The AI binding signature is `env.AI.run(model, inputs)` (`https://developers.cloudflare.com/workers-ai/configuration/bindings/`). On every ASR model the audio input is inline: binary, base64, a byte array, or `{body, contentType}`. **No ASR model page or input schema documents a URL, R2 key, or stream source.** The documented long-audio tutorial confirms the pattern: `fetch(audioUrl)` → `arrayBuffer()` → split → `Buffer.from(chunk, "binary").toString("base64")` → `env.AI.run("@cf/openai/whisper-large-v3-turbo", {audio: base64})` (`https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/`).

The absence of a URL form is not explicitly stated by Cloudflare (an absence can never be fully verified) — **treat "inline only" as the documented reality and any URL form as [unverified]**.

Consequences for Surveyor's R2-held uploads: the drain lane must read bytes out of R2 into the Worker, encode them, and pass them in. R2 range reads help you read a slice without the whole object, but they still land in isolate memory before the model call.

### 1.4 Limits that are and aren't published

Cloudflare publishes **no** per-request maximum duration, file size, or supported-format list for Workers AI ASR. `[unverified]` on all three. What *is* documented:

- ASR rate limit: 720 requests/minute (`https://developers.cloudflare.com/workers-ai/platform/limits/`).
- The chunking tutorial exists "to overcome memory and execution time limitations" and uses 1 MB byte chunks — it does not state the limit it is working around (`https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/`).
- The 128 MB isolate memory limit and per-plan CPU limits are the hard ceilings any in-Worker approach hits (`https://developers.cloudflare.com/workers/platform/limits/`).
- Nova-3 and flux are tagged Real-time, but the AI binding's `stream: true` option is documented only for text generation (`https://developers.cloudflare.com/workers-ai/configuration/bindings/`). For file ingest, treat all five as one-shot.

Formats: the Whisper schemas accept arbitrary binary/base64, and Cloudflare's guides only ever demonstrate MP3. The underlying OpenAI transcription API accepts `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm` (`https://platform.openai.com/docs/guides/speech-to-text`); **assume the same family works on Workers AI, but Cloudflare does not guarantee it [unverified]**.

### 1.5 Pricing and the free daily allowance

Workers AI bills in neurons at $0.011 per 1,000 neurons, with 10,000 neurons/day free, resetting at 00:00 UTC (`https://developers.cloudflare.com/workers-ai/platform/pricing/`). Audio-model neuron rates from the same page:

| Model | Neurons per audio minute | Free-tier minutes/day (derived) |
|---|---|---|
| `@cf/openai/whisper` | 41.14 | ~243 min (~4.0 h) |
| `@cf/openai/whisper-large-v3-turbo` | 46.63 | ~214 min (~3.6 h) |
| `@cf/deepgram/nova-3` (HTTP) | 472.73 | ~21 min |
| `@cf/deepgram/nova-3` (WebSocket) | 836.36 | ~12 min |
| `@cf/deepgram/flux` (WebSocket) | 700.00 | ~14 min |

The minutes/day column is arithmetic on the two cited figures, not a Cloudflare promise; 10,000 ÷ 46.63 = 214.5 for turbo, for example. This matches the ADR-0011 "$0 free-tier promise" framing: a few hours of audio per day at zero marginal cost, before any BYOK key exists.

---

## 2. Handling large media on Workers

### 2.1 Worker-side ceilings

From `https://developers.cloudflare.com/workers/platform/limits/` (last updated 5 September 2026):

| Limit | Free | Paid |
|---|---|---|
| Request body size (Cloudflare plan, not Workers plan) | 100 MB | 100 MB Pro / 200 MB Business / up to 5 GB Enterprise |
| Memory per isolate | 128 MB | 128 MB |
| CPU time per HTTP request | 10 ms | 30 s default, up to 5 min |
| Queue consumer wall time | — | 15 min |
| Workflows per-step wall time | — | Unlimited |
| Subrequests per invocation | 50 | 10,000 |

Memory is **per isolate**, shared across concurrent requests on that isolate — not per invocation. A single 100 MB base64 payload already exceeds the isolate budget before decode, so **the request-body limit does not imply Workers AI can transcribe a 100 MB upload in one call.**

### 2.2 R2 range reads

R2 supports byte-range reads in the Workers API: `get(key, {range: {offset, length} | {suffix}})` returns an `R2ObjectBody` with a `range` field, and `Headers`-based ranges are accepted too (`https://developers.cloudflare.com/r2/api/workers/workers-api-reference/`, "Ranged reads"). R2 object limits are 5 TiB per object, 5 GiB single-part / 4.995 TiB multipart upload (`https://developers.cloudflare.com/r2/platform/limits/`).

**Byte ranges are not time ranges.** Nothing in R2 understands MP3 frames or MP4 boxes. To seek to "minute 37" you must parse the container (frame headers for MP3; `moov`/sample tables for M4A/MP4) or keep a time index produced elsewhere. Cloudflare publishes no Worker-side audio parser or demuxer, so `[unverified]` on any claim that R2 ranges alone can segment audio by time.

### 2.3 The documented long-audio pattern: byte chunking

Cloudflare's only official long-audio guidance is the Whisper chunking tutorial (`https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/`, last updated 25 August 2026). It:

1. fetches the whole file into an `ArrayBuffer`;
2. slices it into fixed 1 MB byte chunks;
3. base64-encodes each chunk and calls `@cf/openai/whisper-large-v3-turbo`;
4. concatenates `res.text` with `\n`, swallowing per-chunk errors as `[Error transcribing chunk]`.

There is **no overlap window, no timestamp offsetting, and no stitching of `segments`**. For Surveyor's evidence chain this is insufficient on its own: chunk-two timestamps restart at 0, and a word split across a chunk boundary is silently lost. A production lane should chunk with overlap (two-plus seconds and/or on VAD silence), supply the original offset when writing timestamps, and keep per-chunk provenance. No Cloudflare source prescribes this — it is an engineering consequence of the cited tutorial.

### 2.4 Async execution surfaces

ADR-0002 already routes extraction off the request path. The same surfaces fit audio:

- **Queue consumer**: 15-minute wall time (`https://developers.cloudflare.com/workers/platform/limits/`). A 2-hour recording at 1 MB chunks is ~140 AI calls; that fits comfortably, but a lane should record progress so a retried consumer resumes rather than restarts.
- **Workflows**: unlimited wall time per step, CPU-limited per step (`https://developers.cloudflare.com/workers/platform/limits/`). One step per chunk (or per batch of chunks) gives retry semantics per chunk and keeps timestamps ordered.
- **`ctx.waitUntil()`** extends execution only for up to 30 seconds after the response (`https://developers.cloudflare.com/workers/platform/limits/`), so it is not a transcription surface.

### 2.5 What does not exist on Workers

There is no documented Worker-side ffmpeg, decoder, resampler, or demuxer. The ADR-0011 finding that workerd forbids runtime Wasm compilation applies to any ffmpeg.wasm-style approach (`docs/adr/0011-ingestion-browser-rasterisation.md`). Cloudflare Containers (Workers Paid) can run an arbitrary image with ffmpeg (`https://developers.cloudflare.com/containers/`), but ADR-0002/0011 rejected Containers for this pipeline on cost and complexity grounds; that trade-off is worth revisiting only if server-side demuxing becomes a hard requirement. Media Transformations (§4.2) is the one documented Cloudflare-native video/audio manipulation surface.

---

## 3. External BYOK options and registry fit

### 3.0 The registry as built, and its transcription gap

The registry is `ChainEntry[]` (`kind`, `label`, `secret_slot`, `model`, `base_url`, `capabilities`) executed by `buildChainClient` (`src/lib/serve.ts:176-268`). Today it constructs `createOpenAICompatible(...)` and calls `provider.chatModel(entry.model)`; the only capability consumed anywhere is `"vision"` (`src/lib/serve.ts:202-204`, `src/lib/lanes.ts:24-25`). A transcription lane needs:

- a new capability string (e.g. `"audio"`), resolved exactly like `"vision"`;
- a `transcribe(...)` method on the client (`ModelClient`), so `drain.ts` can route `held-audio`/`held-video` to capable entries;
- per-provider shaping. The AI SDK v7 `transcribe()` function accepts `Uint8Array | ArrayBuffer | Buffer | base64 string | URL` as `audio` and returns `{text, segments, language, durationInSeconds}` (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`). Its provider table lists transcription models for OpenAI, Groq, Deepgram, AssemblyAI, ElevenLabs, Mistral, Rev.ai and more — but not the openai-compatible provider package itself, and not the community Workers AI provider (which Cloudflare documents only for text generation, tool calls and structured output: `https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/`) **[unverified]**.

URL input via the AI SDK is capped at a 2 GiB default download, configurable with `createDownload({maxBytes})` (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`). For a Worker, "URL" means the Worker downloads the bytes, so R2 would need a signed URL or the bytes must be pulled directly.

### 3.1 OpenAI

**API shape.** `POST /v1/audio/transcriptions`, multipart form upload. The recommended model is `gpt-transcribe`; `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` remain available; `whisper-1` is reserved for word/segment timestamps, subtitle formats and translation to English (`https://platform.openai.com/docs/guides/speech-to-text`). Response formats: JSON or `verbose_json`; `stream=true` streams deltas for the `gpt-transcribe`/`gpt-4o` family but **not** `whisper-1`. The response includes detected `languages` for `gpt-transcribe` and speaker-labelled segments (`speaker`, `start`, `end`) for the diarize model.

**Limits.** Files up to **25 MB**; formats `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`. OpenAI's guidance for larger recordings is compressed formats or ≤25 MB chunks, avoiding mid-sentence splits (`https://platform.openai.com/docs/guides/speech-to-text`). No URL input is documented for transcriptions.

**Pricing.** `gpt-transcribe` $0.0045/min; `gpt-4o-mini-transcribe` $0.003/min; `gpt-4o-transcribe` and `gpt-4o-transcribe-diarize` $0.006/min; Whisper $0.006/min (`https://platform.openai.com/docs/pricing`).

**Retention.** API data is not used for training unless opted in; `/v1/audio/transcriptions` is listed with **no abuse-monitoring retention** and is ZDR-eligible (`https://developers.openai.com/api/docs/guides/your-data`). Regional processing exists (`us.api.openai.com`, `eu.api.openai.com`) but `au.api.openai.com` supports storage only, not processing — relevant to an Australian newsroom.

**Registry fit.** Not OpenAI-compatible in the repo's current sense (it is OpenAI, but the registry path is `chatModel`). The AI SDK's OpenAI provider exposes `openai.transcription('gpt-transcribe')` (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`), so it fits once the client grows a `transcribe` method.

### 3.2 Deepgram

**API shape.** `POST /v1/listen?model=nova-3&smart_format=true` with either a JSON `{"url": ...}`, a raw binary body, or a file upload (`https://developers.deepgram.com/docs/pre-recorded-audio`). Supplying `callback=URL` returns a `request_id` immediately and POSTs results asynchronously, retrying failures up to 10 times with a 30-second delay (`https://developers.deepgram.com/docs/callback`).

**Limits.** Maximum file size **2 GB**; up to 100 concurrent requests per project for Nova/Base/Enhanced (the pricing page states "up to 50 for the REST API" on Pay-As-You-Go — the two Deepgram pages disagree); requests exceeding 10 minutes of processing time (Nova) or 20 minutes (Whisper) return `504: Gateway Timeout`. The docs say explicitly: **"For large video files, extract the audio stream first."** (`https://developers.deepgram.com/docs/pre-recorded-audio`). Formats: 100+ including MP3, MP4, AAC, WAV, FLAC, M4A, Ogg, Opus, WebM (`https://developers.deepgram.com/docs/supported-audio-formats`).

**Pricing.** Pre-recorded Nova-3 monolingual $0.0043/min, Nova-3 multilingual $0.0052/min, Whisper Large $0.0048/min; $200 free credit (`https://deepgram.com/pricing`). The pricing table shows diarisation included on pre-recorded (billed +$0.0020/min on streaming); Smart Formatting included, keyterm prompting +$0.0013/min, redaction +$0.0020/min. EU endpoint `api.eu.deepgram.com` for data residency.

**Retention.** "Deepgram does not store transcripts, so the API response is the only opportunity to retrieve the transcript" (`https://developers.deepgram.com/docs/pre-recorded-audio`).

**Response provenance.** `metadata{request_id, sha256, created, duration, channels, model_info{name, version, arch}}` plus `results.channels[].alternatives[].{transcript, confidence, words[{word,start,end,confidence,punctuated_word}]}` (`https://developers.deepgram.com/docs/pre-recorded-audio`). This is the strongest vendor-side provenance of the four: it includes a **model version string**.

**Registry fit.** Own API, not OpenAI-shaped. The AI SDK has a Deepgram provider with `nova-3` transcription models (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`). Note Workers AI also offers `nova-3` keyless at the same $0.0052/min HTTP price as Deepgram direct multilingual — see §6.

### 3.3 AssemblyAI

**API shape.** `POST /v2/transcript` with required `audio_url` (the provider fetches the media); async by design — the call queues the job and returns `{id, status: queued|processing|completed|error}`, polled via GET or delivered via `webhook_url` with optional webhook auth (`https://www.assemblyai.com/docs/api-reference/transcripts/submit`). Local files can be uploaded first via `/v2/upload` (≤2.2 GB) which returns a URL (`https://www.assemblyai.com/docs/faq/are-there-any-limits-on-file-size-or-file-duration-for-files-submitted-to-the-api`).

**Limits.** Maximum **5 GB** and **10 hours** per file for `/v2/transcript`; the API converts everything to 16 kHz internally and **extracts audio from video server-side** (`https://www.assemblyai.com/docs/faq/what-audio-and-video-file-types-are-supported-by-your-api`). Default model routing is `["universal-3-5-pro", "universal-2"]` (`speech_models`). Rate limits: free tier 5 parallel jobs, paid 200+, plus 20,000 HTTP requests per 5 minutes (`https://www.assemblyai.com/docs/pre-recorded-audio/rate-limits`).

**Pricing.** Pre-recorded Universal-3.5 Pro $0.21/hr (~$0.0035/min), Universal-2 $0.15/hr (~$0.0025/min), pro-rated to the second, failed transcripts not charged; $50 free credits (`https://www.assemblyai.com/pricing`). Add-ons stack: entity detection +$0.08/hr, sentiment +$0.02/hr, diarisation +$0.02/hr, keyterms +$0.05/hr.

**Retention.** This is the critical difference from Deepgram. With no TTL or BAA, the final transcript is deleted automatically at **30 days** (audio at 24–48 h) — but only the deletion *process* begins then; a customer-configured TTL can be as low as 1 hour, a BAA account defaults to 72 hours, and the delete API is available. Training data rules apply unless opted out or using EU servers (`https://www.assemblyai.com/docs/data-retention-and-model-training`). EU endpoint `api.eu.assemblyai.com`, same price (`https://www.assemblyai.com/pricing`).

**Provenance.** `language_code`, `language_confidence`, `confidence`, `words[{text,start,end,confidence}]`, `utterances[]` (when diarisation/multichannel), `audio_duration`, `speech_model_used`, `speech_models` (priority list), `id`, `error`, `metadata.warnings` (`https://www.assemblyai.com/docs/api-reference/transcripts/submit`).

**Registry fit.** Own API; AI SDK has an AssemblyAI provider (`universal-3-5-pro`, `universal-3-pro`) (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`). The URL model means an R2 object needs to be publicly (or presigned) reachable by AssemblyAI, which is a custody decision for source material.

### 3.4 Groq

**API shape.** OpenAI-compatible: `POST https://api.groq.com/openai/v1/audio/transcriptions` and `/audio/translations`; models `whisper-large-v3-turbo` and `whisper-large-v3` (`https://console.groq.com/docs/speech-to-text`). The registry already maps `groq` to `https://api.groq.com/openai/v1` (`src/lib/serve.ts:171-174`).

**Limits.** 25 MB free tier / 100 MB dev tier; a `url` parameter is supported for larger files (the URL may be a Base64URL); minimum billed length 10 s; **only the first audio track** is transcribed; formats `flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `wav`, `webm`; audio is downsampled to 16 kHz mono. `verbose_json` returns `avg_logprob`, `compression_ratio`, `no_speech_prob` per segment plus word/segment timestamps (`https://console.groq.com/docs/speech-to-text`).

**Pricing.** `whisper-large-v3` $0.111/hr (~$0.00185/min); `whisper-large-v3-turbo` $0.04/hr (~$0.00067/min) (`https://console.groq.com/docs/speech-to-text`). Turbo is the cheapest BYOK rate in this report — but still dearer per minute than Workers AI turbo at $0.0005 ($0.03/hr).

**Retention.** Inference requests are not retained by default; temporary logs (<30 days) only for reliability/abuse, with a Zero Data Retention toggle; data lives in GCP USA buckets (`https://console.groq.com/docs/your-data`).

**Registry fit.** The best transport fit: OpenAI-shaped endpoint at the same base URL the registry already uses. The current client path (`chatModel`) still does not transcribe, so Groq needs the same `transcribe` method as the others; the AI SDK Groq provider lists both Whisper models for `transcribe()` (`https://ai-sdk.dev/docs/ai-sdk-core/transcription`).

### 3.5 Comparison

| | Workers AI turbo | OpenAI gpt-transcribe | Deepgram nova-3 | AssemblyAI U-3.5 Pro | Groq turbo |
|---|---|---|---|---|---|
| Price/min | $0.0005 | $0.0045 | $0.0052 (multi) | $0.0035 | $0.00067 |
| Price/hour | $0.03 | $0.27 | $0.31 | $0.21 | $0.04 |
| Max single input | not published [unverified] | 25 MB | 2 GB (URL or binary) | 5 GB / 10 h (URL) | 25 MB (100 MB dev) or URL |
| URL input | No | No | Yes | Yes (required) | Yes |
| Timestamps | word + segment | segments; word on whisper-1 | word + segment | word + utterance | word + segment |
| Confidence | `avg_logprob`, `no_speech_prob` per segment | not documented for gpt-transcribe [unverified] | per word + transcript | per word + transcript | `avg_logprob`, `no_speech_prob` |
| Language detection | `language`, `language_probability` | `languages[]` | `detect_language` | `language_detection` + confidence | `language` hint only |
| Diarisation | No | yes (diarize model) | `diarize` param | `speaker_labels` | No |
| Streaming | No | yes, gpt-transcribe family | WebSocket (real-time only) | No (async job) | No |
| Retention | platform-owned | none (abuse logs); ZDR eligible | none | 30 days default; TTL/BAA/delete | none by default; ZDR toggle |

Prices are the unit prices cited in each provider's section. "Not published"/"not documented" cells are `[unverified]` absences, not negatives.

### 3.6 Storable or ephemeral — what this means for Surveyor

- **Workers AI**: no transcript store. The only copies are what Surveyor writes to D1/R2. The raw audio, if kept, remains in Surveyor's own R2 — the strongest custody position.
- **Deepgram**: "does not store transcripts" (`https://developers.deepgram.com/docs/pre-recorded-audio`). With callback mode, Deepgram has transient possession of the audio only.
- **OpenAI / Groq**: not retained for inference by default, ZDR available; still third-party processing of source audio.
- **AssemblyAI**: stores the transcript by default; 30-day automatic deletion without a TTL/BAA, configurable down to 1 hour, plus an explicit delete API and a training opt-out (`https://www.assemblyai.com/docs/data-retention-and-model-training`). For anonymous-source testimony this is the vendor requiring the most explicit configuration.

---

## 4. Video: demux and extraction

### 4.1 The providers' own positions

- **Deepgram**: accepts MP4/WebM/MOV and other video containers among its 100+ formats (`https://developers.deepgram.com/docs/supported-audio-formats`), but for large video files the docs say to extract the audio stream first (`https://developers.deepgram.com/docs/pre-recorded-audio`).
- **AssemblyAI**: "when you upload a video to our API, the audio will be extracted from it and processed independently, so the list of supported video formats isn't exhaustive" — demux is provider-side and requires no Worker work (`https://www.assemblyai.com/docs/faq/what-audio-and-video-file-types-are-supported-by-your-api`).
- **OpenAI**: `mp4`/`webm` are accepted file formats (`https://platform.openai.com/docs/guides/speech-to-text`).
- **Groq**: `mp4`/`webm` accepted; only the first audio track is transcribed (`https://console.groq.com/docs/speech-to-text`).
- **Workers AI**: no format list is published, and no guide demonstrates video input `[unverified]`.

### 4.2 Cloudflare Media Transformations — the Worker-native demux

Media Transformations is a Cloudflare product (billed with Image Transformations) that transforms videos stored *outside* Stream. It exposes a `media` binding to Workers (`https://developers.cloudflare.com/stream/transform-videos/bindings/`, last updated 1 September 2026):

- `env.MEDIA.input(readableStream).transform({width,height,fit}).output({mode, time, duration, format, audio, imageCount})`
- `mode: "audio"` outputs an AAC-encoded M4A file.
- Results come back as `.response()`, `.media()` (stream), or `.contentType()`; output can be written straight back to R2.
- Cloudflare's own binding example is named **"Transcribe audio with Media Transformations and Workers AI"**: extract `mode: "audio"`, then `env.AI.run("@cf/openai/whisper", {audio: [...new Uint8Array(await audio.arrayBuffer())]})`.

**Limits** (`https://developers.cloudflare.com/stream/transform-videos/`):

- Input video **< 100 MB**, **maximum duration 10 minutes**.
- `time` range **0–10 m**; output `duration` range **1 s–60 s** for `video`/`audio`/`spritesheet`.
- Input ideally MP4/H.264 with AAC or MP3 audio; other formats "may work but are untested".
- URL mode requires the origin (e.g. an R2 public bucket) to support HTTP `HEAD` and range requests and return `Content-Range`.
- Binding mode is public beta: operations are not billed during beta, may have higher latency, and are **not automatically cached** (`https://developers.cloudflare.com/stream/transform-videos/bindings/`).

So Media Transformations solves *short* clips end-to-end inside a Worker, and gives 1–60 s audio slices for longer video — but it cannot extract audio from a video longer than 10 minutes at all. A 90-minute interview video must be cut into ≤10-minute, ≤100 MB source segments first (in the browser, or via another tool) before Media Transformations can touch it.

### 4.3 What runs on Workers vs not

| Task | Runs on Workers? | Source |
|---|---|---|
| Read video bytes from R2, range-read a slice | Yes | `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/` |
| Extract audio from a short video / slice | Yes, Media Transformations binding (Paid, beta) | `https://developers.cloudflare.com/stream/transform-videos/bindings/` |
| Transcribe 1–60 s clips inline | Yes, Workers AI | §1 |
| Demux/transcode arbitrary long video, resample, seek by time | No documented path on Workers; Containers only | `https://developers.cloudflare.com/containers/`, ADR-0011 |
| Segment long recordings without a demuxer | Browser at capture time (MediaRecorder/WebCodecs) is the realistic route | Not Cloudflare-documented for Surveyor; design consequence of the limits above **[unverified]** |
| Video-first ingest with server-side captioning | Cloudflare Stream, a separate paid product | §4.4 |

### 4.4 Cloudflare Stream as a video-first alternative

If Surveyor ever ingests video as video rather than as bytes to be drained, Stream can generate AI captions for a ready video in 12 languages (including English and Japanese, but not Arabic, Hindi, Mandarin or Vietnamese per the listed set), returning WebVTT, with a max 10 MB caption file; upload must precede generation and the endpoint is per-language (`https://developers.cloudflare.com/stream/edit-videos/adding-captions/`). Stream also produces downloadable M4A audio (`https://developers.cloudflare.com/stream/viewing-videos/download-videos/`). Pricing is $5 per 1,000 minutes stored per month plus $1 per 1,000 minutes delivered; ingress/encoding free (`https://developers.cloudflare.com/stream/pricing/`). This is a product decision outside the BYOK registry and outside ADR-0002's "held lane" model, but it is the only Cloudflare service that transcribes video server-side without a Worker-side demux.

---

## 5. Provenance for the evidence chain

`CONTEXT.md` defines **Recording provenance** as the recorder/date/place/jurisdiction/consent metadata the recording gate checks before publication. The transcription's own metadata is the second layer: what the platform records about *how the text was produced*, so a finding can be traced back to the model that produced it and the operator can judge its reliability.

### 5.1 What each source returns

| Field | Workers AI turbo | Deepgram | AssemblyAI | OpenAI | Groq |
|---|---|---|---|---|---|
| Model id | the `@cf/...` id the caller chose | `metadata.model_info[].name` + `version` + `arch` | `speech_model_used` + `speech_models[]` | response `model` | request model |
| Request/job id | not in output schema **[unverified]** | `metadata.request_id` | transcript `id` | response id | response id **[unverified]** |
| Detected language | `transcription_info.language` | `detect_language` result | `language_code` + `language_confidence` | `languages[]` | caller hint only |
| Language confidence | `language_probability` | — | `language_confidence` | not documented **[unverified]** | — |
| Duration | `transcription_info.duration`, `duration_after_vad` | `metadata.duration` | `audio_duration` | — | — |
| Segment timing | `segments[].start/end` | `words[].start/end`, paragraphs | `words[]`, `utterances[]` | `segments[]` (diarize); whisper-1 words | `segments[]`, `words[]` |
| Confidence | `segments[].avg_logprob`, `no_speech_prob`, `compression_ratio` | `confidence` per word/transcript | `confidence` per word/transcript | not documented **[unverified]** | `avg_logprob`, `no_speech_prob`, `compression_ratio` |
| Speaker labels | No | `diarize` | `speaker_labels` | `gpt-4o-transcribe-diarize` | No |
| Source integrity | R2 object etag/size (platform-side) | `metadata.sha256` | — | — | — |

Sources: Workers AI turbo output schema (`https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-output.json`); Deepgram pre-recorded response example (`https://developers.deepgram.com/docs/pre-recorded-audio`); AssemblyAI transcript schema (`https://www.assemblyai.com/docs/api-reference/transcripts/submit`); OpenAI transcription guide (`https://platform.openai.com/docs/guides/speech-to-text`); Groq metadata fields (`https://console.groq.com/docs/speech-to-text`).

### 5.2 Recommended minimum metadata per transcription

Drawn from the fields above, and keeping with ADR-0002's "per-file status is operator-visible" rule:

1. **Source binding** — R2 key, byte size, etag/sha256 of the original media (the platform already holds the raw bytes until the lane drains; `Attachment` in `CONTEXT.md`).
2. **Provider and model** — provider name, model id as requested, and the model version string *when the provider returns one* (Deepgram does; Workers AI does not, which should be recorded as "unpinned" rather than omitted).
3. **Language and detection confidence** — `language`, `language_probability`/`language_confidence`; record whether the language was detected or supplied as a hint, because a wrong hint changes accuracy.
4. **Timebase** — duration, and whether timestamps are relative to the original recording or to a chunk. For chunked runs, record chunk index, byte range, source start offset (from the overlapping window), model params per chunk (`vad_filter`, `beam_size`, `temperature`).
5. **Reliability signals** — per-segment `avg_logprob`/`no_speech_prob`/`compression_ratio` where available, or transcript/word `confidence`. These are the fields that let the operator see a garbled passage before it becomes a finding.
6. **Consent/jurisdiction** — the existing recording-gate fields from `CONTEXT.md`; they attach to the media, not the transcript, but belong in the same evidence record.
7. **Gate outcome** — the name-leak gate verdict and the `parsed`/`OCRed`/`rescued`-equivalent status for audio (ADR-0002 already defines the semantics; audio should reuse `OCRed` or add an explicit `transcribed` state).

### 5.3 Gate interaction

ADR-0002 puts the name-leak gate before the mirror and treats OCR output as untrusted input; transcripts must be treated the same way. Two audio-specific risks deserve a line in the eventual ADR:

- ASR systematically mangles proper nouns, so a name the gate would catch in text may arrive misspelt and pass. Deepgram's `keyterm`/`redact`, AssemblyAI's `entity_detection`, and an `initial_prompt` on Whisper (224-token limit on `whisper-1`; `initial_prompt`/`prefix` on Workers AI turbo) can bias towards known names, but none guarantees detection.
- Where the provider offers server-side entity detection, enabling it sends no additional data beyond the audio already sent, but it is a second vendor model touching source material — record it in provenance if used.

---

## 6. Recommendation

### 6.1 Default path: Workers AI, registry as the rescue lane

Mirroring ADR-0011's keyless-then-BYOK shape for OCR:

- **Default (keyless): `@cf/openai/whisper-large-v3-turbo` through `env.AI`.** Decisive points: the lowest published price ($0.0005/min), a free allocation that covers ~3.5 audio hours/day (derived, §1.5), the richest default provenance fields of any keyless option (`language_probability`, `duration_after_vad`, per-segment `avg_logprob`/`no_speech_prob`), and no new vendor relationship — Cloudflare already processes the corpus for OCR. Chunk with overlap in the async lane (§2.3) and record chunk offsets.
- **Second keyless option: `@cf/deepgram/nova-3`** when diarisation, word confidence or 60+ languages are needed. At $0.0052/min HTTP it costs the same as Deepgram direct pre-recorded multilingual, so the registry only wins if the operator already holds a Deepgram key and wants the concurrency/URL features.
- **BYOK lane (new `audio` capability, chained like `vision`)**: `gpt-transcribe` for accuracy and language detection (25 MB; ZDR-eligible), Groq `whisper-large-v3-turbo` for the cheapest OpenAI-shaped transport, Deepgram direct when the 2 GB URL input avoids uploading, AssemblyAI when the 5 GB/10 hr limit and URL ingest beat chunking — accepting its 30-day default retention unless configured otherwise. All four are reachable through AI SDK v7 `transcribe()` providers, so the registry can keep its provider-chain semantics.
- **Video**: Media Transformations `mode: "audio"` where the video is short enough (<100 MB / ≤10 min, or sliced at capture time); otherwise the provider's own video demux (AssemblyAI/Deepgram/Groq/OpenAI accept MP4). No server-side ffmpeg.

### 6.2 The decisive limits, at a glance

| Constraint | Value | Source |
|---|---|---|
| Workers AI audio input | inline only — no URL/R2 source | §1.3 |
| Worker request body | 100 MB Free/Pro | `https://developers.cloudflare.com/workers/platform/limits/` |
| Isolate memory | 128 MB | same |
| Workers AI ASR rate | 720 req/min; no published size/duration cap | `https://developers.cloudflare.com/workers-ai/platform/limits/` |
| OpenAI/Groq single file | 25 MB (Groq dev: 100 MB) | §3.1, §3.4 |
| Deepgram | 2 GB; 10-min processing timeout (Nova) → 504 | `https://developers.deepgram.com/docs/pre-recorded-audio` |
| AssemblyAI | 5 GB / 10 h; 30-day default retention | §3.3 |
| Media Transformations | <100 MB, ≤10 min input; 1–60 s audio output | `https://developers.cloudflare.com/stream/transform-videos/` |
| Queue consumer / Workflow step | 15 min / unlimited per step | `https://developers.cloudflare.com/workers/platform/limits/` |

### 6.3 Open questions to resolve before an ADR

1. **Chunk size and overlap** — Cloudflare's 1 MB example is not sentence-aware; a spike should measure WER at boundaries for 1 MB vs 10-second-overlap chunking with stitching.
2. **Where chunking happens** — Worker-side byte slicing (works today, cuts mid-word) versus browser-side time slicing at capture (only helps new recordings, not uploaded evidence).
3. **Format support on Workers AI** — only MP3 is demonstrated; M4A/WAV/OGG need a bake-off before the lane advertises them.
4. **Model version pinning** — Workers AI ids are unpinned; the ADR should state that provenance records the id and time of call, and treats Workers AI output as a moving model version.
5. **Retention defaults** — whether the operator's BYOK entry for AssemblyAI must carry a TTL/deletion configuration before the lane will use it (consistent with ADR-0002's gate-before-mirror ethos).

---

## 7. The three biggest constraints for long recordings

1. **Inline-only ingestion into Workers AI, under a 128 MB isolate.** Every byte must be read into the Worker, encoded (base64 is 4/3×; a byte array is worse), and pushed through `env.AI.run()`. Cloudflare's only documented pattern chunks by bytes with no overlap or timestamp offsetting, and no per-request duration or size limit is published. Long audio therefore cannot be a single call, and a naive chunk loop loses words at every boundary and restarts the clock on every chunk.
2. **No server-side demux/resample, and the one Cloudflare-native extractor is capped at 10 minutes / 100 MB.** Media Transformations can produce 1–60 s audio slices inside a Worker, and providers accept video directly, but there is no Worker-side ffmpeg, decoder, or time-indexed R2 range to cut a long recording into correct segments. Either the media arrives pre-segmented (browser capture) or the provider does the demux (AssemblyAI/Deepgram/Groq/OpenAI, with their file-size limits and custody implications).
3. **Provider caps and processing timeouts force sharding.** Deepgram times out after 10 minutes of processing (Nova) with a 2 GB ceiling; OpenAI and Groq cap files at 25 MB; AssemblyAI tops out at 5 GB/10 hours but stores the transcript 30 days by default; Media Transformations cannot see input over 10 minutes. A Queue consumer has 15 minutes of wall time and a Workflow step has unlimited wall time but a CPU budget, so any long recording must be processed as an ordered, resumable set of chunk jobs that record their offsets — including a retry story that does not duplicate text in the mirror.

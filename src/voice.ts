import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export interface TranscriptionResult {
  text: string;
  backend: "parakeet" | "sherpa-onnx" | "openai";
  durationMs: number;
}

export type TranscriptionBackend = "parakeet" | "sherpa-onnx" | "openai";

// Minimal interface for the parakeet-coreml engine instance.
interface ParakeetEngine {
  initialize(): Promise<void>;
  transcribe(samples: Float32Array): Promise<unknown>;
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): unknown;
  free?: () => void;
}

interface SherpaOfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  free?: () => void;
}

interface SherpaRecognizerConstructor {
  new (config: unknown): SherpaOfflineRecognizer;
}

interface SherpaConfig {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  numThreads: number;
}

const PARAKEET_SPECIFIER = "parakeet-coreml";
const SHERPA_ONNX_SPECIFIER = "sherpa-onnx-node";
const SHERPA_ONNX_MODEL_DIR_ENV = "SHERPA_ONNX_MODEL_DIR";
const SHERPA_ONNX_NUM_THREADS_ENV = "SHERPA_ONNX_NUM_THREADS";
const SHERPA_MODEL_DOCS_URL =
  "https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html";
const FFMPEG_INSTALL_MESSAGE = "ffmpeg not found. Install it with: brew install ffmpeg";
const NO_BACKEND_ERROR = `Voice messages require a transcription backend.

Option 1: Install Parakeet CoreML for local transcription on Apple Silicon (free, private, ~1.5GB download):
  npm install parakeet-coreml
Also requires ffmpeg: brew install ffmpeg

Option 2: Install Sherpa-ONNX for local/offline Parakeet transcription on Intel-based Macs, where parakeet-coreml is not supported (also works on Apple Silicon):
  npm install sherpa-onnx-node
  Download the Intel Mac-friendly Parakeet model from:
    ${SHERPA_MODEL_DOCS_URL}
  Set ${SHERPA_ONNX_MODEL_DIR_ENV}=/path/to/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8

Option 3: Set OPENAI_API_KEY for cloud transcription (~$0.006/min):
  Add OPENAI_API_KEY=sk-... to your .env file`;

const _require = createRequire(import.meta.url);
let _importModule: (specifier: string) => Promise<unknown> = async (specifier) => _require(specifier);
let _decodeAudio: (filePath: string) => Promise<Float32Array> = decodeAudioToSamples;
let _engine: ParakeetEngine | null = null;

export function _setImportHook(hook: (specifier: string) => Promise<unknown>): void {
  _importModule = hook;
}

export function _setDecodeHook(hook: (filePath: string) => Promise<Float32Array>): void {
  _decodeAudio = hook;
}

export function _resetImportHook(): void {
  _importModule = async (specifier) => _require(specifier);
  _decodeAudio = decodeAudioToSamples;
  _engine = null;
}

export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  try {
    const parakeetMod = await _importModule(PARAKEET_SPECIFIER);
    return await transcribeWithParakeet(filePath, parakeetMod);
  } catch (error) {
    if (!isModuleNotFoundError(error, PARAKEET_SPECIFIER)) {
      throw error;
    }
  }

  const sherpaConfig = resolveSherpaConfig();
  if (sherpaConfig) {
    try {
      const sherpaMod = await _importModule(SHERPA_ONNX_SPECIFIER);
      return await transcribeWithSherpaOnnx(filePath, sherpaMod, sherpaConfig);
    } catch (error) {
      if (!isModuleNotFoundError(error, SHERPA_ONNX_SPECIFIER)) {
        throw error;
      }
    }
  }

  if (hasOpenAIApiKey()) {
    return await transcribeWithOpenAI(filePath);
  }

  throw new Error(NO_BACKEND_ERROR);
}

export async function getAvailableBackends(): Promise<TranscriptionBackend[]> {
  const backends: TranscriptionBackend[] = [];

  try {
    await _importModule(PARAKEET_SPECIFIER);
    backends.push("parakeet");
  } catch {
    // Treat import failures as unavailable so /start can still work.
  }

  if (resolveSherpaConfig()) {
    try {
      await _importModule(SHERPA_ONNX_SPECIFIER);
      backends.push("sherpa-onnx");
    } catch {
      // Treat import failures as unavailable so /start can still work.
    }
  }

  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }

  return backends;
}

async function transcribeWithParakeet(filePath: string, parakeetMod: unknown): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const samples = await _decodeAudio(filePath);

  if (!_engine) {
    const mod = parakeetMod as Record<string, unknown> | null;
    const ParakeetAsrEngine =
      (mod?.ParakeetAsrEngine as (new () => unknown) | undefined) ??
      ((mod?.default as Record<string, unknown> | undefined)?.ParakeetAsrEngine as (new () => unknown) | undefined);

    if (typeof ParakeetAsrEngine !== "function") {
      throw new Error("parakeet-coreml was loaded but does not expose a ParakeetAsrEngine class");
    }

    const engine = new ParakeetAsrEngine() as Record<string, unknown>;

    if (typeof engine.initialize !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose initialize()");
    }

    if (typeof engine.transcribe !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose transcribe(samples)");
    }

    await (engine.initialize as () => Promise<void>)();
    _engine = engine as unknown as ParakeetEngine;
  }

  const result = await _engine.transcribe(samples);
  const text = extractTranscribedText(result);
  if (text === undefined) {
    throw new Error("parakeet-coreml returned an unsupported transcription result");
  }

  const durationMs =
    typeof result === "object" && result !== null && typeof (result as { durationMs?: unknown }).durationMs === "number"
      ? (result as { durationMs: number }).durationMs
      : Date.now() - startedAt;

  return {
    text,
    backend: "parakeet",
    durationMs,
  };
}

async function transcribeWithSherpaOnnx(
  filePath: string,
  sherpaMod: unknown,
  config: SherpaConfig,
): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const samples = await _decodeAudio(filePath);
  const OfflineRecognizer = resolveSherpaRecognizerConstructor(sherpaMod);

  if (typeof OfflineRecognizer !== "function") {
    throw new Error("sherpa-onnx-node was loaded but does not expose an OfflineRecognizer class");
  }

  const recognizer = new OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: config.encoder,
        decoder: config.decoder,
        joiner: config.joiner,
      },
      tokens: config.tokens,
      numThreads: config.numThreads,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });

  const stream = recognizer.createStream();

  try {
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = extractTranscribedText(result);

    if (text === undefined) {
      throw new Error("sherpa-onnx-node returned an unsupported transcription result");
    }

    return {
      text,
      backend: "sherpa-onnx",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    stream.free?.();
    recognizer.free?.();
  }
}

async function transcribeWithOpenAI(filePath: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(NO_BACKEND_ERROR);
  }

  const startedAt = Date.now();
  const audioBuffer = await readFile(filePath);
  const ext = (path.extname(filePath) || ".ogg").slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    webm: "audio/webm", flac: "audio/flac",
  };
  const mimeType = mimeTypes[ext] ?? "audio/ogg";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), path.basename(filePath) || "audio.ogg");
  form.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => "")).trim();
    throw new Error(
      `OpenAI transcription failed (${response.status}): ${errorText || response.statusText || "Unknown error"}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "openai",
    durationMs: Date.now() - startedAt,
  };
}

function resolveSherpaRecognizerConstructor(sherpaMod: unknown): SherpaRecognizerConstructor | undefined {
  const mod = sherpaMod as Record<string, unknown> | null;
  return (mod?.OfflineRecognizer as SherpaRecognizerConstructor | undefined) ??
    ((mod?.default as Record<string, unknown> | undefined)?.OfflineRecognizer as
      | SherpaRecognizerConstructor
      | undefined);
}

function resolveSherpaConfig(): SherpaConfig | undefined {
  const modelDirRaw = process.env[SHERPA_ONNX_MODEL_DIR_ENV]?.trim();
  if (!modelDirRaw) {
    return undefined;
  }

  const modelDir = path.resolve(modelDirRaw);
  const encoder = path.join(modelDir, "encoder.int8.onnx");
  const decoder = path.join(modelDir, "decoder.int8.onnx");
  const joiner = path.join(modelDir, "joiner.int8.onnx");
  const tokens = path.join(modelDir, "tokens.txt");

  if (![encoder, decoder, joiner, tokens].every((file) => existsSync(file))) {
    return undefined;
  }

  return {
    encoder,
    decoder,
    joiner,
    tokens,
    numThreads: parseSherpaThreadCount(process.env[SHERPA_ONNX_NUM_THREADS_ENV]),
  };
}

function parseSherpaThreadCount(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return 2;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

function decodeAudioToSamples(filePath: string): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const ffmpeg = spawn("ffmpeg", ["-i", filePath, "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };

    ffmpeg.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.once("error", (error) => {
      finish(() => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(FFMPEG_INSTALL_MESSAGE));
          return;
        }
        reject(error);
      });
    });

    ffmpeg.once("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const reason = stderr || (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
          reject(new Error(`ffmpeg failed to decode audio: ${reason}`));
          return;
        }

        const buffer = Buffer.concat(stdoutChunks);
        if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
          reject(new Error("ffmpeg returned invalid float32 PCM output"));
          return;
        }

        const samples = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ).slice();
        resolve(samples);
      });
    });
  });
}

function hasOpenAIApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function extractTranscribedText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }

  return undefined;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const message = error instanceof Error ? error.message : String(error);
    // Only treat as "not installed" if the message references the specific package.
    // A broken transitive dependency (e.g. missing native addon) should surface as a real error.
    return !message || message.includes(specifier);
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Cannot find package '${specifier}'`) ||
    message.includes(`Cannot find module '${specifier}'`) ||
    message.includes(`Cannot resolve module '${specifier}'`)
  );
}

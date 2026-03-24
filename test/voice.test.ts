import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetImportHook,
  _setDecodeHook,
  _setImportHook,
  getAvailableBackends,
  getVoiceBackendStatus,
  transcribeAudio,
} from "../src/voice.js";

describe("voice transcription", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalSherpaModelDir = process.env.SHERPA_ONNX_MODEL_DIR;
  const originalSherpaNumThreads = process.env.SHERPA_ONNX_NUM_THREADS;

  let tempDir: string;
  let audioPath: string;
  let sherpaModelDir: string;

  const moduleNotFound = (specifier: string): Error & { code?: string } => {
    const error = new Error(`Cannot find package '${specifier}'`) as Error & { code?: string };
    error.code = "ERR_MODULE_NOT_FOUND";
    return error;
  };

  const createSherpaModel = (omit: string[] = []): void => {
    mkdirSync(sherpaModelDir, { recursive: true });

    const files: Array<[string, string]> = [
      ["encoder.int8.onnx", "encoder"],
      ["decoder.int8.onnx", "decoder"],
      ["joiner.int8.onnx", "joiner"],
      ["tokens.txt", "tokens"],
    ];

    for (const [name, contents] of files) {
      if (!omit.includes(name)) {
        writeFileSync(path.join(sherpaModelDir, name), contents);
      }
    }

    process.env.SHERPA_ONNX_MODEL_DIR = sherpaModelDir;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-voice-"));
    audioPath = path.join(tempDir, "sample.ogg");
    sherpaModelDir = path.join(tempDir, "sherpa-model");
    writeFileSync(audioPath, Buffer.from("audio"));
    delete process.env.OPENAI_API_KEY;
    delete process.env.SHERPA_ONNX_MODEL_DIR;
    delete process.env.SHERPA_ONNX_NUM_THREADS;
    _resetImportHook();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    _resetImportHook();
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });

    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }

    if (originalSherpaModelDir === undefined) {
      delete process.env.SHERPA_ONNX_MODEL_DIR;
    } else {
      process.env.SHERPA_ONNX_MODEL_DIR = originalSherpaModelDir;
    }

    if (originalSherpaNumThreads === undefined) {
      delete process.env.SHERPA_ONNX_NUM_THREADS;
    } else {
      process.env.SHERPA_ONNX_NUM_THREADS = originalSherpaNumThreads;
    }
  });

  it("uses parakeet when available", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        return {
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(samples: Float32Array): Promise<{ text: string; durationMs: number }> {
              expect(samples).toBeInstanceOf(Float32Array);
              expect(samples.length).toBe(100);
              return { text: "hello world", durationMs: 5 };
            }
          },
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("hello world");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBe(5);
  });

  it("serializes concurrent parakeet calls and reuses one engine", async () => {
    let initializeCount = 0;
    let transcribeCount = 0;
    let activeTranscribes = 0;
    let maxConcurrentTranscribes = 0;
    let releaseFirstTranscribe!: () => void;
    let markFirstTranscribeActive!: () => void;
    const firstTranscribeStarted = new Promise<void>((resolve) => {
      releaseFirstTranscribe = resolve;
    });
    const firstTranscribeActive = new Promise<void>((resolve) => {
      markFirstTranscribeActive = resolve;
    });

    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {
          initializeCount += 1;
        }

        async transcribe(): Promise<{ text: string; durationMs: number }> {
          transcribeCount += 1;
          activeTranscribes += 1;
          maxConcurrentTranscribes = Math.max(maxConcurrentTranscribes, activeTranscribes);

          if (transcribeCount === 1) {
            markFirstTranscribeActive();
            await firstTranscribeStarted;
          }

          activeTranscribes -= 1;
          return { text: `transcript-${transcribeCount}`, durationMs: 5 };
        }
      },
    }));

    const first = transcribeAudio(audioPath);
    const second = transcribeAudio(audioPath);
    await firstTranscribeActive;
    expect(maxConcurrentTranscribes).toBe(1);
    expect(initializeCount).toBe(1);

    releaseFirstTranscribe();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.text).toBe("transcript-1");
    expect(secondResult.text).toBe("transcript-2");
    expect(initializeCount).toBe(1);
    expect(maxConcurrentTranscribes).toBe(1);
  });

  it("releases the parakeet lock after a failed transcription", async () => {
    let callCount = 0;

    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}

        async transcribe(): Promise<{ text: string; durationMs: number }> {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("native failure");
          }
          return { text: "recovered", durationMs: 5 };
        }
      },
    }));

    const first = transcribeAudio(audioPath);
    const second = transcribeAudio(audioPath);

    await expect(first).rejects.toThrow("native failure");
    await expect(second).resolves.toMatchObject({
      text: "recovered",
      backend: "parakeet",
      durationMs: 5,
    });
  });

  it("falls back to sherpa-onnx when parakeet is unavailable", async () => {
    createSherpaModel();
    process.env.SHERPA_ONNX_NUM_THREADS = "4";
    let recognizerConstructCount = 0;
    _setDecodeHook(async () => new Float32Array([0.1, 0.2, 0.3]));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }

      if (specifier === "sherpa-onnx-node") {
        return {
          OfflineRecognizer: class {
            constructor(config: unknown) {
              recognizerConstructCount += 1;
              expect(config).toMatchObject({
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                  tokens: path.join(sherpaModelDir, "tokens.txt"),
                  numThreads: 4,
                  provider: "cpu",
                  modelType: "nemo_transducer",
                  transducer: {
                    encoder: path.join(sherpaModelDir, "encoder.int8.onnx"),
                    decoder: path.join(sherpaModelDir, "decoder.int8.onnx"),
                    joiner: path.join(sherpaModelDir, "joiner.int8.onnx"),
                  },
                },
              });
            }

            createStream() {
              return {
                acceptWaveform: vi.fn((input: { sampleRate: number; samples: Float32Array }) => {
                  expect(input.sampleRate).toBe(16000);
                  const roundedSamples = Array.from(input.samples).map((value) => Number(value.toFixed(3)));
                  expect(roundedSamples).toEqual([0.1, 0.2, 0.3]);
                }),
                free: vi.fn(),
              };
            }

            decode(): void {}

            getResult(): { text: string } {
              return { text: "local sherpa transcript" };
            }

            free(): void {}
          },
        };
      }

      throw new Error(`unexpected import: ${specifier}`);
    });

    const first = await transcribeAudio(audioPath);
    const second = await transcribeAudio(audioPath);

    expect(first.text).toBe("local sherpa transcript");
    expect(first.backend).toBe("sherpa-onnx");
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.text).toBe("local sherpa transcript");
    expect(recognizerConstructCount).toBe(1);
  });

  it("fails clearly when SHERPA_ONNX_MODEL_DIR is set but incomplete", async () => {
    createSherpaModel(["decoder.int8.onnx", "joiner.int8.onnx"]);
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("SHERPA_ONNX_MODEL_DIR is set to");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("decoder.int8.onnx");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("joiner.int8.onnx");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails clearly when SHERPA_ONNX_MODEL_DIR is set but sherpa-onnx-node is missing", async () => {
    createSherpaModel();
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      if (specifier === "sherpa-onnx-node") {
        throw moduleNotFound("sherpa-onnx-node");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("sherpa-onnx-node is not installed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI when parakeet is unavailable and sherpa is not configured", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "cloud transcript" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "cloud transcript",
      backend: "openai",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer sk-test" },
        body: expect.any(FormData),
      }),
    );
  });

  it("throws a helpful error when no backend is available", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("Voice messages require a transcription backend.");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("npm install parakeet-coreml");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("brew install ffmpeg");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("sherpa-onnx-node");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("SHERPA_ONNX_MODEL_DIR");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("OPENAI_API_KEY=sk-");
  });

  it("surfaces OpenAI API errors", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server exploded",
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription failed (500): server exploded",
    );
  });

  it("rethrows parakeet runtime errors instead of falling through", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<never> {
          throw new Error("GPU failure");
        }
      },
    }));
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audioPath)).rejects.toThrow("GPU failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows sherpa runtime errors instead of falling through", async () => {
    createSherpaModel();
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }

      if (specifier === "sherpa-onnx-node") {
        return {
          OfflineRecognizer: class {
            createStream() {
              return {
                acceptWaveform: vi.fn(),
              };
            }

            decode(): void {
              throw new Error("sherpa decode failed");
            }

            getResult(): { text: string } {
              return { text: "unused" };
            }
          },
        };
      }

      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audioPath)).rejects.toThrow("sherpa decode failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports available backends", async () => {
    createSherpaModel();
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        return {
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(): Promise<{ text: string; durationMs: number }> {
              return { text: "ignored", durationMs: 5 };
            }
          },
        };
      }

      if (specifier === "sherpa-onnx-node") {
        return {
          OfflineRecognizer: class {
            createStream() {
              return { acceptWaveform: vi.fn() };
            }
            decode(): void {}
            getResult(): { text: string } {
              return { text: "ignored" };
            }
          },
        };
      }

      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";

    await expect(getAvailableBackends()).resolves.toEqual(["parakeet", "sherpa-onnx", "openai"]);

    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      if (specifier === "sherpa-onnx-node") {
        throw moduleNotFound("sherpa-onnx-node");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    delete process.env.SHERPA_ONNX_MODEL_DIR;
    delete process.env.OPENAI_API_KEY;

    await expect(getAvailableBackends()).resolves.toEqual([]);
  });

  it("surfaces sherpa misconfiguration in backend status", async () => {
    createSherpaModel(["decoder.int8.onnx", "joiner.int8.onnx"]);
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(getAvailableBackends()).resolves.toEqual([]);
    await expect(getVoiceBackendStatus()).resolves.toMatchObject({
      backends: [],
      warning: expect.stringContaining("SHERPA_ONNX_MODEL_DIR is set to"),
    });
  });

  it("allows empty transcripts without throwing", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "", durationMs: 5 };
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "",
      backend: "parakeet",
      durationMs: 5,
    });
  });

  it("falls back to elapsed duration when parakeet omits durationMs", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string }> {
          return { text: "default duration transcript" };
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("default duration transcript");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when OpenAI response is missing text field", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: "ok" }),
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription response did not include a text field",
    );
  });

  it("throws when fetch rejects entirely (network failure)", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow("network unreachable");
  });

  it("surfaces broken parakeet transitive dependency instead of falling through", async () => {
    _setImportHook(async () => {
      // Simulate a broken native addon — MODULE_NOT_FOUND for a sub-dependency unrelated to parakeet-coreml
      const error = new Error("Cannot find module '/usr/lib/node_modules/napi-bindings/build/Release/binding.node'") as Error & { code?: string };
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Should throw the transitive error, NOT silently fall through to OpenAI
    await expect(transcribeAudio(audioPath)).rejects.toThrow("binding.node");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a helpful error when ffmpeg is missing", async () => {
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 5 };
        }
      },
    }));
    // Simulate the message that decodeAudioToSamples already produces on ENOENT —
    // the real conversion is tested in voice.decode.test.ts.
    _setDecodeHook(async () => {
      throw new Error("ffmpeg not found. Install it with: brew install ffmpeg");
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("brew install ffmpeg");
  });

  it("propagates parakeet engine initialization failures", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {
          throw new Error("model download failed");
        }
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 5 };
        }
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("model download failed");
  });

  it("throws when parakeet-coreml does not expose ParakeetAsrEngine", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({}));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("does not expose a ParakeetAsrEngine class");
  });

  it("throws when sherpa-onnx-node does not expose OfflineRecognizer", async () => {
    createSherpaModel();
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      if (specifier === "sherpa-onnx-node") {
        return {};
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("does not expose an OfflineRecognizer class");
  });

  it("throws when the parakeet engine does not expose transcribe", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("does not expose transcribe(samples)");
  });

  it("throws when parakeet returns an unsupported transcription result", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ segments: [] }> {
          return { segments: [] };
        }
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("unsupported transcription result");
  });

  it("throws when sherpa returns an unsupported transcription result", async () => {
    createSherpaModel();
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        throw moduleNotFound("parakeet-coreml");
      }
      if (specifier === "sherpa-onnx-node") {
        return {
          OfflineRecognizer: class {
            createStream() {
              return { acceptWaveform: vi.fn() };
            }
            decode(): void {}
            getResult(): { tokens: [] } {
              return { tokens: [] };
            }
          },
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("sherpa-onnx-node returned an unsupported transcription result");
  });

  it("resolves ParakeetAsrEngine from parakeet-coreml default export", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      default: {
        ParakeetAsrEngine: class {
          async initialize(): Promise<void> {}
          async transcribe(): Promise<{ text: string; durationMs: number }> {
            return { text: "default export transcript", durationMs: 3 };
          }
        },
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("default export transcript");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBe(3);
  });
});

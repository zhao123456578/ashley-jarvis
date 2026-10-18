// Native speaker verification using sherpa-onnx-node.
//
// Replaces the WASM diarization approach that was unstable for short
// wake-word snippets (~0.5s). The native SpeakerEmbeddingExtractor +
// SpeakerEmbeddingManager pair directly extracts a 512-dim embedding
// and compares via cosine similarity, which is far more reliable for
// short utterances than the diarization clustering approach.

import { app } from 'electron';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpaOnnx: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let manager: any = null;
let initialized = false;
let initializing: Promise<void> | null = null;

const SPEAKER_NAME = 'owner';

/** Lazily create the SpeakerEmbeddingExtractor + Manager (singleton). */
export async function ensureSpeakerVerifierReady(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    if (!sherpaOnnx) {
      sherpaOnnx = require('sherpa-onnx-node');
    }

    const modelPath = resolveModelPath();
    extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    });
    manager = new sherpaOnnx.SpeakerEmbeddingManager(extractor.dim);
    initialized = true;
  })();

  return initializing;
}

/** Resolve the embedding model file path for both dev and packaged app. */
function resolveModelPath(): string {
  // In development: <appPath>/dist/assets/speaker-verify/embedding-extractor.onnx
  // In production (packaged): process.resourcesPath/dist/assets/speaker-verify/embedding-extractor.onnx
  const base = app.isPackaged
    ? process.resourcesPath
    : app.getAppPath();
  return path.join(base, 'dist', 'assets', 'speaker-verify', 'embedding-extractor.onnx');
}

/** Extract embedding from a single audio buffer. */
export function extractEmbedding(
  samples: Float32Array,
  sampleRate: number
): Float32Array | null {
  if (!extractor) return null;
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  if (!extractor.isReady(stream)) return null;
  // enableExternalBuffer=false forces the native addon to copy the embedding
  // into a regular Node ArrayBuffer; Electron rejects napi external buffers
  // ("External buffers are not allowed") when they cross IPC.
  return extractor.compute(stream, false) as Float32Array;
}

/** Extract a combined embedding from multiple enrollment samples.
 *  Concatenates all samples into one long audio buffer for a stable embedding. */
export function extractEnrollmentEmbedding(
  samples: Float32Array[],
  sampleRate: number
): Float32Array | null {
  if (!extractor || samples.length === 0) return null;
  const total = samples.reduce((s, a) => s + a.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;
  for (const s of samples) {
    combined.set(s, offset);
    offset += s.length;
  }
  return extractEmbedding(combined, sampleRate);
}

/** Load a pre-computed owner embedding into the manager. */
export function loadOwnerEmbedding(embedding: number[]): void {
  if (!manager) return;
  if (manager.contains(SPEAKER_NAME)) {
    manager.remove(SPEAKER_NAME);
  }
  manager.add({ name: SPEAKER_NAME, v: Float32Array.from(embedding) });
}

/** Verify test audio against the stored owner embedding. */
export function verifySpeaker(
  testAudio: Float32Array,
  sampleRate: number,
  threshold: number
): { accepted: boolean; similarity: number } {
  if (!extractor || !manager) {
    return { accepted: false, similarity: -1 };
  }
  const testEmbedding = extractEmbedding(testAudio, sampleRate);
  if (!testEmbedding) {
    return { accepted: false, similarity: -1 };
  }
  const accepted = manager.verify({
    name: SPEAKER_NAME,
    v: testEmbedding,
    threshold,
  });
  // Also compute raw cosine similarity for logging/debugging
  const ownerEmbedding = getOwnerEmbedding();
  const similarity = ownerEmbedding
    ? cosineSimilarity(ownerEmbedding, Array.from(testEmbedding))
    : -1;
  return { accepted, similarity };
}

/** Get the current owner embedding from the manager (for similarity computation). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ownerEmbeddingCache: Float32Array | null = null;

export function setOwnerEmbeddingCache(embedding: number[]): void {
  ownerEmbeddingCache = Float32Array.from(embedding);
}

function getOwnerEmbedding(): Float32Array | null {
  return ownerEmbeddingCache;
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const arrA = a instanceof Float32Array ? a : Float32Array.from(a);
  const arrB = b instanceof Float32Array ? b : Float32Array.from(b);
  const len = Math.min(arrA.length, arrB.length);
  for (let i = 0; i < len; i++) {
    dot += arrA[i] * arrB[i];
    normA += arrA[i] * arrA[i];
    normB += arrB[i] * arrB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

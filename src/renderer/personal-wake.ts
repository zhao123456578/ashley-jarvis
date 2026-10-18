// Personal wake model — real speaker verification.
//
// Version 3 stores pre-computed speaker embeddings extracted by the
// sherpa-onnx-node native SpeakerEmbeddingExtractor (512-dim, 3D-Speaker
// ERes2Net). Verification computes a test embedding from the wake-word
// audio and compares cosine similarity via SpeakerEmbeddingManager.
//
// This replaces the v2 diarization approach that was unstable for short
// wake-word snippets (~0.5s). The native embedding extractor is far more
// reliable for short utterances.

export type PersonalWakeMode = 'off' | 'shadow' | 'active';

export const PERSONAL_WAKE_SAMPLE_RATE = 16000;
// Cosine similarity threshold for SpeakerEmbeddingManager.verify().
// 0.5 is the sherpa-onnx default; same-speaker scores are typically >0.7,
// different-speaker <0.3. For 0.5s short wake words, 0.5 provides a good
// balance — may need tuning based on actual similarity scores.
export const PERSONAL_WAKE_VERIFY_THRESHOLD = 0.5;

export type PersonalWakeModel = {
  version: 3;
  createdAt: string;
  keyword: string;
  sampleRate: number;
  mode: PersonalWakeMode;
  // Each entry is a raw Float32 PCM snippet (one spoken wake-word utterance).
  // Kept for backward compatibility and potential re-extraction.
  samples: number[][];
  // Pre-computed reference embeddings from enrollment.
  // The last entry is the combined embedding (all samples concatenated).
  embeddings: number[][];
  enrollment: {
    sampleCount: number;
    embeddingDim: number;
  };
};

// Minimum usable utterance length (seconds) — below this the embedding
// extractor cannot produce a reliable embedding.
// 0.3s (4800 samples at 16kHz) is sufficient for a 3-character wake word
// like "贾维斯" when spoken quickly.
export const MIN_UTTERANCE_SECONDS = 0.3;
export const MAX_UTTERANCE_SECONDS = 2.0;

function rmsOf(values: Float32Array | number[], start: number, end: number) {
  let sumSquares = 0;
  for (let i = start; i < end; i += 1) sumSquares += values[i] * values[i];
  return Math.sqrt(sumSquares / Math.max(1, end - start));
}

// Trim leading/trailing silence by energy, keep a short lead-in/tail so the
// word's onset and release are preserved, and cap the total length. Returns a
// plain number[] ready to serialise.
export function trimUtterance(raw: Float32Array, sampleRate: number): number[] {
  if (!raw || raw.length === 0) throw new Error('没有采集到声音。');
  const frameSize = Math.max(160, Math.floor(sampleRate * 0.02));
  // KWS detects wake words via keyword modelling (not RMS), so it can fire on
  // quiet utterances whose per-frame RMS is well below 0.012. A noise floor of
  // 0.006 lets trimUtterance retain those quiet wake words instead of treating
  // the entire window as silence and failing the length check.
  const noiseFloor = 0.006;
  let start = 0;
  let end = raw.length;
  for (let i = 0; i + frameSize <= raw.length; i += frameSize) {
    if (rmsOf(raw, i, i + frameSize) > noiseFloor) {
      start = Math.max(0, i - Math.floor(sampleRate * 0.08));
      break;
    }
  }
  for (let i = raw.length - frameSize; i >= 0; i -= frameSize) {
    if (rmsOf(raw, i, i + frameSize) > noiseFloor) {
      end = Math.min(raw.length, i + frameSize + Math.floor(sampleRate * 0.12));
      break;
    }
  }
  const maxSamples = Math.floor(sampleRate * MAX_UTTERANCE_SECONDS);
  if (end - start > maxSamples) {
    const extra = end - start - maxSamples;
    start += Math.floor(extra / 2);
    end -= Math.ceil(extra / 2);
  }
  const out = Array.from(raw.slice(start, end));
  if (out.length < Math.floor(sampleRate * MIN_UTTERANCE_SECONDS)) {
    throw new Error('录入的声音太短或太轻，请靠近麦克风、用正常音量再录一次。');
  }
  for (const value of out) {
    if (!Number.isFinite(value)) throw new Error('录入的声音包含无效数据。');
  }
  return out;
}

export function isPersonalWakeModel(value: unknown): value is PersonalWakeModel {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<PersonalWakeModel>;
  return model.version === 3
    && typeof model.createdAt === 'string'
    && typeof model.keyword === 'string'
    && model.sampleRate === PERSONAL_WAKE_SAMPLE_RATE
    && ['off', 'shadow', 'active'].includes(String(model.mode))
    && Array.isArray(model.samples)
    && model.samples.length >= 3
    && model.samples.every((sample) =>
      Array.isArray(sample)
      && sample.length >= Math.floor(PERSONAL_WAKE_SAMPLE_RATE * MIN_UTTERANCE_SECONDS)
      && sample.every(Number.isFinite)
    )
    && Array.isArray(model.embeddings)
    && model.embeddings.length > 0
    && model.embeddings.every((emb) =>
      Array.isArray(emb)
      && emb.every(Number.isFinite)
    );
}

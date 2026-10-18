export type WakeModelConfig = { keyword: string; modelFile: string };

const defaultWakeModel: WakeModelConfig = {
  keyword: '贾维斯',
  modelFile: 'sherpa-onnx-kws-zipformer-wenetspeech'
};

function readExtraWakeModels(): WakeModelConfig[] {
  const raw = new URLSearchParams(window.location.search).get('extraWakeModels');
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WakeModelConfig => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<WakeModelConfig>;
      return typeof candidate.keyword === 'string' && typeof candidate.modelFile === 'string';
    });
  } catch {
    return [];
  }
}

const wakeModels = [defaultWakeModel, ...readExtraWakeModels()];

export const voiceConfig = {
  wakeKeyword: '贾维斯',
  // Sherpa-onnx KWS with wenetspeech Zipformer transducer. Open-vocabulary:
  // the wake word is configured at runtime via a keywords string (ppinyin
  // tokens), so changing it needs no model retraining or wasm recompilation.
  wakeModelFile: 'sherpa-onnx-kws-zipformer-wenetspeech',
  wakeModels,
  // Sherpa KWS trigger threshold (0–1, lower = easier to fire). 0.25 is the
  // sherpa demo default; voice.ts still applies its own confirmation policy
  // on top of the emitted score.
  wakeThreshold: 0.25,
  wakeGain: 1.5,
  assemblySoundDurationMs: 2_600,
  outputLevelScale: 3.2,
  doubaoVoice: 'zh_male_xiaotian_jupiter_bigtts'
};

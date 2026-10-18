// speaker-verify-worker.js
//
// Hosts the sherpa-onnx offline speaker-diarization WASM runtime inside a
// dedicated Web Worker. The main thread MUST NOT load this runtime directly:
// its Emscripten build redefines the same globals (Module, FS, HEAP*, …)
// that the KWS wake-word runtime already owns on the main thread, and loading
// it there corrupts the KWS engine and stops all keyword detection.
//
// Message protocol (main → worker):
//   { type: 'init', baseUrl }
//   { type: 'verify', references: Float32Array[], test: Float32Array, threshold }
//   { type: 'enrollmentLabels', samples: Float32Array[], threshold }
//
// Message protocol (worker → main):
//   { type: 'ready', sampleRate }
//   { type: 'init-error', error: string }
//   { type: 'verify-result', accepted: boolean, detail: string, segments? }
//   { type: 'enrollment-result', labels: number[] | null }

/* eslint-env worker */

const GAP_SECONDS = 0.5;
// Enrollment captures 5 samples; using all of them (rather than only the last
// 3) gives the clustering a denser, more stable owner centre, which reduces
// the chance of the test utterance being split into a separate cluster on
// short wake-word snippets.
const MAX_REFERENCES = 5;

// Emscripten references window.location / window.prompt in a couple of
// branches. In a worker `window` is undefined; alias it to the worker global
// so those branches degrade gracefully instead of throwing ReferenceError.
self.window = self;

let sd = null;
let sampleRate = 16000;
let initResolve = null;
let initReject = null;

function initReady() {
  return new Promise((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });
}

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      await handleInit(msg.baseUrl);
      break;
    case 'verify':
      await handleVerify(msg.references, msg.test, msg.threshold);
      break;
    case 'enrollmentLabels':
      await handleEnrollmentLabels(msg.samples, msg.threshold);
      break;
    default:
      self.postMessage({ type: 'error', error: `Unknown message type: ${msg.type}` });
  }
};

async function handleInit(baseUrl) {
  if (sd) {
    self.postMessage({ type: 'ready', sampleRate });
    return;
  }
  const ready = initReady();

  const moduleConfig = {
    locateFile: (path) => `${baseUrl}/${path}`,
    onRuntimeInitialized: () => {
      try {
        const createDiar = self.createOfflineSpeakerDiarization;
        if (!createDiar) {
          initReject?.(new Error('createOfflineSpeakerDiarization not found after wasm init'));
          return;
        }
        sd = createDiar(self.Module);
        sampleRate = sd.sampleRate || 16000;
        initResolve?.(sd);
      } catch (error) {
        initReject?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  self.Module = moduleConfig;

  // 120 s watchdog for the 45 MB model bundle.
  const watchdog = setTimeout(() => {
    if (!sd) initReject?.(new Error('Speaker verifier wasm did not initialise within 120s'));
  }, 120_000);

  try {
    importScripts(`${baseUrl}/sherpa-onnx-speaker-diarization.js`);
    importScripts(`${baseUrl}/sherpa-onnx-wasm-main-speaker-diarization.js`);
    await ready;
    clearTimeout(watchdog);
    self.postMessage({ type: 'ready', sampleRate });
  } catch (error) {
    clearTimeout(watchdog);
    self.postMessage({
      type: 'init-error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function gap() {
  return new Float32Array(Math.floor(sampleRate * GAP_SECONDS));
}

function buildClip(references, test) {
  const g = gap();
  const refs = references.slice(-MAX_REFERENCES);
  const parts = [];
  for (let i = 0; i < refs.length; i += 1) {
    if (i > 0) parts.push(g);
    parts.push(refs[i]);
  }
  parts.push(g);
  const testStartSamples = parts.reduce((sum, p) => sum + p.length, 0);
  parts.push(test);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const clip = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    clip.set(part, offset);
    offset += part.length;
  }
  return { clip, testStartSeconds: testStartSamples / sampleRate };
}

function runDiarization(clip, threshold) {
  sd.setConfig({ clustering: { numClusters: -1, threshold } });
  return sd.process(clip);
}

async function handleVerify(references, test, threshold) {
  if (!sd) {
    self.postMessage({
      type: 'verify-result',
      accepted: true,
      detail: 'worker-not-ready (fail-open)'
    });
    return;
  }
  try {
    const { clip, testStartSeconds } = buildClip(references, test);
    const segments = runDiarization(clip, threshold);
    if (!segments || segments.length === 0) {
      self.postMessage({
        type: 'verify-result',
        accepted: true,
        detail: 'no-speech-segments (fail-open)'
      });
      return;
    }
    const ownerLabels = new Set();
    const testLabels = new Set();
    for (const seg of segments) {
      const center = (seg.start + seg.end) / 2;
      if (center < testStartSeconds) ownerLabels.add(seg.speaker);
      else testLabels.add(seg.speaker);
    }
    if (testLabels.size === 0) {
      // KWS already confirmed a wake word was spoken, so the test window MUST
      // contain speech. If the diarizer found owner segments but no test
      // segment, the voiceprint check failed — reject rather than fail-open,
      // otherwise a quiet/short impostor utterance could bypass the gate.
      self.postMessage({
        type: 'verify-result',
        accepted: false,
        detail: 'no-test-segment (rejected: KWS detected speech but diarizer found no test speaker)',
        segments
      });
      return;
    }
    const matched = [...testLabels].some((label) => ownerLabels.has(label));
    // Strict matching: only accept when the test utterance shares at least one
    // speaker label with the owner references. We do NOT fail-open on a
    // single-owner/single-test mismatch because that pattern is indistinguishable
    // from a genuine different speaker — accepting it would let anyone wake up.
    self.postMessage({
      type: 'verify-result',
      accepted: matched,
      detail: `ownerLabels=[${[...ownerLabels].join(',')}] testLabels=[${[...testLabels].join(',')}] `
        + `matched=${matched}`,
      segments
    });
  } catch (error) {
    self.postMessage({
      type: 'verify-result',
      accepted: true,
      detail: `worker-error fail-open: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

async function handleEnrollmentLabels(samples, threshold) {
  if (!sd) {
    self.postMessage({ type: 'enrollment-result', labels: null });
    return;
  }
  try {
    const g = gap();
    const parts = [];
    for (let i = 0; i < samples.length; i += 1) {
      if (i > 0) parts.push(g);
      parts.push(samples[i]);
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const clip = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      clip.set(part, offset);
      offset += part.length;
    }
    const segments = runDiarization(clip, threshold);
    const labels = [...new Set(segments.map((s) => s.speaker))];
    self.postMessage({ type: 'enrollment-result', labels });
  } catch (error) {
    console.error('[SpeakerVerifyWorker] enrollmentLabels failed', error);
    self.postMessage({ type: 'enrollment-result', labels: null });
  }
}

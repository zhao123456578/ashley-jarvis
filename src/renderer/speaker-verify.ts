// SpeakerVerifier — real speaker verification via the sherpa-onnx offline
// speaker-diarization WASM runtime (pyannote segmentation + 3D-Speaker
// ERes2Net embedding + fast clustering).
//
// The wasm build does not expose per-utterance embeddings directly, so we use
// diarization as a speaker-comparison primitive: reference (owner) snippets
// are concatenated with the new utterance, separated by silence, and we check
// whether the diarizer assigns them the SAME speaker label. Same label =
// owner; a different label = a different speaker = reject.
//
// The diarization runtime runs inside a dedicated Web Worker
// (speaker-verify-worker.js). It MUST NOT be loaded on the main thread: the
// Emscripten build redefines the same globals (Module, FS, HEAP*, …) that the
// KWS wake-word runtime already owns, and loading it there corrupts the KWS
// engine and stops all keyword detection.

export type VerifyResult = {
  accepted: boolean;
  detail: string;
  segments?: { start: number; end: number; speaker: number }[];
};

type WorkerMessage =
  | { type: 'ready'; sampleRate: number }
  | { type: 'init-error'; error: string }
  | { type: 'verify-result'; accepted: boolean; detail: string; segments?: { start: number; end: number; speaker: number }[] }
  | { type: 'enrollment-result'; labels: number[] | null }
  | { type: 'error'; error: string };

class SpeakerVerifier {
  private baseUrl = '';
  private worker: Worker | null = null;
  private workerReady = false;
  private initPromise: Promise<void> | null = null;

  // Lazily spin up the worker + wasm runtime. Safe to call repeatedly.
  async ensureReady(wasmBaseUrl: string): Promise<void> {
    this.baseUrl = wasmBaseUrl;
    if (this.workerReady) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initWorker();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  get ready() {
    return this.workerReady;
  }

  private initWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const workerUrl = new URL('./speaker-verify-worker.js', window.location.href).href;
      this.worker = new Worker(workerUrl);

      const onMessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.workerReady = true;
          this.worker?.removeEventListener('message', onMessage);
          this.worker?.removeEventListener('error', onError);
          resolve();
        } else if (msg.type === 'init-error') {
          this.worker?.removeEventListener('message', onMessage);
          this.worker?.removeEventListener('error', onError);
          reject(new Error(msg.error));
        }
      };

      const onError = (err: ErrorEvent) => {
        this.worker?.removeEventListener('message', onMessage);
        this.worker?.removeEventListener('error', onError);
        reject(new Error(err.message || 'Speaker verifier worker error'));
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.addEventListener('error', onError);
      this.worker.postMessage({ type: 'init', baseUrl: this.baseUrl });
    });
  }

  private sendVerify(references: Float32Array[], test: Float32Array, threshold: number): Promise<VerifyResult> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve({ accepted: true, detail: 'no-worker (fail-open)' });
        return;
      }
      const onMessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.type === 'verify-result') {
          this.worker?.removeEventListener('message', onMessage);
          resolve({
            accepted: msg.accepted,
            detail: msg.detail,
            segments: msg.segments
          });
        }
      };
      this.worker.addEventListener('message', onMessage);
      // Transfer the underlying ArrayBuffers for zero-copy handoff.
      const transfer: Transferable[] = [];
      for (const ref of references) transfer.push(ref.buffer);
      transfer.push(test.buffer);
      this.worker.postMessage(
        { type: 'verify', references, test, threshold },
        transfer
      );
    });
  }

  private sendEnrollmentLabels(samples: Float32Array[], threshold: number): Promise<number[] | null> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve(null);
        return;
      }
      const onMessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.type === 'enrollment-result') {
          this.worker?.removeEventListener('message', onMessage);
          resolve(msg.labels);
        }
      };
      this.worker.addEventListener('message', onMessage);
      const transfer: Transferable[] = samples.map((s) => s.buffer);
      this.worker.postMessage(
        { type: 'enrollmentLabels', samples, threshold },
        transfer
      );
    });
  }

  // Compare a test utterance against enrolled references. Fails OPEN on any
  // internal error so a verifier fault can never lock the user out.
  async verify(
    references: Float32Array[],
    test: Float32Array,
    threshold: number
  ): Promise<VerifyResult> {
    // If the worker is not ready yet (cold start), kick off the load in the
    // background and fail-open immediately so wake detection is never blocked.
    if (!this.workerReady) {
      if (!this.initPromise) {
        void this.ensureReady(this.baseUrl).catch(() => undefined);
      }
      return { accepted: true, detail: 'verifier-not-ready (fail-open, loading in background)' };
    }
    return this.sendVerify(references, test, threshold);
  }

  // Enrolment sanity check: all snippets should be a single speaker. Returns
  // the distinct speaker labels found (length 1 = consistent). Returns null
  // (unknown) when the runtime is not ready, so enrolment can proceed even if
  // the diarization model failed to load.
  async enrollmentLabels(samples: Float32Array[], threshold: number): Promise<number[] | null> {
    if (!this.workerReady) {
      if (!this.initPromise) {
        void this.ensureReady(this.baseUrl).catch(() => undefined);
      }
      return null;
    }
    return this.sendEnrollmentLabels(samples, threshold);
  }
}

export const speakerVerifier = new SpeakerVerifier();

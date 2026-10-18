// SherpaKwsEngine — adapter that wraps the sherpa-onnx KWS WASM module to
// match the interface that voice.ts expects from the old openWakeWord engine.
//
// The sherpa-onnx KWS is an open-vocabulary keyword spotter: it decodes
// streaming audio with a Zipformer transducer and only fires when the
// decoded token sequence matches one of the keywords listed in the keywords
// string.  Changing the wake word is just editing that string — no model
// retraining, no recompilation of the WASM.
//
// Personal wake (speaker verification) is not wired here because the sherpa
// encoder produces a different embedding space than openWakeWord's 96-dim
// model.  getKeywordEmbeddingSnapshot returns a synthetic "complete" snapshot
// so that voice.ts's embedding-window gate does not discard detections.

type SherpaKwsConfig = {
  // Base URL of the directory containing the compiled wasm/data/js files.
  wasmBaseUrl: string;
  // Keywords string in sherpa ppinyin token format, one keyword per line.
  // Example: "j iǎ w éi s ī @贾维斯\n"
  keywords: string;
  // Trigger threshold (0–1, lower = easier to trigger).
  keywordsThreshold: number;
  // Boosting score for keyword paths in beam search (higher = easier).
  keywordsScore: number;
  // Minimum gap between consecutive detect events, in milliseconds.
  cooldownMs: number;
};

// Synthetic embedding snapshot — voice.ts requires a "complete" snapshot
// before it lets a detection through its confirmation gate.  All-zero values
// would be filtered by the energy check, so use a small non-zero constant.
const FAKE_EMBEDDING = new Array(96).fill(0.1) as number[];
const FAKE_SNAPSHOT = {
  history: Array.from({ length: 16 }, () => FAKE_EMBEDDING),
  accumulatedEmbeddings: 16,
  requiredEmbeddings: 16,
  complete: true
};

// Simple energy-based VAD thresholds.
const SPEECH_ENERGY_THRESHOLD = 0.008;
const SPEECH_END_SILENCE_MS = 500;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

export class SherpaKwsEngine {
  private config: SherpaKwsConfig;
  private listeners = new Map<string, Set<Function>>();
  private kws: any = null;
  private stream: any = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private loaded = false;
  private running = false;
  private lastDetectAt = 0;

  // Simple VAD state
  private speechActive = false;
  private speechEndTimer: number | null = null;
  private expectedSampleRate = 16000;
  private actualSampleRate = 16000;

  // Diagnostics counters (windowed; reset by getDiagnostics).
  private diagFrames = 0;
  private diagDecodes = 0;
  private diagReadyLoops = 0;
  private diagMaxRms = 0;

  // Rolling ring buffer of RAW 16 kHz mono PCM, used for real speaker
  // verification. It keeps the last few seconds so that, the instant the KWS
  // fires, we can hand the spoken wake-word waveform to the speaker model.
  private ring: Float32Array = new Float32Array(this.expectedSampleRate * 4);
  private ringWrite = 0;
  private ringFilled = false;
  // Write position captured when speech starts; the utterance is everything
  // from just before that point to speech-end.
  private speechStartRingPos = -1;

  // Internal properties accessed by voice.ts via type casts.
  _mediaStream?: MediaStream;
  _audioContext?: AudioContext | null;
  _workletNode?: ScriptProcessorNode | null;

  constructor(config: SherpaKwsConfig) {
    this.config = config;
  }

  on(event: string, handler: Function): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) handlers.forEach((h) => h(...args));
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    // Configure the global Module object that the emscripten runtime reads
    // when sherpa-onnx-wasm-kws-main.js executes.  locateFile tells the
    // runtime where to fetch the .wasm and .data files.
    const wasmBaseUrl = this.config.wasmBaseUrl;
    const moduleConfig: Record<string, unknown> = {
      locateFile: (path: string) => `${wasmBaseUrl}/${path}`,
      onRuntimeInitialized: () => {
        try {
          const createKws = (window as any).createKws;
          if (!createKws) {
            this.emit('error', new Error('createKws not found after wasm init'));
            return;
          }
          this.kws = createKws((window as any).Module, {
            featConfig: { samplingRate: 16000, featureDim: 80 },
            modelConfig: {
              transducer: {
                encoder: './encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
                decoder: './decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
                joiner: './joiner-epoch-12-avg-2-chunk-16-left-64.onnx'
              },
              tokens: './tokens.txt',
              provider: 'cpu',
              modelType: '',
              numThreads: 1,
              debug: 0,
              modelingUnit: 'cjkchar',
              bpeVocab: ''
            },
            maxActivePaths: 8,
            numTrailingBlanks: 1,
            keywordsScore: this.config.keywordsScore,
            keywordsThreshold: this.config.keywordsThreshold,
            keywords: this.config.keywords
          });
          this.loaded = true;
        } catch (error) {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    (window as any).Module = moduleConfig;

    // Load order: kws.js (defines createKws) → wasm-kws-main.js (runtime).
    await loadScript(`${wasmBaseUrl}/sherpa-onnx-kws.js`);
    await loadScript(`${wasmBaseUrl}/sherpa-onnx-wasm-kws-main.js`);

    // Wait for onRuntimeInitialized — the runtime loads .wasm/.data
    // asynchronously after the script tag executes.
    const deadline = performance.now() + 60_000;
    while (!this.loaded && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!this.loaded) throw new Error('Sherpa KWS wasm did not initialize within 60s');
  }

  async start({ gain }: { gain?: number } = {}): Promise<void> {
    if (this.running) return;
    if (!this.kws) throw new Error('KWS not loaded');

    // IMPORTANT: request RAW microphone audio. The sherpa KWS model was
    // trained on unprocessed audio; WebRTC noiseSuppression/echoCancellation
    // (Chrome's neural APM) clips the onset and high-frequency content of
    // short wake words and caused roughly 1-in-4 detection. This mirrors the
    // official sherpa-onnx wasm demo, which uses plain { audio: true }.
    // Wake listening never overlaps with assistant playback, so echo
    // cancellation is unnecessary; the explicit gain node handles loudness.
    // getUserMedia can in rare Windows device states never settle (exclusive
    // mode held elsewhere, audiodg wedged). A pending prompt used to leave
    // wakeStartInProgress stuck true, which silently froze the whole health
    // loop. Race it with a hard timeout and throw so the caller can recover.
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 }
      }
    });
    const deviceStream = await Promise.race([
      streamPromise,
      new Promise<MediaStream>((_resolve, reject) => {
        window.setTimeout(() => reject(new Error('getUserMedia timed out after 8s')), 8_000);
      })
    ]).catch((error: unknown) => {
      // If the timeout won, a stream may still resolve afterwards: stop its
      // tracks so the microphone is not held open by an engine that will
      // never use it. Device errors on streamPromise are swallowed here.
      streamPromise
        .then((lateStream) => lateStream.getAudioTracks().forEach((track) => track.stop()))
        .catch(() => undefined);
      throw error;
    });
    this.mediaStream = deviceStream;
    this._mediaStream = this.mediaStream;

    try {
      this.audioContext = new AudioContext({ sampleRate: this.expectedSampleRate });
    } catch {
      this.audioContext = new AudioContext();
    }
    this._audioContext = this.audioContext;
    this.actualSampleRate = this.audioContext.sampleRate;

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Apply mic gain if configured.
    let lastNode: AudioNode = this.sourceNode;
    if (gain && gain !== 1) {
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = gain;
      this.sourceNode.connect(this.gainNode);
      lastNode = this.gainNode;
    }

    // ScriptProcessor captures audio frames on the main thread.  It is
    // deprecated in the spec but still functional in Chromium and matches
    // the sherpa-onnx WASM demo's approach.
    const bufferSize = 4096;
    this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this._workletNode = this.scriptNode;
    this.stream = this.kws.createStream();
    this.lastDetectAt = 0;
    this.diagFrames = 0;
    this.diagDecodes = 0;
    this.diagReadyLoops = 0;
    this.diagMaxRms = 0;
    this.ring = new Float32Array(this.expectedSampleRate * 4);
    this.ringWrite = 0;
    this.ringFilled = false;
    this.speechStartRingPos = -1;
    console.info(
      `[SherpaKws] started: contextRate=${this.actualSampleRate}Hz, `
      + `downsampling=${this.actualSampleRate !== this.expectedSampleRate}`
    );

    this.scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.running || !this.stream) return;

      const inputSamples = e.inputBuffer.getChannelData(0);
      const samples = this.actualSampleRate !== this.expectedSampleRate
        ? this.downsampleBuffer(inputSamples)
        : inputSamples;

      this.writeRing(samples);

      // Simple energy-based VAD so voice.ts gets speech-start/speech-end
      // events (used for enrollment capture and personal-wake inspection).
      this.detectSpeechActivity(samples);
      this.diagFrames++;
      let sumSq = 0;
      for (let i = 0; i < samples.length; i += 8) sumSq += samples[i] * samples[i];
      const rms = Math.sqrt(sumSq / Math.ceil(samples.length / 8));
      if (rms > this.diagMaxRms) this.diagMaxRms = rms;

      this.stream.acceptWaveform(this.expectedSampleRate, samples);
      let loopCount = 0;
      while (this.kws.isReady(this.stream)) {
        this.kws.decode(this.stream);
        this.diagDecodes++;
        loopCount++;
        if (loopCount > 50) break; // safety: never spin forever
        const result = this.kws.getResult(this.stream);
        if (result.keyword && result.keyword.length > 0) {
          const now = performance.now();
          if (now - this.lastDetectAt >= this.config.cooldownMs) {
            this.lastDetectAt = now;
            // Sherpa KWS is a hard trigger (keyword is either above threshold
            // or not detected).  Emit score 1.0 so voice.ts wakes immediately.
            this.emit('detect', { keyword: result.keyword, score: 0.7 });
          }
          this.kws.reset(this.stream);
        }
      }
      if (loopCount > 0) this.diagReadyLoops++;
    };

    lastNode.connect(this.scriptNode);
    this.scriptNode.connect(this.audioContext.destination);

    // Detect deafness immediately instead of waiting up to 10s for the health
    // poll: Chromium can suspend an idle AudioContext on its own, and the mic
    // track can end when Windows reassigns or loses the default device.
    this.audioContext.onstatechange = () => {
      const state = this.audioContext?.state;
      if (this.running && (state === 'suspended' || state === 'interrupted')) {
        this.emit('audio-lost', `AudioContext ${state}`);
      }
    };
    this.mediaStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (this.running) this.emit('audio-lost', 'microphone track ended');
      };
    });

    this.running = true;

    // The offscreen, never-visible voice window has no autoplay gesture, so a
    // freshly created AudioContext can begin life suspended. resume() itself
    // can also hang forever on a wedged Windows audio device — never await it
    // without a timeout, or start() (and the health loop) wedges permanently.
    if (this.audioContext.state !== 'running') {
      await Promise.race([
        this.audioContext.resume().catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 2_000))
      ]);
      const stateAfterResume = this.audioContext.state as string;
      if (stateAfterResume !== 'running') {
        this.emit('audio-lost', `AudioContext did not resume (state=${stateAfterResume})`);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode.onaudioprocess = null;
      this.scriptNode = null;
    }
    this._workletNode = null;

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.mediaStream = null;
    }
    this._mediaStream = undefined;

    if (this.audioContext) {
      const contextToClose = this.audioContext;
      contextToClose.onstatechange = null;
      try {
        // close() can hang indefinitely on a wedged audiodg/device. A pending
        // close used to deadlock recoverWakeWord (wakeHealthRecoveryRunning
        // stayed true forever), which silently froze every later health check.
        await Promise.race([
          contextToClose.close(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 1_000))
        ]);
      } catch {
        // already closed
      }
      this.audioContext = null;
    }
    this._audioContext = null;

    if (this.stream) {
      try {
        this.stream.free();
      } catch {
        // stream may already be freed
      }
      this.stream = null;
    }

    if (this.speechEndTimer !== null) {
      window.clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }
    this.speechActive = false;
  }

  // Returns a synthetic "complete" snapshot so that voice.ts's
  // embedding-window gate does not discard detections.  Personal wake
  // (speaker verification) is disabled because the sherpa encoder's
  // embedding space is incompatible with openWakeWord's 96-dim model.
  getKeywordEmbeddingSnapshot(_keyword: string) {
    return FAKE_SNAPSHOT;
  }

  // ---- Raw 16 kHz PCM access for real speaker verification --------------

  private writeRing(samples: Float32Array): void {
    const capacity = this.ring.length;
    for (let i = 0; i < samples.length; i += 1) {
      this.ring[this.ringWrite] = samples[i];
      this.ringWrite = (this.ringWrite + 1) % capacity;
    }
    // Filled once the write cursor has wrapped all the way around.
    if (!this.ringFilled && samples.length >= capacity) this.ringFilled = true;
    else if (!this.ringFilled && this.ringWrite === 0 && samples.length > 0) this.ringFilled = true;
  }

  // Copy the most recent `seconds` of 16 kHz mono audio out of the ring.
  getRecentAudio(seconds: number): Float32Array {
    const capacity = this.ring.length;
    const available = this.ringFilled ? capacity : this.ringWrite;
    const wanted = Math.min(available, Math.floor(this.expectedSampleRate * seconds));
    const out = new Float32Array(wanted);
    let start = this.ringWrite - wanted;
    if (start < 0) start += capacity;
    for (let i = 0; i < wanted; i += 1) {
      out[i] = this.ring[(start + i) % capacity];
    }
    return out;
  }

  // Copy the spoken utterance captured between speech-start (with a short
  // lead-in) and the current ring position. Used for enrolment. Returns an
  // empty buffer if no utterance has been anchored.
  getCapturedUtterance(): Float32Array {
    const capacity = this.ring.length;
    if (this.speechStartRingPos < 0) return new Float32Array(0);
    const start = this.speechStartRingPos;
    const end = this.ringWrite;
    const length = end >= start ? end - start : capacity - start + end;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = this.ring[(start + i) % capacity];
    }
    return out;
  }

  resetCapturedUtterance(): void {
    this.speechStartRingPos = -1;
  }

  // Windowed diagnostics for the health check. Counters reset on read.
  getDiagnostics() {
    const snap = {
      running: this.running,
      contextState: this.audioContext?.state ?? 'none',
      actualSampleRate: this.actualSampleRate,
      expectedSampleRate: this.expectedSampleRate,
      downsampling: this.actualSampleRate !== this.expectedSampleRate,
      frames: this.diagFrames,
      readyLoops: this.diagReadyLoops,
      decodes: this.diagDecodes,
      maxRms: this.diagMaxRms,
      speechActive: this.speechActive
    };
    this.diagFrames = 0;
    this.diagReadyLoops = 0;
    this.diagDecodes = 0;
    this.diagMaxRms = 0;
    return snap;
  }

  private detectSpeechActivity(samples: Float32Array): void {
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    if (rms > SPEECH_ENERGY_THRESHOLD) {
      if (!this.speechActive) {
        this.speechActive = true;
        // Anchor the utterance slightly before the first voiced frame so the
        // word's onset consonant is not clipped.
        const lead = Math.floor(this.expectedSampleRate * 0.1);
        this.speechStartRingPos = (this.ringWrite - lead + this.ring.length) % this.ring.length;
        this.emit('speech-start');
      }
      if (this.speechEndTimer !== null) {
        window.clearTimeout(this.speechEndTimer);
        this.speechEndTimer = null;
      }
    } else if (this.speechActive && this.speechEndTimer === null) {
      this.speechEndTimer = window.setTimeout(() => {
        this.speechActive = false;
        this.speechEndTimer = null;
        this.emit('speech-end');
      }, SPEECH_END_SILENCE_MS);
    }
  }

  private downsampleBuffer(buffer: Float32Array): Float32Array {
    const ratio = this.actualSampleRate / this.expectedSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    return result;
  }
}

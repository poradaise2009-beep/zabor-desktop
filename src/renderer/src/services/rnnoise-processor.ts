let rnnoiseModule: any = null;

const FRAME_SIZE = 480;

export async function createRNNoiseProcessor(
  audioContext: AudioContext,
  sourceStream: MediaStream
): Promise<{ stream: MediaStream; destroy: () => void }> {
  if (!rnnoiseModule) {
    try {
      const mod = await import('@jitsi/rnnoise-wasm');
      rnnoiseModule = mod;
    } catch {
      return { stream: sourceStream, destroy: () => {} };
    }
  }

  const source = audioContext.createMediaStreamSource(sourceStream);
  const dest = audioContext.createMediaStreamDestination();

  const rnnoiseState = rnnoiseModule.newState();
  const pcm16 = new Int16Array(FRAME_SIZE);

  const processor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    for (let i = 0; i < FRAME_SIZE; i++) {
      pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
    }

    rnnoiseModule.processFrame(rnnoiseState, pcm16);

    for (let i = 0; i < FRAME_SIZE; i++) {
      output[i] = pcm16[i] / 32767;
    }
  };

  source.connect(processor);
  processor.connect(dest);

  return {
    stream: dest.stream,
    destroy: () => {
      processor.disconnect();
      source.disconnect();
      if (rnnoiseState) {
        try { rnnoiseModule.deleteState(rnnoiseState); } catch {}
      }
    }
  };
}
export const MIC_SILENCE_ADVANCE_MS = 800
export const MIC_PROCESSOR_BUFFER = 2048
export const MIC_SPEECH_ONSET_RMS = 0.012
export const MIC_SILENCE_RMS = 0.0035
export const MIC_SPEECH_FRAMES = 2
export const MIC_SPEECH_RESET_FRAMES = 2

export function rmsFromTimeDomain(samples: Uint8Array | Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  if (samples instanceof Uint8Array) {
    for (const sample of samples) {
      const centered = (sample - 128) / 128
      sum += centered * centered
    }
  } else {
    for (const sample of samples) {
      sum += sample * sample
    }
  }
  return Math.sqrt(sum / samples.length)
}

export function silenceFramesFor(
  silenceDurationMs: number,
  sampleRate: number,
  bufferSize = MIC_PROCESSOR_BUFFER,
): number {
  const seconds = Math.max(0.05, silenceDurationMs / 1000)
  return Math.max(3, Math.round((seconds * sampleRate) / bufferSize))
}

export function createSilenceAdvanceTracker(options: {
  silenceDurationMs?: number
  sampleRate: number
  bufferSize?: number
}) {
  const bufferSize = options.bufferSize || MIC_PROCESSOR_BUFFER
  const framesNeeded = silenceFramesFor(
    options.silenceDurationMs ?? MIC_SILENCE_ADVANCE_MS,
    options.sampleRate,
    bufferSize,
  )
  let noiseFloor = 0.003
  let speechFrames = 0
  let speechDetected = false
  let silentFrames = 0
  let resetHold = 0

  return {
    get speechDetected() {
      return speechDetected
    },
    pushRms(rms: number): 'continue' | 'advance' {
      if (!Number.isFinite(rms) || rms < 0) return 'continue'
      const speechGate = Math.max(MIC_SPEECH_ONSET_RMS, noiseFloor * 2.6)
      const silenceGate = Math.max(MIC_SILENCE_RMS, noiseFloor * 1.15)

      if (!speechDetected) {
        if (rms > speechGate) {
          speechFrames += 1
          if (speechFrames >= MIC_SPEECH_FRAMES) speechDetected = true
        } else {
          speechFrames = 0
          noiseFloor = noiseFloor * 0.97 + rms * 0.03
        }
        return 'continue'
      }

      if (rms > speechGate) {
        resetHold += 1
        if (resetHold >= MIC_SPEECH_RESET_FRAMES) {
          silentFrames = 0
          resetHold = 0
        }
        return 'continue'
      }

      resetHold = 0

      // Decaying word endings sit between speech and true silence.
      // Hold the pause clock so we do not skip mid-word.
      if (rms > silenceGate) return 'continue'

      silentFrames += 1
      if (silentFrames >= framesNeeded) return 'advance'
      return 'continue'
    },
  }
}

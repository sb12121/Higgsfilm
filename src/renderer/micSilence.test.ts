import { describe, expect, it } from 'vitest'
import {
  MIC_PROCESSOR_BUFFER,
  MIC_SILENCE_ADVANCE_MS,
  createSilenceAdvanceTracker,
  rmsFromTimeDomain,
  silenceFramesFor,
} from './micSilence'

function pushMany(
  tracker: ReturnType<typeof createSilenceAdvanceTracker>,
  rms: number,
  frames: number,
) {
  let result: 'continue' | 'advance' = 'continue'
  for (let index = 0; index < frames; index += 1) {
    result = tracker.pushRms(rms)
  }
  return result
}

describe('micSilence', () => {
  it('computes RMS from byte and float buffers', () => {
    expect(rmsFromTimeDomain(new Uint8Array([128, 128, 128, 128]))).toBe(0)
    expect(rmsFromTimeDomain(new Float32Array([0, 0, 0, 0]))).toBe(0)
    expect(rmsFromTimeDomain(new Uint8Array([128, 180, 76, 128]))).toBeGreaterThan(0.2)
  })

  it('needs about 0.8 seconds of quiet frames at 48kHz', () => {
    expect(silenceFramesFor(MIC_SILENCE_ADVANCE_MS, 48000, MIC_PROCESSOR_BUFFER)).toBe(19)
  })

  it('does not advance until speech has been heard', () => {
    const tracker = createSilenceAdvanceTracker({ sampleRate: 48000 })
    expect(pushMany(tracker, 0.002, 40)).toBe('continue')
    expect(tracker.speechDetected).toBe(false)
  })

  it('advances after speech followed by a run of true quiet frames', () => {
    const tracker = createSilenceAdvanceTracker({ sampleRate: 48000 })
    expect(pushMany(tracker, 0.08, 3)).toBe('continue')
    expect(tracker.speechDetected).toBe(true)
    expect(pushMany(tracker, 0.001, 18)).toBe('continue')
    expect(tracker.pushRms(0.001)).toBe('advance')
  })

  it('does not treat a decaying word ending as a pause', () => {
    const tracker = createSilenceAdvanceTracker({ sampleRate: 48000 })
    pushMany(tracker, 0.08, 3)
    expect(pushMany(tracker, 0.006, 40)).toBe('continue')
    expect(pushMany(tracker, 0.001, 18)).toBe('continue')
    expect(tracker.pushRms(0.001)).toBe('advance')
  })

  it('does not throw away a silence run because of one loud spike', () => {
    const tracker = createSilenceAdvanceTracker({ sampleRate: 48000 })
    pushMany(tracker, 0.08, 3)
    pushMany(tracker, 0.001, 12)
    expect(tracker.pushRms(0.04)).toBe('continue')
    expect(pushMany(tracker, 0.001, 7)).toBe('advance')
  })
})

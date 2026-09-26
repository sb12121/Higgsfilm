import { describe, expect, it } from 'vitest'
import { detectVoiceBoundary } from './voiceBoundary'

const rate = 24000
function waveform(duration: number, speech: Array<[number, number, number]>, transient = false): Int16Array {
  return Int16Array.from({ length: Math.round(duration * rate) }, (_, i) => {
    const time = i / rate
    let amplitude = 0.0015
    for (const [start, end, level] of speech) {
      if (time >= start && time < end) amplitude = level
    }
    if (transient && time >= 0.05 && time < 0.07) amplitude = 0.1
    return Math.round(32767 * amplitude * Math.sin(i * 0.37))
  })
}

describe('adaptive voice boundary', () => {
  it('ignores room noise and an isolated leading click', () => {
    const result = detectVoiceBoundary(waveform(2, [[0.4, 1.2, 0.03]], true), rate)
    expect(result.confident).toBe(true)
    expect(result.speechStart).toBeGreaterThan(0.35)
    expect(result.speechEnd).toBeLessThan(1.25)
  })

  it('preserves soft word edges and internal pauses', () => {
    const result = detectVoiceBoundary(waveform(2, [
      [0.2, 0.27, 0.005], [0.27, 0.7, 0.035],
      [0.9, 1.4, 0.03], [1.4, 1.48, 0.005],
    ]), rate)
    expect(result.speechStart).toBeLessThanOrEqual(0.2)
    expect(result.speechEnd).toBeGreaterThanOrEqual(1.48)
  })

  it('retains quiet 6 kHz frication before and after voiced speech', () => {
    const samples = Int16Array.from({ length: rate * 2 }, (_, i) => {
      const time = i / rate
      const isFricative = (time >= 0.2 && time < 0.31) || (time >= 1.31 && time < 1.42)
      const isVoiced = time >= 0.31 && time < 1.31
      const noise = 0.0015 * Math.sin(i * 0.37)
      const fricative = isFricative ? 0.005 * Math.sin(2 * Math.PI * 6000 * time) : 0
      const voiced = isVoiced ? 0.03 * Math.sin(2 * Math.PI * 220 * time) : 0
      return Math.round(32767 * (noise + fricative + voiced))
    })
    const result = detectVoiceBoundary(samples, rate)
    expect(result.confident).toBe(true)
    expect(result.speechStart).toBeLessThanOrEqual(0.2)
    expect(result.speechEnd).toBeGreaterThanOrEqual(1.42)
  })

  it('leaves ambiguous all-quiet recordings untouched', () => {
    const result = detectVoiceBoundary(waveform(2, []), rate)
    expect(result).toMatchObject({ speechStart: 0, speechEnd: 2, confident: false })
  })

  it('does not remove speech that touches either file edge', () => {
    const result = detectVoiceBoundary(waveform(2, [[0, 0.5, 0.03], [1.5, 2, 0.03]]), rate)
    expect(result.speechStart).toBe(0)
    expect(result.speechEnd).toBe(2)
  })
})

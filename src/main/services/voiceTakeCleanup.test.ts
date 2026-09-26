import { describe, expect, it } from 'vitest'
import {
  buildVoiceCleanupAudioFilter,
  cleanedDurationFromWindow,
  clampVoiceTrimEnd,
  clampVoiceTrimStart,
  rawTrimEndFromCleanedEnd,
  rawTrimStartFromCleanedStart,
  speechWindowFromSilence,
} from './voiceTakeCleanup'

describe('voiceTakeCleanup', () => {
  it('backs up from detected speech onset so soft consonants stay intact', () => {
    const window = speechWindowFromSilence(
      [
        { start: 0, end: 0.4 },
        { start: 2.5, end: null },
      ],
      3,
      0.2,
      0.25,
    )
    expect(window.trimStart).toBeCloseTo(0.2, 3)
    expect(window.trimEnd).toBeCloseTo(2.75, 3)
  })

  it('bakes only an end gap for v2 takes', () => {
    expect(
      buildVoiceCleanupAudioFilter({
        trimStart: 0.2,
        trimEnd: 2.75,
        sourceDuration: 3,
      }),
    ).toBe('atrim=start=0.2:end=2.75,asetpts=PTS-STARTPTS,apad=pad_dur=0.25')
  })

  it('computes cleaned duration from the speech window plus pads', () => {
    expect(cleanedDurationFromWindow({ trimStart: 0.15, trimEnd: 1 })).toBe(1.1)
  })

  it('clamps trailing trim so the speech window cannot collapse', () => {
    expect(clampVoiceTrimEnd(0.15, 0.1, 3)).toBeCloseTo(0.2, 3)
    expect(clampVoiceTrimEnd(0.15, 4, 3)).toBe(3)
    expect(clampVoiceTrimEnd(0.15, 0.9, 3)).toBe(0.9)
  })

  it('maps a cleaned waveform end back to the raw trim end', () => {
    // cleaned = speech + 0.1 start pad + 0.1 end pad
    expect(rawTrimEndFromCleanedEnd(1.05, 0.15)).toBeCloseTo(1, 3)
    expect(rawTrimEndFromCleanedEnd(0.85, 0.15)).toBeCloseTo(0.8, 3)
  })

  it('maps a cleaned waveform start back to the raw trim start', () => {
    expect(rawTrimStartFromCleanedStart(0, 0.15)).toBeCloseTo(0.15, 3)
    expect(rawTrimStartFromCleanedStart(0.1, 0.15)).toBeCloseTo(0.15, 3)
    expect(rawTrimStartFromCleanedStart(0.25, 0.15)).toBeCloseTo(0.3, 3)
  })

  it('clamps leading trim so the speech window cannot collapse', () => {
    expect(clampVoiceTrimStart(-1, 1, 3)).toBe(0)
    expect(clampVoiceTrimStart(0.99, 1, 3)).toBeCloseTo(0.95, 3)
    expect(clampVoiceTrimStart(0.3, 0.9, 3)).toBe(0.3)
  })
})

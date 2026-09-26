import { describe, expect, it } from 'vitest'
import {
  audioDurationSeconds,
  calculateLineBoundaries,
  parseSilenceRanges,
  splitParagraphAudio,
  validateAudioCues,
  wordCountAudioCues,
} from './audioSegmenter'

describe('audioSegmenter', () => {
  it('prefers natural silence near word-weighted line boundaries', () => {
    const boundaries = calculateLineBoundaries(
      [{ text: 'one two three four' }, { text: 'five six' }, { text: 'seven eight' }],
      10,
      [
        { start: 3.7, end: 4.3 },
        { start: 7.3, end: 7.8 },
      ],
    )

    expect(boundaries).toEqual([0, 3.7, 7.3, 10])
  })

  it('rejects a pause that is too far from the expected line boundary', () => {
    expect(() =>
      calculateLineBoundaries(
        [{ text: 'one two three' }, { text: 'four five six' }, { text: 'seven eight nine' }],
        9,
        [
          { start: 4.9, end: 5.2 },
          { start: 7.2, end: 7.5 },
        ],
      ),
    ).toThrow(/proportional speech cuts are disabled/)
  })

  it('parses paired FFmpeg silence markers', () => {
    const ranges = parseSilenceRanges(
      [
        '[silencedetect] silence_start: 1.25',
        '[silencedetect] silence_end: 1.68 | silence_duration: 0.43',
        '[silencedetect] silence_start: 4',
        '[silencedetect] silence_end: 4.2 | silence_duration: 0.2',
      ].join('\n'),
    )

    expect(ranges).toEqual([
      { start: 1.25, end: 1.68 },
      { start: 4, end: 4.2 },
    ])
  })

  it('rejects proportional boundaries without detected pauses', () => {
    expect(() =>
      calculateLineBoundaries(
        [{ text: 'one' }, { text: 'two three' }],
        6,
        [],
      ),
    ).toThrow(/proportional speech cuts are disabled/)
  })

  it('uses the encoded audio duration for a single-line master', async () => {
    const streamInfo = new Uint8Array(18)
    streamInfo[10] = 0x0b
    streamInfo[11] = 0xb8
    streamInfo[12] = 0
    streamInfo[16] = 0xbb
    streamInfo[17] = 0x80
    const flac = Buffer.concat([
      Buffer.from('fLaC'),
      Buffer.from([0x80, 0, 0, 18]),
      Buffer.from(streamInfo),
    ])

    expect(audioDurationSeconds(flac)).toBe(1)
    const segments = await splitParagraphAudio(flac, [{ text: 'one line' }], 9)
    expect(segments[0]).toMatchObject({ duration: 1, start: 0, end: 1 })
  })

  it('rejects overlapping or mid-word-like cue coverage', () => {
    expect(() =>
      validateAudioCues(
        [
          { start: 0, end: 1.1 },
          { start: 1, end: 2 },
        ],
        2,
        2,
      ),
    ).toThrow(/overlapping/)
    expect(() =>
      validateAudioCues(
        [
          { start: 0.2, end: 1 },
          { start: 1, end: 2 },
        ],
        2,
        2,
      ),
    ).toThrow(/missing coverage/)
  })

  it('splits stanza audio cues by word count, including short punch lines', () => {
    const cues = wordCountAudioCues(
      [{ text: 'One hundred dollars.' }, { text: 'Beautiful.' }],
      4,
    )
    expect(cues).toHaveLength(2)
    expect(cues[0]?.start).toBe(0)
    expect(cues[1]?.end).toBe(4)
    expect(cues[0]!.end).toBeGreaterThan(cues[1]!.end - cues[1]!.start)
    expect(cues[1]!.end - cues[1]!.start).toBeCloseTo(1, 5)
  })
})

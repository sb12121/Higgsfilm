import { describe, expect, it } from 'vitest'
import { estimateTimeline, secondsToTimestamp, splitIntoSentences } from './scriptParser'

describe('splitIntoSentences', () => {
  it('keeps sentence punctuation and separates narration lines', () => {
    expect(splitIntoSentences('Fire changed everything. Then people moved. Really? Yes!')).toEqual([
      'Fire changed everything.',
      'Then people moved.',
      'Really?',
      'Yes!',
    ])
  })

  it('removes timestamp prefixes from imported transcripts', () => {
    expect(splitIntoSentences('00:00 The hook begins. 00:04 The story continues.')).toEqual([
      'The hook begins.',
      'The story continues.',
    ])
  })
})

describe('estimateTimeline', () => {
  it('creates contiguous timestamps from narration length', () => {
    const timeline = estimateTimeline(['one two three', 'four five'], 60)
    expect(timeline[0]).toEqual({ startTime: 0, endTime: 3, duration: 3 })
    expect(timeline[1]).toEqual({ startTime: 3, endTime: 5, duration: 2 })
  })
})

describe('secondsToTimestamp', () => {
  it('formats timestamps for filenames', () => {
    expect(secondsToTimestamp(0)).toBe('00-00')
    expect(secondsToTimestamp(70)).toBe('01-10')
  })
})

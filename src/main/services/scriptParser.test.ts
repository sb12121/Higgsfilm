import { describe, expect, it } from 'vitest'
import {
  estimateTimeline,
  secondsToTimestamp,
  splitIntoSentences,
  splitIntoScriptLines,
  splitIntoStanzaLines,
} from './scriptParser'

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

describe('splitIntoScriptLines', () => {
  it('preserves paragraph membership while splitting narration lines', () => {
    expect(
      splitIntoScriptLines('The hook begins. The setup follows.\n\nThe reveal lands.'),
    ).toEqual([
      { text: 'The hook begins.', paragraphIndex: 0 },
      { text: 'The setup follows.', paragraphIndex: 0 },
      { text: 'The reveal lands.', paragraphIndex: 1 },
    ])
  })
})

describe('splitIntoStanzaLines', () => {
  it('gives every newline its own scene and recording take, even with trailing commas', () => {
    expect(
      splitIntoStanzaLines(
        [
          'Custom: Bux look at wallet,',
          'Custom: One hundred dollars,',
          'Warm Smile: Beautiful.',
          '',
          'Confident: Bux feel rich.',
        ].join('\n'),
      ),
    ).toEqual([
      { text: 'Custom: Bux look at wallet,', paragraphIndex: 0 },
      { text: 'Custom: One hundred dollars,', paragraphIndex: 1 },
      { text: 'Warm Smile: Beautiful.', paragraphIndex: 2 },
      { text: 'Confident: Bux feel rich.', paragraphIndex: 3 },
    ])
  })

  it('starts a new take after every newline, even without a blank line', () => {
    expect(splitIntoStanzaLines('DB go store.\nLife good.')).toEqual([
      { text: 'DB go store.', paragraphIndex: 0 },
      { text: 'Life good.', paragraphIndex: 1 },
    ])
  })

  it('ignores blank lines and still keeps each beat as its own take', () => {
    expect(
      splitIntoStanzaLines('Custom: Bux look at wallet,\n\nCustom: One hundred dollars.'),
    ).toEqual([
      { text: 'Custom: Bux look at wallet,', paragraphIndex: 0 },
      { text: 'Custom: One hundred dollars.', paragraphIndex: 1 },
    ])
  })
})

describe('secondsToTimestamp', () => {
  it('formats timestamps for filenames', () => {
    expect(secondsToTimestamp(0)).toBe('00-00')
    expect(secondsToTimestamp(70)).toBe('01-10')
  })
})

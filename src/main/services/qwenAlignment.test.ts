import { describe, expect, it } from 'vitest'
import {
  shouldUseQwenLineFallback,
  tokenize,
  verifyQwenTranscript,
  type WhisperWord,
} from './qwenAlignment'

function word(text: string, start: number, end: number, confidence = 0.95): WhisperWord {
  return { text, start, end, confidence }
}

describe('qwenAlignment', () => {
  it('ignores punctuation and creates word-safe cues between lines', () => {
    const result = verifyQwenTranscript(
      [
        { id: 'line-1', text: 'Hello, world!' },
        { id: 'line-2', text: 'This is next.' },
      ],
      [
        word('Hello', 0, 0.35),
        word('world', 0.4, 0.8),
        word('This', 1.05, 1.35),
        word('is', 1.4, 1.55),
        word('next', 1.6, 1.95),
      ],
      2.2,
    )

    expect(result.severity).toBe('exact')
    expect(result.cues).toEqual([
      expect.objectContaining({ lineId: 'line-1', start: 0, end: 0.925 }),
      expect.objectContaining({ lineId: 'line-2', start: 0.925, end: 2.2 }),
    ])
  })

  it('keeps repeated words monotonic instead of collapsing them', () => {
    const result = verifyQwenTranscript(
      [
        { id: 'line-1', text: 'very very good' },
        { id: 'line-2', text: 'very good' },
      ],
      [
        word('very', 0, 0.2),
        word('very', 0.25, 0.45),
        word('good', 0.5, 0.75),
        word('very', 1, 1.2),
        word('good', 1.25, 1.5),
      ],
      1.7,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines.every((line) => line.mismatchCount === 0)).toBe(true)
  })

  it('normalizes common contractions consistently', () => {
    expect(tokenize("We're ready, aren't we?")).toEqual([
      'we',
      'are',
      'ready',
      'are',
      'not',
      'we',
    ])
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: "We're ready, aren't we?" }],
      [
        word("We're", 0, 0.3),
        word('ready,', 0.35, 0.6),
        word("aren't", 0.65, 0.95),
        word('we?', 1, 1.1),
      ],
      1.3,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines[0]?.transcriptText).toBe("We're ready, aren't we?")
  })

  it('normalizes hyphenated words when Whisper splits them differently', () => {
    expect(tokenize('fur-clad')).toEqual(['fur', 'clad'])
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: 'A fur-clad caveman waits.' }],
      [
        word('A', 0, 0.1),
        word('fur', 0.12, 0.25),
        word('-clad', 0.26, 0.42),
        word('caveman', 0.45, 0.7),
        word('waits', 0.75, 0.95),
      ],
      1.2,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines[0]?.mismatchCount).toBe(0)
  })

  it('marks a localized omission for line-level fallback', () => {
    const result = verifyQwenTranscript(
      [
        { id: 'line-1', text: 'The first line is stable.' },
        { id: 'line-2', text: 'The second line has a missing word.' },
        { id: 'line-3', text: 'The final line is stable.' },
      ],
      [
        word('The', 0, 0.1),
        word('first', 0.12, 0.25),
        word('line', 0.28, 0.4),
        word('is', 0.42, 0.5),
        word('stable', 0.55, 0.8),
        word('The', 1, 1.1),
        word('second', 1.12, 1.3),
        word('line', 1.32, 1.45),
        word('has', 1.48, 1.6),
        word('missing', 1.65, 1.85),
        word('word', 1.88, 2),
        word('The', 2.1, 2.2),
        word('final', 2.22, 2.4),
        word('line', 2.42, 2.55),
        word('is', 2.58, 2.68),
        word('stable', 2.72, 2.95),
      ],
      3.2,
    )

    expect(result.severity).toBe('localized')
    expect(result.lines[1]).toMatchObject({
      lineId: 'line-2',
      missingCount: 1,
      mismatchCount: 1,
    })
  })

  it('marks widespread omissions as severe instead of inventing boundaries', () => {
    const result = verifyQwenTranscript(
      [
        { id: 'line-1', text: 'The first complete sentence.' },
        { id: 'line-2', text: 'The second complete sentence.' },
      ],
      [word('unexpected', 0.2, 0.6), word('audio', 0.7, 1.1)],
      1.5,
    )

    expect(result.severity).toBe('severe')
    expect(result.cues.length).toBeLessThan(2)
  })

  it('treats reordered words as a transcript mismatch', () => {
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: 'Cats chase birds.' }],
      [
        word('Birds', 0, 0.2),
        word('chase', 0.25, 0.45),
        word('cats', 0.5, 0.7),
      ],
      1,
    )

    expect(result.severity).toBe('severe')
    expect(result.editDistance).toBeGreaterThan(0)
  })

  it('flags inserted words as mismatches instead of treating them as exact', () => {
    const result = verifyQwenTranscript(
      [
        { id: 'line-1', text: 'The dog waits.' },
        { id: 'line-2', text: 'The door opens.' },
      ],
      [
        word('The', 0, 0.1),
        word('dog', 0.12, 0.3),
        word('waits', 0.32, 0.5),
        word('quietly', 0.52, 0.7),
        word('The', 0.95, 1.05),
        word('door', 1.08, 1.25),
        word('opens', 1.3, 1.5),
      ],
      1.8,
    )

    expect(result.severity).toBe('localized')
    expect(result.lines[0]?.extraCount).toBe(1)
    expect(result.lines[0]?.mismatchCount).toBe(1)
  })

  it('treats Whisper Bucks as script Bux', () => {
    expect(tokenize('Bux look at wallet.')).toEqual(['bux', 'look', 'at', 'wallet'])
    expect(tokenize('Bucks look at wallet.')).toEqual(['bux', 'look', 'at', 'wallet'])
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: 'Bux look at wallet.' }],
      [
        word('Bucks', 0, 0.2),
        word('look', 0.25, 0.4),
        word('at', 0.42, 0.5),
        word('wallet.', 0.55, 0.9),
      ],
      1,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines[0]).toMatchObject({
      mismatchCount: 0,
      substitutionCount: 0,
    })
    expect(shouldUseQwenLineFallback(result.lines[0]!)).toBe(false)
  })

  it('treats Whisper by as script buy', () => {
    expect(tokenize('Bux buy giant treat mountain.')).toEqual([
      'bux',
      'buy',
      'giant',
      'treat',
      'mountain',
    ])
    expect(tokenize('Bucks by Giant Treat Mountain')).toEqual([
      'bux',
      'buy',
      'giant',
      'treat',
      'mountain',
    ])
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: 'Bux buy giant treat mountain.' }],
      [
        word('Bucks', 0, 0.2),
        word('by', 0.22, 0.35),
        word('Giant', 0.4, 0.6),
        word('Treat', 0.62, 0.8),
        word('Mountain', 0.82, 1.1),
      ],
      1.2,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines[0]).toMatchObject({
      mismatchCount: 0,
      substitutionCount: 0,
    })
    expect(shouldUseQwenLineFallback(result.lines[0]!)).toBe(false)
  })

  it('treats Whisper currency and digits as spoken numbers', () => {
    expect(tokenize('One hundred dollars buys twenty bags.')).toEqual([
      'one',
      'hundred',
      'dollars',
      'buys',
      'twenty',
      'bags',
    ])
    expect(tokenize('$100 buys 20 bags.')).toEqual([
      'one',
      'hundred',
      'dollars',
      'buys',
      'twenty',
      'bags',
    ])
    expect(tokenize('$100 buys 14 bags.')).toEqual(tokenize('One hundred dollars buys fourteen bags.'))
    const result = verifyQwenTranscript(
      [{ id: 'line-1', text: 'One hundred dollars buys twenty bags.' }],
      [
        word('$100', 0, 0.4),
        word('buys', 0.45, 0.65),
        word('20', 0.7, 0.9),
        word('bags.', 0.95, 1.2),
      ],
      1.4,
    )

    expect(result.severity).toBe('exact')
    expect(result.lines[0]).toMatchObject({
      mismatchCount: 0,
      missingCount: 0,
      substitutionCount: 0,
    })
    expect(shouldUseQwenLineFallback(result.lines[0]!)).toBe(false)
  })

  it('only falls back when a line is mismatched or below the confidence gate', () => {
    expect(
      shouldUseQwenLineFallback({
        lineId: 'good',
        expectedText: 'good',
        transcriptText: 'good',
        confidence: 0.9,
        mismatchCount: 0,
        missingCount: 0,
        extraCount: 0,
        substitutionCount: 0,
      }),
    ).toBe(false)
    expect(
      shouldUseQwenLineFallback({
        lineId: 'bad',
        expectedText: 'bad',
        transcriptText: 'bad',
        confidence: 0.9,
        mismatchCount: 1,
        missingCount: 0,
        extraCount: 1,
        substitutionCount: 0,
      }),
    ).toBe(true)
  })
})

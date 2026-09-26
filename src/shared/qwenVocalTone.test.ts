import { describe, expect, it } from 'vitest'
import {
  qwenVocalInstructForExpression,
  qwenVocalInstructForLine,
  stillCastLineVocalExpression,
} from './qwenVocalTone'
import type { ScriptLine } from './types'

function line(expression: string): Pick<ScriptLine, 'stillBeats'> {
  return {
    stillBeats: [{ id: 'beat', text: 'spoken', expression }],
  }
}

describe('qwenVocalTone', () => {
  it('maps Custom stills to Neutral Talking', () => {
    expect(stillCastLineVocalExpression(line('custom'))).toBe('neutral-talking')
    expect(qwenVocalInstructForLine(line('Custom'))).toBe(
      qwenVocalInstructForExpression('neutral-talking'),
    )
  })

  it('maps missing beats to Neutral Talking', () => {
    expect(stillCastLineVocalExpression({})).toBe('neutral-talking')
  })

  it('keeps named expressions as vocal tones', () => {
    expect(stillCastLineVocalExpression(line('Laughing'))).toBe('laughing')
    expect(qwenVocalInstructForLine(line('laughing'))).toMatch(/laughing/i)
    expect(qwenVocalInstructForLine(line('Raised finger'))).toMatch(/just got it/i)
  })
})

import { describe, expect, it } from 'vitest'
import { parseQwenAlignmentResponse } from './qwenAligner'

describe('qwenAligner', () => {
  it('parses the helper JSON envelope without accepting log noise', () => {
    expect(
      parseQwenAlignmentResponse(
        JSON.stringify({
          ok: true,
          transcript: 'A test.',
          words: [{ text: 'A', start: 0, end: 0.2, confidence: 0.99 }],
        }),
      ),
    ).toMatchObject({
      ok: true,
      transcript: 'A test.',
    })
    expect(parseQwenAlignmentResponse('loading model\n{"ok":true}')).toBeUndefined()
    expect(parseQwenAlignmentResponse('')).toBeUndefined()
  })
})

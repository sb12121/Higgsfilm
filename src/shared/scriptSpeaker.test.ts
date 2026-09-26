import { describe, expect, it } from 'vitest'
import {
  SCRIPT_SPEAKER_HINT,
  SCRIPT_SPEAKER_LABEL,
  scriptSpeakerCue,
  scriptSpeakerCuesForLines,
  scriptSpeakerFromExpression,
} from './scriptSpeaker'

describe('scriptSpeaker', () => {
  it('treats comedy faces and Custom as Bux the fool', () => {
    expect(scriptSpeakerFromExpression('Confident')).toBe('fool')
    expect(scriptSpeakerFromExpression('custom')).toBe('fool')
    expect(scriptSpeakerFromExpression('Custom still')).toBe('fool')
    expect(scriptSpeakerFromExpression('Warm Smile')).toBe('fool')
    expect(scriptSpeakerFromExpression(undefined)).toBe('fool')
  })

  it('treats click faces as Bux realization', () => {
    expect(scriptSpeakerFromExpression('Raised finger')).toBe('realization')
    expect(scriptSpeakerFromExpression('Neutral Talking')).toBe('realization')
    expect(scriptSpeakerFromExpression('Present Open Hands')).toBe('realization')
    expect(scriptSpeakerFromExpression('Realization')).toBe('realization')
    expect(scriptSpeakerFromExpression('Point at camera')).toBe('realization')
  })

  it('returns teleprompter labels and recording hints', () => {
    expect(scriptSpeakerCue('custom')).toMatchObject({
      register: 'fool',
      label: SCRIPT_SPEAKER_LABEL.fool,
      hint: SCRIPT_SPEAKER_HINT.fool,
    })
    expect(scriptSpeakerCue('raised-finger')).toMatchObject({
      register: 'realization',
      label: SCRIPT_SPEAKER_LABEL.realization,
      hint: SCRIPT_SPEAKER_HINT.realization,
    })
  })

  it('maps a stanza of still beats to speaker cues', () => {
    const cues = scriptSpeakerCuesForLines([
      { stillBeats: [{ id: 'a', text: 'Bux look at wallet.', expression: 'custom' }] },
      { stillBeats: [{ id: 'b', text: 'Oh. That inflation.', expression: 'Raised finger' }] },
    ])
    expect(cues.map((cue) => cue.label)).toEqual([
      SCRIPT_SPEAKER_LABEL.fool,
      SCRIPT_SPEAKER_LABEL.realization,
    ])
  })
})

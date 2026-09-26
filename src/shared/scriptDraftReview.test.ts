import { describe, expect, it } from 'vitest'
import { DOGGOBUX_SCRIPT_CLOSER } from './doggoBuxCloser'
import { reviewScriptDraft } from './scriptDraftReview'
import { parseStillCastScriptLine } from './stillCast'

describe('reviewScriptDraft', () => {
  it('reviews valid Custom scenes and the fixed outro without counting shot notes', () => {
    const script = [
      'Custom: Bux learned one useful rule. | Full body, Bux points at a paper rule card.',
      ...DOGGOBUX_SCRIPT_CLOSER,
    ].join('\n')
    const review = reviewScriptDraft(script, { customOnly: true })
    const expectedSpoken = [
      'Bux learned one useful rule.',
      ...DOGGOBUX_SCRIPT_CLOSER.map((line) => parseStillCastScriptLine(line).text),
    ].join('\n')

    expect(review).toEqual({
      spokenText: expectedSpoken,
      spokenWordCount: 42,
      sceneCount: 4,
      estimatedSeconds: (42 / 150) * 60,
      issues: [],
      canApply: true,
    })
    expect(review.spokenText).not.toContain('Full body')
  })

  it('blocks missing prefixes, empty narration, missing shot notes, headings, and fences', () => {
    const review = reviewScriptDraft([
      'Custom: | note words must not be spoken',
      'Custom: Bux said this. |',
      'Custom: This also needs a note.',
      'Happy: This prefix is not allowed.',
      '# Draft heading',
      '```text',
    ].join('\n'), { customOnly: true })

    expect(review.canApply).toBe(false)
    expect(review.spokenText).toBe('Bux said this.\nThis also needs a note.\nThis prefix is not allowed.')
    expect(review.spokenText).not.toContain('note words')
    expect(review.issues.filter((issue) => issue.severity === 'error')).toHaveLength(7)
    expect(review.sceneCount).toBe(4)
  })

  it('warns about duplicate and long spoken takes while allowing application', () => {
    const script = [
      'Custom: Bux learned the rule. | Full body, Bux nods.',
      'Custom: Bux learned the rule. | Full body, Bux points.',
      'Custom: Bux explains that this unusually detailed sentence contains many more words than a short comfortable spoken take should probably include. | Full body, Bux talks.',
    ].join('\n')
    const review = reviewScriptDraft(script, { customOnly: true })
    expect(review.issues).toHaveLength(2)
    expect(review.issues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(review.canApply).toBe(true)
  })

  it('keeps plain narration drafts applicable and strips recognized prefixes and shot notes', () => {
    const review = reviewScriptDraft('Happy: A complete spoken sentence. | A silent portrait.')
    expect(review).toMatchObject({
      spokenText: 'A complete spoken sentence.',
      spokenWordCount: 4,
      sceneCount: 1,
      estimatedSeconds: (4 / 150) * 60,
      issues: [],
      canApply: true,
    })
  })

  it('does not allow an empty script to be applied', () => {
    expect(reviewScriptDraft('  \n\t')).toMatchObject({
      spokenText: '', spokenWordCount: 0, sceneCount: 0, estimatedSeconds: 0, issues: [], canApply: false,
    })
  })
})

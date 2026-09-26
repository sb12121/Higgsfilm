import { describe, expect, it } from 'vitest'
import {
  composeGenerationPrompt,
  composeScenePrompt,
  composeScriptDraftPrompt,
  composeTrailerScriptPrompt,
  composeZImagePrompt,
  normalizeScriptDraft,
  normalizeTrailerScript,
} from './promptComposer'
import type { SceneDirectionRecord } from './types'

const visualBible = {
  name: 'Test bible',
  style: 'flat hand-drawn illustration',
  characters: 'one expressive stickman',
  mainCharacter: '',
  supportingCharacter: '',
  setting: 'white background',
  palette: 'black and red',
  camera: 'wide shot',
  negativePrompt: 'unreadable text',
}

describe('promptComposer', () => {
  it('removes the narration wrapper from image-generation prompts', () => {
    const narration = 'See this smile?'
    const scenePrompt = composeScenePrompt(
      narration,
      'A happy golden retriever looks directly into the camera.',
    )

    const prompt = composeGenerationPrompt(scenePrompt, visualBible)

    expect(prompt).toContain('A happy golden retriever looks directly into the camera.')
    expect(prompt).not.toContain(narration)
    expect(prompt).not.toContain('Create a single visual scene for this narration')
    expect(prompt).toContain('Every visible character')
    expect(prompt).toContain('Never leave a character featureless')
    expect(prompt).toContain('animal carrying, retrieving, bringing, or holding an object')
    expect(prompt).toContain('in its mouth')
    expect(prompt).toContain('Creative variation requirements')
    expect(prompt).toContain('Do not force the recurring protagonist into every frame')
    expect(prompt).not.toContain('question mark')
    expect(prompt).not.toContain('thought bubble')
  })

  it('keeps manually written scene prompts intact', () => {
    const prompt = composeGenerationPrompt(
      'A stickman opens a red door.',
      visualBible,
    )

    expect(prompt).toContain('A stickman opens a red door.')
  })

  it('adds vertical composition guidance for trailer images', () => {
    const prompt = composeGenerationPrompt(
      composeScenePrompt('A stickman looks up.', 'A colorful stickman looks up at a tall tower.'),
      visualBible,
      '9:16',
    )

    expect(prompt).toContain('Composition format: 9:16')
    expect(prompt).toContain('inside the 9:16 canvas')
  })

  it('includes the whole-script continuity canon when available', () => {
    const prompt = composeGenerationPrompt(
      'A cat watches the moon.',
      visualBible,
      '16:9',
      'The recurring subject is a black cat named Luna. The story stays in a quiet home.',
    )

    expect(prompt).toContain('Whole-script continuity canon')
    expect(prompt).toContain('black cat named Luna')
    expect(prompt).toContain('Do not replace an established subject')
  })

  it('uses the canonical scene record as the provider-facing source of truth', () => {
    const record: SceneDirectionRecord = {
      version: 1,
      lineId: 'line-1',
      sourceFingerprint: 'fingerprint-1',
      focalSubject: 'environment',
      visualAction: 'sunlight falls across a closed red door',
      shotType: 'wide establishing shot',
      setting: 'bright apartment entryway',
      visibleCharacters: [],
      visibleProps: ['closed red door'],
      propState: 'red door closed',
      variationReason: 'environmental consequence beat',
      direction:
        'A bright apartment entryway contains a closed red door as sunlight falls across the pale floor in a wide establishing shot.',
    }
    const standardPrompt = composeGenerationPrompt(
      'stale narration wrapper',
      visualBible,
      '16:9',
      undefined,
      record,
    )
    const zImagePrompt = composeZImagePrompt(
      'stale narration wrapper',
      visualBible,
      '16:9',
      record,
    )

    expect(standardPrompt).toContain(record.direction)
    expect(standardPrompt).toContain('Production-ready scene direction')
    expect(standardPrompt).not.toContain('stale narration wrapper')
    expect(zImagePrompt).toContain(record.direction)
    expect(zImagePrompt.startsWith('flat hand-drawn illustration')).toBe(true)
    expect(zImagePrompt).toContain('16:9 canvas')
    expect(zImagePrompt).not.toContain('Production-ready scene direction')
    expect(zImagePrompt).not.toContain('red door closed')
    expect(zImagePrompt).not.toContain('stale narration wrapper')
  })

  it('uses a direction-only record without emitting missing metadata', () => {
    const record: SceneDirectionRecord = {
      version: 1,
      lineId: 'line-2',
      sourceFingerprint: 'fingerprint-2',
      direction:
        'A golden retriever watches rain gather on the apartment window from a quiet corner in a close environmental reaction shot.',
    }

    const prompt = composeGenerationPrompt(
      composeScenePrompt('The room feels different.', record.direction),
      visualBible,
      '16:9',
      undefined,
      record,
    )

    expect(prompt).toContain(record.direction)
    expect(prompt).not.toContain('undefined')
    expect(prompt).not.toContain('Focal subject:')
  })

  it('includes filled character locks in provider prompts', () => {
    const lockedBible = {
      ...visualBible,
      mainCharacter: 'Male golden retriever with warm gold fur and a blue collar.',
      supportingCharacter: 'Owner with short brown hair, a green sweater, and round glasses.',
    }
    const prompt = composeGenerationPrompt(
      composeScenePrompt(
        'The owner opens the door.',
        'A male golden retriever watches the owner open the red front door.',
      ),
      lockedBible,
    )

    expect(prompt).toContain('Main character lock')
    expect(prompt).toContain(lockedBible.mainCharacter)
    expect(prompt).toContain('Supporting character lock')
    expect(prompt).toContain(lockedBible.supportingCharacter)
  })

  it('keeps the Z-Image Turbo prompt compact and omits the negative-prompt block', () => {
    const prompt = composeZImagePrompt(
      composeScenePrompt('A stickman opens a red door.', 'A stickman opens a red door.'),
      visualBible,
    )

    expect(prompt).toContain('A stickman opens a red door.')
    expect(prompt).toContain('flat hand-drawn illustration')
    expect(prompt).toContain('16:9 canvas')
    expect(prompt).toContain('Heads attached to necks')
    expect(prompt).toContain('only the named limbs')
    expect(prompt).not.toContain('unreadable text')
    expect(prompt).not.toContain('Creative variation requirements')
    expect(prompt).not.toContain('Whole-script continuity canon')
    expect(prompt).not.toContain('Keep animals anatomically natural and quadrupedal')
    expect(prompt).not.toContain('question mark')
  })

  it('adds bite-geometry closer when a Z-Image scene carries an object', () => {
    const record: SceneDirectionRecord = {
      version: 1,
      lineId: 'line-3',
      sourceFingerprint: 'fingerprint-3',
      visualAction: 'the dog carries a damp sock',
      direction:
        'A proud golden retriever sits on the hardwood floor with a damp white tube sock clamped in his teeth.',
    }
    const prompt = composeZImagePrompt('ignored', visualBible, '16:9', record)

    expect(prompt.startsWith('flat hand-drawn illustration')).toBe(true)
    expect(prompt).toContain(record.direction)
    expect(prompt).toContain('inside the animal mouth')
    expect(prompt).toContain('gripped by the teeth')
    expect(prompt).not.toContain('between the natural jaws')
  })

  it('omits duplicate character locks when the Z-Image direction already states them', () => {
    const lockedBible = {
      ...visualBible,
      mainCharacter: 'Male golden retriever with warm gold fur and a blue collar.',
      supportingCharacter: 'Owner with short brown hair, a green sweater, and round glasses.',
    }
    const direction =
      'Male golden retriever with warm gold fur and a blue collar watches the owner open a red door.'
    const prompt = composeZImagePrompt(direction, lockedBible, '9:16')

    expect(prompt).toContain('9:16 canvas')
    expect(prompt).toContain(direction)
    expect(prompt).toContain(lockedBible.supportingCharacter)
    expect(
      (prompt.match(/Male golden retriever with warm gold fur and a blue collar/g) || []).length,
    ).toBe(1)
  })

  it('requires and normalizes a final trailer CTA', () => {
    const request = composeTrailerScriptPrompt(
      'The longform story explains why this matters.',
      visualBible,
    )
    expect(request).toContain('condensed 9:16 version')
    expect(request).toContain('25–35 seconds')
    expect(request).not.toContain('Never write Custom')
    expect(request).toContain('final line is mandatory')
    expect(request).toContain('LONGFORM SCRIPT:')

    const stillCastRequest = composeTrailerScriptPrompt(
      'The longform story explains why this matters.',
      visualBible,
      { stillCast: true },
    )
    expect(stillCastRequest).toContain('Custom-9x16')
    expect(stillCastRequest).toContain('Custom: spoken words')
    expect(stillCastRequest).toContain('never Expressions library faces')

    const normalized = normalizeTrailerScript('Hook the viewer.\nDiscover the hidden detail.')
    expect(normalized.split('\n').at(-1)).toBe('See the full video to learn more.')

    const movedCta = normalizeTrailerScript('See the full video to learn more.\nHook the viewer.')
    expect(movedCta.split('\n').at(-1)).toBe('See the full video to learn more.')

    const rewrittenCustom = normalizeTrailerScript(
      'Custom: Bux opened his wallet.\nRaised finger: Prices had gone up.',
      true,
    )
    expect(rewrittenCustom.split('\n')[0]).toBe('Custom: Bux opened his wallet.')
    expect(rewrittenCustom.split('\n')[1]).toBe('Custom: Prices had gone up.')
    expect(rewrittenCustom.split('\n').at(-1)).toBe('Custom: See the full video to learn more.')
  })

  it('asks the LLM to follow a script bible and keeps stanza prefixes', () => {
    const bible = [
      'Prefix each line with an expression folder.',
      'Use Custom: for cutaways.',
      'Blank lines start a new recording stanza.',
    ].join('\n')
    const prompt = composeScriptDraftPrompt('Why one hundred dollars feels powerful.', bible)
    expect(prompt).toContain('SCRIPT BIBLE:')
    expect(prompt).toContain('Use Custom: for cutaways.')
    expect(prompt).toContain('TOPIC:')
    expect(prompt).toContain('Why one hundred dollars feels powerful.')
    expect(prompt).toContain('Promise, Proof, Plan')
    expect(prompt).toContain('Emotion, Visual, Text, and Open loop')
    expect(prompt).toContain('opening 5–8 lines')
    expect(prompt).toContain('answer that open loop')
    expect(prompt).toContain('two escalating mistakes')
    expect(prompt).toContain('correct attempt, payoff, and memorable rule')
    expect(prompt).toContain('friendly third-person narrator')
    expect(prompt).toContain('natural conversational English')
    expect(prompt).toContain('fixed channel outro is appended')
    expect(prompt).toContain('Do not write a 9:16 condensed cut')
    expect(prompt).toContain('HARD RULES FOR EVERY LINE:')
    expect(prompt).toContain('Every line is recorded as voice')
    expect(prompt).toContain('Do not invent extra Custom lines to hold pictures')
    expect(prompt).toContain('March toward treat store')
    expect(prompt).toContain('Bux opened his wallet and counted one hundred dollars')
    expect(prompt).toContain('Bux is the reusable main character, not the niche')
    expect(prompt).toContain('never assume personal finance')
    expect(prompt).toContain('alternate naturally with "he" and "his."')
    expect(prompt).toContain('Never use caveman grammar')
    expect(prompt).toContain('Do not impersonate Bux with "I" or "Me,"')
    expect(prompt).toContain('doer-less shot-list fragments')
    expect(prompt).toContain('every spoken line must be a Custom scene picture')
    expect(prompt).toContain('Do not use standard expression prefixes')
    expect(prompt).toContain('One Custom line is one generated still')
    expect(prompt).toContain('unspoken shot note')
    expect(prompt).toContain('about 90–110 spoken lines')
    expect(prompt).toContain('roughly 500–700 words as editorial defaults, never as hard quotas')
    expect(prompt).toContain('Preserve the appended fixed channel closer verbatim')
    expect(prompt).toContain('do not split it to meet this body-line target')
    expect(prompt).toContain('without splitting normal sentences to hit a count')
    expect(prompt).toContain('Recording stanzas: every newline is its own scene')
    expect(prompt).toContain('Return only the script.')
    expect(prompt).not.toContain('three cycles of issue')
    expect(prompt).toContain('selected title, thumbnail promise, differentiation, and production constraints')
    expect(prompt).toContain('Popularity on public YouTube is evidence of audience interest, not proof')
    expect(prompt).toContain('Never invent studies, statistics, citations, guaranteed results, or certainty')
    expect(prompt).toContain('Preserve the limits and uncertainty stated in the approved brief')
    expect(prompt).toContain('CTA or next-step brief to shape the useful payoff')
    expect(prompt).toContain('privately read it aloud')
    expect(prompt).toContain('Remove padded fragments and keyword stacking')
    expect(prompt).toContain('Do not use standard expression prefixes')

    const normalized = normalizeScriptDraft(
      [
        '```text',
        '# Wallet episode',
        '',
        'Custom: Bux opened his wallet.',
        '',
        'Confident: To him, that felt like a fortune.',
        '```',
      ].join('\n'),
    )
    expect(normalized).toBe(
      'Custom: Bux opened his wallet.\n\nConfident: To him, that felt like a fortune.',
    )
  })
})

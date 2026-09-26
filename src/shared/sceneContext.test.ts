import { describe, expect, it } from 'vitest'
import { sceneContextFingerprint, scenePromptFingerprint } from './sceneContext'
import type { ProjectManifest } from './types'

const manifest = {
  lines: [
    {
      id: 'line-1',
      index: 0,
      text: 'A golden retriever waits.',
    },
  ],
  visualBible: {
    name: 'cartoon',
    style: 'flat',
    characters: 'golden retriever',
    mainCharacter: '',
    supportingCharacter: '',
    setting: 'entryway',
    palette: 'warm',
    camera: 'wide',
    negativePrompt: 'text',
  },
} as ProjectManifest

describe('scene context fingerprints', () => {
  it('changes when script or visual bible context changes', () => {
    const original = sceneContextFingerprint(manifest, 'main')
    const changedScript = structuredClone(manifest)
    changedScript.lines[0]!.text = 'A golden retriever runs.'
    const changedBible = structuredClone(manifest)
    changedBible.visualBible.palette = 'cool'

    expect(sceneContextFingerprint(changedScript, 'main')).not.toBe(original)
    expect(sceneContextFingerprint(changedBible, 'main')).not.toBe(original)
    expect(sceneContextFingerprint(manifest, 'main')).toBe(original)
  })

  it('fingerprints the exact production prompt', () => {
    expect(scenePromptFingerprint('A scene')).toBe(scenePromptFingerprint(' A scene '))
    expect(scenePromptFingerprint('A scene')).not.toBe(scenePromptFingerprint('Another scene'))
  })

  it('invalidates trailer context when the longform script changes', () => {
    const trailerManifest = structuredClone(manifest)
    trailerManifest.trailer = {
      lines: [{ ...manifest.lines[0]!, id: 'trailer-1', text: 'The trailer opens.' }],
      scriptFile: 'trailer/script.txt',
      exportSettings: {},
    } as NonNullable<ProjectManifest['trailer']>

    const original = sceneContextFingerprint(trailerManifest, 'trailer')
    const changedLongform = structuredClone(trailerManifest)
    changedLongform.lines[0]!.text = 'The longform story changes.'

    expect(sceneContextFingerprint(changedLongform, 'trailer')).not.toBe(original)
  })
})

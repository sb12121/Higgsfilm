import type { ProjectManifest, SequenceId, VisualBible } from './types'

export function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function scriptTextForSequence(
  manifest: ProjectManifest,
  sequence: SequenceId,
): string {
  const lines =
    sequence === 'trailer'
      ? manifest.trailer?.lines || []
      : manifest.lines
  return lines
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((line) => `LINE ${line.index + 1}: ${line.text}`)
    .join('\n')
}

export function sceneContextFingerprint(
  manifest: ProjectManifest,
  sequence: SequenceId,
): string {
  const visualBible: VisualBible = manifest.visualBible
  const longformContext = sequence === 'trailer' ? scriptTextForSequence(manifest, 'main') : ''
  return hashText(
    JSON.stringify({
      sequence,
      script: scriptTextForSequence(manifest, sequence),
      longformContext,
      visualBible,
    }),
  )
}

export function scenePromptFingerprint(prompt: string): string {
  return hashText(prompt.trim())
}

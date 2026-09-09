import type { VisualBible } from './types'

export function composeScenePrompt(
  text: string,
  sceneDescription?: string,
): string {
  return [
    `Create a single visual scene for this narration: "${text}"`,
    ...(sceneDescription ? [`Scene direction: ${sceneDescription}`] : []),
  ].join('\n')
}

export function composeGenerationPrompt(scenePrompt: string, visualBible: VisualBible): string {
  return [
    stripVisualBible(scenePrompt),
    `Style: ${visualBible.style}`,
    `Characters: ${visualBible.characters}`,
    `Setting: ${visualBible.setting}`,
    `Palette: ${visualBible.palette}`,
    `Camera: ${visualBible.camera}`,
    `Avoid: ${visualBible.negativePrompt}`,
    'Character continuity requirements: Render the recurring main protagonist with the same solid flat colors in every scene, including their face, hair, clothing, body, and identifying accessories. Never render the protagonist as black-and-white outlines only or leave their color fills unfilled. Give every human character a clearly expressive face with visible eyes, eyebrows, and mouth that communicate the emotion and action of the narration. Keep faces stylized and simple, not photorealistic.',
    'Keep the composition readable and leave safe space for optional captions.',
  ].join('\n')
}

export function stripVisualBible(prompt: string): string {
  const styleStart = prompt.search(/\nStyle\s*:/i)
  return (styleStart >= 0 ? prompt.slice(0, styleStart) : prompt).trim()
}

import type { AspectRatio, SceneDirectionRecord, VisualBible } from './types'
import { statedSceneCharacterCount } from './sceneDirection'

const ANIMAL_PATTERN =
  /\b(?:dog|puppy|pup|wolf|retriever|animal|cat|kitten|horse|bird|rabbit)\b/i
const HUMAN_PATTERN =
  /\b(?:man|woman|human|person|people|caveman|stickman|owner|adult|boy|girl|child)\b/i
const ANIMAL_CARRY_PATTERN =
  /\b(?:dog|puppy|pup|wolf|retriever|animal|cat|horse)\b[\s\S]{0,100}\b(?:carry|carries|carrying|retrieve|retrieves|retrieving|bring|brings|bringing|fetch|fetches|fetching|clamped|gripped|in (?:his|her|its) teeth)\b/i

const Z_IMAGE_CLEANUP =
  'Even shadowless fill light, paper-like 2D cartoon pigment. Heads attached to necks, hands attached to arms, only the named limbs. Clean unmarked picture surface.'
const Z_IMAGE_EMPTY_CLEANUP =
  'Even shadowless fill light, paper-like 2D cartoon pigment. Unoccupied frame filled only by the named place and props. Clean unmarked picture surface.'

export function composeZImageTurboPrompt(input: {
  direction: string
  visualBible: VisualBible
  aspectRatio: AspectRatio
  sceneRecord?: SceneDirectionRecord
}): string {
  const direction = input.direction.trim()
  const cast = sceneCast(direction, input.sceneRecord)
  return [
    zImageMediumSentence(input.visualBible, input.aspectRatio),
    zImageSpeciesSplit(direction, input.sceneRecord),
    sanitizeZImageDirection(direction),
    ...(cast.count === 0 ? [] : zImageIdentityLocks(input.visualBible, direction)),
    zImageCastCloser(direction, input.sceneRecord),
    zImageAnatomyCloser(direction, input.sceneRecord),
    cast.count === 0 ? Z_IMAGE_EMPTY_CLEANUP : Z_IMAGE_CLEANUP,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')
}

export function zImageMediumSentence(
  visualBible: VisualBible,
  aspectRatio: AspectRatio,
): string {
  const style = compactClause(visualBible.style, 28)
  const medium = /cartoon|illustration|2d/i.test(style)
    ? style
    : `Clean 2D cartoon illustration. ${style}`.trim()
  const palette = compactClause(visualBible.palette, 28)
  const setting = compactClause(visualBible.setting, 22)
  return [medium.replace(/[.]+$/, ''), `${aspectRatio} canvas`, palette, setting]
    .filter(Boolean)
    .join(', ')
    .replace(/,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.]$/, '') + '.'
}

export function zImageSpeciesSplit(
  direction: string,
  sceneRecord?: SceneDirectionRecord,
): string {
  const { hasHuman, hasAnimal } = sceneCast(direction, sceneRecord)
  if (!hasHuman || !hasAnimal) return ''
  const animal = namedAnimal(visibleCastText(direction, sceneRecord))
  return `One clothed bipedal adult human with a human face, visible hair, a simple shirt, pants, and shoes stands apart from one quadruped ${animal} with fur, two ears, one tail, and four paws. Two different species, two separate bodies.`
}

export function zImageCastCloser(
  direction: string,
  sceneRecord?: SceneDirectionRecord,
): string {
  const { count, hasHuman, hasAnimal } = sceneCast(direction, sceneRecord)
  const animal = namedAnimal(visibleCastText(direction, sceneRecord))

  if (count === 0) {
    return 'Exactly zero characters in the frame. Unoccupied place filled only by the named architecture and props.'
  }
  if (count != null) {
    if (hasHuman && hasAnimal) {
      return `Exactly ${count} characters in the frame: one clothed human and one separate quadruped ${animal}. Two different species. One of each.`
    }
    return `Exactly ${count} character${count === 1 ? '' : 's'} in the frame. Only the named figures.`
  }
  if (hasHuman && hasAnimal) {
    return `Only the named clothed human and the separate quadruped ${animal} are present. Two different species. At most three figures.`
  }
  return 'Only the named characters are present. At most three figures.'
}

export function zImageAnatomyCloser(
  direction: string,
  sceneRecord?: SceneDirectionRecord,
): string {
  const { count, hasHuman, hasAnimal } = sceneCast(direction, sceneRecord)
  const action = visibleCastText(direction, sceneRecord)
  const animalCarrying = ANIMAL_CARRY_PATTERN.test(action)
  const parts: string[] = []

  if (count === 0) {
    return 'Unoccupied scene. Only the named architecture and props fill the frame.'
  }

  if (hasHuman && hasAnimal) {
    parts.push(
      'The prop-holding figure stays a clothed bipedal person: human face, hair, two arms, two five-fingered hands on the props, two legs, shoes on the floor. The animal stays a furred quadruped beside the person, four paws on the floor.',
    )
    if (animalCarrying) {
      parts.push(
        'The carried object is inside the animal mouth, gripped by the teeth, with ends hanging out.',
      )
    } else {
      parts.push('The animal mouth is empty and closed.')
    }
    return parts.join(' ')
  }

  if (hasHuman) {
    parts.push(
      'Every human is a full standing or kneeling body: head on a neck, torso, two arms attached at the shoulders, two legs attached at the hips, both feet on the ground. A held prop sits in a hand at the end of an attached arm, away from every mouth.',
    )
  }
  if (hasAnimal) {
    if (animalCarrying) {
      parts.push(
        'The animal is a quadruped with four legs and four paws. The carried object is inside the animal mouth, gripped by the teeth, with ends hanging out. Four paws on the floor, fur, and a tail.',
      )
    } else {
      parts.push(
        'The animal is a quadruped with four legs and four paws on the ground. The animal mouth is empty and closed. Four paws, fur, and a tail.',
      )
    }
  }
  return parts.join(' ')
}

function sceneCast(
  direction: string,
  sceneRecord?: SceneDirectionRecord,
): { count: number | undefined; hasHuman: boolean; hasAnimal: boolean } {
  const listed = sceneRecord?.visibleCharacters?.filter((value) => value.trim()) || []
  const stated = statedSceneCharacterCount(direction)
  const count = stated ?? (listed.length > 0 ? Math.min(listed.length, 3) : undefined)
  if (count === 0) {
    return { count: 0, hasHuman: false, hasAnimal: false }
  }
  const action = visibleCastText(direction, sceneRecord)
  return {
    count,
    hasHuman: HUMAN_PATTERN.test(action),
    hasAnimal: ANIMAL_PATTERN.test(action),
  }
}

function visibleCastText(direction: string, sceneRecord?: SceneDirectionRecord): string {
  return stripNegatedCast(sceneActionText(direction, sceneRecord))
}

function stripNegatedCast(text: string): string {
  return text.replace(
    /\b(?:no|without|zero|not any)\s+(?:people|persons?|humans?|animals?|cats?|dogs?|figures?|characters?|silhouettes?)\b/gi,
    ' ',
  )
}

function sanitizeZImageDirection(direction: string): string {
  return direction
    .replace(/\bno people or animals(?: are visible)?/gi, 'an unoccupied place')
    .replace(/\bno (?:people|animals|humans|persons|figures)(?: are visible)?/gi, 'unoccupied')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim()
}

function sceneActionText(direction: string, sceneRecord?: SceneDirectionRecord): string {
  return `${sceneRecord?.visualAction || ''} ${direction}`
}

function namedAnimal(text: string): string {
  if (/\b(?:cats?|kitten|feline|tabby)\b/i.test(text)) return 'cat'
  if (/\b(?:wolves|wolf)\b/i.test(text)) return 'wolf'
  if (/\b(?:dogs?|puppy|retriever)\b/i.test(text)) return 'dog'
  if (/\bhorse\b/i.test(text)) return 'horse'
  if (/\bbird\b/i.test(text)) return 'bird'
  if (/\brabbit\b/i.test(text)) return 'rabbit'
  return 'animal'
}

function zImageIdentityLocks(visualBible: VisualBible, direction: string): string[] {
  return [visualBible.mainCharacter, visualBible.supportingCharacter]
    .map((value) => value.trim())
    .filter((lock) => lock && !alreadyStated(direction, lock))
}

function alreadyStated(direction: string, lock: string): boolean {
  const key = lock.split(/[.,]/)[0]?.trim() || ''
  if (key.length < 12) return false
  return direction.toLowerCase().includes(key.toLowerCase())
}

function compactClause(text: string, maxWords: number): string {
  const sentence = firstSentence(text).replace(
    /^(?:Use|Keep|Make|Create|Render|Avoid)\s+/i,
    '',
  )
  const words = sentence.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  if (words.length <= maxWords) return words.join(' ').replace(/[.,;:]+$/, '')
  return words.slice(0, maxWords).join(' ')
}

function firstSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const match = trimmed.match(/^[^.!?]+[.!?]*/)
  return (match?.[0] || trimmed).trim()
}

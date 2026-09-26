import { describe, expect, it } from 'vitest'
import { isZImageModel, scenePromptingWorkflowForSettings } from './imageModels'
import {
  composeZImageTurboPrompt,
  zImageAnatomyCloser,
  zImageCastCloser,
  zImageSpeciesSplit,
} from './zImageTurboPrompting'

describe('imageModels', () => {
  it('detects Z-Image Turbo filenames', () => {
    expect(isZImageModel('z_image_turbo_bf16.safetensors')).toBe(true)
    expect(isZImageModel('Z_IMAGE_TURBO.safetensors')).toBe(true)
    expect(isZImageModel('flux-2-klein-9b-fp8.safetensors')).toBe(false)
  })

  it('selects the Turbo scene-direction workflow only for ComfyUI Z-Image', () => {
    expect(
      scenePromptingWorkflowForSettings({
        imageGenerator: 'comfyui',
        comfy: { diffusionModel: 'z_image_turbo_bf16.safetensors' },
      }),
    ).toBe('z-image-turbo')
    expect(
      scenePromptingWorkflowForSettings({
        imageGenerator: 'comfyui',
        comfy: { diffusionModel: 'flux-2-klein-9b-fp8.safetensors' },
      }),
    ).toBe('default')
    expect(
      scenePromptingWorkflowForSettings({
        imageGenerator: 'higgsfield',
        comfy: { diffusionModel: 'z_image_turbo_bf16.safetensors' },
      }),
    ).toBe('default')
  })
})

describe('zImageTurboPrompting', () => {
  const visualBible = {
    name: 'Test',
    style: 'Oil painting with heavy brush texture.',
    characters: 'a tabby cat',
    mainCharacter: 'Orange tabby cat with white paws and a torn left ear.',
    supportingCharacter: '',
    setting: 'A cramped kitchen with a dripping faucet.',
    palette: 'Warm amber and cream with a single teal accent.',
    camera: 'Wide cinematic shot',
    negativePrompt: 'extra limbs, text',
  }

  it('locks cartoon medium first even when the bible style is not cartoon', () => {
    const prompt = composeZImageTurboPrompt({
      direction: 'A tabby cat stares at a dripping faucet.',
      visualBible,
      aspectRatio: '16:9',
    })

    expect(prompt.startsWith('Clean 2D cartoon illustration')).toBe(true)
    expect(prompt).toContain('16:9 canvas')
    expect(prompt).toContain('Orange tabby cat with white paws')
    expect(prompt).toContain('animal mouth is empty')
    expect(prompt).toContain('At most three figures')
    expect(prompt).not.toContain(visualBible.negativePrompt)
  })

  it('picks bite geometry when the beat is a carry', () => {
    expect(zImageAnatomyCloser('the dog fetches a green leaf')).toContain('inside the animal mouth')
    expect(zImageAnatomyCloser('the dog sits on the rug')).toContain('animal mouth is empty')
  })

  it('does not put human-held props in an animal mouth or drop human bodies', () => {
    const direction =
      'A fur-clad caveman proudly presents a tiny wolf pup, while a modern human beside him stares in stunned disbelief. The caveman points with one hand and supports a stone platter with the other.'
    const closer = zImageAnatomyCloser(direction)

    expect(closer).toContain('clothed bipedal person')
    expect(closer).toContain('five-fingered hands')
    expect(closer).toContain('furred quadruped')
    expect(closer).toContain('animal mouth is empty')
    expect(closer).not.toContain('inside the animal mouth')
    expect(closer).not.toMatch(/not human arms/i)
    expect(closer).not.toMatch(/\bno object\b/i)
    expect(zImageSpeciesSplit(direction)).toMatch(/two different species/i)
    expect(zImageSpeciesSplit(direction)).toContain('quadruped wolf')
  })

  it('keeps a mixed human-and-cat scene from collapsing into two cats', () => {
    const direction =
      'Exactly two characters: one human owner and one domestic cat. The owner stands beside a small table, clutching a briefcase in one hand and a stack of bills in the other while staring at three dinner plates with a stunned face. The domestic cat is a sleek quadrupedal feline seated nearby, hind legs folded, both front paws planted, four paws visible, one head, two ears, one tail, empty closed mouth, and an aloof stare fixed on the dinner. The human has a head, neck, torso, two arms, two legs, and both feet on the floor. A wall clock and a couch occupy the uncluttered living room.'
    const prompt = composeZImageTurboPrompt({
      direction,
      visualBible,
      aspectRatio: '16:9',
    })

    expect(prompt.startsWith('Clean 2D cartoon illustration')).toBe(true)
    expect(prompt).toContain('clothed bipedal adult human')
    expect(prompt).toContain('simple shirt, pants, and shoes')
    expect(prompt).toContain('quadruped cat')
    expect(prompt).toContain('Two different species')
    expect(prompt).toContain('one clothed human and one separate quadruped cat')
    expect(prompt).toContain('five-fingered hands on the props')
    expect(prompt).not.toMatch(/not human arms/i)
    expect(prompt).not.toMatch(/no extra (?:people|limbs)/i)
    expect(zImageCastCloser(direction)).toContain('quadruped cat')
    expect(zImageAnatomyCloser('the cat sits on the rug')).toContain('Four paws, fur, and a tail')
    expect(zImageAnatomyCloser('the cat sits on the rug')).not.toMatch(/not human arms/i)
  })

  it('keeps a zero-character scene unoccupied instead of inventing a body', () => {
    const direction =
      'Exactly zero characters: no people or animals are visible. An open mud-brick granary has torn grain sacks, gnawed kernels, dark droppings, and dirty paw-sized smears scattered across the wheat and barley, while a foul-looking pile of spoiled grain sits beside the threshold. The contamination turns the once-proud food store into an unusable mess. A heavy wooden door leans against the granary wall, and bundled sheaves lie abandoned on the dusty ground. A small Neolithic village of mud-brick huts stands behind the store beneath a pale, cloudless Fertile Crescent sky.'
    const prompt = composeZImageTurboPrompt({
      direction,
      visualBible,
      aspectRatio: '16:9',
    })

    expect(prompt).toContain('an unoccupied place')
    expect(prompt).toContain('Unoccupied scene')
    expect(prompt).toContain('named architecture and props')
    expect(prompt).not.toContain('no people or animals')
    expect(prompt).not.toContain('Orange tabby cat')
    expect(prompt).not.toContain('full standing or kneeling body')
    expect(prompt).not.toContain('clothed bipedal')
    expect(prompt).not.toMatch(/not human arms/i)
    expect(prompt).not.toMatch(/no floating heads/i)
  })

  it('restates the stated cast count and never allows more than three', () => {
    expect(zImageCastCloser('Exactly one character: a tabby cat stares at a faucet.')).toContain(
      'Exactly 1 character in the frame',
    )
    expect(
      zImageCastCloser('Exactly two characters: a caveman and a wolf pup stand in a cave.'),
    ).toContain('Exactly 2 characters in the frame')
    expect(zImageCastCloser('Exactly zero characters: an empty stone cave with a cold firepit.')).toContain(
      'Exactly zero characters in the frame',
    )
    expect(zImageCastCloser('A tabby cat stares at a dripping faucet.')).toContain(
      'At most three figures',
    )
    expect(
      zImageCastCloser('A crowd gathers.', {
        version: 1,
        lineId: 'line-1',
        sourceFingerprint: 'abc',
        direction: 'A crowd gathers.',
        visibleCharacters: ['one', 'two', 'three'],
      }),
    ).toContain('Exactly 3 characters in the frame')
  })
})

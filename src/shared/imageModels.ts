import type { ImageGenerator } from './types'

export type ScenePromptingWorkflow = 'default' | 'z-image-turbo'

export function isZImageModel(modelName?: string | null): boolean {
  return (modelName || '').toLowerCase().includes('z_image')
}

export function scenePromptingWorkflowForSettings(settings: {
  imageGenerator: ImageGenerator
  comfy: { diffusionModel: string }
}): ScenePromptingWorkflow {
  return settings.imageGenerator === 'comfyui' && isZImageModel(settings.comfy.diffusionModel)
    ? 'z-image-turbo'
    : 'default'
}

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CodexClient } from '../src/main/services/codexClient'

const reference = process.argv[2]
const output = process.argv[3]
if (!reference || !output) {
  throw new Error('Usage: codex-image-smoke.ts <reference-image> <output-image>')
}

const client = new CodexClient()
const image = await client.generateImage({
  aspectRatio: '16:9',
  referenceImagePaths: [reference],
  prompt: [
    'Recreate this character still.',
    'Keep the same golden retriever, paper-collage cutout fur, crumpled beige paper background, black athletic tank with a white paw print, black shorts, green collar, yellow BUX tag, black watch, and paw-print sneakers.',
    'Pose: a deep squat with both knees following the toes downward, hands clasped in front, smiling, full body centered, facing the camera.',
  ].join(' '),
})

await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, image.data)
console.log(`saved ${output} (${image.data.byteLength} bytes, ${image.extension})`)
client.dispose()

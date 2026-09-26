import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

describe('preload export bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockClear()
    exposeInMainWorld.mockClear()
  })

  it('forwards the selected sequence to the export IPC handler', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      export: { longform: (sequence?: 'main' | 'trailer') => Promise<unknown> }
    }

    api.export.longform('trailer')

    expect(invoke).toHaveBeenCalledWith('export:longform', 'trailer')
  })

  it('forwards QWEN generation and cancellation through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      qwen: {
        generate: (input: { mode: 'all'; sequence: 'main' }) => Promise<unknown>
        cancel: () => Promise<void>
      }
    }

    api.qwen.generate({ mode: 'all', sequence: 'main' })
    api.qwen.cancel()

    expect(invoke).toHaveBeenCalledWith('qwen:generate', { mode: 'all', sequence: 'main' })
    expect(invoke).toHaveBeenCalledWith('qwen:cancel')
  })

  it('forwards YouTube channel profile CRUD through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      channelProfiles: {
        list: () => Promise<unknown>
        save: (input: { name: string }) => Promise<unknown>
        remove: (id: string) => Promise<unknown>
        apply: (id: string) => Promise<unknown>
      }
    }

    api.channelProfiles.list()
    api.channelProfiles.save({ name: 'Doggo' })
    api.channelProfiles.apply('profile-1')
    api.channelProfiles.remove('profile-1')

    expect(invoke).toHaveBeenCalledWith('channel-profiles:list')
    expect(invoke).toHaveBeenCalledWith('channel-profiles:save', { name: 'Doggo' })
    expect(invoke).toHaveBeenCalledWith('channel-profiles:apply', 'profile-1')
    expect(invoke).toHaveBeenCalledWith('channel-profiles:remove', 'profile-1')
  })

  it('forwards script bible choose and read through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      scriptBible: {
        choose: () => Promise<unknown>
        read: (filePath: string) => Promise<unknown>
      }
    }

    api.scriptBible.choose()
    api.scriptBible.read('C:\\bibles\\doggo.txt')

    expect(invoke).toHaveBeenCalledWith('script-bible:choose')
    expect(invoke).toHaveBeenCalledWith('script-bible:read', 'C:\\bibles\\doggo.txt')
  })

  it('forwards idea guide choose and read through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      ideaGuide: {
        choose: () => Promise<unknown>
        read: (filePath: string) => Promise<unknown>
      }
    }

    api.ideaGuide.choose()
    api.ideaGuide.read('C:\\guides\\video-idea.md')

    expect(invoke).toHaveBeenCalledWith('idea-guide:choose')
    expect(invoke).toHaveBeenCalledWith('idea-guide:read', 'C:\\guides\\video-idea.md')
  })

  it('forwards script creator draft saves through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      project: { saveScriptCreator: (draft: { topic: string; draft: string }) => Promise<unknown> }
    }

    api.project.saveScriptCreator({ topic: 'Inflation', draft: 'Custom: Bux look at wallet.' })

    expect(invoke).toHaveBeenCalledWith('project:save-script-creator', {
      topic: 'Inflation',
      draft: 'Custom: Bux look at wallet.',
    })
  })

  it('forwards YouTube research through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      youtube: { research: (input: { queries: string[] }) => Promise<unknown> }
    }

    api.youtube.research({ queries: ['why money loses value'] })

    expect(invoke).toHaveBeenCalledWith('youtube:research', { queries: ['why money loses value'] })
  })

  it('forwards image thumb requests through the bridge', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      project: {
        assetThumbDataUrl: (relativePath: string, maxEdge?: number) => Promise<unknown>
      }
    }

    api.project.assetThumbDataUrl('stills/001/a.png', 512)

    expect(invoke).toHaveBeenCalledWith('project:asset-thumb', 'stills/001/a.png', 512)
  })
})

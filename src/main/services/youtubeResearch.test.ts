import { describe, expect, it, vi } from 'vitest'
import { collectVideos, parseViewCount, researchYouTube, youtubeChannelHandle } from './youtubeResearch'

describe('YouTube research', () => {
  it('parses compact and abbreviated view counts', () => {
    expect(parseViewCount('1,234 views')).toBe(1234)
    expect(parseViewCount('1.2M views')).toBe(1_200_000)
    expect(parseViewCount('800K views')).toBe(800_000)
  })

  it('turns spaced channel names into YouTube handles', () => {
    expect(youtubeChannelHandle('Andrei Jikh')).toBe('@AndreiJikh')
    expect(youtubeChannelHandle('@Graham Stephan')).toBe('@GrahamStephan')
    expect(youtubeChannelHandle('https://www.youtube.com/@nischa/videos')).toBe('@nischa')
  })

  it('collects nested video renderers without reordering traversal', () => {
    const videos = collectVideos({
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      {
                        videoRenderer: {
                          videoId: 'relevant',
                          title: { runs: [{ text: 'Exact question match' }] },
                          ownerText: { runs: [{ text: 'Tiny Channel' }] },
                          viewCountText: { simpleText: '12 views' },
                        },
                      },
                      {
                        videoRenderer: {
                          videoId: 'popular',
                          title: { simpleText: 'Why money buys less' },
                          ownerText: {
                            runs: [
                              {
                                text: 'Plain Money',
                                navigationEndpoint: { browseEndpoint: { browseId: 'UCabcdefghijklmnopqrstuv' } },
                              },
                            ],
                          },
                          viewCountText: { simpleText: '2.4M views' },
                          publishedTimeText: { simpleText: '3 months ago' },
                          descriptionSnippet: { runs: [{ text: 'Prices keep rising.' }] },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    })

    const outlier = videos.find((video) => video.videoId === 'popular')
    expect(outlier?.channelId).toBe('UCabcdefghijklmnopqrstuv')
    expect(outlier?.url).toBe('https://www.youtube.com/watch?v=popular')
    expect(outlier?.viewCount).toBe(2_400_000)
    expect(videos.map((video) => video.videoId)).toEqual(['relevant', 'popular'])
  })

  it('collects current channel Videos lockupViewModel cards', () => {
    const videos = collectVideos({
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  richGridRenderer: {
                    contents: [
                      {
                        richItemRenderer: {
                          content: {
                            lockupViewModel: {
                              contentId: 'gTKS8SAwUzE',
                              contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                              contentImage: {
                                thumbnailViewModel: {
                                  overlays: [
                                    {
                                      thumbnailBottomOverlayViewModel: {
                                        badges: [
                                          {
                                            thumbnailBadgeViewModel: { text: '23:28' },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                              metadata: {
                                lockupMetadataViewModel: {
                                  title: { content: 'I Survived The Most Extreme Places On Earth' },
                                  metadata: {
                                    contentMetadataViewModel: {
                                      metadataRows: [
                                        {
                                          metadataParts: [
                                            { text: { content: '106M views' } },
                                            { text: { content: '13 days ago' } },
                                          ],
                                        },
                                      ],
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    })

    expect(videos).toHaveLength(1)
    expect(videos[0]).toMatchObject({
      videoId: 'gTKS8SAwUzE',
      title: 'I Survived The Most Extreme Places On Earth',
      viewCount: 106_000_000,
      viewCountText: '106M views',
      published: '13 days ago',
      duration: '23:28',
      url: 'https://www.youtube.com/watch?v=gTKS8SAwUzE',
    })
  })

  it('runs search queries through Innertube and records failures', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/youtubei/v1/search')) {
        return new Response(
          JSON.stringify({
            contents: {
              relevantResult: {
                videoRenderer: {
                  videoId: 'hit',
                  title: { simpleText: 'Why is everything so expensive' },
                  ownerText: { simpleText: 'Bills Channel' },
                  viewCountText: { simpleText: '900 views' },
                },
              },
              popularResult: {
                videoRenderer: {
                  videoId: 'viral',
                  title: { simpleText: 'A viral cost of living video' },
                  ownerText: { simpleText: 'Popular Channel' },
                  viewCountText: { simpleText: '9M views' },
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch

    const result = await researchYouTube(
      {
        queries: ['why is everything so expensive', 'why is everything so expensive'],
        channels: ['@missing'],
      },
      fetchImpl,
    )

    expect(result.queries).toHaveLength(1)
    expect(result.queries[0]?.videos[0]?.title).toBe('Why is everything so expensive')
    expect(result.queries[0]?.videos.map(video => video.videoId)).toEqual(['hit', 'viral'])
    expect(result.channels[0]?.error).toMatch(/404|resolve|failed/i)
  })
})

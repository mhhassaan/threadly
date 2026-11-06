import { ApiError } from '../../lib/account-thread'
import type { GenerationInput } from '../../lib/thread-generation'
import { textMedia, type Media, type Source } from '../../lib/thread'
import type { Platform } from '../platform'
import { safe, readArticle, bounded, extractArticle } from '../article.js'
import { withDeadline } from './transport'

export type GenerationSource = {
  text: string
  title: string
  sourceUrl: string
  source: Source | null
  media: Media[]
}
const unavailable = () =>
  new ApiError(
    422,
    'SOURCE_UNAVAILABLE',
    'Could not read enough article content. Paste the article text instead.',
  )
const tooLarge = () =>
  new ApiError(
    422,
    'SOURCE_TOO_LARGE',
    'The source exceeds 100000 characters. Use a shorter source.',
  )
const unsafe = () =>
  new ApiError(
    400,
    'INVALID_SOURCE_URL',
    'Use a public HTTP(S) article address.',
  )
export function checkSourceLength(text: string) {
  if (text.length > 100000) throw tooLarge()
}
// Access walls and navigation-only responses are not usable source evidence.
function adequate(text: string) {
  const paragraphs = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const wall =
    /\b(sign in|log in|subscribe|subscription required|enable javascript|access denied|verify (?:that )?you are human|accept (?:all )?cookies|page not found|robot check|paywall)\b/i
  const narrative = paragraphs
    .filter((s) => !wall.test(s))
    .join('\n')
    .trim()
  return narrative.length >= 150 && /\s/.test(narrative)
}
export async function retrieveGenerationSource(
  p: Platform,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GenerationSource> {
  if (signal.aborted) throw unavailable()
  checkSourceLength(input.source)
  if (input.mode !== 'url') {
    if (!input.source.trim()) throw unavailable()
    return {
      text: input.source,
      title: '',
      sourceUrl: '',
      source: null,
      media: textMedia(input.source),
    }
  }
  let url: URL
  try {
    url = new URL(input.source)
  } catch {
    throw unsafe()
  }
  if (!safe(url) || url.href.length > 8192) throw unsafe()
  let article: Awaited<ReturnType<typeof readArticle>> | undefined
  try {
    article = await withDeadline(signal, 15000, (s) =>
      readArticle(url.href, { signal: s, truncate: false }),
    )
    checkSourceLength(article.text)
    if (adequate(article.text))
      return {
        text: article.text,
        title: article.title,
        sourceUrl: article.url,
        source: article.source,
        media: article.media,
      }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'UNSAFE_SOURCE_URL') throw unsafe()
    if (code === 'SOURCE_TOO_LARGE') throw tooLarge()
    if (signal.aborted) throw unavailable()
  }
  if (!p.env.deepseekApiKey || signal.aborted) throw unavailable()
  try {
    return await withDeadline(signal, 10000, async (s) => {
      const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
        method: 'POST',
        redirect: 'error',
        signal: s,
        headers: {
          Authorization: `Bearer ${p.env.deepseekApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url.href }),
      })
      if (!response.ok) throw unavailable()
      const page = JSON.parse(
        await (await bounded(response, 1048576, s)).text(),
      )
      if (typeof page?.content !== 'string') throw unavailable()
      checkSourceLength(page.content)
      if (!adequate(page.content)) throw unavailable()
      return {
        text: page.content,
        title:
          article?.title || (typeof page.title === 'string' ? page.title : ''),
        sourceUrl: article?.url || url.href,
        source: article?.source || extractArticle('', url.href).source,
        media: [...(article?.media || []), ...textMedia(page.content)]
          .filter(
            (item, index, all) =>
              all.findIndex((other) => other.url === item.url) === index,
          )
          .slice(0, 16),
      }
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'SOURCE_TOO_LARGE')
      throw tooLarge()
    throw unavailable()
  }
}

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
// Match access/consent instructions, not incidental reporting about these topics.
function articleNarrative(text: string) {
  const navigationLabel =
    /^(?:home|news|world|politics|business|technology|science|health|culture|sports|opinion|about(?: us)?|contact(?: us)?|privacy policy|terms(?: of service)?|help|careers|newsletters)$/i
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => {
    const plain = paragraph.trim().replace(/^#{1,6}\s+/, '')
    const accessNotice =
      /^(?:you(?: have|'ve) (?:reached|exceeded) (?:your|the) .{0,60}(?:limit|allowance)|subscription required|enable javascript|access denied|verify (?:that )?you are human|page not found|robot check)\b/i.test(
        plain,
      )
    const accessAction =
      /^(?:(?:sign|log) in|subscribe|create an? account|register|become a member|choose a plan)\b.{0,120}\b(?:continue|read (?:the |this |more|full)|full access|unlimited (?:access|articles)|unlock|access (?:this|the) (?:article|content))/i.test(
        plain,
      )
    const consent =
      /^accept (?:all |optional )?cookies\b/i.test(plain) ||
      (/^we (?:use cookies|value your privacy)\b/i.test(plain) &&
        /\b(?:accept all cookies|manage your preferences|give (?:your )?consent|continue (?:to|browsing))\b/i.test(
          plain,
        ))
    const menu = plain
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .split(/[|›»•·>\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    const navigation =
      menu.length >= 3 && menu.every((item) => navigationLabel.test(item))
    return !accessNotice && !accessAction && !consent && !navigation
  })
  const narrative = paragraphs.join('\n\n').trim()
  return narrative.length >= 150 && /\s/.test(narrative) ? narrative : ''
}
export async function retrieveGenerationSource(
  p: Platform,
  input: GenerationInput,
  signal: AbortSignal,
  beforeExternal?: () => Promise<void>,
): Promise<GenerationSource> {
  if (signal.aborted) throw unavailable()
  checkSourceLength(input.source)
  if (input.mode !== 'url') {
    if (!input.source.trim()) throw unavailable()
    let sourceUrl = '',
      source: Source | null = null
    const attributed = input.source.match(/^Source:\s*(https?:\/\/\S+)/im)
    if (attributed) {
      try {
        const url = new URL(attributed[1])
        if (safe(url) && url.href.length <= 8192) {
          sourceUrl = url.href
          source = extractArticle('', sourceUrl).source
        }
      } catch {
        // Invalid attribution remains part of the original source text.
      }
    }
    return {
      text: input.source,
      title: '',
      sourceUrl,
      source,
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
    const narrative = articleNarrative(article.text)
    if (narrative)
      return {
        text: narrative,
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
  if (beforeExternal) await beforeExternal()
  if (signal.aborted) throw unavailable()
  try {
    return await withDeadline(signal, 10000, async (s) => {
      const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
        method: 'POST',
        redirect: 'manual',
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
      const narrative = articleNarrative(page.content)
      if (!narrative) throw unavailable()
      return {
        text: narrative,
        title:
          article?.title || (typeof page.title === 'string' ? page.title : ''),
        sourceUrl: article?.url || url.href,
        source: article?.source || extractArticle('', url.href).source,
        media: [...(article?.media || []), ...textMedia(narrative)]
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

import app from '../../dist/server/index.js'
import { extractArticle } from '../../src/server/article.js'

// Profiling-only entry: never referenced by the app's Wrangler/Vite configuration.
const paragraph =
  '<p>' +
  'Careful reading connects evidence to context and preserves the meaning of a source. '.repeat(
    8,
  ) +
  '</p>'
const html =
  '<html><title>Local CPU fixture</title><article>' +
  paragraph.repeat(Math.floor(1_000_000 / paragraph.length)) +
  '</article></html>'

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/__profile_extract') {
      const article = extractArticle(html, 'https://fixture.example/article')
      return Response.json({
        inputBytes: html.length,
        extractedCharacters: article.text.length,
      })
    }
    return app.fetch(request)
  },
}

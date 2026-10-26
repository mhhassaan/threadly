<img src="public/brand/threadly-mark.svg" alt="Threadly logo" width="80" height="80">

# Threadly

Threadly turns articles, pasted text, and TXT or Markdown files into editable Twitter-style reading threads. It condenses the source while preserving complete thoughts and their original order.

## Features

- Import a public article URL, paste text, or upload a TXT or Markdown file up to 1 MB.
- Choose Quick read, Balanced, or Deep dive, with automatic thread length or a limit of 5, 10, or 20 posts.
- Read the result in a separate tab or window, with source identity and article media when available.
- Edit individual posts, copy a post or the complete thread, and download the thread as text.
- Save all, individual, or selected posts as themed PNG images. Long exports are split into numbered PNG pages in a ZIP.
- Save threads in a browser-local library. Reader content survives a refresh within its session.
- Add local replies, likes, reposts, and bookmarks. These interactions do not publish to Twitter or X.
- Choose White, Gray, Dim, Dark, or Paper themes, with custom background, card, and accent colors.
- Use responsive layouts, keyboard-accessible controls, and reduced-motion support.

## Current status

Threadly currently uses extractive summarization: it selects connected passages from the source rather than generating new text with an LLM. Long sentences may exceed 280 characters to preserve a complete thought.

AI conversations about threads and individual posts are being considered. AI chat and a TanStack migration are not implemented.

## Run locally

Requires Node.js 22 or newer. The current app has no third-party JavaScript package dependencies and does not require an API key or an installation step.

From the project directory:

```sh
node scripts/build.mjs
node scripts/preview.mjs
```

Open [http://localhost:4173](http://localhost:4173). Stop the preview with Ctrl+C.

The preview listens on the local machine only. It does not hot-reload: after editing source files, rebuild, stop the existing preview, and start it again.

The equivalent package scripts are `npm run build` and `npm run dev`. Run the build before starting the preview.

## Checks

Build first, then run the functional checks:

```sh
node scripts/build.mjs
node scripts/check.mjs
```

The checks cover source extraction, sentence continuity, summary depth and limits, media handling, themes, image export wrapping, ZIP output, and rejection of private-address fetch targets. Browser checks are still needed for layout and interactions; mobile touch and keyboard behavior should be checked on a physical device.

## Project structure

```text
public/
  index.html       Dashboard and reader markup
  style.css        Layout, themes, typography, and motion
  app.js           Input, reader interactions, and saved threads
  summary.js       Source-based summarization
  appearance.js    Theme preferences and shared color tokens
  export.js        Canvas image export and ZIP packaging
  fonts/           Local fonts and provenance records
  brand/           Logo assets and design notes
worker/
  index.js         Article extraction, media proxy, and asset routes
scripts/
  build.mjs        Embeds browser assets into the Worker build
  preview.mjs      Local Node.js server for the built app
  check.mjs        Functional regression checks
devlog.md          Project change history
```

Authored source lives in `public/`, `worker/`, and `scripts/`. The generated `dist/` directory is excluded from Git.

## Data and privacy

Pasted text and uploaded text files are summarized in the browser. Article URLs are fetched by the server, and displayed source images may pass through the media proxy. The browser also requests Google Fonts for the supporting interface typography.

Saved threads and appearance preferences use local storage; the active reader uses session storage. There are no user accounts, cloud synchronization, or shared conversations in the current version. Avoid saving sensitive content on a shared device.

## Limitations

- Paywalled, protected, or JavaScript-dependent articles may not import. Paste the text instead.
- Summaries can omit context; the original source remains the reference.
- Media playback depends on the source. Image exports use static images or media representations rather than playable audio or video.
- Some remote images may be unavailable in exports.
- Custom dropdown rendering varies by browser; standard native controls remain the fallback.
- Popup blocking may require selecting Open thread after generation.

## Hosting

The build produces `dist/server/index.js`, which exports a Worker-compatible request handler. The local preview runs that handler through Node.js.

Existing deployment identity is stored locally in `.openai/hosting.json` and excluded from Git. When present, the build copies it into `dist/.openai/`. It is optional for local builds and checks. Keep an existing manifest when updating its associated deployment; a new deployment requires configuration for the chosen host.

## Fonts and asset attribution

Jersey 25 is used for headings, navigation, and the footer; Chirp is used for thread content. Font sources and notices are in [public/fonts/FONT-SOURCES.md](public/fonts/FONT-SOURCES.md), including the Jersey 25 Open Font License. The supplied Chirp source does not include a license file; its provenance record does not grant redistribution rights.

Brand assets and their provenance are documented in [public/brand/README.md](public/brand/README.md). This repository does not currently declare a project-wide software license; third-party notices retain their own terms.

## Git hygiene

The ignore rules exclude generated builds, dependencies, local environment files, hosting identity, editor files, and local agent/context folders. Source assets, attribution files, this README, and the devlog remain eligible for version control.

If any excluded files were already committed in another checkout, `.gitignore` will not remove them from Git history. Review staged files before pushing.

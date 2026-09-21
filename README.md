# Gemini Reader

A personal Firefox extension that reads web pages aloud with Gemini TTS
(`gemini-2.5-flash-preview-tts`, the cheapest Gemini TTS model) and highlights each
sentence as it's spoken.

## Use

Right-click a page and open **Activate TTS**:

- **Read from here**: starts at the first highlighted word, or at the paragraph you
  right-clicked, and reads to the end of the article's main text.
- **Read highlighted text**: reads only the selection.

A control bar in the bottom-right corner has play/pause, speed, stop, and a live
elapsed/estimated-total timer. Click the toolbar icon to set the API key, default
voice, default speed and the max-words-per-request cap.

## How it works

- `content.js` finds the article (the element whose paragraphs hold the most text)
  and splits it into real DOM paragraphs and sentences.
- Those paragraphs are packed into as few Gemini requests ("chunks") as possible: whole
  paragraphs are greedily combined up to *max words per request* (default 600, ~4
  minutes of speech). A paragraph longer than that on its own is split at a sentence
  boundary instead of being force-fit, and an unusually long sentence is split by
  words. A typical article fits in a single request — true whole-document reading —
  while very long pages still get split to avoid Gemini's documented audio-quality
  drift on long single requests and the wait before playback would otherwise start.
- Highlighting is independent of that request grouping: a subtle highlight always
  covers the one real paragraph containing the sentence being read, and a stronger
  highlight marks that sentence, however many paragraphs happen to share a request.
- `background.js` sends each chunk to Gemini (two chunks ahead of playback), wraps the
  returned PCM in a WAV header, and plays it. Speed is the audio's playback rate
  (pitch preserved).
- Gemini doesn't return timestamps, so the highlighted sentence — and the timer's
  remaining-time estimate — are derived from playback progress and measured chunk
  durations, weighted by sentence/word counts.

## Install

**Quick test (removed when Firefox restarts):**
open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and
pick `manifest.json` in this folder.

**Permanent:** release Firefox only installs signed extensions. Mozilla signs
personal ("unlisted") extensions for free; they aren't published anywhere.

1. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
2. In this folder, run:
   ```
   npx web-ext sign --channel=unlisted --api-key=YOUR_JWT_ISSUER --api-secret=YOUR_JWT_SECRET
   ```
3. Drag the `.xpi` from `web-ext-artifacts/` into Firefox.

Bump `version` in `manifest.json` before signing a new build.

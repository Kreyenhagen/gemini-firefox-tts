# Gemini Reader

A personal Firefox extension that reads web pages aloud with Gemini TTS
(`gemini-2.5-flash-preview-tts`, the cheapest Gemini TTS model) and highlights each
sentence as it's spoken.

## Use

Right-click a page and open **Activate TTS**:

- **Read from here**: starts at the first highlighted word, or at the paragraph you
  right-clicked, and reads to the end of the article's main text.
- **Read highlighted text**: reads only the selection.

A control bar in the bottom-right corner has play/pause, speed and stop buttons.
Click the toolbar icon to set the API key, default voice, default speed and the chunk
word limits.

## How it works

- `content.js` finds the article (the element whose paragraphs hold the most text),
  splits it into paragraphs and sentences, and groups sentences into chunks:
  paragraphs are merged until a chunk has at least *min words*, and a chunk that would
  pass *max words* ends at the previous sentence.
- `background.js` sends each chunk to Gemini (two chunks ahead of playback), wraps the
  returned PCM in a WAV header, and plays it. Speed is the audio's playback rate
  (pitch preserved).
- Gemini doesn't return timestamps, so the highlighted sentence is estimated from
  playback progress through the chunk, weighted by sentence length.

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

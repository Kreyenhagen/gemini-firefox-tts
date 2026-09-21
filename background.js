'use strict';

// Cheapest Gemini TTS model ($0.50 / 1M text-in, $10 / 1M audio-out tokens).
const MODEL = 'gemini-2.5-flash-preview-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
// Without an instruction, very short inputs ("Introduction") make the model try to reply in text.
const PROMPT = 'Read the following text aloud, word for word:\n\n';
const PREFETCH = 2; // chunks synthesized ahead of the one playing
const SENTENCE_PAUSE = 12; // extra weight (in characters) per sentence when estimating timing
const FALLBACK_WORDS_PER_SEC = 2.5; // ~150wpm guess used until a real chunk duration is known

// ---------- settings ----------

let settings = { ...DEFAULTS };
browser.storage.local.get(DEFAULTS).then((s) => { settings = s; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue ?? DEFAULTS[key];
  }
});

// ---------- context menu ----------

const MENU_CONTEXTS = ['page', 'selection', 'link'];
browser.menus.removeAll().then(() => {
  browser.menus.create({ id: 'gtts', title: 'Activate TTS', contexts: MENU_CONTEXTS });
  browser.menus.create({ id: 'gtts-from-here', parentId: 'gtts', title: 'Read from here', contexts: MENU_CONTEXTS });
  browser.menus.create({ id: 'gtts-selection', parentId: 'gtts', title: 'Read highlighted text', contexts: ['selection'] });
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'gtts-from-here' && info.menuItemId !== 'gtts-selection') return;
  if (!settings.apiKey) {
    // Must run synchronously inside the click handler to count as a user action.
    browser.browserAction.openPopup().catch(() => browser.runtime.openOptionsPage());
    return;
  }
  startInTab(tab.id, info.frameId || 0, {
    type: 'start',
    mode: info.menuItemId === 'gtts-selection' ? 'selection' : 'from-here',
    targetElementId: info.targetElementId,
    speed: settings.speed,
    maxWords: settings.maxWords,
  });
});

async function startInTab(tabId, frameId, message) {
  try {
    await browser.tabs.removeCSS(tabId, { file: 'content.css', frameId }).catch(() => {});
    await browser.tabs.insertCSS(tabId, { file: 'content.css', frameId });
    await browser.tabs.executeScript(tabId, { file: 'content.js', frameId });
    await browser.tabs.sendMessage(tabId, message, { frameId });
  } catch (err) {
    console.warn('Gemini Reader cannot run on this page:', err);
  }
}

// ---------- playback session ----------
// The content script extracts text and draws highlights; audio lives here so page
// CSP and autoplay rules never get in the way.

let session = null;

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gtts') return;
  port.onMessage.addListener((msg) => onPortMessage(port, msg));
  port.onDisconnect.addListener(() => {
    if (session?.port === port) stop(false);
  });
});

function onPortMessage(port, msg) {
  if (msg.type === 'load') {
    startSession(port, msg);
    return;
  }
  const s = session;
  if (!s || s.port !== port) return;
  switch (msg.type) {
    case 'play': resume(s); break;
    case 'pause': pause(s); break;
    case 'speed': setSpeed(s, msg.value); break;
    case 'cancel': stop(false); break;
  }
}

function startSession(port, { chunks, speed }) {
  stop(true);
  const audio = new Audio();
  const s = {
    port,
    chunks: chunks.map((c) => ({
      ...c,
      total: c.weights.reduce((sum, w) => sum + w + SENTENCE_PAUSE, 0),
    })),
    totalWords: chunks.reduce((sum, c) => sum + c.words, 0),
    wordsDone: 0, // words in chunks that have finished playing (for the rate estimate)
    durationDone: 0, // their real, measured audio duration in seconds
    elapsedWallSec: 0, // real elapsed listening time, accumulated across pauses/chunks
    playStartWallTime: null, // performance.now() when playback last (re)started, else null
    speed,
    audio,
    index: -1,
    sentence: -1,
    ready: false,
    paused: false,
    cache: new Map(), // chunk index -> Promise<blob URL>
    abort: new AbortController(),
    voice: settings.voice,
    apiKey: settings.apiKey,
    ticker: null,
  };
  session = s;
  audio.addEventListener('ended', () => {
    accumulateWallClock(s);
    if (s.index >= 0) {
      const done = s.chunks[s.index];
      s.wordsDone += done.words;
      s.durationDone += audio.duration || 0;
    }
    playChunk(s, s.index + 1);
  });
  s.ticker = setInterval(() => updateSentence(s), 100);
  playChunk(s, 0);
}

async function playChunk(s, i) {
  if (s !== session) return;
  if (i >= s.chunks.length) {
    post(s, { type: 'done' });
    stop(false);
    return;
  }
  s.index = i;
  s.sentence = 0;
  s.ready = false;
  for (let j = i; j <= i + PREFETCH && j < s.chunks.length; j++) load(s, j);
  for (const [j, url] of s.cache) {
    if (j < i) {
      url.then((u) => URL.revokeObjectURL(u), () => {});
      s.cache.delete(j);
    }
  }
  post(s, { type: 'chunk', index: i, loading: true, paused: s.paused });

  let url;
  try {
    url = await s.cache.get(i);
  } catch (err) {
    if (s === session && err.name !== 'AbortError') {
      post(s, { type: 'error', message: err.message });
      stop(false);
    }
    return;
  }
  if (s !== session) return;

  s.audio.src = url;
  // Loading a new src resets playbackRate to defaultPlaybackRate, so set both.
  s.audio.defaultPlaybackRate = s.speed;
  s.audio.playbackRate = s.speed;
  s.audio.preservesPitch = true;
  s.ready = true;
  post(s, { type: 'state', loading: false, paused: s.paused });
  if (!s.paused) play(s);
}

function play(s) {
  s.audio.play().then(() => {
    if (s === session) s.playStartWallTime = performance.now();
  }).catch((err) => {
    if (s !== session) return;
    post(s, { type: 'error', message: `Playback failed: ${err.message}` });
    stop(false);
  });
}

function pause(s) {
  s.paused = true;
  s.audio.pause();
  accumulateWallClock(s);
  post(s, { type: 'state', loading: !s.ready, paused: true });
}

function accumulateWallClock(s) {
  if (s.playStartWallTime != null) {
    s.elapsedWallSec += (performance.now() - s.playStartWallTime) / 1000;
    s.playStartWallTime = null;
  }
}

function resume(s) {
  s.paused = false;
  if (s.ready) play(s);
  post(s, { type: 'state', loading: !s.ready, paused: false });
}

function setSpeed(s, value) {
  s.speed = value;
  s.audio.defaultPlaybackRate = value;
  s.audio.playbackRate = value;
}

// Gemini returns no timestamps, so estimate the current sentence from how far
// through the chunk's audio we are, weighted by sentence length. The same tick
// also reports elapsed/remaining time for the widget's timer.
function updateSentence(s) {
  const { audio } = s;
  const elapsedSec = s.elapsedWallSec + (s.playStartWallTime != null ? (performance.now() - s.playStartWallTime) / 1000 : 0);
  if (!s.ready || !audio.duration || !isFinite(audio.duration)) {
    post(s, { type: 'progress', chunk: s.index, sentence: s.sentence, elapsedSec, remainingSec: null });
    return;
  }
  const chunk = s.chunks[s.index];
  const fraction = audio.currentTime / audio.duration;
  const target = fraction * chunk.total;
  let acc = 0;
  let j = 0;
  for (; j < chunk.weights.length - 1; j++) {
    acc += chunk.weights[j] + SENTENCE_PAUSE;
    if (acc > target) break;
  }
  s.sentence = j;

  const wordsSoFar = s.wordsDone + fraction * chunk.words;
  const rate = s.durationDone > 0 ? s.wordsDone / s.durationDone : FALLBACK_WORDS_PER_SEC;
  const remainingWords = Math.max(0, s.totalWords - wordsSoFar);
  const remainingSec = remainingWords / rate / s.speed;

  post(s, { type: 'progress', chunk: s.index, sentence: j, elapsedSec, remainingSec });
}

function stop(notify) {
  const s = session;
  if (!s) return;
  session = null;
  s.abort.abort();
  clearInterval(s.ticker);
  s.audio.pause();
  s.audio.removeAttribute('src');
  s.audio.load();
  for (const url of s.cache.values()) url.then((u) => URL.revokeObjectURL(u), () => {});
  s.cache.clear();
  if (notify) post(s, { type: 'stopped' });
}

function post(s, msg) {
  try {
    s.port.postMessage(msg);
  } catch {
    // Port already closed (tab navigated away).
  }
}

// ---------- Gemini TTS ----------

function load(s, j) {
  if (s.cache.has(j)) return;
  const url = synthesizeWithRetry(s.chunks[j].text, s).then((wav) => URL.createObjectURL(wav));
  url.catch(() => {}); // errors surface when this chunk is played
  s.cache.set(j, url);
}

async function synthesizeWithRetry(text, s) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await synthesize(text, s.voice, s.apiKey, s.abort.signal);
    } catch (err) {
      if (err.name === 'AbortError' || !err.retryable || attempt >= 3) throw err;
      await sleep(err.status === 429 ? 10000 * (attempt + 1) : 1000 * (attempt + 1), s.abort.signal);
    }
  }
}

async function synthesize(text, voice, apiKey, signal) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT + text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500 || /tried to generate text/i.test(msg);
    throw apiError(friendlyMessage(res.status, msg), res.status, retryable);
  }
  const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw apiError('Gemini returned no audio for this passage.', 0, true);
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1]) || 24000;
  return pcmToWav(base64ToBytes(part.inlineData.data), rate);
}

function friendlyMessage(status, msg) {
  if (/api key/i.test(msg)) return 'Invalid API key. Check the extension settings.';
  if (status === 403) return 'API key not allowed to use Gemini TTS.';
  if (status === 429) return `Rate limit or spending cap reached. ${msg}`;
  return msg;
}

function apiError(message, status, retryable) {
  const err = new Error(message);
  err.status = status;
  err.retryable = retryable;
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function base64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Gemini sends raw 16-bit mono PCM; wrap it in a WAV header so <audio> can play it.
function pcmToWav(pcm, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset, str) => {
    for (let i = 0; i < str.length; i++) header.setUint8(offset + i, str.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  header.setUint32(40, pcm.length, true);
  return new Blob([header.buffer, pcm], { type: 'audio/wav' });
}

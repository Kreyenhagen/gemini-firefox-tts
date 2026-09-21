(() => {
  'use strict';

  // Injected on every menu click; only set up once per frame.
  if (window.__geminiReader) return;
  window.__geminiReader = true;

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
  const ALWAYS_SKIP = 'script, style, noscript, template, svg, math, iframe, canvas, video, audio, select, textarea, input, #gtts-widget';
  const ARTICLE_SKIP = `${ALWAYS_SKIP}, nav, aside, footer, form, button, figure, pre, sup, [aria-hidden="true"],
    [role="navigation"], [role="complementary"], [role="contentinfo"], [role="button"],
    .sr-only, .visually-hidden, .screen-reader-text`;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    minus: 'M5 11h14v2H5z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  };

  let current = null;

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'start') start(msg);
  });

  // ---------- starting a session ----------

  function start({ mode, targetElementId, speed, maxWords }) {
    const range = mode === 'selection' ? selectionRange() : fromHereRange(targetElementId);
    teardown();
    if (!range) {
      showNotice('Highlight some text first.');
      return;
    }
    const paras = collectParagraphs(range, mode === 'selection' ? ALWAYS_SKIP : ARTICLE_SKIP, mode === 'from-here');
    const chunks = buildChunks(paras, maxWords);
    if (!chunks.length) {
      showNotice('No readable text found here.');
      return;
    }
    window.getSelection().removeAllRanges();

    const port = browser.runtime.connect({ name: 'gtts' });
    const session = {
      port, chunks, speed, paused: false,
      chunkIndex: -1, lastSentence: -1, ranges: [], paraGroups: [], widget: null,
    };
    current = session;
    session.widget = createWidget(session);
    port.onMessage.addListener((msg) => onPortMessage(session, msg));
    port.onDisconnect.addListener(() => { if (current === session) teardown(); });
    port.postMessage({
      type: 'load',
      speed,
      chunks: chunks.map((c) => ({
        text: c.sentences.map((s, i) => (i === 0 ? '' : s.para !== c.sentences[i - 1].para ? '\n\n' : ' ') + s.text).join(''),
        weights: c.sentences.map((s) => s.text.length),
        words: c.words,
      })),
    });
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    return sel.getRangeAt(0).cloneRange();
  }

  // From the start of the selection (or the right-clicked element) to the end of the article.
  function fromHereRange(targetElementId) {
    const sel = window.getSelection();
    let node = null;
    let offset = 0;
    if (sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      node = r.startContainer;
      offset = r.startOffset;
    } else if (targetElementId != null) {
      node = browser.menus.getTargetElement(targetElementId);
    }
    const root = findArticleRoot(node);
    const range = document.createRange();
    range.selectNodeContents(root);
    if (node && root.contains(node)) range.setStart(node, offset);
    return range;
  }

  // Readability-style guess: the element whose <p> children hold the most text.
  function findArticleRoot(near) {
    const scores = new Map();
    for (const p of document.querySelectorAll('p')) {
      const len = p.textContent.trim().length;
      if (len < 25 || !p.parentElement) continue;
      const parent = p.parentElement;
      scores.set(parent, (scores.get(parent) || 0) + len);
      if (parent.parentElement) scores.set(parent.parentElement, (scores.get(parent.parentElement) || 0) + len / 2);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, score] of scores) {
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    let root = best?.closest('article') || best || document.body;
    if (near && !root.contains(near)) {
      const el = near.nodeType === Node.ELEMENT_NODE ? near : near.parentElement;
      root = el?.closest('article, main, [role="main"]') || document.body;
    }
    return root;
  }

  // ---------- text extraction ----------

  // Paragraph = run of text nodes sharing the same nearest block-level ancestor.
  // Each keeps a map from its text offsets back to DOM text nodes for highlighting.
  function collectParagraphs(range, skipSelector, snapToWord) {
    const container = range.commonAncestorContainer;
    const rootEl = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const blockCache = new Map();
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (n.matches(skipSelector) || !n.checkVisibility({ visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    });

    const paras = [];
    let para = null;
    let block = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.localName === 'br') block = null;
        continue;
      }
      if (!range.intersectsNode(n)) continue;
      const b = closestBlock(n.parentElement, blockCache);
      if (!para || b !== block) {
        para = { nodes: [], text: '' };
        paras.push(para);
        block = b;
      }
      para.nodes.push({ node: n, start: para.text.length });
      para.text += n.data;
    }

    // Only the range's boundary nodes can be partially included.
    for (const p of paras) {
      const first = p.nodes[0];
      const last = p.nodes[p.nodes.length - 1];
      p.from = first.start + (first.node === range.startContainer ? range.startOffset : 0);
      p.to = last.start + (last.node === range.endContainer ? range.endOffset : last.node.length);
    }
    if (snapToWord && paras.length) {
      const p = paras[0];
      while (p.from > 0 && /\S/.test(p.text[p.from - 1])) p.from--;
    }

    const segmenter = sentenceSegmenter();
    for (const p of paras) {
      p.sentences = [];
      for (const { segment, index } of segmenter.segment(p.text)) {
        let s = Math.max(index, p.from);
        let e = Math.min(index + segment.length, p.to);
        while (s < e && /\s/.test(p.text[s])) s++;
        while (e > s && /\s/.test(p.text[e - 1])) e--;
        if (e <= s) continue;
        const text = p.text.slice(s, e).replace(/\s+/g, ' ');
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        p.sentences.push({ para: p, start: s, end: e, text, words: text.split(' ').length });
      }
    }
    return paras.filter((p) => p.sentences.length);
  }

  function closestBlock(el, cache) {
    for (let e = el; e; e = e.parentElement) {
      let isBlock = cache.get(e);
      if (isBlock === undefined) {
        const display = getComputedStyle(e).display;
        isBlock = !display.startsWith('inline') && display !== 'contents';
        cache.set(e, isBlock);
      }
      if (isBlock) return e;
    }
    return document.body;
  }

  function sentenceSegmenter() {
    try {
      return new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' });
    } catch {
      return new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
  }

  // ---------- chunking ----------
  // A chunk is one TTS request. Whole paragraphs are packed in greedily, never split,
  // up to maxWords. A paragraph longer than maxWords on its own is split at sentence
  // boundaries instead (and, if a single sentence is itself too long, at word boundaries).
  // This is purely about request size/quality; highlighting tracks real paragraphs
  // separately (see showChunk), so merging or splitting here doesn't affect it.

  function buildChunks(paras, maxWords) {
    const chunks = [];
    let chunk = null;
    const push = () => { if (chunk) { chunks.push(chunk); chunk = null; } };
    const add = (pieces) => {
      const words = pieces.reduce((sum, p) => sum + p.words, 0);
      if (chunk && chunk.words + words > maxWords) push();
      chunk ??= { sentences: [], words: 0 };
      chunk.sentences.push(...pieces);
      chunk.words += words;
    };

    for (const p of paras) {
      const paraWords = p.sentences.reduce((sum, s) => sum + s.words, 0);
      if (paraWords <= maxWords) {
        add(p.sentences);
      } else {
        push(); // give an oversized paragraph a fresh chunk to split across
        for (const sentence of p.sentences) {
          add(sentence.words > maxWords ? splitSentence(sentence, maxWords) : [sentence]);
        }
      }
    }
    push();
    return chunks;
  }

  function splitSentence(sentence, maxWords) {
    const { para } = sentence;
    const words = [...para.text.slice(sentence.start, sentence.end).matchAll(/\S+/g)];
    const pieces = [];
    for (let i = 0; i < words.length; i += maxWords) {
      const group = words.slice(i, i + maxWords);
      const last = group[group.length - 1];
      const start = sentence.start + group[0].index;
      const end = sentence.start + last.index + last[0].length;
      pieces.push({ para, start, end, text: para.text.slice(start, end).replace(/\s+/g, ' '), words: group.length });
    }
    return pieces;
  }

  // ---------- messages from the background player ----------

  function onPortMessage(session, msg) {
    if (current !== session) return;
    switch (msg.type) {
      case 'chunk':
        showChunk(session, msg.index);
        session.lastSentence = 0;
        highlightSentence(session, 0);
        session.paused = msg.paused;
        updateWidget(session, msg.loading);
        break;
      case 'state':
        session.paused = msg.paused;
        updateWidget(session, msg.loading);
        break;
      case 'progress':
        if (msg.chunk === session.chunkIndex) {
          if (msg.sentence !== session.lastSentence) {
            session.lastSentence = msg.sentence;
            highlightSentence(session, msg.sentence);
          }
          if (msg.remainingSec != null) updateTimer(session, msg.elapsedSec, msg.remainingSec);
        }
        break;
      case 'error':
        clearHighlights();
        showError(session, msg.message);
        break;
      case 'done':
      case 'stopped':
        teardown();
        break;
    }
  }

  // ---------- highlighting ----------
  // Two layers: a subtle highlight over the whole source paragraph containing the
  // sentence being read, and a stronger one on that sentence. Both are computed from
  // the real DOM paragraphs, independent of how sentences were grouped into TTS requests.

  function showChunk(session, index) {
    session.chunkIndex = index;
    const sentences = session.chunks[index].sentences;
    session.ranges = sentences.map(makeRange); // index-aligned with sentences; entries may be null
    session.paraGroups = [];
    sentences.forEach((sentence, i) => {
      const g = session.paraGroups[session.paraGroups.length - 1];
      if (g && sentence.para === sentences[g.start].para) g.end = i;
      else session.paraGroups.push({ start: i, end: i });
    });
  }

  function highlightSentence(session, i) {
    const group = session.paraGroups.find((g) => i >= g.start && i <= g.end);
    if (group) setHighlight('gtts-paragraph', session.ranges.slice(group.start, group.end + 1).filter(Boolean));
    const range = session.ranges[i];
    setHighlight('gtts-sentence', range ? [range] : []);
    if (range) scrollIntoViewIfNeeded(range);
  }

  function makeRange({ para, start, end }) {
    try {
      const a = locate(para, start, false);
      const b = locate(para, end, true);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null; // page changed underneath us
    }
  }

  function locate(para, offset, isEnd) {
    for (const { node, start } of para.nodes) {
      const end = start + node.length;
      if (isEnd ? offset <= end : offset < end) return { node, offset: Math.min(offset - start, node.length) };
    }
    const last = para.nodes[para.nodes.length - 1].node;
    return { node: last, offset: last.length };
  }

  function setHighlight(name, ranges) {
    try {
      CSS.highlights.set(name, new Highlight(...ranges));
    } catch {
      // Fall back to the page's own objects if the content-script wrappers refuse.
      const page = window.wrappedJSObject;
      page.CSS.highlights.set(name, new page.Highlight(...ranges));
    }
  }

  function clearHighlights() {
    try {
      CSS.highlights.delete('gtts-paragraph');
      CSS.highlights.delete('gtts-sentence');
    } catch {
      window.wrappedJSObject.CSS.highlights.clear();
    }
  }

  function scrollIntoViewIfNeeded(range) {
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const scroller = scrollParent(range.startContainer.parentElement);
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const height = view.bottom - view.top;
    if (rect.top >= view.top + 60 && rect.bottom <= view.bottom - 110) return;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    (scroller || window).scrollBy({ top: rect.top - view.top - height / 3, behavior });
  }

  function scrollParent(el) {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const { overflowY } = getComputedStyle(e);
      if ((overflowY === 'auto' || overflowY === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  }

  // ---------- floating controls ----------

  function createWidget(session) {
    const widget = h('div', { id: 'gtts-widget', role: 'region', 'aria-label': 'Gemini Reader' });

    const playBtn = iconButton('gtts-play', 'Pause', ICONS.pause, () => {
      session.paused = !session.paused;
      send(session, { type: session.paused ? 'pause' : 'play' });
      setPlayIcon(session);
    });
    const slower = iconButton('gtts-small', 'Slower', ICONS.minus, () => changeSpeed(session, -1));
    const speedLabel = h('span', { class: 'gtts-speed' });
    const faster = iconButton('gtts-small', 'Faster', ICONS.plus, () => changeSpeed(session, 1));
    const status = h('span', { class: 'gtts-status' });
    const closeBtn = iconButton('gtts-small', 'Stop reading', ICONS.close, () => {
      send(session, { type: 'cancel' });
      teardown();
    });

    const speedGroup = h('div', { class: 'gtts-speed-group' });
    speedGroup.append(slower, speedLabel, faster);
    widget.append(playBtn, speedGroup, status, closeBtn);
    document.documentElement.append(widget);

    Object.assign(session, { playBtn, speedLabel, status });
    speedLabel.textContent = formatSpeed(session.speed);
    return widget;
  }

  function updateWidget(session, loading) {
    setPlayIcon(session);
    if (loading) {
      session.status.classList.remove('gtts-error');
      session.status.textContent = 'Loading…';
    }
  }

  // Elapsed / estimated-total time, e.g. "1:32 / 8:47". The total is a moving estimate:
  // it sharpens once real chunk durations come in, and updates live if speed changes.
  function updateTimer(session, elapsedSec, remainingSec) {
    session.status.classList.remove('gtts-error');
    session.status.textContent = `${formatTime(elapsedSec)} / ${formatTime(elapsedSec + remainingSec)}`;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : m;
    return (h > 0 ? `${h}:${mm}` : `${mm}`) + `:${String(s).padStart(2, '0')}`;
  }

  function setPlayIcon(session) {
    const label = session.paused ? 'Play' : 'Pause';
    session.playBtn.title = label;
    session.playBtn.setAttribute('aria-label', label);
    session.playBtn.firstChild.firstChild.setAttribute('d', session.paused ? ICONS.play : ICONS.pause);
  }

  function changeSpeed(session, direction) {
    const nearest = SPEEDS.reduce((best, s, i) => (Math.abs(s - session.speed) < Math.abs(SPEEDS[best] - session.speed) ? i : best), 0);
    session.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, nearest + direction))];
    session.speedLabel.textContent = formatSpeed(session.speed);
    send(session, { type: 'speed', value: session.speed });
  }

  function send(session, msg) {
    try {
      session.port.postMessage(msg);
    } catch {
      // background side already closed
    }
  }

  function formatSpeed(speed) {
    return `${speed}×`;
  }

  function showError(session, message) {
    session.status.textContent = message;
    session.status.title = message;
    session.status.classList.add('gtts-error');
    session.playBtn.disabled = true;
  }

  function showNotice(message) {
    const widget = h('div', { id: 'gtts-widget', role: 'status' });
    const status = h('span', { class: 'gtts-status' });
    status.textContent = message;
    widget.append(status, iconButton('gtts-small', 'Close', ICONS.close, () => widget.remove()));
    document.documentElement.append(widget);
    setTimeout(() => widget.remove(), 4000);
  }

  function teardown() {
    const session = current;
    current = null;
    document.querySelectorAll('#gtts-widget').forEach((w) => w.remove());
    clearHighlights();
    if (session) {
      try {
        session.port.disconnect();
      } catch {
        // already closed
      }
    }
  }

  function iconButton(className, label, path, onClick) {
    const btn = h('button', { type: 'button', class: className, title: label, 'aria-label': label });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    btn.append(svg);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
})();

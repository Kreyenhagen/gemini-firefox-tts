(() => {
  'use strict';

  // Injected on every menu click; only set up once per frame.
  if (window.__geminiReader) return;
  window.__geminiReader = true;

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
  const ALWAYS_SKIP = 'script, style, noscript, template, svg, math, iframe, canvas, video, audio, select, textarea, input, #gtts-widget';
  const ARTICLE_SKIP = `${ALWAYS_SKIP}, nav, aside, footer, form, button, figure, pre, sup, [aria-hidden="true"],
    [role="navigation"], [role="complementary"], [role="contentinfo"], [role="button"],
    [data-ad-slot], [data-ad-unit], [data-google-query-id],
    .sr-only, .visually-hidden, .screen-reader-text`;
  // Words in a class/id/aria-label that mark ads, related-article strips, comments, share bars…
  const JUNK_NAME = / (ads?|adverts?|advertis\w*|adsbygoogle|dfp|sponsor\w*|promo\w*|related|recommend\w*|recirc|taboola|outbrain|revcontent|mgid|zergnet|newsletter|subscribe|signup|shar(e|ing)|social|comments?|trending|popular|most read|read (next|more)|sidebar|widget) /;
  // A heading or line that is only one of these labels (lowercased, trailing punctuation dropped).
  const JUNK_LABEL = /^(ads?|advertisements?|sponsored( (content|links|stories|by .+))?|promoted( (content|stories))?|paid (content|post)|story continues (below|after) advertisement|(continue|keep) reading( below)?|scroll to continue( reading)?|skip advertisement|(from )?around the web|related( (articles?|stories|posts?|content|coverage|links|topics|news))?|recommended( (for you|articles?|stories|posts?))?|you (may|might) (also )?(like|enjoy|be interested in)|more (stories|articles|posts|news)( from .+)?|read (next|more|also)|up next|trending( (now|posts|stories|articles))?|(most )?popular( (now|posts|stories|articles))?|most read|latest (news|stories|articles|posts)|(leave a )?(comment|reply)s?( \(\d+\))?|\d+ (comments?|replies)|share( this( article| story| post)?)?|subscribe( now)?|newsletter|sign up( now)?)$/;
  // A line that opens with an inline pointer to another article, e.g. "Also read: …".
  const PROMO_LEAD = /^(also read|read also|related|read more|see also|read next|recommended)\s*[:\-–—]/;
  const HEADING = 'h1, h2, h3, h4, h5, h6';
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

  function start({ mode, targetElementId, speed, autoScroll, minWords, maxWords }) {
    const range = mode === 'selection' ? selectionRange() : fromHereRange(targetElementId);
    teardown();
    if (!range) {
      showNotice('Highlight some text first.');
      return;
    }
    const paras = collectParagraphs(range, mode === 'from-here');
    const chunks = buildChunks(paras, minWords, maxWords);
    if (!chunks.length) {
      showNotice('No readable text found here.');
      return;
    }
    window.getSelection().removeAllRanges();

    const port = browser.runtime.connect({ name: 'gtts' });
    const session = {
      port, chunks, speed, autoScroll,
      paused: false, loading: true, time: null, chunkIndex: -1, ranges: [], widget: null,
    };
    current = session;
    session.widget = createWidget(session);
    port.onMessage.addListener((msg) => onPortMessage(session, msg));
    port.onDisconnect.addListener(() => { if (current === session) teardown(); });
    port.postMessage({
      type: 'load',
      speed,
      chunks: chunks.map((c) => ({
        text: c.sentences.map((s, i) => (i === 0 ? '' : s.paraBreak ? '\n\n' : ' ') + s.text).join(''),
        weights: c.sentences.map((s) => s.text.length),
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
  // `article` is true for "read from here": skip page furniture and start on a word boundary.
  function collectParagraphs(range, article) {
    const container = range.commonAncestorContainer;
    const rootEl = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const skipSelector = article ? ARTICLE_SKIP : ALWAYS_SKIP;
    const isFurniture = article && furnitureTest(rootEl, range.startContainer);
    const blockCache = new Map();
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (n.matches(skipSelector) || !n.checkVisibility({ visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
      if (isFurniture && isFurniture(n)) return NodeFilter.FILTER_REJECT;
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
    if (article && paras.length) {
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
    return paras.filter((p) => p.sentences.length && !(article && isLabelLine(p.text)));
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

  // ---------- page furniture ----------
  // Best-effort guesses at ads, related-article strips, comments and share bars inside
  // the article. They fail open: a block is never skipped if it holds the point reading
  // starts from, or makes up half or more of the article's text.

  function furnitureTest(root, startNode) {
    const rootLength = root.textContent.length;
    return (el) => (hasJunkName(el) || startsWithJunkHeading(el) || isLinkBlock(el))
      && !el.contains(startNode)
      && el.textContent.length < rootLength / 2;
  }

  function hasJunkName(el) {
    const words = ['class', 'id', 'aria-label', 'data-testid', 'data-component']
      .map((name) => el.getAttribute(name) || '')
      .join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ');
    return JUNK_NAME.test(` ${words} `);
  }

  // A heading like "Related articles", or a wrapper whose first text is one.
  function startsWithJunkHeading(el) {
    const heading = el.matches(HEADING) ? el : el.querySelector(HEADING);
    if (!heading) return false;
    const title = normalize(heading.textContent);
    return JUNK_LABEL.test(title) && (heading === el || normalize(el.textContent).startsWith(title));
  }

  // Lists and card grids that are almost all links: related stories, tables of contents.
  function isLinkBlock(el) {
    if (!/^(ul|ol|div|section)$/.test(el.localName)) return false;
    const links = el.querySelectorAll('a');
    if (links.length < 3) return false;
    let linked = 0;
    for (const a of links) linked += textSize(a);
    return linked >= 0.7 * textSize(el);
  }

  function isLabelLine(text) {
    const line = normalize(text);
    return JUNK_LABEL.test(line) || PROMO_LEAD.test(line);
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s:.\-–—|•·]+$/, '');
  }

  function textSize(el) {
    return el.textContent.replace(/\s/g, '').length;
  }

  // ---------- chunking ----------
  // A chunk (one TTS request) ends at a paragraph break once it has at least minWords,
  // and never exceeds maxWords: if the next sentence would overflow, the chunk ends at
  // the previous sentence. A single sentence longer than maxWords is split by words.

  function buildChunks(paras, minWords, maxWords) {
    const chunks = [];
    let chunk = null;
    for (const p of paras) {
      p.sentences.forEach((sentence, si) => {
        const pieces = sentence.words > maxWords ? splitSentence(sentence, maxWords) : [sentence];
        pieces.forEach((piece, pi) => {
          const startsPara = si === 0 && pi === 0;
          if (chunk && ((startsPara && chunk.words >= minWords) || chunk.words + piece.words > maxWords)) {
            chunks.push(chunk);
            chunk = null;
          }
          chunk ??= { sentences: [], words: 0 };
          chunk.sentences.push({ ...piece, paraBreak: startsPara && chunk.sentences.length > 0 });
          chunk.words += piece.words;
        });
      });
    }
    if (chunk) chunks.push(chunk);
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
        highlightSentence(session, 0);
        session.paused = msg.paused;
        updateWidget(session, msg.loading);
        break;
      case 'state':
        session.paused = msg.paused;
        updateWidget(session, msg.loading);
        break;
      case 'progress':
        if (msg.chunk === session.chunkIndex) highlightSentence(session, msg.sentence);
        break;
      case 'time':
        session.time = msg;
        if (!session.loading) renderStatus(session);
        break;
      case 'autoScroll':
        session.autoScroll = msg.value;
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

  function showChunk(session, index) {
    session.chunkIndex = index;
    session.ranges = session.chunks[index].sentences.map(makeRange).filter(Boolean);
    setHighlight('gtts-chunk', session.ranges);
  }

  function highlightSentence(session, i) {
    const range = session.ranges[i];
    if (!range) return;
    setHighlight('gtts-sentence', [range]);
    if (session.autoScroll) scrollIntoViewIfNeeded(range);
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
      CSS.highlights.delete('gtts-chunk');
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
    session.loading = loading;
    renderStatus(session);
  }

  function renderStatus(session) {
    session.status.classList.remove('gtts-error');
    session.status.title = session.loading ? '' : 'Elapsed / estimated total time';
    session.status.textContent = session.loading ? 'Loading…' : formatTimer(session.time);
  }

  // "1:32 / 8:47". The total is an estimate ("~") until every chunk has been fetched,
  // and it follows speed changes.
  function formatTimer(time) {
    if (!time) return '';
    return `${formatTime(time.elapsed)} / ${time.exact ? '' : '~'}${formatTime(time.total)}`;
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
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

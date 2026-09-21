'use strict';

// Gemini TTS prebuilt voices with Google's one-word descriptions.
const VOICES = [
  ['Achernar', 'Soft'], ['Achird', 'Friendly'], ['Algenib', 'Gravelly'], ['Algieba', 'Smooth'],
  ['Alnilam', 'Firm'], ['Aoede', 'Breezy'], ['Autonoe', 'Bright'], ['Callirrhoe', 'Easy-going'],
  ['Charon', 'Informative'], ['Despina', 'Smooth'], ['Enceladus', 'Breathy'], ['Erinome', 'Clear'],
  ['Fenrir', 'Excitable'], ['Gacrux', 'Mature'], ['Iapetus', 'Clear'], ['Kore', 'Firm'],
  ['Laomedeia', 'Upbeat'], ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Puck', 'Upbeat'],
  ['Pulcherrima', 'Forward'], ['Rasalgethi', 'Informative'], ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'], ['Schedar', 'Even'], ['Sulafat', 'Warm'], ['Umbriel', 'Easy-going'],
  ['Vindemiatrix', 'Gentle'], ['Zephyr', 'Bright'], ['Zubenelgenubi', 'Casual'],
];

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let statusTimer;

for (const [name, desc] of VOICES) $('voice').add(new Option(`${name} (${desc})`, name));
for (const s of SPEEDS) $('speed').add(new Option(`${s}×`, String(s)));

browser.storage.local.get(DEFAULTS).then((s) => {
  $('apiKey').value = s.apiKey;
  $('voice').value = s.voice;
  $('speed').value = String(s.speed);
  $('maxWords').value = s.maxWords;
});

$('apiKey').addEventListener('change', () => save({ apiKey: $('apiKey').value.trim() }));
$('voice').addEventListener('change', () => save({ voice: $('voice').value }));
$('speed').addEventListener('change', () => save({ speed: Number($('speed').value) }));
$('maxWords').addEventListener('change', () => {
  const max = Number($('maxWords').value);
  if (!Number.isInteger(max) || max < 1 || max > 20000) {
    showStatus('Max words must be a whole number from 1 to 20000.', true);
    return;
  }
  save({ maxWords: max });
});

function save(values) {
  browser.storage.local.set(values).then(
    () => showStatus('Saved'),
    (err) => showStatus(`Couldn't save: ${err.message}`, true),
  );
}

function showStatus(text, isError = false) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  if (!isError) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

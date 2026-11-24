// Macaron: unlocks the library with the passcode, shows each episode's words, plays Tom's clips.
// The lock must match tools/build.py and Dual Subs' macaron.js: PBKDF2-SHA256, 600 000 rounds, 512 bits,
// the first 256 as the AES-GCM key; a locked file is a 12-byte IV followed by the ciphertext.
'use strict';

const LOCK = { salt: 'macaron/v1/atomixninja', iterations: 600000 };
const KEY_STORE = 'macaron:key';      // the AES key made from the passcode (never the passcode itself)
const HEARD_STORE = 'macaron:heard';  // words whose clip has been played, for the progress line
const TAB_STORE = 'macaron:episode';  // the episode last opened
const TYPES = [['verb', 'Verbes'], ['adj', 'Adjectifs'], ['noun', 'Noms'], ['other', 'Autres mots']];
const TAG_COLOURS = [['#6e5b9a', '#c3b6dc'], ['#5f7e9c', '#a9bccd'], ['#a8778c', '#d2b5c1'], ['#6f8f62', '#b7c9ad']];
const DOT = { verb: '#6e5b9a', adj: '#5f7e9c', noun: '#a8778c', other: '#6f8f62' };

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false && c !== 0 && c !== ''));
  return node;
};
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  drop(key) { try { localStorage.removeItem(key); } catch {} },
};

// ---------- Lock ----------

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function keyFromPasscode(passcode) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(LOCK.salt), iterations: LOCK.iterations }, base, 512);
  return b64(bits.slice(0, 32));
}

let aesKey = null;
const useKey = async text => { aesKey = await crypto.subtle.importKey('raw', unb64(text), 'AES-GCM', false, ['decrypt']); };

async function openLocked(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw Object.assign(new Error(`${url}: ${res.status}`), { status: res.status });
  const blob = new Uint8Array(await res.arrayBuffer());
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, aesKey, blob.slice(12));
}

async function loadLibrary() {
  try {
    return JSON.parse(new TextDecoder().decode(await openLocked('data/library.enc')));
  } catch (e) {
    if (e.status === 404) return { episodes: [] }; // nothing sent yet
    throw e;
  }
}

// ---------- Greeting ----------

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Bonne nuit.' : h < 18 ? 'Bonjour.' : 'Bonsoir.';
}

// ---------- Audio ----------
// One audio element, unlocked by the first touch, so clips can start after they've been decrypted (iOS).

const player = new Audio();
player.preload = 'auto';
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let unlocked = false;
addEventListener('pointerdown', () => {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => {});
}, { once: false, capture: true });

const clipUrls = new Map(); // clip name -> promise of an object URL
function clipUrl(name) {
  if (!clipUrls.has(name)) {
    clipUrls.set(name, openLocked(`data/clips/${name}.enc`)
      .then(data => URL.createObjectURL(new Blob([data], { type: 'audio/mp4' })))
      .catch(e => { clipUrls.delete(name); throw e; }));
  }
  return clipUrls.get(name);
}

let playingButton = null;
async function play(name, button, onPlayed) {
  if (!name) return;
  playingButton?.classList.remove('playing');
  playingButton = button;
  button?.classList.add('playing');
  try {
    player.src = await clipUrl(name);
    await player.play();
    onPlayed?.();
  } catch {
    button?.classList.remove('playing');
  }
}
player.addEventListener('ended', () => playingButton?.classList.remove('playing'));
player.addEventListener('pause', () => playingButton?.classList.remove('playing'));

const speaker = size => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M4 9v6h4l5 4V5L8 9z M16 8.5a5 5 0 0 1 0 7 M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
};

// ---------- Home ----------

let library = { episodes: [] };
let heard = new Set(store.get(HEARD_STORE, []));
const heardKey = (ep, w) => `${ep.id}|${w.word}`;

function showStats() {
  const words = library.episodes.reduce((n, e) => n + e.words.length, 0);
  const eps = library.episodes.length;
  const listened = library.episodes.reduce((n, e) => n + e.words.filter(w => heard.has(heardKey(e, w))).length, 0);
  $('stats').replaceChildren(
    el('b', { textContent: `${words} ${words === 1 ? 'word' : 'words'}` }), ' from ',
    el('b', { textContent: `${eps} ${eps === 1 ? 'episode' : 'episodes'}` }), ` · ${listened} listened to`);
}

function episodeLabel(ep) {
  const n = ep.season && ep.episode ? `S${ep.season} E${ep.episode}` : ep.episode ? `E${ep.episode}` : '';
  return [ep.show, n].filter(Boolean).join(' · ');
}

function showTabs(current) {
  $('tags').replaceChildren(...library.episodes.map((ep, i) => {
    const [colour, line] = TAG_COLOURS[i % TAG_COLOURS.length];
    const tag = el('button', { type: 'button', className: 'tag', textContent: episodeLabel(ep) });
    tag.style.setProperty('--tag', colour);
    tag.style.setProperty('--tag-line', line);
    tag.setAttribute('aria-pressed', String(ep.id === current.id));
    tag.addEventListener('click', () => showEpisode(ep));
    return tag;
  }));
  $('tags').querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function wordItem(ep, w) {
  const li = el('li', { className: 'w' });
  li.classList.toggle('heard', heard.has(heardKey(ep, w)));
  const markHeard = () => {
    heard.add(heardKey(ep, w));
    store.set(HEARD_STORE, [...heard]);
    li.classList.add('heard');
    showStats();
  };

  const row = el('button', { type: 'button', className: 'row' },
    el('span', { className: 'fr', lang: 'fr', textContent: w.word }),
    el('span', { className: 'en', textContent: w.translations?.en || '' }),
    el('span', { className: 'heard-dot' }),
    el('span', { className: 'n', textContent: w.count ? `×${w.count}` : '' }));
  row.setAttribute('aria-expanded', 'false');
  const big = el('button', { type: 'button', className: 'play', ariaLabel: `Écouter « ${w.word} »` }, speaker(22));
  big.addEventListener('click', () => play(w.clip, big, markHeard));

  const s = w.sentence;
  const forms = (w.heard ?? []).filter(f => f !== w.word);
  const more = el('div', { className: 'more' },
    w.translations?.en && el('p', { className: 'tr', textContent: w.translations.en }),
    w.translations?.ar && el('p', { className: 'tr', lang: 'ar', dir: 'rtl', textContent: w.translations.ar }),
    w.count && el('p', { className: 'forms' }, `Heard ${w.count} ${w.count === 1 ? 'time' : 'times'}`,
      ...(forms.length ? [' as ', ...forms.flatMap((f, i) => [i ? ', ' : '', el('em', { lang: 'fr', textContent: f })])] : [])),
    s ? (() => {
      const small = el('button', { type: 'button', className: 'play small', ariaLabel: 'Écouter la phrase' }, speaker(18));
      small.addEventListener('click', () => play(w.sentenceClip, small));
      return el('div', { className: 'ex' },
        el('div', {},
          el('p', { className: 'fr-s', lang: 'fr', textContent: s.fr }),
          s.en && el('p', { className: 'en-s', textContent: s.en }),
          el('p', { className: 'src' }, el('a', { href: `https://tatoeba.org/en/sentences/show/${encodeURIComponent(s.id)}`, target: '_blank', rel: 'noopener', textContent: 'Sentence from Tatoeba' }))),
        small);
    })() : el('p', { className: 'no-ex', textContent: 'No simple example found for this word yet.' }));

  li.append(el('div', { className: 'head' }, row, big), el('div', { className: 'fold' }, el('div', {}, more)));

  row.addEventListener('click', () => {
    const open = !li.classList.contains('open');
    document.querySelectorAll('.w.open').forEach(o => {
      o.classList.remove('open');
      o.querySelector('.row').setAttribute('aria-expanded', 'false');
    });
    if (!open) return;
    li.classList.add('open');
    row.setAttribute('aria-expanded', 'true');
    play(w.clip, big, markHeard);           // Tom says the word as it opens
    if (w.sentenceClip) clipUrl(w.sentenceClip).catch(() => {}); // and the sentence is ready to play
    setTimeout(() => {
      const r = li.getBoundingClientRect();
      if (r.bottom > innerHeight) li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 380);
  });
  return li;
}

function showEpisode(ep) {
  store.set(TAB_STORE, ep.id);
  showTabs(ep);
  const numbers = [ep.season && `Saison ${ep.season}`, ep.episode && `Épisode ${ep.episode}`].filter(Boolean).join(' · ');
  $('ep').replaceChildren(
    el('div', { className: 'kicker', textContent: numbers || ep.show }),
    el('h2', { className: 'serif', textContent: ep.title || ep.show }));
  $('words').replaceChildren(...TYPES.flatMap(([type, label]) => {
    const list = ep.words.filter(w => (w.type || 'other') === type).sort((a, b) => (b.count || 0) - (a.count || 0));
    if (!list.length) return [];
    const h3 = el('h3', {}, el('i'), `${label} · ${list.length}`);
    h3.style.setProperty('--dot', DOT[type]);
    return [h3, el('ol', { className: 'words' }, ...list.map(w => wordItem(ep, w)))];
  }));
}

// Fetch every clip once in the background, so the words work offline (the service worker keeps them).
async function warmClips() {
  const names = library.episodes.flatMap(e => e.words.flatMap(w => [w.clip, w.sentenceClip])).filter(Boolean);
  for (const name of names) {
    await fetch(`data/clips/${name}.enc`).catch(() => {});
  }
}

function showHome() {
  document.body.classList.remove('is-locked');
  $('lock').hidden = true;
  $('home').hidden = false;
  $('scene').setAttribute('preserveAspectRatio', 'xMidYMax slice');
  $('hello').textContent = greeting();
  showStats();
  const eps = library.episodes;
  $('empty').hidden = eps.length > 0;
  if (eps.length) showEpisode(eps.find(e => e.id === store.get(TAB_STORE)) ?? eps[0]);
  if ('requestIdleCallback' in window) requestIdleCallback(warmClips); else setTimeout(warmClips, 2000);
}

function showLock(message = '') {
  document.body.classList.add('is-locked');
  $('home').hidden = true;
  $('lock').hidden = false;
  $('scene').setAttribute('preserveAspectRatio', 'xMaxYMax slice');
  $('lock-hello').textContent = greeting();
  $('lock-msg').textContent = message;
}

$('lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const passcode = $('passcode').value;
  if (!passcode) return;
  $('enter').disabled = true;
  $('lock-msg').textContent = 'Un instant…';
  try {
    const key = await keyFromPasscode(passcode);
    await useKey(key);
    library = await loadLibrary();
    store.set(KEY_STORE, key);
    $('passcode').value = '';
    showHome();
  } catch (err) {
    aesKey = null;
    const wrong = err.name === 'OperationError';
    $('lock-msg').textContent = wrong ? "Ce n'est pas le bon mot de passe." : "Impossible d'ouvrir tes mots. Vérifie la connexion.";
    $('lock-form').classList.remove('shake');
    void $('lock-form').offsetWidth;
    $('lock-form').classList.add('shake');
  } finally {
    $('enter').disabled = false;
  }
});

$('lock-again').addEventListener('click', () => {
  store.drop(KEY_STORE);
  aesKey = null;
  library = { episodes: [] };
  showLock();
  scrollTo(0, 0);
});

// ---------- Start ----------

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const saved = store.get(KEY_STORE);
  if (!saved) return showLock();
  try {
    await useKey(saved);
    library = await loadLibrary();
    showHome();
  } catch (err) {
    if (err.name === 'OperationError') store.drop(KEY_STORE); // passcode changed: ask again
    showLock(err.name === 'OperationError' ? '' : "Impossible d'ouvrir tes mots. Vérifie la connexion.");
  }
})();

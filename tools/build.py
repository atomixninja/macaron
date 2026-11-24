#!/usr/bin/env python3
"""Macaron builder: turns the word lists Dual Subs sends into the site's locked data.

For every list waiting in inbox/ (sent, locked, by the "Send to my website" button):
  1. unlock it with the passcode,
  2. find a short, simple Tatoeba sentence for each word (with its English translation when there is one),
  3. record Tom (Piper fr_FR-tom-medium) saying the word and the sentence,
  4. lock everything again and add or update the episode in site/data/library.enc,
  5. empty the inbox and remove clips nothing uses any more.

Everything under site/data is locked with AES-GCM; the key comes from the passcode (PBKDF2-SHA256).
The same scheme is used by the site (app.js) and by Dual Subs (vocab.js): keep LOCK in step with them.

  MACARON_PASSCODE=… python tools/build.py --cache <folder with Tatoeba files and Tom's voice>
  MACARON_PASSCODE=… python tools/build.py seal list.json     # lock a list by hand (for tests)
"""
import argparse, bz2, hashlib, hmac, io, json, math, os, re, subprocess, sys, tempfile, unicodedata, wave
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INBOX = ROOT / 'inbox'
DATA = ROOT / 'site' / 'data'
CLIPS = DATA / 'clips'
LIBRARY = DATA / 'library.enc'

# The lock. Must match app.js and Dual Subs' vocab.js.
LOCK = {'salt': b'macaron/v1/atomixninja', 'iterations': 600_000}
VOICE = 'fr_FR-tom-medium'
VOICE_TAG = 'tom-medium/1'  # change to re-record every clip

# Clip settings, the same as Blobby's: ≤ 50 ms before, ≤ 150 ms after, about −16 LUFS, true peak below −1 dBTP.
LEAD, TAIL, TARGET_LUFS, PEAK_DB = 0.05, 0.15, -16.0, -1.0
WORDS_MAX = 80


# ---------- Lock ----------

def keys(passcode):
    raw = hashlib.pbkdf2_hmac('sha256', unicodedata.normalize('NFC', passcode).encode(), LOCK['salt'], LOCK['iterations'], 64)
    return raw[:32], raw[32:]  # AES-GCM key, key for naming clip files


def lock(key, data):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    return iv + AESGCM(key).encrypt(iv, data, None)


def unlock(key, blob):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(key).decrypt(blob[:12], blob[12:], None)


def clip_name(name_key, text):
    # Named from the text with a secret key, so the same clip is reused but file names give nothing away.
    return hmac.new(name_key, f'{VOICE_TAG}|{text}'.encode(), 'sha256').hexdigest()[:24]


# ---------- Tatoeba ----------

TOKEN = re.compile(r"[a-zàâäçéèêëîïôöùûüÿœæ]+")
tokens = lambda s: TOKEN.findall(s.lower().replace('’', "'"))


def read_tsv(path):
    with bz2.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) >= 3:
                yield parts


class Sentences:
    """Finds a short, everyday French sentence for a word, with an English translation when Tatoeba has one."""

    def __init__(self, cache, wanted):
        print('Reading Tatoeba…', flush=True)
        self.freq = Counter()
        self.by_form = defaultdict(list)  # form -> [(id, text, n_tokens)]
        for sid, _, text in read_tsv(cache / 'fra_sentences.tsv.bz2'):
            toks = tokens(text)
            self.freq.update(toks)
            if 3 <= len(toks) <= 10 and len(text) <= 70 and text[-1] in '.!?' and not re.search(r'[\d"«»()\[\]/:;]', text):
                for form in wanted.intersection(toks):
                    self.by_form[form].append((int(sid), text, toks))
        self.total = sum(self.freq.values())
        needed = {sid for found in self.by_form.values() for sid, _, _ in found}
        links = defaultdict(list)
        with bz2.open(cache / 'fra-eng_links.tsv.bz2', 'rt') as f:
            for line in f:
                fra, eng = line.split()
                if int(fra) in needed:
                    links[int(fra)].append(int(eng))
        eng_ids = {e for es in links.values() for e in es}
        english = {int(sid): text for sid, _, text in read_tsv(cache / 'eng_sentences.tsv.bz2') if int(sid) in eng_ids}
        self.english = {fra: min((english[e] for e in es if e in english), key=len, default=None) for fra, es in links.items()}

    def rarity(self, tok):
        return -math.log10((self.freq[tok] + 1) / self.total)

    def find(self, forms):
        seen, best = set(), None
        for form in forms:
            for sid, text, toks in self.by_form.get(form, []):
                if sid in seen:
                    continue
                seen.add(sid)
                others = [t for t in toks if t not in forms] or toks
                score = (0 if self.english.get(sid) else 4) + 0.5 * abs(len(toks) - 6) + 1.5 * max(map(self.rarity, others))
                if best is None or (score, sid) < best[0]:
                    best = ((score, sid), {'fr': text, 'en': self.english.get(sid), 'id': sid})
        return best and best[1]


# ---------- Voice ----------

class Tom:
    def __init__(self, model):
        from piper import PiperVoice
        self.voice = PiperVoice.load(str(model))

    def record(self, text):
        """Tom says the text; returns a mono AAC .m4a, trimmed and levelled like Blobby's clips."""
        import numpy as np, pyloudnorm
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            self.voice.synthesize_wav(text, w)
        buf.seek(0)
        with wave.open(buf, 'rb') as w:
            rate = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768

        loud = np.flatnonzero(np.abs(x) > 10 ** (-40 / 20))
        if len(loud):
            x = x[max(0, loud[0] - int(LEAD * rate)): loud[-1] + int(TAIL * rate)]

        padded = np.concatenate([x, np.zeros(max(0, int(0.5 * rate) - len(x)))])  # the meter needs 0.4 s at least
        lufs = pyloudnorm.Meter(rate).integrated_loudness(padded)
        gain = 10 ** ((TARGET_LUFS - lufs) / 20) if math.isfinite(lufs) else 1.0
        pcm = (x * gain).astype('<f4').tobytes()  # may go over full scale: the limiter below brings the peaks down

        # Limiter a little under the peak ceiling, at 4× the rate so peaks between samples are caught too,
        # leaving room for the small overshoot AAC adds.
        ceiling = 10 ** ((PEAK_DB - 1.5) / 20)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'clip.m4a'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(rate), '-ac', '1', '-i', '-',
                            '-af', f'aresample={rate * 4},alimiter=limit={ceiling:.4f}:attack=1:release=40:level=false,aresample={rate}',
                            '-c:a', 'aac', '-b:a', '80k', '-movflags', '+faststart', str(out)], input=pcm, check=True)
            return out.read_bytes()


# ---------- Lists ----------

def clean(text, limit=200):
    return str(text or '').strip()[:limit]


def read_list(raw):
    """The list Dual Subs sends, checked and trimmed to what the site uses."""
    data = json.loads(raw)
    if data.get('format') != 1 or not re.fullmatch(r'\d{1,12}', str(data.get('id', ''))):
        raise ValueError('not a Dual Subs list')
    words = []
    for w in data.get('words', [])[:WORDS_MAX]:
        word = clean(w.get('word'), 40).lower()
        if not TOKEN.fullmatch(word):
            continue
        forms = [f for f in (clean(f, 40).lower() for f in w.get('forms', [])) if TOKEN.fullmatch(f)]
        words.append({
            'word': word,
            'type': w.get('type') if w.get('type') in ('verb', 'adj', 'noun') else 'other',
            'count': int(w.get('count') or 0),
            'forms': sorted(set(forms) | {word}),
            'translations': {l: clean(t, 80) for l, t in (w.get('translations') or {}).items() if l in ('en', 'ar')},
        })
    return {
        'id': str(data['id']),
        'show': clean(data.get('show'), 120) or 'Episode',
        'season': data.get('season') if isinstance(data.get('season'), int) else None,
        'episode': data.get('episode') if isinstance(data.get('episode'), int) else None,
        'title': clean(data.get('title'), 160),
        'url': clean(data.get('url'), 300) if str(data.get('url', '')).startswith('https://www.france.tv/') else None,
        'words': words,
    }


def build(passcode, cache, model):
    key, name_key = keys(passcode)
    waiting = sorted(INBOX.glob('*.enc'))
    if not waiting:
        print('Inbox empty: nothing to do.')
        return
    library = json.loads(unlock(key, LIBRARY.read_bytes())) if LIBRARY.exists() else {'version': 1, 'episodes': []}

    lists = []
    for path in waiting:
        try:
            lists.append(read_list(unlock(key, path.read_bytes())))
        except Exception as e:  # wrong passcode or not a list: leave a note in the log and drop it
            print(f'Skipped {path.name}: {type(e).__name__} {e}', file=sys.stderr)

    sentences = Sentences(cache, {f for l in lists for w in l['words'] for f in w['forms']})
    tom = Tom(model)
    CLIPS.mkdir(parents=True, exist_ok=True)

    def clip(text):
        name = clip_name(name_key, text)
        path = CLIPS / f'{name}.enc'
        if not path.exists():
            path.write_bytes(lock(key, tom.record(text)))
        return name

    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    for ep in lists:
        print(f"{ep['show']} S{ep['season']}E{ep['episode']} ({ep['id']}): {len(ep['words'])} words", flush=True)
        for w in ep['words']:
            w['sentence'] = sentences.find(set(w['forms']))
            w['clip'] = clip(w['word'][0].upper() + w['word'][1:] + '.')
            w['sentenceClip'] = clip(w['sentence']['fr']) if w['sentence'] else None
            w['heard'] = [f for f in w.pop('forms') if f != w['word']]  # the forms heard in the episode
        old = next((e for e in library['episodes'] if e['id'] == ep['id']), None)
        ep['added'] = old['added'] if old else now
        ep['updated'] = now
        library['episodes'] = [e for e in library['episodes'] if e['id'] != ep['id']] + [ep]

    library['episodes'].sort(key=lambda e: e['added'], reverse=True)
    LIBRARY.write_bytes(lock(key, json.dumps(library, ensure_ascii=False, separators=(',', ':')).encode()))

    used = {c for e in library['episodes'] for w in e['words'] for c in (w['clip'], w['sentenceClip']) if c}
    for path in CLIPS.glob('*.enc'):
        if path.stem not in used:
            path.unlink()
    for path in waiting:
        path.unlink()
    print(f"Library: {len(library['episodes'])} episodes, {len(used)} clips.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', nargs='?', default='build', choices=['build', 'seal', 'open'])
    ap.add_argument('file', nargs='?')
    ap.add_argument('--cache', type=Path, default=ROOT / '.cache')
    ap.add_argument('--model', type=Path)
    args = ap.parse_args()
    passcode = os.environ.get('MACARON_PASSCODE')
    if not passcode:
        sys.exit('MACARON_PASSCODE is not set.')
    if args.command == 'seal':  # lock a list the way Dual Subs does, into inbox/
        INBOX.mkdir(exist_ok=True)
        out = INBOX / f'{Path(args.file).stem}.enc'
        out.write_bytes(lock(keys(passcode)[0], Path(args.file).read_bytes()))
        print(out)
    elif args.command == 'open':  # print the unlocked library (for checks)
        print(json.dumps(json.loads(unlock(keys(passcode)[0], LIBRARY.read_bytes())), ensure_ascii=False, indent=1))
    else:
        build(passcode, args.cache, args.model or args.cache / f'{VOICE}.onnx')


if __name__ == '__main__':
    main()

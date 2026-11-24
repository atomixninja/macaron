# Macaron

A private word site: each episode's words from [Dual Subs](https://github.com/atomixninja/dual-subs), with a
simple example sentence and a voice clip of each. Everything under `site/data` is encrypted (AES-GCM, key
from a passcode with PBKDF2-SHA256); the page asks for the passcode and decrypts in the browser.

## How a list becomes a tab

1. Dual Subs' **Send to my website** button locks the episode's word list with the passcode and puts it in
   `inbox/` through the GitHub API.
2. That push runs `.github/workflows/build.yml`, which runs `tools/build.py`: it finds a short Tatoeba sentence
   for each word, records the word and the sentence with Piper's `fr_FR-tom-medium` voice, locks everything,
   adds the episode to `site/data/library.enc`, and empties the inbox.
3. The same run publishes `site/` to GitHub Pages.

The passcode is the repository secret `MACARON_PASSCODE`; it is never stored in the repository.

To try the builder locally (Python ≤ 3.14, ffmpeg, the files the workflow downloads in a folder):

    MACARON_PASSCODE=… python tools/build.py seal list.json
    MACARON_PASSCODE=… python tools/build.py --cache <folder>
    MACARON_PASSCODE=… python tools/build.py open

## Credits

- Example sentences and their English translations: [Tatoeba](https://tatoeba.org) (CC BY 2.0 FR); each
  sentence links back to its page there.
- Voice: Piper voice [fr_FR-tom-medium](https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR/tom/medium)
  (dataset AGPLv3, https://git.bksp.space/Tjiho/French-tts-model-piper).

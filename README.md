# Yetkin's Audio Slicer

A browser-based audio tool that detects transients, slices audio into segments, and lets you rearrange, shuffle, and reconstruct sound in creative ways. Playable with your QWERTY keyboard or a MIDI controller.

**Live demo:** [yetkinozturk.github.io/audioslicer](https://yetkinozturk.github.io/audioslicer/)

## Features

- **Transient detection** — analyzes audio energy to find slice points automatically
- **9 presets** — from Micro Glitch (tiny granular fragments) to Stems (intro/verse/chorus/outro)
- **5 rearrangement modes:**
  - **Shuffle** — randomize all slices
  - **Sort** — order by energy, loudest or quietest first
  - **Groove** — cycle through energy bands for repeating patterns
  - **Spice** — swap similar-sounding transients (kicks with kicks, snares with snares)
  - **Shredder** — swap adjacent blocks like vertical blinds
- **Playable keyboard** — QWERTY keys Q through M trigger individual slices
- **MIDI support** — connect a MIDI controller, notes from C2 map to slices
- **Hover preview** — hover over slice chips to audition them
- **WAV export** — download your rearranged audio
- **Transport controls** — play, pause, seek, stop with time display

## Getting Started

```bash
git clone https://github.com/yetkinozturk/audioslicer.git
cd audioslicer
bun install
bun run dev
```

Opens at `http://localhost:5173`.

## Build & Deploy

```bash
bun run build        # Build for production
bun run deploy       # Deploy to GitHub Pages
```

## Tech Stack

- React
- Vite
- Web Audio API
- Web MIDI API

## Contact

abgtjjmka@mozmail.com

---

*This tool is dedicated to the experimenters — the ones who treat music not as something to master, but as something to question. Studying, practicing are all in the discipline of craft. Some of the most important musical discoveries come from asking "what if I rearrange this?" or "what does it sound like backwards?"*

*Every great tradition in music was once someone's weird experiment. Dub reggae was an engineer muting channels to see what remained. Musique concrète was a composer cutting tape with scissors. Hip-hop was two turntables and the space between breakbeats. These weren't accidents — they were mindful choices to listen differently.*

*So slice, shuffle, shred. Break a song apart and put it back wrong. The mistakes you choose to keep are the beginning of your sound.*

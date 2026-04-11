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


## Contact

abgtjjmka@mozmail.com

---

*This tool is dedicated to the people who experiment and show us new ways on our journey.*
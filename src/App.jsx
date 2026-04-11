import { useState, useRef, useCallback, useEffect } from "react";

const COLORS = {
  bg: "#0a0a0b",
  surface: "#141416",
  surfaceHover: "#1c1c20",
  border: "#2a2a30",
  borderActive: "#53ffea",
  accent: "#53ffea",
  accentDim: "#3dccd0",
  accentGlow: "rgba(83,255,234,0.12)",
  text: "#e8e6e3",
  textDim: "#7a7872",
  waveform: "#53ffea",
  waveformBg: "#1a1a1e",
  success: "#4caf50",
};

const SLICE_COLORS = ["#53ffea","#35b0ff","#a3ff35","#ff35a3","#ffd735","#35ffd7","#d735ff","#ff3535"];

// QWERTY keyboard layout for slice triggering
const KEY_ROWS = [
  ["Q","W","E","R","T","Y","U","I","O","P"],
  ["A","S","D","F","G","H","J","K","L"],
  ["Z","X","C","V","B","N","M"],
];
const ALL_KEYS = KEY_ROWS.flat();

const PRESETS = [
  { name: "Micro Glitch", desc: "Tiny granular fragments", sensitivity: 90, minGap: 20, windowMs: 2, preRoll: 1 },
  { name: "Stutter", desc: "Fast rhythmic cuts", sensitivity: 80, minGap: 50, windowMs: 3, preRoll: 2 },
  { name: "Grain", desc: "Small granular slices", sensitivity: 75, minGap: 80, windowMs: 4, preRoll: 3 },
  { name: "Drum Hits", desc: "Individual percussion hits", sensitivity: 50, minGap: 100, windowMs: 5, preRoll: 5 },
  { name: "Tight Chops", desc: "Short musical phrases", sensitivity: 55, minGap: 150, windowMs: 8, preRoll: 8 },
  { name: "Musical Phrases", desc: "Melodic or vocal phrases", sensitivity: 65, minGap: 400, windowMs: 20, preRoll: 15 },
  { name: "Vocal Sentences", desc: "Speech or singing passages", sensitivity: 70, minGap: 600, windowMs: 25, preRoll: 20 },
  { name: "Broad Sections", desc: "Large structural chunks", sensitivity: 45, minGap: 1200, windowMs: 35, preRoll: 25 },
  { name: "Stems", desc: "Intro, verse, chorus, outro — structural sections", sensitivity: null, minGap: null, windowMs: null, preRoll: null, isStemMode: true },
  { name: "Custom", desc: "Manual slider control", sensitivity: null, minGap: null, windowMs: null, preRoll: null },
];

function getSliceColor(i) {
  return SLICE_COLORS[i % SLICE_COLORS.length];
}

function detectTransients(channelData, sampleRate, sensitivity, minGapMs, windowMs) {
  const windowSamps = Math.max(2, Math.floor((windowMs / 1000) * sampleRate));
  const hopSamps = Math.max(1, Math.floor(windowSamps / 2));
  const minGapSamps = Math.floor((minGapMs / 1000) * sampleRate);
  const envLength = Math.floor(channelData.length / hopSamps);
  const envelope = new Float32Array(envLength);

  for (let i = 0; i < envLength; i++) {
    let sum = 0;
    const start = i * hopSamps;
    const end = Math.min(start + windowSamps, channelData.length);
    for (let j = start; j < end; j++) {
      sum += Math.abs(channelData[j]);
    }
    envelope[i] = sum / (end - start);
  }

  let peak = 0, total = 0;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > peak) peak = envelope[i];
    total += envelope[i];
  }
  const mean = total / envelope.length;
  const threshold = mean + (peak - mean) * ((100 - sensitivity) / 100);

  const avgWindow = 20;
  const ringBuffer = new Float32Array(avgWindow);
  let ringIndex = 0, runningSum = 0, runningCount = 0;
  let lastOnsetSample = -999999;
  const onsets = [];

  for (let i = 0; i < envelope.length; i++) {
    const val = envelope[i];
    const localAvg = runningCount > 0 ? runningSum / Math.min(runningCount, avgWindow) : 0;
    const samplePos = i * hopSamps;

    if (val > threshold && val > 2.0 * Math.max(localAvg, 1e-10) && (samplePos - lastOnsetSample) > minGapSamps) {
      onsets.push(samplePos);
      lastOnsetSample = samplePos;
    }

    if (runningCount >= avgWindow) {
      runningSum -= ringBuffer[ringIndex];
    }
    ringBuffer[ringIndex] = val;
    runningSum += val;
    runningCount++;
    ringIndex = (ringIndex + 1) % avgWindow;
  }

  return onsets;
}

function detectStems(channelData, sampleRate) {
  // Analyze energy over large windows (2-4 seconds) to find structural boundaries
  // like intro→verse, verse→chorus, chorus→bridge, etc.
  const windowSecs = 2.0;
  const hopSecs = 0.5;
  const windowSamps = Math.floor(windowSecs * sampleRate);
  const hopSamps = Math.floor(hopSecs * sampleRate);
  const totalSamps = channelData.length;
  const totalDuration = totalSamps / sampleRate;

  // Compute RMS energy for each window
  const energyFrames = [];
  for (let start = 0; start + windowSamps <= totalSamps; start += hopSamps) {
    let sum = 0;
    for (let i = start; i < start + windowSamps; i++) {
      sum += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sum / windowSamps);
    energyFrames.push({ sample: start, rms });
  }

  if (energyFrames.length < 4) return [];

  // Smooth the energy curve with a moving average (8-frame window)
  const smoothWindow = Math.min(8, Math.floor(energyFrames.length / 2));
  const smoothed = energyFrames.map((frame, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - smoothWindow); j <= Math.min(energyFrames.length - 1, i + smoothWindow); j++) {
      sum += energyFrames[j].rms;
      count++;
    }
    return { sample: frame.sample, rms: sum / count };
  });

  // Compute the derivative (rate of change) of the smoothed energy
  const derivatives = [];
  for (let i = 1; i < smoothed.length; i++) {
    derivatives.push({
      sample: smoothed[i].sample,
      delta: Math.abs(smoothed[i].rms - smoothed[i - 1].rms),
      energyBefore: smoothed[i - 1].rms,
      energyAfter: smoothed[i].rms,
    });
  }

  if (derivatives.length === 0) return [];

  // Find the mean and peak of derivatives
  let meanDelta = 0, peakDelta = 0;
  for (const d of derivatives) {
    meanDelta += d.delta;
    if (d.delta > peakDelta) peakDelta = d.delta;
  }
  meanDelta /= derivatives.length;

  // Threshold: points where energy changes significantly
  // Use mean + 0.5 * (peak - mean) as the boundary threshold
  const threshold = meanDelta + 0.4 * (peakDelta - meanDelta);

  // Minimum gap between sections: at least 5 seconds or 5% of total duration
  const minGapSamps = Math.floor(Math.max(5.0, totalDuration * 0.05) * sampleRate);

  // Collect boundary points where derivative exceeds threshold
  const boundaries = [];
  let lastBoundary = -999999;
  for (const d of derivatives) {
    if (d.delta > threshold && (d.sample - lastBoundary) > minGapSamps) {
      boundaries.push(d.sample);
      lastBoundary = d.sample;
    }
  }

  // If we found very few or no boundaries, fall back to equal energy-based splitting
  if (boundaries.length < 2) {
    // Split into roughly equal energy sections (aim for 3-6 sections)
    const targetSections = Math.min(6, Math.max(3, Math.floor(totalDuration / 30)));
    const totalEnergy = smoothed.reduce((s, f) => s + f.rms, 0);
    const energyPerSection = totalEnergy / targetSections;

    let accumEnergy = 0;
    const equalBoundaries = [];
    for (let i = 0; i < smoothed.length; i++) {
      accumEnergy += smoothed[i].rms;
      if (accumEnergy >= energyPerSection && (equalBoundaries.length === 0 ||
          (smoothed[i].sample - equalBoundaries[equalBoundaries.length - 1]) > minGapSamps)) {
        equalBoundaries.push(smoothed[i].sample);
        accumEnergy = 0;
      }
    }
    // Remove last boundary if too close to end
    if (equalBoundaries.length > 0 &&
        (totalSamps - equalBoundaries[equalBoundaries.length - 1]) < minGapSamps) {
      equalBoundaries.pop();
    }
    return equalBoundaries;
  }

  return boundaries;
}

function sliceAudio(audioBuffer, onsets, preRollMs) {
  const preRollSamps = Math.floor((preRollMs / 1000) * audioBuffer.sampleRate);
  const totalLength = audioBuffer.getChannelData(0).length;
  const slicePoints = [0];

  for (const onset of onsets) {
    const point = Math.max(0, onset - preRollSamps);
    if (point > slicePoints[slicePoints.length - 1]) {
      slicePoints.push(point);
    }
  }

  const slices = [];
  for (let i = 0; i < slicePoints.length; i++) {
    const start = slicePoints[i];
    const end = i < slicePoints.length - 1 ? slicePoints[i + 1] : totalLength;
    const length = end - start;
    const sliceBuffer = new Float32Array(length);
    const channelData = audioBuffer.getChannelData(0);
    for (let j = 0; j < length; j++) {
      sliceBuffer[j] = channelData[start + j];
    }
    slices.push({ data: sliceBuffer, originalIndex: i, start, end, length });
  }
  return slices;
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function reconstructAudio(ctx, slices, order, sampleRate) {
  const totalLength = slices.reduce((sum, s) => sum + s.length, 0);
  const buffer = ctx.createBuffer(1, totalLength, sampleRate);
  const output = buffer.getChannelData(0);
  let offset = 0;
  for (const idx of order) {
    const slice = slices[idx];
    for (let i = 0; i < slice.length; i++) {
      output[offset + i] = slice.data[i];
    }
    offset += slice.length;
  }
  return buffer;
}

function drawWaveform(canvas, audioBuffer, slices, order, isShuffled, playProgress) {
  if (!canvas || !audioBuffer) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLORS.waveformBg;
  ctx.fillRect(0, 0, w, h);

  if (!slices || slices.length === 0) {
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / w);
    ctx.strokeStyle = COLORS.waveform;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const idx = i * step;
      let min = 1, max = -1;
      for (let j = 0; j < step && idx + j < data.length; j++) {
        const val = data[idx + j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      ctx.moveTo(i, ((1 + min) / 2) * h);
      ctx.lineTo(i, ((1 + max) / 2) * h);
    }
    ctx.stroke();
    return;
  }

  const displayOrder = isShuffled ? order : slices.map((_, i) => i);
  const totalLength = slices.reduce((sum, s) => sum + s.length, 0);
  let pixelOffset = 0;

  for (let oi = 0; oi < displayOrder.length; oi++) {
    const sliceIdx = displayOrder[oi];
    const slice = slices[sliceIdx];
    const slicePixelWidth = Math.max(1, Math.round((slice.length / totalLength) * w));
    const color = getSliceColor(sliceIdx);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;

    const step = Math.max(1, Math.ceil(slice.length / slicePixelWidth));
    ctx.beginPath();
    for (let i = 0; i < slicePixelWidth && (pixelOffset + i) < w; i++) {
      const idx = i * step;
      let min = 1, max = -1;
      for (let j = 0; j < step && idx + j < slice.length; j++) {
        const val = slice.data[idx + j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const x = pixelOffset + i;
      ctx.moveTo(x, ((1 + min) / 2) * h);
      ctx.lineTo(x, ((1 + max) / 2) * h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (oi > 0) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pixelOffset, 0);
      ctx.lineTo(pixelOffset, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.font = "9px monospace";
    ctx.fillText(`${sliceIdx + 1}`, pixelOffset + 3, 12);
    ctx.globalAlpha = 1;
    pixelOffset += slicePixelWidth;
  }

  if (playProgress > 0 && playProgress < 1) {
    const x = playProgress * w;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export default function AudioSlicer() {
  const [audioBuffer, setAudioBuffer] = useState(null);
  const [fileName, setFileName] = useState("");
  const [slices, setSlices] = useState(null);
  const [order, setOrder] = useState(null);
  const [isShuffled, setIsShuffled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [sensitivity, setSensitivity] = useState(50);
  const [minGap, setMinGap] = useState(100);
  const [windowMs, setWindowMs] = useState(5);
  const [preRoll, setPreRoll] = useState(5);
  const [activePreset, setActivePreset] = useState("Drum Hits");
  const [status, setStatus] = useState("Load an audio file to begin");
  const [shuffleCount, setShuffleCount] = useState(0);
  const [sortMode, setSortMode] = useState(null); // null | "loud" | "quiet"
  const [grooveGroups, setGrooveGroups] = useState(3); // number of energy bands for groove
  const [dillaGroups, setDillaGroups] = useState(2); // number of transient types for Spice
  const [shredderSize, setShredderSize] = useState(1); // block size for Shredder
  const [activeKeys, setActiveKeys] = useState(new Set()); // currently pressed keys
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [midiDeviceName, setMidiDeviceName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const canvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const animFrameRef = useRef(null);
  const startTimeRef = useRef(0);
  const durationRef = useRef(0);
  const playOffsetRef = useRef(0);
  const sliceSourcesRef = useRef({}); // active slice playback sources keyed by slice index
  const midiAccessRef = useRef(null); // where in the buffer we started from (for seeking)

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  }, []);

  const stopPlayback = useCallback((preservePosition) => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch(e) {}
      sourceRef.current = null;
    }
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (!preservePosition) {
      setPlayProgress(0);
      playOffsetRef.current = 0;
    }
    setIsPlaying(false);
  }, []);

  const applyPreset = useCallback((presetName) => {
    const preset = PRESETS.find(p => p.name === presetName);
    if (!preset || preset.name === "Custom") {
      setActivePreset("Custom");
      return;
    }
    setSensitivity(preset.sensitivity);
    setMinGap(preset.minGap);
    setWindowMs(preset.windowMs);
    setPreRoll(preset.preRoll);
    setActivePreset(presetName);
  }, []);

  const handleSliderChange = useCallback((setter, value) => {
    setter(value);
    setActivePreset("Custom");
  }, []);

  const handleFile = useCallback(async (file) => {
    stopPlayback();
    setIsLoading(true);
    setStatus("Decoding audio...");
    setFileName(file.name);
    try {
      const ctx = getAudioCtx();
      const arrayBuf = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf);
      setAudioBuffer(decoded);
      setSlices(null);
      setOrder(null);
      setIsShuffled(false);
      setShuffleCount(0);
      setStatus(`Loaded: ${file.name} (${decoded.duration.toFixed(1)}s, ${decoded.sampleRate}Hz)`);
    } catch (e) {
      setStatus("Error decoding audio: " + e.message);
    }
    setIsLoading(false);
  }, [getAudioCtx, stopPlayback]);

  const handleSlice = useCallback(() => {
    if (!audioBuffer) return;
    stopPlayback();
    const channelData = audioBuffer.getChannelData(0);
    const currentPresetObj = PRESETS.find(p => p.name === activePreset);
    let onsets;

    if (currentPresetObj && currentPresetObj.isStemMode) {
      setStatus("Analyzing song structure...");
      onsets = detectStems(channelData, audioBuffer.sampleRate);
    } else {
      setStatus("Detecting transients...");
      onsets = detectTransients(channelData, audioBuffer.sampleRate, sensitivity, minGap, windowMs);
    }

    const newSlices = sliceAudio(audioBuffer, onsets, currentPresetObj?.isStemMode ? 0 : preRoll);
    const initialOrder = newSlices.map((_, i) => i);
    setSlices(newSlices);
    setOrder(initialOrder);
    setIsShuffled(false);
    setShuffleCount(0);
    setSortMode(null);

    if (currentPresetObj?.isStemMode) {
      // Label sections based on energy profile
      const sectionNames = newSlices.map((slice, i) => {
        let rms = 0;
        for (let j = 0; j < slice.length; j++) rms += slice.data[j] * slice.data[j];
        rms = Math.sqrt(rms / Math.max(slice.length, 1));
        return { i, rms, dur: slice.length / audioBuffer.sampleRate };
      });
      const maxRms = Math.max(...sectionNames.map(s => s.rms), 1e-10);
      const labels = sectionNames.map((s, idx) => {
        const relEnergy = s.rms / maxRms;
        const isFirst = idx === 0;
        const isLast = idx === sectionNames.length - 1;
        if (isFirst && relEnergy < 0.4) return "Intro";
        if (isLast && relEnergy < 0.4) return "Outro";
        if (relEnergy > 0.75) return "Chorus";
        if (relEnergy > 0.45) return "Verse";
        if (isFirst) return "Intro";
        if (isLast) return "Outro";
        return "Bridge";
      });
      setStatus(`Stems: ${newSlices.length} sections — ${labels.join(" → ")}`);
    } else {
      setStatus(`Found ${newSlices.length} slices using "${activePreset}" preset. Hit Shuffle to rearrange.`);
    }
  }, [audioBuffer, sensitivity, minGap, windowMs, preRoll, activePreset, stopPlayback]);

  const handleShuffle = useCallback(() => {
    if (!slices) return;
    stopPlayback();
    const indices = slices.map((_, i) => i);
    const newOrder = shuffleArray(indices);
    setOrder(newOrder);
    setIsShuffled(true);
    setShuffleCount(c => c + 1);
    setSortMode(null);
    setStatus(`Shuffle #${shuffleCount + 1} — ${slices.length} slices rearranged`);
  }, [slices, shuffleCount, stopPlayback]);

  const handleReset = useCallback(() => {
    if (!slices) return;
    stopPlayback();
    setOrder(slices.map((_, i) => i));
    setIsShuffled(false);
    setSortMode(null);
    setStatus("Reset to original order");
  }, [slices, stopPlayback]);

  const handleSort = useCallback(() => {
    if (!slices) return;
    stopPlayback();
    // Compute peak amplitude for each slice
    const peaks = slices.map((slice, idx) => {
      let peak = 0;
      for (let i = 0; i < slice.length; i++) {
        const abs = Math.abs(slice.data[i]);
        if (abs > peak) peak = abs;
      }
      return { idx, peak };
    });
    // Toggle between loudest-first and quietest-first
    const nextMode = sortMode === "loud" ? "quiet" : "loud";
    if (nextMode === "loud") {
      peaks.sort((a, b) => b.peak - a.peak);
    } else {
      peaks.sort((a, b) => a.peak - b.peak);
    }
    const newOrder = peaks.map(p => p.idx);
    setOrder(newOrder);
    setIsShuffled(true);
    setSortMode(nextMode);
    setStatus(`Sorted by transient energy: ${nextMode === "loud" ? "loudest first" : "quietest first"}`);
  }, [slices, sortMode, stopPlayback]);

  const handleGroove = useCallback(() => {
    if (!slices || slices.length < 2) return;
    stopPlayback();

    // Compute peak amplitude for each slice
    const peaks = slices.map((slice, idx) => {
      let peak = 0;
      for (let i = 0; i < slice.length; i++) {
        const abs = Math.abs(slice.data[i]);
        if (abs > peak) peak = abs;
      }
      return { idx, peak };
    });

    // Sort by energy to assign bands
    const sorted = [...peaks].sort((a, b) => b.peak - a.peak);

    // Split into N energy bands (loud, mid, quiet, etc.)
    const bands = grooveGroups;
    const bandSize = Math.ceil(sorted.length / bands);
    const buckets = [];
    for (let b = 0; b < bands; b++) {
      buckets.push([]);
    }
    sorted.forEach((item, i) => {
      const band = Math.min(Math.floor(i / bandSize), bands - 1);
      buckets[band].push(item.idx);
    });

    // Interleave: cycle through bands picking one from each
    // This creates patterns like loud-mid-quiet, loud-mid-quiet...
    const newOrder = [];
    let maxLen = 0;
    for (const b of buckets) {
      if (b.length > maxLen) maxLen = b.length;
    }
    for (let i = 0; i < maxLen; i++) {
      for (let b = 0; b < buckets.length; b++) {
        if (i < buckets[b].length) {
          newOrder.push(buckets[b][i]);
        }
      }
    }

    setOrder(newOrder);
    setIsShuffled(true);
    setSortMode("groove");
    setStatus(`Groove pattern: ${bands} energy bands cycling across ${slices.length} slices`);
  }, [slices, grooveGroups, stopPlayback]);

  const handleDilla = useCallback(() => {
    if (!slices || slices.length < 3) return;
    stopPlayback();

    const k = Math.min(dillaGroups, slices.length);

    // Compute features for each slice
    const features = slices.map((slice, idx) => {
      let peak = 0, rmsSum = 0;
      let highEnergy = 0, lowEnergy = 0;
      const halfPoint = Math.floor(slice.length / 2);
      for (let i = 0; i < slice.length; i++) {
        const abs = Math.abs(slice.data[i]);
        if (abs > peak) peak = abs;
        rmsSum += abs * abs;
        if (i < halfPoint) highEnergy += abs;
        else lowEnergy += abs;
      }
      const rms = Math.sqrt(rmsSum / Math.max(slice.length, 1));
      const brightness = highEnergy / Math.max(highEnergy + lowEnergy, 1e-10);
      return { idx, peak, rms, length: slice.length, brightness };
    });

    // Normalize to 0-1
    const maxPeak = Math.max(...features.map(f => f.peak), 1e-10);
    const maxRms = Math.max(...features.map(f => f.rms), 1e-10);
    const maxLen = Math.max(...features.map(f => f.length), 1);

    const points = features.map(f => [
      f.peak / maxPeak,
      f.rms / maxRms,
      f.length / maxLen,
      f.brightness,
    ]);

    // Distance between two points
    const vecDist = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
      return Math.sqrt(sum);
    };

    // Simple k-means clustering
    // Initialize centroids by picking k evenly spaced points sorted by energy
    const sortedByEnergy = [...points.keys()].sort((a, b) => points[b][0] - points[a][0]);
    const centroids = [];
    for (let i = 0; i < k; i++) {
      const pick = sortedByEnergy[Math.floor(i * sortedByEnergy.length / k)];
      centroids.push([...points[pick]]);
    }

    let assignments = new Array(points.length).fill(0);

    // Run k-means for up to 20 iterations
    for (let iter = 0; iter < 20; iter++) {
      // Assign each point to nearest centroid
      let changed = false;
      for (let i = 0; i < points.length; i++) {
        let bestK = 0, bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const d = vecDist(points[i], centroids[c]);
          if (d < bestDist) { bestDist = d; bestK = c; }
        }
        if (assignments[i] !== bestK) { assignments[i] = bestK; changed = true; }
      }
      if (!changed) break;

      // Recompute centroids
      for (let c = 0; c < k; c++) {
        const members = points.filter((_, i) => assignments[i] === c);
        if (members.length === 0) continue;
        for (let d = 0; d < 4; d++) {
          centroids[c][d] = members.reduce((s, m) => s + m[d], 0) / members.length;
        }
      }
    }

    // Build clusters: map cluster label -> list of slice indices
    const clusters = {};
    for (let i = 0; i < assignments.length; i++) {
      const c = assignments[i];
      if (!clusters[c]) clusters[c] = [];
      clusters[c].push(i);
    }

    // Start from current order, shuffle within each cluster
    const currentOrder = order ? [...order] : slices.map((_, i) => i);
    const newOrder = [...currentOrder];

    // Collect positions in newOrder that belong to each cluster
    const positionsByCluster = {};
    for (let pos = 0; pos < newOrder.length; pos++) {
      const sliceIdx = newOrder[pos];
      const c = assignments[sliceIdx];
      if (!positionsByCluster[c]) positionsByCluster[c] = [];
      positionsByCluster[c].push(pos);
    }

    // Shuffle within each cluster
    let swapCount = 0;
    for (const [, positions] of Object.entries(positionsByCluster)) {
      if (positions.length < 2) continue;
      const sliceIndices = positions.map(p => newOrder[p]);
      for (let i = sliceIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sliceIndices[i], sliceIndices[j]] = [sliceIndices[j], sliceIndices[i]];
      }
      for (let i = 0; i < positions.length; i++) {
        if (newOrder[positions[i]] !== sliceIndices[i]) swapCount++;
        newOrder[positions[i]] = sliceIndices[i];
      }
    }

    const activeGroups = Object.values(positionsByCluster).filter(p => p.length >= 2).length;
    const typeNames = k === 1 ? "1 type" : `${k} types`;

    setOrder(newOrder);
    setIsShuffled(true);
    setSortMode("dilla");
    setStatus(`Spice (${typeNames}): ${swapCount} swaps across ${activeGroups} active groups`);
  }, [slices, order, dillaGroups, stopPlayback]);

  const handleShredder = useCallback(() => {
    if (!slices || slices.length < 2) return;
    stopPlayback();

    const blockSize = Math.max(1, Math.min(shredderSize, Math.floor(slices.length / 2)));
    const currentOrder = order ? [...order] : slices.map((_, i) => i);
    const newOrder = [...currentOrder];
    const len = newOrder.length;

    // Create fixed-size regions of blockSize and swap adjacent regions
    // Like vertical blinds: region A and region B swap positions
    let swapCount = 0;
    for (let i = 0; i + 2 * blockSize <= len; i += 2 * blockSize) {
      // Swap block [i..i+blockSize-1] with block [i+blockSize..i+2*blockSize-1]
      for (let j = 0; j < blockSize; j++) {
        const temp = newOrder[i + j];
        newOrder[i + j] = newOrder[i + blockSize + j];
        newOrder[i + blockSize + j] = temp;
        swapCount++;
      }
    }

    setOrder(newOrder);
    setIsShuffled(true);
    setSortMode("shredder");
    setStatus(`Shredder (block ${blockSize}): ${swapCount} swaps — adjacent blocks exchanged`);
  }, [slices, order, shredderSize, stopPlayback]);

  const getPlaybackBuffer = useCallback(() => {
    if (!audioBuffer) return null;
    const ctx = getAudioCtx();
    if (slices && order) {
      return reconstructAudio(ctx, slices, order, audioBuffer.sampleRate);
    }
    // No slices yet — play the raw audio buffer
    return audioBuffer;
  }, [audioBuffer, slices, order, getAudioCtx]);

  const startPlaybackFrom = useCallback((offsetSeconds) => {
    const buffer = getPlaybackBuffer();
    if (!buffer) return;
    const ctx = getAudioCtx();
    const clampedOffset = Math.max(0, Math.min(offsetSeconds, buffer.duration - 0.01));

    // Stop any current source without resetting progress
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch(e) {}
      sourceRef.current = null;
    }
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0, clampedOffset);
    sourceRef.current = source;
    durationRef.current = buffer.duration;
    startTimeRef.current = ctx.currentTime;
    playOffsetRef.current = clampedOffset;
    setIsPlaying(true);

    const animate = () => {
      const elapsed = ctx.currentTime - startTimeRef.current + clampedOffset;
      const progress = elapsed / durationRef.current;
      if (progress >= 1) {
        setIsPlaying(false);
        setPlayProgress(0);
        playOffsetRef.current = 0;
        return;
      }
      setPlayProgress(progress);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    source.onended = () => {
      if (sourceRef.current === source) {
        setIsPlaying(false);
        setPlayProgress(0);
        playOffsetRef.current = 0;
      }
    };
  }, [getPlaybackBuffer, getAudioCtx]);

  const handlePlay = useCallback(() => {
    if (!audioBuffer) return;
    if (isPlaying) {
      // Pause — remember position
      const elapsed = (audioCtxRef.current?.currentTime || 0) - startTimeRef.current + playOffsetRef.current;
      playOffsetRef.current = elapsed;
      stopPlayback(true);
      return;
    }
    startPlaybackFrom(playOffsetRef.current);
  }, [audioBuffer, isPlaying, stopPlayback, startPlaybackFrom]);

  const handleSeek = useCallback((deltaSecs) => {
    if (!audioBuffer) return;
    const duration = durationRef.current || audioBuffer.duration;
    let currentPos;
    if (isPlaying) {
      currentPos = (audioCtxRef.current?.currentTime || 0) - startTimeRef.current + playOffsetRef.current;
    } else {
      currentPos = playOffsetRef.current;
    }
    const newPos = Math.max(0, Math.min(currentPos + deltaSecs, duration - 0.01));
    playOffsetRef.current = newPos;
    setPlayProgress(newPos / duration);
    if (isPlaying) {
      startPlaybackFrom(newPos);
    }
  }, [audioBuffer, isPlaying, startPlaybackFrom]);

  const handleExport = useCallback(() => {
    if (!slices || !order) return;
    const ctx = getAudioCtx();
    const buffer = reconstructAudio(ctx, slices, order, audioBuffer.sampleRate);
    const length = buffer.length;
    const data = buffer.getChannelData(0);

    const wavBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(wavBuffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, audioBuffer.sampleRate, true);
    view.setUint32(28, audioBuffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const baseName = fileName.replace(/\.[^.]+$/, "");
    a.href = url;
    a.download = `${baseName}_${activePreset.toLowerCase().replace(/\s+/g, "-")}_shuffle${shuffleCount}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported as ${baseName}_${activePreset.toLowerCase().replace(/\s+/g, "-")}_shuffle${shuffleCount}.wav`);
  }, [slices, order, audioBuffer, fileName, shuffleCount, activePreset, getAudioCtx]);

  // --- Play a single slice by its actual slice index ---
  const playSliceRaw = useCallback((sliceIdx) => {
    if (!slices || sliceIdx < 0 || sliceIdx >= slices.length) return;
    const ctx = getAudioCtx();
    const slice = slices[sliceIdx];
    if (slice.length === 0) return;

    // Stop any existing playback of this slice
    if (sliceSourcesRef.current[sliceIdx]) {
      try { sliceSourcesRef.current[sliceIdx].stop(); } catch(e) {}
    }

    const buffer = ctx.createBuffer(1, slice.length, audioBuffer.sampleRate);
    buffer.getChannelData(0).set(slice.data);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    sliceSourcesRef.current[sliceIdx] = source;
    source.onended = () => {
      if (sliceSourcesRef.current[sliceIdx] === source) {
        delete sliceSourcesRef.current[sliceIdx];
      }
    };
  }, [slices, audioBuffer, getAudioCtx]);

  // --- Play slice by position in current order (keyboard/MIDI use this) ---
  const playSliceByOrder = useCallback((positionIdx) => {
    if (!slices || !order) return;
    if (positionIdx < 0 || positionIdx >= order.length) return;
    const actualSliceIdx = order[positionIdx];
    playSliceRaw(actualSliceIdx);
  }, [slices, order, playSliceRaw]);

  const stopSliceByOrder = useCallback((positionIdx) => {
    if (!order) return;
    if (positionIdx < 0 || positionIdx >= order.length) return;
    const actualSliceIdx = order[positionIdx];
    if (sliceSourcesRef.current[actualSliceIdx]) {
      try { sliceSourcesRef.current[actualSliceIdx].stop(); } catch(e) {}
      delete sliceSourcesRef.current[actualSliceIdx];
    }
  }, [order]);

  // --- Keyboard handler ---
  useEffect(() => {
    if (!slices || !order) return;

    const handleKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      const key = e.key.toUpperCase();
      const idx = ALL_KEYS.indexOf(key);
      if (idx === -1 || idx >= order.length) return;
      if (e.repeat) return;
      e.preventDefault();
      setActiveKeys(prev => new Set(prev).add(key));
      playSliceByOrder(idx);
    };

    const handleKeyUp = (e) => {
      const key = e.key.toUpperCase();
      const idx = ALL_KEYS.indexOf(key);
      if (idx === -1) return;
      setActiveKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      stopSliceByOrder(idx);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [slices, order, playSliceByOrder, stopSliceByOrder]);

  // --- MIDI handler ---
  const initMidi = useCallback(async () => {
    if (!navigator.requestMIDIAccess) {
      setStatus("MIDI not supported in this browser");
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      midiAccessRef.current = access;

      const onMidiMessage = (e) => {
        if (!slices || !order) return;
        const [status, note, velocity] = e.data;
        const cmd = status & 0xf0;
        // Map MIDI notes: C2 (note 36) = position 0 in order, C#2 = position 1, etc.
        const posIdx = note - 36;
        if (posIdx < 0 || posIdx >= order.length) return;
        const key = posIdx < ALL_KEYS.length ? ALL_KEYS[posIdx] : null;

        if (cmd === 0x90 && velocity > 0) {
          if (key) setActiveKeys(prev => new Set(prev).add(key));
          playSliceByOrder(posIdx);
        } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
          if (key) setActiveKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
          stopSliceByOrder(posIdx);
        }
      };

      let deviceName = "";
      for (const input of access.inputs.values()) {
        input.onmidimessage = onMidiMessage;
        if (!deviceName) deviceName = input.name;
      }

      // Listen for new devices
      access.onstatechange = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = onMidiMessage;
          if (!deviceName) deviceName = input.name;
        }
      };

      setMidiEnabled(true);
      setMidiDeviceName(deviceName || "Waiting for device...");
      setStatus(deviceName ? `MIDI connected: ${deviceName}` : "MIDI enabled — connect a device");
    } catch (err) {
      setStatus("MIDI access denied: " + err.message);
    }
  }, [slices, order, playSliceByOrder, stopSliceByOrder]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const container = canvas.parentElement;
    if (container) {
      canvas.width = container.clientWidth;
      canvas.height = 180;
    }
    if (audioBuffer) {
      drawWaveform(canvas, audioBuffer, slices, order, isShuffled, playProgress);
    }
  }, [audioBuffer, slices, order, isShuffled, playProgress]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const currentPreset = PRESETS.find(p => p.name === activePreset);

  const btnStyle = (active, accent, disabled) => ({
    padding: "10px 20px",
    border: `1px solid ${active ? COLORS.borderActive : COLORS.border}`,
    borderRadius: "2px",
    background: active ? COLORS.accentGlow : COLORS.surface,
    color: disabled ? COLORS.textDim : accent ? COLORS.accent : COLORS.text,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    transition: "all 0.15s ease",
    opacity: disabled ? 0.35 : 1,
  });

  const sliderBox = (label, value, setter, min, max, step, unit, tooltip) => (
    <div style={{ flex: 1, minWidth: 140 }} title={tooltip}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <span style={{ color: COLORS.accent, fontSize: 11, fontFamily: "monospace" }}>{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => handleSliderChange(setter, Number(e.target.value))}
        style={{ width: "100%", accentColor: COLORS.accent, height: 3 }}
      />
    </div>
  );

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", padding: 0 }}>
      {/* Header */}
      <div style={{ padding: "24px 28px 0", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.accent, letterSpacing: "-0.02em" }}>YETKIN'S</span>
        <span style={{ fontSize: 18, fontWeight: 300, color: COLORS.textDim }}>AUDIO SLICER</span>
        <span style={{ flex: 1 }} />
        <a href="https://github.com/yetkinozturk/audioslicer" target="_blank" rel="noopener noreferrer" style={{
          fontSize: 9, color: COLORS.textDim, letterSpacing: "0.05em",
          textDecoration: "none", opacity: 0.7, transition: "opacity 0.2s",
        }} onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.7}
           title="View source on GitHub">GitHub</a>
        <span style={{ fontSize: 9, color: COLORS.textDim, opacity: 0.3 }}>·</span>
        <a href="mailto:abgtjjmka@mozmail.com" style={{
          fontSize: 9, color: COLORS.textDim, letterSpacing: "0.05em",
          textDecoration: "none", opacity: 0.7, transition: "opacity 0.2s",
        }} onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.7}
           title="Get in touch">abgtjjmka@mozmail.com</a>
        <span style={{ fontSize: 9, color: COLORS.textDim, letterSpacing: "0.1em" }}>v1.3</span>
      </div>

      <div style={{ padding: "16px 28px" }}>
        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => document.getElementById("file-input").click()}
          style={{
            border: `1px dashed ${COLORS.border}`,
            borderRadius: 2,
            padding: audioBuffer ? "12px 16px" : "36px 16px",
            textAlign: "center",
            cursor: "pointer",
            marginBottom: 16,
            background: COLORS.surface,
          }}
        >
          <input id="file-input" type="file" accept="audio/*" style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
          {isLoading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <svg width="20" height="20" viewBox="0 0 20 20" style={{ animation: "spin 1s linear infinite" }}>
                <circle cx="10" cy="10" r="8" fill="none" stroke={COLORS.border} strokeWidth="2" />
                <circle cx="10" cy="10" r="8" fill="none" stroke={COLORS.accent} strokeWidth="2"
                  strokeDasharray="25 25" strokeLinecap="round" />
              </svg>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>Decoding {fileName}...</span>
            </div>
          ) : audioBuffer ? (
            <span style={{ color: COLORS.textDim, fontSize: 11 }}>{fileName} — click or drop to replace</span>
          ) : (
            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>Drop audio file here</div>
              <div style={{ fontSize: 10, color: COLORS.textDim }}>WAV, MP3, OGG, FLAC</div>
            </div>
          )}
        </div>

        {/* Waveform */}
        <div style={{ background: COLORS.waveformBg, border: `1px solid ${COLORS.border}`, borderRadius: 2, overflow: "hidden", marginBottom: 16 }}>
          <canvas ref={canvasRef} style={{ width: "100%", height: 180, display: "block" }} />
        </div>

        {/* Preset selector */}
        <div style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 2,
          padding: "12px 16px",
          marginBottom: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.1em", whiteSpace: "nowrap" }}>Preset</span>
            <select
              title="Choose a detection preset — from micro-glitch fragments to broad structural sections"
              value={activePreset}
              onChange={e => applyPreset(e.target.value)}
              style={{
                flex: 1,
                background: COLORS.bg,
                color: COLORS.text,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 2,
                padding: "8px 12px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                cursor: "pointer",
                outline: "none",
              }}
            >
              {PRESETS.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            {currentPreset && (
              <span style={{ fontSize: 10, color: COLORS.textDim, whiteSpace: "nowrap" }}>{currentPreset.desc}</span>
            )}
          </div>
        </div>

        {/* Sliders */}
        {activePreset !== "Stems" && (
          <div style={{
            display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16,
            opacity: activePreset === "Custom" ? 1 : 0.6,
            transition: "opacity 0.2s",
          }}>
            {sliderBox("Sensitivity", sensitivity, setSensitivity, 1, 100, 1, "%", "How picky the detector is — higher catches more transients")}
            {sliderBox("Min Gap", minGap, setMinGap, 10, 2000, 10, "ms", "Minimum time between slice points — prevents double-triggers")}
            {sliderBox("Window", windowMs, setWindowMs, 1, 50, 1, "ms", "Analysis window size — shorter for sharp hits, longer for gradual onsets")}
            {sliderBox("Pre-roll", preRoll, setPreRoll, 0, 50, 1, "ms", "Shift slice point earlier to avoid clipping the attack")}
          </div>
        )}
        {activePreset === "Stems" && (
          <div style={{
            padding: "10px 14px", marginBottom: 16, fontSize: 11,
            color: COLORS.textDim, background: COLORS.surface,
            border: `1px solid ${COLORS.border}`, borderRadius: 2,
          }}>
            Stems mode analyzes average energy over long windows to find structural boundaries like intro, verse, chorus, and outro. No manual parameters needed — just hit Slice.
          </div>
        )}

        {/* Row 1: Slice + Transport + actions */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button title="Detect transients and slice the audio into segments" onClick={handleSlice} disabled={!audioBuffer} style={btnStyle(false, true, !audioBuffer)}>
            Slice
          </button>
          <div style={{ width: 1, height: 28, background: COLORS.border, margin: "0 2px" }} />
          <button title="Rewind 5 seconds" onClick={() => handleSeek(-5)} disabled={!audioBuffer} style={{
            ...btnStyle(false, false, !audioBuffer),
            width: 36, padding: "10px 0", textAlign: "center",
          }}>
            ◀◀
          </button>
          <button title={isPlaying ? "Pause playback" : "Play audio"} onClick={handlePlay} disabled={!audioBuffer} style={{
            ...btnStyle(isPlaying, isPlaying, !audioBuffer),
            width: 36, padding: "10px 0", textAlign: "center",
          }}>
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button title="Forward 5 seconds" onClick={() => handleSeek(5)} disabled={!audioBuffer} style={{
            ...btnStyle(false, false, !audioBuffer),
            width: 36, padding: "10px 0", textAlign: "center",
          }}>
            ▶▶
          </button>
          <button title="Stop and return to start" onClick={() => { stopPlayback(); }} disabled={!audioBuffer} style={{
            ...btnStyle(false, false, !audioBuffer),
            width: 36, padding: "10px 0", textAlign: "center",
          }}>
            ■
          </button>
          {audioBuffer && (
            <span style={{ fontSize: 10, color: COLORS.textDim, fontFamily: "monospace", marginLeft: 2 }}>
              {(() => {
                const dur = durationRef.current || audioBuffer.duration;
                const cur = playProgress * dur;
                const fmt = (s) => {
                  const m = Math.floor(s / 60);
                  const sec = Math.floor(s % 60);
                  return `${m}:${sec.toString().padStart(2, "0")}`;
                };
                return `${fmt(cur)} / ${fmt(dur)}`;
              })()}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button title="Reset slices to original order" onClick={handleReset} disabled={!slices} style={btnStyle(false, false, !slices)}>
            Reset
          </button>
          <button title="Download the current arrangement as a WAV file" onClick={handleExport} disabled={!slices || !isShuffled} style={btnStyle(false, false, !slices || !isShuffled)}>
            Export
          </button>
        </div>

        {/* Row 2: Rearrange modes as segmented pill group */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
            Rearrange
          </div>
          <div style={{ display: "flex", gap: 0, opacity: !slices ? 0.35 : 1, transition: "opacity 0.2s" }}>
            {/* Shuffle */}
            <button title="Randomly rearrange all slices" onClick={handleShuffle} disabled={!slices} style={{
              ...btnStyle(isShuffled && !sortMode, true, !slices),
              borderRadius: 0, borderTopLeftRadius: 2, borderBottomLeftRadius: 2,
              borderRight: "none", opacity: 1, padding: "8px 14px", fontSize: 11,
            }}>
              Shuffle
            </button>
            {/* Sort */}
            <button title="Sort slices by peak energy — click to toggle loud-first / quiet-first" onClick={handleSort} disabled={!slices} style={{
              ...btnStyle(sortMode === "loud" || sortMode === "quiet", true, !slices),
              borderRadius: 0, borderRight: "none", opacity: 1, padding: "8px 14px", fontSize: 11,
            }}>
              {sortMode === "loud" ? "Sort ↓" : sortMode === "quiet" ? "Sort ↑" : "Sort"}
            </button>
            {/* Groove + param */}
            <button title="Group slices into energy bands and interleave them cyclically for a repeating groove pattern" onClick={handleGroove} disabled={!slices} style={{
              ...btnStyle(sortMode === "groove", true, !slices),
              borderRadius: 0, borderRight: "none", opacity: 1, padding: "8px 10px 8px 14px", fontSize: 11,
            }}>
              Groove
            </button>
            <select
              title="Number of energy bands for groove cycling"
              value={grooveGroups}
              disabled={!slices}
              onChange={e => setGrooveGroups(Number(e.target.value))}
              style={{
                background: sortMode === "groove" ? COLORS.accentGlow : COLORS.surface,
                color: !slices ? COLORS.textDim : COLORS.accent,
                border: `1px solid ${sortMode === "groove" ? COLORS.borderActive : COLORS.border}`,
                borderLeft: "none", borderRight: "none", borderRadius: 0,
                padding: "8px 4px", fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10, cursor: !slices ? "not-allowed" : "pointer", outline: "none",
              }}
            >
              {[2,3,4,5,6,8].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {/* Spice + param */}
            <button title="Swap similar-sounding transients — kicks stay in kick positions, snares in snare positions" onClick={handleDilla} disabled={!slices} style={{
              ...btnStyle(sortMode === "dilla", true, !slices),
              borderRadius: 0, borderRight: "none", opacity: 1, padding: "8px 10px 8px 14px", fontSize: 11,
            }}>
              Spice
            </button>
            <select
              title="Number of transient types to detect — 1 = all alike, 8 = very fine distinction"
              value={dillaGroups}
              disabled={!slices}
              onChange={e => setDillaGroups(Number(e.target.value))}
              style={{
                background: sortMode === "dilla" ? COLORS.accentGlow : COLORS.surface,
                color: !slices ? COLORS.textDim : COLORS.accent,
                border: `1px solid ${sortMode === "dilla" ? COLORS.borderActive : COLORS.border}`,
                borderLeft: "none", borderRight: "none", borderRadius: 0,
                padding: "8px 4px", fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10, cursor: !slices ? "not-allowed" : "pointer", outline: "none",
              }}
            >
              {[1,2,3,4,5,6,7,8].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {/* Shredder + param */}
            <button title="Swap adjacent blocks of slices like vertical blinds — creates a cut-up, paper-shredder effect" onClick={handleShredder} disabled={!slices} style={{
              ...btnStyle(sortMode === "shredder", true, !slices),
              borderRadius: 0, borderRight: "none", opacity: 1, padding: "8px 10px 8px 14px", fontSize: 11,
            }}>
              Shredder
            </button>
            <select
              title="Block size — how many slices per block to swap with the next block"
              value={shredderSize}
              disabled={!slices}
              onChange={e => setShredderSize(Number(e.target.value))}
              style={{
                background: sortMode === "shredder" ? COLORS.accentGlow : COLORS.surface,
                color: !slices ? COLORS.textDim : COLORS.accent,
                border: `1px solid ${sortMode === "shredder" ? COLORS.borderActive : COLORS.border}`,
                borderLeft: "none", borderRadius: 0,
                borderTopRightRadius: 2, borderBottomRightRadius: 2,
                padding: "8px 4px", fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10, cursor: !slices ? "not-allowed" : "pointer", outline: "none",
              }}
            >
              {[1,2,3,4,5,6,7,8].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Order display */}
        {slices && order && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 2, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 9, color: COLORS.textDim, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              {sortMode === "groove" ? `Groove (${grooveGroups} bands)` : sortMode === "dilla" ? `Spice (${dillaGroups} types)` : sortMode === "shredder" ? `Shredder (block ${shredderSize})` : isShuffled ? `Shuffle #${shuffleCount}` : "Original Order"} — {slices.length} slices — {activePreset}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {order.map((idx, pos) => (
                <span
                  key={pos}
                  title={`Slice ${idx + 1} — hover to preview`}
                  onMouseEnter={() => playSliceRaw(idx)}
                  onMouseLeave={() => {
                    if (sliceSourcesRef.current[idx]) {
                      try { sliceSourcesRef.current[idx].stop(); } catch(e) {}
                      delete sliceSourcesRef.current[idx];
                    }
                  }}
                  style={{
                    display: "inline-block",
                    padding: "2px 6px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#000",
                    background: getSliceColor(idx),
                    borderRadius: 1,
                    opacity: 0.85,
                    cursor: "pointer",
                    transition: "transform 0.1s ease, opacity 0.1s ease",
                  }}
                  onMouseDown={e => { e.currentTarget.style.transform = "scale(0.9)"; }}
                  onMouseUp={e => { e.currentTarget.style.transform = "scale(1)"; }}
                >{idx + 1}</span>
              ))}
            </div>
          </div>
        )}

        {/* Keyboard */}
        {slices && order && slices.length > 0 && (
          <div style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 2,
            padding: "16px",
            marginBottom: 16,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 9, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Keyboard — {Math.min(order.length, ALL_KEYS.length)} slices mapped
              </span>
              <button
                onClick={initMidi}
                style={{
                  ...btnStyle(midiEnabled, midiEnabled, false),
                  padding: "4px 10px",
                  fontSize: 9,
                }}
              >
                {midiEnabled ? `MIDI: ${midiDeviceName}` : "Enable MIDI"}
              </button>
            </div>
            {KEY_ROWS.map((row, rowIdx) => {
              const offsets = [0, 20, 44];
              return (
                <div key={rowIdx} style={{
                  display: "flex",
                  gap: 4,
                  marginBottom: 4,
                  paddingLeft: offsets[rowIdx],
                }}>
                  {row.map((key) => {
                    const posIdx = ALL_KEYS.indexOf(key);
                    const hasSample = posIdx < order.length;
                    const actualSliceIdx = hasSample ? order[posIdx] : -1;
                    const isActive = activeKeys.has(key);
                    const color = hasSample ? getSliceColor(actualSliceIdx) : COLORS.border;
                    return (
                      <button
                        key={key}
                        onMouseDown={() => { if (hasSample) { setActiveKeys(prev => new Set(prev).add(key)); playSliceByOrder(posIdx); } }}
                        onMouseUp={() => { if (hasSample) { setActiveKeys(prev => { const n = new Set(prev); n.delete(key); return n; }); stopSliceByOrder(posIdx); } }}
                        onMouseLeave={() => { if (hasSample && activeKeys.has(key)) { setActiveKeys(prev => { const n = new Set(prev); n.delete(key); return n; }); stopSliceByOrder(posIdx); } }}
                        style={{
                          width: 44,
                          height: 44,
                          border: `1px solid ${isActive ? color : COLORS.border}`,
                          borderRadius: 3,
                          background: isActive ? color : hasSample ? COLORS.bg : COLORS.surface,
                          color: isActive ? "#000" : hasSample ? color : COLORS.textDim,
                          cursor: hasSample ? "pointer" : "default",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          fontWeight: 700,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 1,
                          transition: "all 0.06s ease",
                          opacity: hasSample ? 1 : 0.25,
                          boxShadow: isActive ? `0 0 12px ${color}44` : "none",
                          transform: isActive ? "scale(0.95)" : "scale(1)",
                        }}
                      >
                        <span>{key}</span>
                        {hasSample && (
                          <span style={{
                            fontSize: 7,
                            opacity: 0.6,
                            color: isActive ? "#000" : COLORS.textDim,
                          }}>{actualSliceIdx + 1}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <div style={{ marginTop: 8, fontSize: 9, color: COLORS.textDim }}>
              Press keys to trigger slices • Click pads to play • MIDI notes from C2 (36)
            </div>
          </div>
        )}

        {/* Status */}
        <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.04em" }}>{status}</div>

        {/* About */}
        <div style={{
          marginTop: 40, paddingTop: 20,
          borderTop: `1px solid ${COLORS.border}`,
        }}>
          <div style={{
            fontSize: 12, color: COLORS.textDim, lineHeight: 1.8,
            maxWidth: 620, opacity: 0.7,
          }}>
            <p style={{ marginBottom: 12 }}>
              This tool is dedicated to the experimenters — the ones who treat music not as something to master, but as something to question. Studying, practicing are all in the discipline of craft. Some of the most important musical discoveries come from asking "what if I rearrange this?" or "what does it sound like backwards?"
            </p>
            <p style={{ marginBottom: 12 }}>
              Every great tradition in music was once someone's weird experiment. Dub reggae was an engineer muting channels to see what remained. Musique concrète was a composer cutting tape with scissors. Hip-hop was two turntables and the space between breakbeats. These weren't accidents — they were mindful choices to listen differently.
            </p>
            <p style={{ marginBottom: 0 }}>
              So slice, shuffle, shred. Break a song apart and put it back wrong. The mistakes you choose to keep are the beginning of your sound.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

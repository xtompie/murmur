/**
 * murmur – lokalny rejestrator i transkrybent audio
 * Stack: MediaRecorder, Whisper WASM, WebLLM (WebGPU)
 */

// ── Constants ──────────────────────────────────────────────────────────────

const LLM_MODEL = 'Phi-3.5-mini-instruct-q4f16_1-MLC';
const CHUNK_INTERVAL_MS = 30_000;
const OVERLAP_SECONDS = 10;
const OVERLAP_MS = OVERLAP_SECONDS * 1000;

// Whisper model IDs for @huggingface/transformers (ONNX, cached in IndexedDB)
const WHISPER_MODELS = {
  'tiny-q5_1':   'onnx-community/whisper-tiny',
  'base-q5_1':   'onnx-community/whisper-base',
  'small-q5_1':  'onnx-community/whisper-small',
  'medium-q5_0': 'onnx-community/whisper-medium',
  'large-q5_0':  'onnx-community/whisper-large-v2',
};

// ── State ──────────────────────────────────────────────────────────────────

let llmEngine = null;
let llmReady = false;

let whisperModule = null;
let whisperReady = false;

let mediaRecorder = null;
let audioStream = null;
let audioContext = null;
let analyser = null;
let waveformAnimId = null;
let wakeLock = null;
let wakeLockOscillator = null;

let isRecording = false;
let timerInterval = null;
let timerSeconds = 0;

// Rolling audio buffer for overlap (stores {blob, durationMs} objects)
let overlapBuffer = [];
let overlapBufferDurationMs = 0;

let fullTranscript = '';
let chunkQueue = [];
let processingChunk = false;

// ── DOM refs ───────────────────────────────────────────────────────────────

const btnRecord       = document.getElementById('btnRecord');
const recordIcon      = document.getElementById('recordIcon');
const recordLabel     = document.getElementById('recordLabel');
const timerEl         = document.getElementById('timer');
const waveformWrap    = document.getElementById('waveformWrap');
const waveformCanvas  = document.getElementById('waveform');
const downloadProgress = document.getElementById('downloadProgress');
const downloadLabel   = document.getElementById('downloadLabel');
const downloadPct     = document.getElementById('downloadPct');
const progressFill    = document.getElementById('progressFill');
const transcriptText  = document.getElementById('transcriptText');
const notesText       = document.getElementById('notesText');
const summaryText     = document.getElementById('summaryText');
const transcribingInd = document.getElementById('transcribingIndicator');
const toast           = document.getElementById('toast');

// Modals
const modalSettings      = document.getElementById('modalSettings');
const modalWebGPU        = document.getElementById('modalWebGPU');
const modalMic           = document.getElementById('modalMic');
const modalDownloadErr   = document.getElementById('modalDownloadErr');
const downloadErrMsg     = document.getElementById('downloadErrMsg');
const selectWhisper      = document.getElementById('selectWhisper');
const selectLang         = document.getElementById('selectLang');

// ── Utility ────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2000) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function showModal(el) {
  el.classList.add('visible');
}

function hideModal(el) {
  el.classList.remove('visible');
}

function formatTime(secs) {
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function skeletonHTML() {
  const widths = [92, 78, 85, 60, 88, 72, 50];
  return `<div class="skeleton">${widths.map(w =>
    `<div class="skeleton-line" style="width:${w}%"></div>`
  ).join('')}</div>`;
}

// ── Settings persistence ───────────────────────────────────────────────────

function loadSettings() {
  selectWhisper.value = localStorage.getItem('whisperModel') || 'tiny-q5_1';
  selectLang.value    = localStorage.getItem('whisperLang')  || 'pl';
}

function saveSettings() {
  localStorage.setItem('whisperModel', selectWhisper.value);
  localStorage.setItem('whisperLang',  selectLang.value);
}

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Copy buttons ───────────────────────────────────────────────────────────

document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.target);
    const text = target.innerText.replace(/Transkrypcja pojawi.*|Notatki zostaną.*|Skrót zostanie.*/g, '').trim();
    if (!text) { showToast('Brak tekstu do skopiowania'); return; }
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      btn.querySelector('span') && (btn.querySelector('span').textContent = 'Skopiowano!');
      const label = btn.childNodes[btn.childNodes.length - 1];
      if (label.nodeType === Node.TEXT_NODE) label.textContent = 'Skopiowano!';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (label.nodeType === Node.TEXT_NODE) label.textContent = 'Kopiuj';
      }, 2000);
    } catch {
      showToast('Nie można skopiować');
    }
  });
});

// ── WebGPU detection ───────────────────────────────────────────────────────

async function checkWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

// ── LLM init ──────────────────────────────────────────────────────────────

async function initLLM() {
  const gpuOk = await checkWebGPU();
  if (!gpuOk) {
    showModal(modalWebGPU);
    return;
  }

  downloadProgress.classList.add('visible');
  downloadLabel.textContent = 'Pobieranie modelu LLM...';

  try {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    llmEngine = await webllm.CreateMLCEngine(LLM_MODEL, {
      initProgressCallback: (report) => {
        const pct = Math.round((report.progress || 0) * 100);
        downloadPct.textContent = `${pct}%`;
        progressFill.style.width = `${pct}%`;
        if (report.text) {
          downloadLabel.textContent = report.text.length > 60
            ? report.text.slice(0, 57) + '...'
            : report.text;
        }
      },
    });

    llmReady = true;
    downloadProgress.classList.remove('visible');
    enableRecordButton();
  } catch (err) {
    console.error('LLM init error:', err);
    downloadProgress.classList.remove('visible');
    downloadErrMsg.textContent = `Nie udało się pobrać modelu LLM: ${err.message || err}`;
    showModal(modalDownloadErr);
  }
}

function enableRecordButton() {
  if (llmReady) {
    btnRecord.disabled = false;
    setButtonIdle();
  }
}

// ── Record button states ───────────────────────────────────────────────────

const MIC_ICON = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="1" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.6"/>
  <path d="M4 10a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="11" y1="17" x2="11" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="8" y1="21" x2="14" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const STOP_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
  <rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor"/>
</svg>`;

const SPINNER_HTML = `<div class="spinner"></div>`;

function setButtonIdle() {
  btnRecord.classList.remove('recording');
  recordIcon.innerHTML = MIC_ICON;
  recordLabel.textContent = 'Nagraj';
  btnRecord.disabled = false;
}

function setButtonLoading(text = 'Ładowanie...') {
  btnRecord.classList.remove('recording');
  recordIcon.innerHTML = SPINNER_HTML;
  recordLabel.textContent = text;
  btnRecord.disabled = true;
}

function setButtonRecording() {
  btnRecord.classList.add('recording');
  recordIcon.innerHTML = STOP_ICON;
  recordLabel.textContent = 'Stop';
  btnRecord.disabled = false;
}

// ── Timer ─────────────────────────────────────────────────────────────────

function startTimer() {
  timerSeconds = 0;
  timerEl.textContent = formatTime(0);
  timerEl.classList.add('visible');
  timerInterval = setInterval(() => {
    timerSeconds++;
    timerEl.textContent = formatTime(timerSeconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerEl.classList.remove('visible');
}

// ── Waveform ──────────────────────────────────────────────────────────────

function startWaveform(stream) {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  waveformWrap.classList.add('visible');
  const canvas = waveformCanvas;
  const ctx = canvas.getContext('2d');

  function draw() {
    waveformAnimId = requestAnimationFrame(draw);
    canvas.width = canvas.offsetWidth;
    canvas.height = 48;

    const bufLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barCount = 48;
    const barW = 3;
    const gap = (canvas.width - barCount * barW) / (barCount + 1);

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * bufLen * 0.6);
      const val = data[idx] / 255;
      const h = Math.max(3, val * canvas.height);
      const x = gap + i * (barW + gap);
      const y = (canvas.height - h) / 2;

      ctx.fillStyle = `rgba(232, 97, 74, ${0.4 + val * 0.6})`;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 1.5);
      ctx.fill();
    }
  }
  draw();
}

function stopWaveform() {
  if (waveformAnimId) cancelAnimationFrame(waveformAnimId);
  waveformWrap.classList.remove('visible');
  if (audioContext) { audioContext.close(); audioContext = null; }
  analyser = null;
}

// ── Wake Lock ──────────────────────────────────────────────────────────────

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Fallback: silent oscillator keeps audio context alive (helps on some devices)
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      wakeLockOscillator = { osc, ctx };
    } catch {
      // ignore
    }
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (wakeLockOscillator) {
    wakeLockOscillator.osc.stop();
    wakeLockOscillator.ctx.close();
    wakeLockOscillator = null;
  }
}

// ── MediaRecorder + overlap chunking ──────────────────────────────────────

async function startRecording() {
  setButtonLoading('Ładowanie...');

  // Request mic
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error('Mic error:', err);
    showModal(modalMic);
    setButtonIdle();
    return;
  }

  // Init Whisper if needed
  if (!whisperReady) {
    const modelKey = localStorage.getItem('whisperModel') || 'tiny-q5_1';
    const ok = await initWhisper(modelKey);
    if (!ok) {
      audioStream.getTracks().forEach(t => t.stop());
      setButtonIdle();
      return;
    }
  }

  // Reset state
  fullTranscript = '';
  overlapBuffer = [];
  overlapBufferDurationMs = 0;
  chunkQueue = [];
  processingChunk = false;

  transcriptText.innerHTML = '<span class="placeholder">Transkrypcja pojawi się tutaj podczas nagrywania...</span>';
  notesText.innerHTML = '<span class="placeholder">Notatki zostaną wygenerowane po zakończeniu nagrywania.</span>';
  summaryText.innerHTML = '<span class="placeholder">Skrót zostanie wygenerowany po zakończeniu nagrywania.</span>';

  // Wake lock
  await requestWakeLock();

  // Start waveform
  startWaveform(audioStream);

  // MediaRecorder
  mediaRecorder = new MediaRecorder(audioStream, {
    mimeType: getSupportedMimeType(),
    audioBitsPerSecond: 16000,
  });

  let chunkStartTime = Date.now();

  mediaRecorder.addEventListener('dataavailable', async (event) => {
    if (!event.data || event.data.size === 0) return;

    const blobDuration = Date.now() - chunkStartTime;
    chunkStartTime = Date.now();

    const newBlob = event.data;

    // Build chunk = overlap + new
    const overlapBlobs = overlapBuffer.map(o => o.blob);
    const chunkBlob = new Blob([...overlapBlobs, newBlob], { type: newBlob.type });

    // Queue for transcription
    chunkQueue.push(chunkBlob);
    processNextChunk();

    // Update overlap buffer: add new blob, trim to last OVERLAP_MS
    overlapBuffer.push({ blob: newBlob, durationMs: blobDuration });
    overlapBufferDurationMs += blobDuration;
    while (overlapBufferDurationMs > OVERLAP_MS && overlapBuffer.length > 1) {
      const removed = overlapBuffer.shift();
      overlapBufferDurationMs -= removed.durationMs;
    }
  });

  mediaRecorder.start(CHUNK_INTERVAL_MS);
  isRecording = true;
  setButtonRecording();
  startTimer();
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  setButtonLoading('Zatrzymuję...');
  stopTimer();

  // Stop media recorder, get final chunk
  await new Promise(resolve => {
    mediaRecorder.addEventListener('stop', resolve, { once: true });
    mediaRecorder.stop();
  });

  audioStream.getTracks().forEach(t => t.stop());
  stopWaveform();
  releaseWakeLock();

  // Wait for all chunks to finish transcription
  await waitForChunkQueue();

  transcribingInd.style.display = 'none';

  if (!fullTranscript.trim()) {
    setButtonIdle();
    showToast('Brak transkrypcji do przetworzenia');
    return;
  }

  // Generate notes and summary
  generateNotesAndSummary();
  setButtonIdle();
}

// ── Chunk processing queue ─────────────────────────────────────────────────

async function processNextChunk() {
  if (processingChunk || chunkQueue.length === 0) return;
  processingChunk = true;

  const blob = chunkQueue.shift();
  transcribingInd.style.display = 'flex';

  try {
    const rawText = await transcribeBlob(blob);
    if (rawText && rawText.trim()) {
      await mergeTranscript(rawText.trim());
    }
  } catch (err) {
    console.error('Chunk transcription error:', err);
    appendTranscriptGap();
  }

  processingChunk = false;
  processNextChunk();
}

async function waitForChunkQueue() {
  while (chunkQueue.length > 0 || processingChunk) {
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── Whisper init (@huggingface/transformers) ───────────────────────────────

async function initWhisper(modelKey) {
  downloadProgress.classList.add('visible');
  downloadLabel.textContent = 'Pobieranie modelu Whisper...';
  downloadPct.textContent = '0%';
  progressFill.style.width = '0%';

  try {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js');

    // Use local cache (IndexedDB via browser)
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const modelId = WHISPER_MODELS[modelKey] || WHISPER_MODELS['tiny-q5_1'];

    whisperModule = await pipeline('automatic-speech-recognition', modelId, {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      device: 'wasm',
      progress_callback: (progress) => {
        if (progress.status === 'downloading') {
          const pct = progress.total > 0
            ? Math.round((progress.loaded / progress.total) * 100)
            : 0;
          downloadPct.textContent = `${pct}%`;
          progressFill.style.width = `${pct}%`;
          downloadLabel.textContent = `Pobieranie Whisper (${progress.file || ''})...`;
        }
      },
    });

    whisperReady = true;
    downloadProgress.classList.remove('visible');
    return true;
  } catch (err) {
    console.error('Whisper init error:', err);
    downloadProgress.classList.remove('visible');
    downloadErrMsg.textContent = `Nie udało się załadować Whisper: ${err.message || err}`;
    showModal(modalDownloadErr);
    return false;
  }
}

// ── Transcription ──────────────────────────────────────────────────────────

async function transcribeBlob(blob) {
  if (!whisperModule) throw new Error('Whisper not loaded');

  const lang = localStorage.getItem('whisperLang') || 'pl';

  // Convert blob to Float32Array PCM (16kHz, mono)
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await decodeAudioData(arrayBuffer);
  const pcm = await resampleTo16kHz(audioBuffer);

  const result = await whisperModule(pcm, {
    language: lang === 'auto' ? null : lang,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  return result.text || '';
}

async function decodeAudioData(arrayBuffer) {
  try {
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    ctx.close();
    return decoded;
  } catch {
    // Some browsers need OfflineAudioContext
    const tmpCtx = new OfflineAudioContext(1, 1, 44100);
    return tmpCtx.decodeAudioData(arrayBuffer);
  }
}

async function resampleTo16kHz(audioBuffer) {
  const targetSampleRate = 16000;
  const numChannels = 1;
  const numFrames = Math.ceil(audioBuffer.duration * targetSampleRate);

  const offlineCtx = new OfflineAudioContext(numChannels, numFrames, targetSampleRate);
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// ── Transcript merge (LLM deduplicate) ────────────────────────────────────

async function mergeTranscript(newChunkText) {
  let merged;

  if (!fullTranscript.trim()) {
    merged = newChunkText;
  } else {
    const tail = fullTranscript.slice(-150);
    try {
      merged = await llmDeduplicate(tail, newChunkText);
    } catch (err) {
      console.error('LLM dedup error:', err);
      // Fallback: simple append
      merged = newChunkText;
    }
  }

  if (merged && merged.trim()) {
    fullTranscript += (fullTranscript ? ' ' : '') + merged.trim();
    appendTranscriptChunk(merged.trim());
  }
}

async function llmDeduplicate(tail, newText) {
  const response = await llmEngine.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'Jesteś asystentem który scala fragmenty transkrypcji. Odpowiadasz TYLKO czystym tekstem, bez komentarzy.',
      },
      {
        role: 'user',
        content: `Dotychczasowa transkrypcja kończy się na:\n'${tail}'\n\nNowy fragment:\n'${newText}'\n\nZwróć TYLKO nową treść, bez powtórzeń z końca dotychczasowej transkrypcji.`,
      },
    ],
    max_tokens: 512,
    temperature: 0.1,
  });
  return response.choices[0]?.message?.content?.trim() || newText;
}

// ── Transcript UI ──────────────────────────────────────────────────────────

function appendTranscriptChunk(text) {
  // Remove placeholder
  const placeholder = transcriptText.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const span = document.createElement('span');
  span.className = 'chunk';
  span.textContent = (transcriptText.textContent.trim() ? ' ' : '') + text;
  transcriptText.appendChild(span);

  // Auto-scroll unless user has scrolled up
  const el = transcriptText;
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (isNearBottom) el.scrollTop = el.scrollHeight;
}

function appendTranscriptGap() {
  const placeholder = transcriptText.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const span = document.createElement('span');
  span.style.color = 'var(--text-muted)';
  span.style.fontStyle = 'italic';
  span.textContent = ' [...] ';
  transcriptText.appendChild(span);
}

// ── Notes & Summary generation ────────────────────────────────────────────

async function generateNotesAndSummary() {
  if (!fullTranscript.trim() || !llmReady) return;

  // Show skeletons
  notesText.innerHTML = skeletonHTML();
  summaryText.innerHTML = skeletonHTML();

  // Switch to first empty tab to show progress
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns[1].click();

  // Generate both in parallel
  try {
    const [notes, summary] = await Promise.all([
      generateNotes(fullTranscript),
      generateSummary(fullTranscript),
    ]);

    notesText.innerHTML = '';
    notesText.textContent = notes;

    summaryText.innerHTML = '';
    summaryText.textContent = summary;
  } catch (err) {
    console.error('Generation error:', err);
    notesText.innerHTML = '<span style="color:var(--text-dim)">Błąd podczas generowania notatek.</span>';
    summaryText.innerHTML = '<span style="color:var(--text-dim)">Błąd podczas generowania skrótu.</span>';
  }
}

async function generateNotes(transcript) {
  const response = await llmEngine.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'Jesteś asystentem tworzącym szczegółowe notatki z transkrypcji.',
      },
      {
        role: 'user',
        content: `Stwórz szczegółowe notatki z poniższej transkrypcji. Zachowaj wszystkie istotne informacje, fakty, liczby, nazwiska, decyzje, pytania. Użyj nagłówków i list. Pisz po polsku.\n\nTranskrypcja:\n${transcript}`,
      },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function generateSummary(transcript) {
  const response = await llmEngine.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'Jesteś asystentem tworzącym zwięzłe podsumowania.',
      },
      {
        role: 'user',
        content: `W 3-5 zdaniach opisz: o czym była rozmowa, główny temat, kluczowe wnioski. Pisz po polsku.\n\nTranskrypcja:\n${transcript}`,
      },
    ],
    max_tokens: 256,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

// ── Event handlers ─────────────────────────────────────────────────────────

btnRecord.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

// Settings modal
document.getElementById('btnSettings').addEventListener('click', () => showModal(modalSettings));
document.getElementById('btnSettingsCancel').addEventListener('click', () => hideModal(modalSettings));
document.getElementById('btnSettingsSave').addEventListener('click', () => {
  saveSettings();
  hideModal(modalSettings);
  showToast('Ustawienia zapisane');
  // If Whisper is not yet loaded, it'll use saved settings on first Record
  if (whisperReady) {
    // Force re-init on next recording
    whisperReady = false;
    whisperModule = null;
  }
});

// Close on overlay click
modalSettings.addEventListener('click', (e) => {
  if (e.target === modalSettings) hideModal(modalSettings);
});

// WebGPU modal
document.getElementById('btnWebGPUClose').addEventListener('click', () => hideModal(modalWebGPU));

// Mic modal
document.getElementById('btnMicClose').addEventListener('click', () => hideModal(modalMic));

// Download error modal
document.getElementById('btnDownloadErrClose').addEventListener('click', () => hideModal(modalDownloadErr));
document.getElementById('btnDownloadRetry').addEventListener('click', () => {
  hideModal(modalDownloadErr);
  if (!llmReady) {
    initLLM();
  } else if (!whisperReady) {
    const modelKey = localStorage.getItem('whisperModel') || 'tiny-q5_1';
    initWhisper(modelKey);
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  loadSettings();

  // Show loading state on button until LLM is ready
  setButtonLoading('Ładowanie...');

  await initLLM();
}

boot();

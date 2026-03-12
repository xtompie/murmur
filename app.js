/**
 * murmur – transkrybent audio
 * Stack: OpenAI Realtime API (transkrypcja live) + Chat API (notatki, skrót)
 */

// ── Constants ──────────────────────────────────────────────────────────────

const REALTIME_MODEL   = 'gpt-4o-realtime-preview';
const REALTIME_URL     = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const CHAT_URL         = 'https://api.openai.com/v1/chat/completions';
const CHAT_MODEL       = 'gpt-4o-mini';

const LANG_NAMES = {
  auto: 'auto',
  pl: 'Polish',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
};

// ── State ──────────────────────────────────────────────────────────────────

let ws              = null;
let audioContext    = null;
let micSource       = null;
let scriptProcessor = null;
let analyser        = null;
let waveformAnimId  = null;
let audioStream     = null;
let wakeLock        = null;

let isRecording     = false;
let timerInterval   = null;
let timerSeconds    = 0;

let fullTranscript  = '';
let interimSpan     = null;

// ── DOM refs ───────────────────────────────────────────────────────────────

const btnRecord        = document.getElementById('btnRecord');
const recordIcon       = document.getElementById('recordIcon');
const recordLabel      = document.getElementById('recordLabel');
const timerEl          = document.getElementById('timer');
const waveformWrap     = document.getElementById('waveformWrap');
const waveformCanvas   = document.getElementById('waveform');
const transcriptText   = document.getElementById('transcriptText');
const notesText        = document.getElementById('notesText');
const summaryText      = document.getElementById('summaryText');
const transcribingInd  = document.getElementById('transcribingIndicator');
const badgeDot         = document.getElementById('badgeDot');
const toast            = document.getElementById('toast');

const modalSettings    = document.getElementById('modalSettings');
const modalMic         = document.getElementById('modalMic');
const modalApiError    = document.getElementById('modalApiError');
const apiErrorMsg      = document.getElementById('apiErrorMsg');
const inputApiKey      = document.getElementById('inputApiKey');
const selectLang       = document.getElementById('selectLang');

// ── Utility ────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function showModal(el)  { el.classList.add('visible'); }
function hideModal(el)  { el.classList.remove('visible'); }

function formatTime(secs) {
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function skeletonHTML() {
  return `<div class="skeleton">${[88, 72, 90, 65, 80, 55].map(w =>
    `<div class="skeleton-line" style="width:${w}%"></div>`
  ).join('')}</div>`;
}

// ── Settings ───────────────────────────────────────────────────────────────

function loadSettings() {
  inputApiKey.value = localStorage.getItem('openaiKey') || '';
  selectLang.value  = localStorage.getItem('lang')      || 'pl';
}

function saveSettings() {
  localStorage.setItem('openaiKey', inputApiKey.value.trim());
  localStorage.setItem('lang',      selectLang.value);
}

function getApiKey()  { return localStorage.getItem('openaiKey') || ''; }
function getLang()    { return localStorage.getItem('lang') || 'pl'; }

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
    const text = target.innerText.replace(/Transkrypcja pojawi.*|Notatki zostaną.*|Skrót zostanie.*/gs, '').trim();
    if (!text) { showToast('Brak tekstu do skopiowania'); return; }
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      const label = btn.childNodes[btn.childNodes.length - 1];
      if (label.nodeType === Node.TEXT_NODE) label.textContent = ' Skopiowano!';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (label.nodeType === Node.TEXT_NODE) label.textContent = ' Kopiuj';
      }, 2000);
    } catch {
      showToast('Nie można skopiować');
    }
  });
});

// ── Record button states ───────────────────────────────────────────────────

const MIC_ICON = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none">
  <rect x="8" y="1" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.6"/>
  <path d="M4 10a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="11" y1="17" x2="11" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="8" y1="21" x2="14" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const STOP_ICON = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
  <rect x="3" y="3" width="12" height="12" rx="2" fill="currentColor"/>
</svg>`;

function setButtonIdle() {
  btnRecord.classList.remove('recording');
  recordIcon.innerHTML = MIC_ICON;
  recordLabel.textContent = 'Nagraj';
  btnRecord.disabled = false;
}

function setButtonLoading(text = 'Ładowanie...') {
  btnRecord.classList.remove('recording');
  recordIcon.innerHTML = '<div class="spinner"></div>';
  recordLabel.textContent = text;
  btnRecord.disabled = true;
}

function setButtonRecording() {
  btnRecord.classList.add('recording');
  recordIcon.innerHTML = STOP_ICON;
  recordLabel.textContent = 'Stop';
  btnRecord.disabled = false;
}

// ── Timer ──────────────────────────────────────────────────────────────────

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

// ── Waveform ───────────────────────────────────────────────────────────────

function startWaveform() {
  waveformWrap.classList.add('visible');
  const canvas = waveformCanvas;
  const ctx = canvas.getContext('2d');

  function draw() {
    waveformAnimId = requestAnimationFrame(draw);
    canvas.width  = canvas.offsetWidth;
    canvas.height = 44;

    if (!analyser) return;

    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barCount = 48;
    const barW     = 2;
    const gap      = (canvas.width - barCount * barW) / (barCount + 1);

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * bufLen * 0.6);
      const val = data[idx] / 255;
      const h   = Math.max(2, val * canvas.height);
      const x   = gap + i * (barW + gap);
      const y   = (canvas.height - h) / 2;

      ctx.fillStyle = `rgba(61, 44, 30, ${0.2 + val * 0.7})`;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 1);
      ctx.fill();
    }
  }
  draw();
}

function stopWaveform() {
  if (waveformAnimId) cancelAnimationFrame(waveformAnimId);
  waveformWrap.classList.remove('visible');
}

// ── Wake lock ──────────────────────────────────────────────────────────────

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* ignore */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ── Audio helpers ──────────────────────────────────────────────────────────

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function base64Encode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Transcript UI ──────────────────────────────────────────────────────────

function clearInterim() {
  if (interimSpan) { interimSpan.remove(); interimSpan = null; }
}

function showInterim(text) {
  const placeholder = transcriptText.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  if (!interimSpan) {
    interimSpan = document.createElement('span');
    interimSpan.className = 'interim';
    transcriptText.appendChild(interimSpan);
  }
  interimSpan.textContent = (fullTranscript ? ' ' : '') + text;
}

function finalizeSegment(text) {
  clearInterim();
  if (!text.trim()) return;

  const placeholder = transcriptText.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  fullTranscript += (fullTranscript ? ' ' : '') + text.trim();

  const span = document.createElement('span');
  span.className = 'segment';
  span.textContent = (transcriptText.textContent.trim() ? ' ' : '') + text.trim();
  transcriptText.appendChild(span);

  const el = transcriptText;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
}

// ── OpenAI Realtime API ────────────────────────────────────────────────────

function connectRealtime(apiKey, lang) {
  ws = new WebSocket(REALTIME_URL, [
    'realtime',
    `openai-insecure-api-key.${apiKey}`,
    'openai-beta.realtime-v1',
  ]);

  ws.addEventListener('open', () => {
    console.log('[WS] connected');
    badgeDot.classList.add('connected');

    const language = lang === 'auto' ? undefined : lang;

    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'gpt-4o-transcribe',
          ...(language ? { language } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          silence_duration_ms: 600,
          threshold: 0.5,
        },
      },
    }));

    startAudioCapture().catch(err => {
      console.error('Audio capture error:', err);
      handleConnectionError('Błąd inicjalizacji audio.');
    });
    setButtonRecording();
    startTimer();
    startWaveform();
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    console.log('[WS] message:', msg.type, msg);
    handleRealtimeMessage(msg);
  });

  ws.addEventListener('error', () => {
    handleConnectionError('Błąd połączenia z OpenAI Realtime API.');
  });

  ws.addEventListener('close', (event) => {
    badgeDot.classList.remove('connected');
    if (isRecording) {
      // Unexpected close during recording
      handleConnectionError(`Połączenie przerwane (kod ${event.code}).`);
    }
  });
}

function handleRealtimeMessage(msg) {
  switch (msg.type) {
    case 'conversation.item.input_audio_transcription.delta':
      showInterim(msg.delta || '');
      transcribingInd.style.display = 'flex';
      break;

    case 'conversation.item.input_audio_transcription.completed':
      finalizeSegment(msg.transcript || '');
      transcribingInd.style.display = 'none';
      break;

    case 'conversation.item.input_audio_transcription.failed': {
      const err = msg.error || {};
      console.error('[Transcription] FAILED:', JSON.stringify(err));
      const isQuota = err.code === 'insufficient_quota';
      showToast(isQuota
        ? 'Brak kredytów OpenAI — doładuj konto'
        : `Błąd transkrypcji: ${err.message || err.code || 'nieznany błąd'}`
      , 4000);
      break;
    }

    case 'error':
      console.error('Realtime error:', msg.error);
      const code = msg.error?.code || '';
      const isAuth = code === 'invalid_api_key' || msg.error?.type === 'invalid_request_error';
      handleConnectionError(
        isAuth
          ? 'Nieprawidłowy klucz API. Sprawdź ustawienia.'
          : `Błąd API: ${msg.error?.message || code}`
      );
      break;
  }
}

function handleConnectionError(message) {
  if (isRecording) {
    isRecording = false;
    stopTimer();
    stopAudioCapture();
    stopWaveform();
    releaseWakeLock();
    setButtonIdle();
    clearInterim();
    transcribingInd.style.display = 'none';
  }
  apiErrorMsg.textContent = message;
  showModal(modalApiError);
}

// ── Audio capture ──────────────────────────────────────────────────────────

const WORKLET_CODE = `
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel);
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

async function startAudioCapture() {
  // 24kHz required by OpenAI Realtime API
  audioContext = new AudioContext({ sampleRate: 24000 });

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  micSource = audioContext.createMediaStreamSource(audioStream);
  micSource.connect(analyser);

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  if (!audioContext) return; // connection was closed during async addModule

  scriptProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');

  console.log('[Audio] worklet started, audioContext sampleRate:', audioContext.sampleRate);

  let audioChunkCount = 0;
  scriptProcessor.port.onmessage = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    audioChunkCount++;
    if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
      console.log(`[Audio] chunk #${audioChunkCount}, samples: ${e.data.length}`);
    }
    const int16  = float32ToInt16(e.data);
    const base64 = base64Encode(int16.buffer);
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
  };

  micSource.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
}

function stopAudioCapture() {
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (micSource)       { micSource.disconnect(); micSource = null; }
  if (audioContext)    { audioContext.close(); audioContext = null; }
  analyser = null;
  if (audioStream)     { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
}

// ── Recording flow ─────────────────────────────────────────────────────────

async function startRecording() {
  const apiKey = getApiKey();
  if (!apiKey) {
    showModal(modalSettings);
    return;
  }

  setButtonLoading('Łączę...');

  // Request microphone
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error('Mic error:', err);
    showModal(modalMic);
    setButtonIdle();
    return;
  }

  // Reset UI
  fullTranscript = '';
  interimSpan    = null;
  transcriptText.innerHTML = '<span class="placeholder">Transkrypcja pojawi się tutaj podczas nagrywania...</span>';
  notesText.innerHTML      = '<span class="placeholder">Notatki zostaną wygenerowane po zakończeniu nagrywania.</span>';
  summaryText.innerHTML    = '<span class="placeholder">Skrót zostanie wygenerowany po zakończeniu nagrywania.</span>';
  transcribingInd.style.display = 'none';

  isRecording = true;
  await requestWakeLock();

  connectRealtime(apiKey, getLang());
  // Button state set in ws.open handler
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  setButtonLoading('Zatrzymuję...');
  stopTimer();
  stopWaveform();
  clearInterim();
  transcribingInd.style.display = 'none';
  releaseWakeLock();

  // Close WebSocket gracefully
  if (ws) {
    ws.close();
    ws = null;
  }

  stopAudioCapture();
  badgeDot.classList.remove('connected');

  setButtonIdle();

  if (!fullTranscript.trim()) {
    showToast('Brak transkrypcji do przetworzenia');
    return;
  }

  generateNotesAndSummary();
}

// ── Notes & Summary (Chat API, streaming) ─────────────────────────────────

async function generateNotesAndSummary() {
  const apiKey = getApiKey();
  const lang   = getLang();
  const langName = LANG_NAMES[lang] || 'Polish';

  notesText.innerHTML  = skeletonHTML();
  summaryText.innerHTML = skeletonHTML();

  try {
    await Promise.all([
      streamChatToElement({
        apiKey,
        element: notesText,
        systemPrompt: `You are an assistant creating notes from transcripts. RULE: record ONLY what is said in the transcript. Do not add, supplement, or infer anything beyond the text. If something was not said — do not write about it. Respond in ${langName}.`,
        userPrompt: `List as bullet points the key things said in the transcript. Use only words from the transcript. Do not add any conclusions or content not in it.\n\nTranscript:\n${fullTranscript}`,
      }),
      streamChatToElement({
        apiKey,
        element: summaryText,
        systemPrompt: `You are an assistant writing concise summaries. RULE: base yourself ONLY on what was said. Do not add anything beyond the transcript. Do not mention that it is a recording or transcript. Write directly about the content. Respond in ${langName}.`,
        userPrompt: `In 2-3 sentences summarize the main topic and key points. Write directly — no phrases like "The recording is about" or "In this transcript". Just state the content.\n\nTranscript:\n${fullTranscript}`,
      }),
    ]);
  } catch (err) {
    console.error('Generation error:', err);
    notesText.innerHTML   = '<span style="color:var(--text-dim)">Błąd podczas generowania notatek.</span>';
    summaryText.innerHTML = '<span style="color:var(--text-dim)">Błąd podczas generowania skrótu.</span>';
  }
}

async function streamChatToElement({ apiKey, element, systemPrompt, userPrompt }) {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: true,
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }

  element.innerHTML = '';
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta  = parsed.choices?.[0]?.delta?.content || '';
        if (delta) element.textContent += delta;
      } catch { /* skip malformed */ }
    }
  }
}

// ── Event handlers ─────────────────────────────────────────────────────────

btnRecord.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// Settings modal
document.getElementById('btnSettings').addEventListener('click', () => {
  loadSettings();
  showModal(modalSettings);
});
document.getElementById('btnSettingsCancel').addEventListener('click', () => {
  if (getApiKey()) hideModal(modalSettings);
});
document.getElementById('btnSettingsSave').addEventListener('click', () => {
  const key = inputApiKey.value.trim();
  if (!key) { showToast('Podaj klucz API'); return; }
  saveSettings();
  hideModal(modalSettings);
  showToast('Ustawienia zapisane');
});
modalSettings.addEventListener('click', (e) => {
  if (e.target === modalSettings && getApiKey()) hideModal(modalSettings);
});

// Mic modal
document.getElementById('btnMicClose').addEventListener('click', () => hideModal(modalMic));

// API error modal
document.getElementById('btnApiErrClose').addEventListener('click', () => hideModal(modalApiError));
document.getElementById('btnApiErrSettings').addEventListener('click', () => {
  hideModal(modalApiError);
  loadSettings();
  showModal(modalSettings);
});

// ── Boot ───────────────────────────────────────────────────────────────────

function boot() {
  loadSettings();
  setButtonIdle();
  if (!getApiKey()) {
    showModal(modalSettings);
  }
}

boot();

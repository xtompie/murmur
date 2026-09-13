/**
 * Recorder — owns `recorder-*` markup.
 *
 * State lives in the DOM:
 *   [recorder-space][recorder-state]  idle | connecting | recording
 *   [recorder-timer]                  elapsed time, as text
 *   [recorder-value]                  the transcript itself — the single source of truth
 *   [recorder-interim]                the not-yet-final fragment
 *
 * Live handles (WebSocket, AudioContext, interval ids) hang off the space
 * as `_`-prefixed props.
 */
const Recorder = (() => {

    // A worklet hands over 128 samples at a time — roughly 5 ms. Sending those
    // straight out means ~180 WebSocket messages a second, which the server VAD
    // will not segment. Batch them into 100 ms frames before they leave.
    const FRAME = 2400; // 100 ms at 24 kHz

    const WORKLET = `
const FRAME = ${FRAME};

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let read = 0;
    while (read < channel.length) {
      const take = Math.min(FRAME - this.filled, channel.length - read);
      this.buffer.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read       += take;

      if (this.filled === FRAME) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

    const space = (ctx) => ctx.up('[recorder-space]');
    const state = (s, value) => s.attr('recorder-state', value);

    // ── Public ──────────────────────────────────────────────────────────

    const Toggle = (ctx) => {
        const s = space(ctx);
        s.attr('recorder-state') === 'recording' ? Stop(s) : Start(s);
    };

    // ── Start ───────────────────────────────────────────────────────────

    const Start = async (s) => {
        if (!Settings.Key()) {
            Settings.Open(s);
            return;
        }

        state(s, 'connecting');

        try {
            s._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {
            state(s, 'idle');
            s.one('[recorder-mic-error]').showModal();
            return;
        }

        reset(s);
        wakeOn(s);

        s._session = Openai.Transcribe({
            key:  Settings.Key(),
            lang: Settings.Lang(),
            onOpen:  () => opened(s),
            onDelta: (delta) => interim(s, delta),
            onFinal: (text)  => finalize(s, text),
            onError: (message, fatal) => fatal ? fail(s, message) : Toast.Show(s, message, 4000),
            onClose: (code) => {
                s.one('[recorder-badge]').flag('recorder-connected', false);
                if (s.attr('recorder-state') === 'recording') fail(s, `Połączenie przerwane (kod ${code}).`);
            },
        });
    };

    const opened = (s) => {
        s.one('[recorder-badge]').flag('recorder-connected', true);
        state(s, 'recording');
        timerOn(s);
        capture(s).catch(() => fail(s, 'Błąd inicjalizacji audio.'));
    };

    // ── Stop ────────────────────────────────────────────────────────────

    const Stop = (s) => {
        teardown(s);
        state(s, 'idle');

        if (!s.one('[recorder-value]').innerText.trim()) {
            Toast.Show(s, 'Brak transkrypcji do przetworzenia');
            return;
        }
        Notes.Generate(s);
    };

    // One failure can arrive twice — the API error, then the socket closing
    // behind it. The first one wins; the rest are already handled.
    const fail = (s, message) => {
        if (s.attr('recorder-state') === 'idle') return;

        teardown(s);
        state(s, 'idle');

        const dialog = s.one('[recorder-api-error]');
        dialog.one('[recorder-api-error-message]').textContent = message;
        if (!dialog.open) dialog.showModal();
    };

    const teardown = (s) => {
        s._session?.Close();
        s._session = null;

        s._node?.disconnect();
        s._source?.disconnect();
        s._audio?.close();
        s._node = s._source = s._audio = null;

        s._stream?.getTracks().each(t => t.stop());
        s._stream = null;

        Waveform.Stop(s.one('[recorder-waveform]'));
        timerOff(s);
        wakeOff(s);
        clearInterim(s);
        s.one('[recorder-badge]').flag('recorder-connected', false);
    };

    // ── Audio capture ───────────────────────────────────────────────────

    const capture = async (s) => {
        s._audio = new AudioContext({ sampleRate: Openai.SAMPLE_RATE });

        const analyser = s._audio.createAnalyser();
        analyser.fftSize = 256;

        s._source = s._audio.createMediaStreamSource(s._stream);
        s._source.connect(analyser);
        Waveform.Start(s.one('[recorder-waveform]'), analyser);

        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await s._audio.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        if (!s._audio) return; // stopped while the module was loading

        s._node = new AudioWorkletNode(s._audio, 'pcm-processor');
        s._node.port.onmessage = (e) => s._session?.Send(e.data);

        s._source.connect(s._node);
        s._node.connect(s._audio.destination);
    };

    // ── Transcript ──────────────────────────────────────────────────────

    const reset = (s) => {
        s.one('[recorder-value]').clear();
        clearInterim(s);
        Switch.To(s.one('[recorder-pane]'), '[pane-space]', 'empty');
        Notes.Reset(s);
    };

    const interim = (s, delta) => {
        Switch.To(s.one('[recorder-pane]'), '[pane-space]', 'ready');
        const el = s.one('[recorder-interim]');
        el.textContent += delta;
        scroll(s);
    };

    const clearInterim = (s) => s.one('[recorder-interim]').clear();

    const finalize = (s, text) => {
        clearInterim(s);
        if (!text.trim()) return;

        Switch.To(s.one('[recorder-pane]'), '[pane-space]', 'ready');

        const value   = s.one('[recorder-value]');
        const segment = document.createElement('span');
        segment.setAttribute('recorder-segment', '');
        segment.textContent = (value.innerText.trim() ? ' ' : '') + text.trim();
        value.append(segment);
        scroll(s);
    };

    const scroll = (s) => {
        const el = s.one('[recorder-scroll]');
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
    };

    // ── Timer ───────────────────────────────────────────────────────────

    const timerOn = (s) => {
        const el = s.one('[recorder-timer]');
        let seconds = 0;
        el.textContent = format(0);
        s._timer = setInterval(() => { el.textContent = format(++seconds); }, 1000);
    };

    const timerOff = (s) => {
        clearInterval(s._timer);
        s._timer = null;
    };

    const format = (total) => {
        const pad = (n) => String(n).padStart(2, '0');
        return [
            pad(Math.floor(total / 3600)),
            pad(Math.floor(total / 60) % 60),
            pad(total % 60),
        ].join(':');
    };

    // ── Keeping the machine awake ───────────────────────────────────────

    const wakeOn = async (s) => {
        // A silent 0 dB oscillator keeps the audio session alive; wakeLock
        // alone is unreliable and unsupported in parts of Safari.
        try {
            const audio = new AudioContext();
            const osc   = audio.createOscillator();
            const gain  = audio.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(audio.destination);
            osc.start();
            s._silence = { audio, osc };
        } catch { /* ignore */ }

        try {
            s._wakeLock = await navigator.wakeLock.request('screen');
        } catch { /* ignore */ }
    };

    const wakeOff = (s) => {
        if (s._silence) {
            try { s._silence.osc.stop(); } catch { /* ignore */ }
            s._silence.audio.close().catch(() => {});
            s._silence = null;
        }
        s._wakeLock?.release().catch(() => {});
        s._wakeLock = null;
    };

    return { Toggle };
})();

/**
 * Openai — transport only. Knows nothing about the DOM.
 *
 * Realtime transcription runs over the GA WebSocket shape
 * (`?intent=transcription` + `session.type = 'transcription'`).
 * The old beta shape (`openai-beta.realtime-v1` subprotocol) is rejected
 * by the server with `beta_api_shape_disabled`.
 */
const Openai = (() => {

    const REALTIME_URL     = 'wss://api.openai.com/v1/realtime?intent=transcription';
    const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
    const CHAT_URL         = 'https://api.openai.com/v1/chat/completions';
    const CHAT_MODEL       = 'gpt-4o-mini';
    const SAMPLE_RATE      = 24000;

    const float32ToBase64 = (float32) => {
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const bytes = new Uint8Array(int16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    };

    const Transcribe = ({ key, lang, onOpen, onDelta, onFinal, onError, onClose }) => {
        const ws = new WebSocket(REALTIME_URL, ['realtime', `openai-insecure-api-key.${key}`]);

        ws.addEventListener('open', () => {
            const language = lang === 'auto' ? undefined : lang;
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'transcription',
                    audio: {
                        input: {
                            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                            transcription: { model: TRANSCRIBE_MODEL, ...(language ? { language } : {}) },
                            turn_detection: { type: 'server_vad', silence_duration_ms: 600, threshold: 0.5 },
                        },
                    },
                },
            }));
            onOpen?.();
        });

        ws.addEventListener('message', (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            switch (msg.type) {
                case 'conversation.item.input_audio_transcription.delta':
                    onDelta?.(msg.delta || '');
                    break;
                case 'conversation.item.input_audio_transcription.completed':
                    onFinal?.(msg.transcript || '');
                    break;
                case 'conversation.item.input_audio_transcription.failed':
                    // A quota failure never recovers on its own — every later
                    // segment fails the same way, so stop instead of nagging.
                    onError?.(describe(msg.error), blocking(msg.error));
                    break;
                case 'error':
                    onError?.(describe(msg.error), true);
                    break;
            }
        });

        ws.addEventListener('error', () => onError?.('Błąd połączenia z OpenAI Realtime API.', true));
        ws.addEventListener('close', (event) => onClose?.(event.code));

        return {
            Send: (float32) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: float32ToBase64(float32) }));
            },
            Close: () => ws.close(),
        };
    };

    const QUOTA = ['insufficient_quota', 'credit_balance_exhausted'];

    const blocking = (error = {}) => QUOTA.includes(error.code) || QUOTA.includes(error.type);

    const describe = (error = {}) => {
        if (blocking(error))                  return 'Brak kredytów na koncie OpenAI — doładuj konto, żeby nagrywać.';
        if (error.code === 'invalid_api_key') return 'Nieprawidłowy klucz API. Sprawdź ustawienia.';
        return error.message || error.code || 'Nieznany błąd OpenAI.';
    };

    const Chat = async ({ key, system, user, onDelta }) => {
        const response = await fetch(CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({
                model: CHAT_MODEL,
                stream: true,
                temperature: 0.1,
                max_tokens: 600,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user',   content: user },
                ],
            }),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error?.message || `HTTP ${response.status}`);
        }

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                    const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                    if (delta) onDelta(delta);
                } catch { /* skip malformed chunk */ }
            }
        }
    };

    return { Transcribe, Chat, SAMPLE_RATE };
})();

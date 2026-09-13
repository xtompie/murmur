/**
 * Notes — generates the notes and the summary from whatever transcript
 * is currently in the DOM. Owns `notes-*` and `summary-*` markup.
 */
const Notes = (() => {

    const LANGUAGES = {
        auto: 'the language of the transcript',
        pl: 'Polish',
        en: 'English',
        de: 'German',
        fr: 'French',
        es: 'Spanish',
    };

    const Reset = (ctx) => {
        const s = ctx.up('[recorder-space]');
        s.one('[notes-value]').clear();
        s.one('[summary-value]').clear();
        Switch.To(s.one('[notes-pane]'),   '[pane-space]', 'empty');
        Switch.To(s.one('[summary-pane]'), '[pane-space]', 'empty');
    };

    const Generate = async (ctx) => {
        const s        = ctx.up('[recorder-space]');
        const key      = Settings.Key();
        const language = LANGUAGES[Settings.Lang()] || LANGUAGES.pl;
        const text     = s.one('[recorder-value]').innerText.trim();

        Switch.To(s.one('[notes-pane]'),   '[pane-space]', 'busy');
        Switch.To(s.one('[summary-pane]'), '[pane-space]', 'busy');

        await Promise.all([
            stream({
                key, language, text,
                pane:   s.one('[notes-pane]'),
                value:  s.one('[notes-value]'),
                system: `You are an assistant creating notes from transcripts. RULE: record ONLY what is said in the transcript. Do not add, supplement, or infer anything beyond the text. If something was not said — do not write about it. Respond in ${language}.`,
                user:   `List as bullet points the key things said in the transcript. Use only words from the transcript. Do not add any conclusions or content not in it.\n\nTranscript:\n${text}`,
                failure: 'Błąd podczas generowania notatek.',
            }),
            stream({
                key, language, text,
                pane:   s.one('[summary-pane]'),
                value:  s.one('[summary-value]'),
                system: `You are an assistant writing concise summaries. RULE: base yourself ONLY on what was said. Do not add anything beyond the transcript. Do not mention that it is a recording or transcript. Write directly about the content. Respond in ${language}.`,
                user:   `In 2-3 sentences summarize the main topic and key points. Write directly — no phrases like "The recording is about" or "In this transcript". Just state the content.\n\nTranscript:\n${text}`,
                failure: 'Błąd podczas generowania skrótu.',
            }),
        ]);
    };

    const stream = async ({ key, pane, value, system, user, failure }) => {
        let started = false;
        try {
            await Openai.Chat({
                key, system, user,
                onDelta: (delta) => {
                    if (!started) {
                        started = true;
                        Switch.To(pane, '[pane-space]', 'ready');
                    }
                    value.textContent += delta;
                },
            });
            if (!started) Switch.To(pane, '[pane-space]', 'ready');
        } catch {
            value.textContent = failure;
            Switch.To(pane, '[pane-space]', 'ready');
        }
    };

    return { Reset, Generate };
})();

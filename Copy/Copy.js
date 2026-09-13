const Copy = (() => {

    // Copies the text of [copy-value] inside the nearest [copy-space].
    // Placeholders and skeletons live outside [copy-value], so nothing
    // has to be stripped out afterwards.
    const Copy_ = async (ctx) => {
        const space = ctx.up('[copy-space]');
        const text  = space.one('[copy-value]').innerText.trim();

        if (!text) {
            Toast.Show(ctx, 'Brak tekstu do skopiowania');
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
        } catch {
            Toast.Show(ctx, 'Nie można skopiować');
            return;
        }

        ctx.flag('copy-done', true);
        clearTimeout(ctx._timer);
        ctx._timer = setTimeout(() => ctx.flag('copy-done', false), 2000);
    };

    return { Copy: Copy_ };
})();

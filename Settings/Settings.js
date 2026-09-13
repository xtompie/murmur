const Settings = (() => {

    const KEY_API  = 'openaiKey';
    const KEY_LANG = 'lang';

    const space = (ctx) => ctx.up('[settings-space]');

    const Key  = () => localStorage.getItem(KEY_API) || '';
    const Lang = () => localStorage.getItem(KEY_LANG) || 'pl';

    const Open = (ctx) => {
        const s = space(ctx);
        s.one('[settings-key]').value  = Key();
        s.one('[settings-lang]').value = Lang();
        s.one('[settings-dialog]').showModal();
    };

    const Save = (ctx) => {
        const s   = space(ctx);
        const key = s.one('[settings-key]').value.trim();
        if (!key) {
            Toast.Show(ctx, 'Podaj klucz API');
            return;
        }
        localStorage.setItem(KEY_API,  key);
        localStorage.setItem(KEY_LANG, s.one('[settings-lang]').value);
        s.one('[settings-dialog]').close();
        Toast.Show(ctx, 'Ustawienia zapisane');
    };

    const Cancel = (ctx) => {
        if (!Key()) return;
        space(ctx).one('[settings-dialog]').close();
    };

    // Guard: the dialog stays open until a key exists (Escape included).
    const Guard = (event, ctx) => {
        if (!Key()) event.preventDefault();
    };

    const Init = (ctx) => {
        if (!Key()) space(ctx).one('[settings-dialog]').showModal();
    };

    return { Key, Lang, Open, Save, Cancel, Guard, Init };
})();

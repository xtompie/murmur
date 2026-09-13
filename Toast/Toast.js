const Toast = (() => {

    const Show = (ctx, message, duration = 2500) => {
        const el = ctx.up('body').one('[toast]');
        el.textContent = message;
        el.flag('toast-on', true);
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.flag('toast-on', false), duration);
    };

    return { Show };
})();

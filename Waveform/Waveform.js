const Waveform = (() => {

    const BARS  = 48;
    const BAR_W = 2;

    // The analyser node is a live handle, so it hangs off the element as `_analyser`.
    const Start = (canvas, analyser) => {
        canvas._analyser = analyser;
        const ctx = canvas.getContext('2d');

        const draw = () => {
            canvas._anim  = requestAnimationFrame(draw);
            canvas.width  = canvas.offsetWidth;
            canvas.height = 44;

            if (!canvas._analyser) return;

            const bins = canvas._analyser.frequencyBinCount;
            const data = new Uint8Array(bins);
            canvas._analyser.getByteFrequencyData(data);

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const gap = (canvas.width - BARS * BAR_W) / (BARS + 1);
            for (let i = 0; i < BARS; i++) {
                const value  = data[Math.floor((i / BARS) * bins * 0.6)] / 255;
                const height = Math.max(2, value * canvas.height);
                ctx.fillStyle = `rgba(61, 44, 30, ${0.2 + value * 0.7})`;
                ctx.beginPath();
                ctx.roundRect(gap + i * (BAR_W + gap), (canvas.height - height) / 2, BAR_W, height, 1);
                ctx.fill();
            }
        };
        draw();
    };

    const Stop = (canvas) => {
        cancelAnimationFrame(canvas._anim);
        canvas._anim = null;
        canvas._analyser = null;
    };

    return { Start, Stop };
})();

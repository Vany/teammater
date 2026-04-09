(function () {
    const widget = document.getElementById('hr-widget');
    const valEl  = document.getElementById('hr-value');
    const icon   = document.getElementById('hr-icon');
    const line   = document.getElementById('hr-line');
    const fillEl = document.getElementById('hr-fill');
    const dot    = document.getElementById('hr-dot');
    const gradTop = document.getElementById('grad-top');

    const MAX = 30;
    const W = 220, H = 38;
    const STEP = W / (MAX - 1);
    const history = [];
    const STALE_MS = 5000;
    let staleTimer = null;

    // ── colour zones ──────────────────────────────────────
    // ≤100 green, 100–125 yellow, ≥125 red
    function hrColor(bpm) {
        if (bpm >= 125) return '#ff4444';
        if (bpm >= 100) return '#ffcc00';
        return '#44dd88';
    }

    function applyColor(color) {
        line.setAttribute('stroke', color);
        dot.setAttribute('fill', color);
        gradTop.setAttribute('stop-color', color);
        valEl.style.textShadow = `0 0 18px ${color}88`;
    }

    // ── chart ─────────────────────────────────────────────
    function updateChart() {
        const n = history.length;
        if (n < 2) return;

        const lo   = Math.min(...history);
        const hi   = Math.max(...history);
        const span = hi - lo || 1;
        const startX = W - (n - 1) * STEP;

        const pts = history.map((v, i) => {
            const x = startX + i * STEP;
            const y = H - ((v - lo) / span) * (H - 4) - 2;
            return [x, y];
        });

        const polyStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        line.setAttribute('points', polyStr);

        const [lx, ly] = pts[pts.length - 1];
        dot.setAttribute('cx', lx.toFixed(1));
        dot.setAttribute('cy', ly.toFixed(1));

        fillEl.setAttribute('points',
            polyStr + ` ${lx.toFixed(1)},${H} ${pts[0][0].toFixed(1)},${H}`);
    }

    // ── update ────────────────────────────────────────────
    function onHeartRate(bpm) {
        valEl.textContent = bpm;
        widget.classList.add('visible');
        widget.classList.remove('stale');
        icon.style.animationDuration = (60 / bpm).toFixed(3) + 's';

        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => widget.classList.add('stale'), STALE_MS);
        applyColor(hrColor(bpm));

        history.push(bpm);
        if (history.length > MAX) history.shift();
        updateChart();
    }

    // ── Now Playing ───────────────────────────────────────
    const npWidget  = document.getElementById('np-widget');
    const npCover   = document.getElementById('np-cover');
    const npArtist  = document.getElementById('np-artist');
    const npTitle   = document.getElementById('np-title');
    const npVersion = document.getElementById('np-version');
    const npQueue   = document.getElementById('np-queue');

    function onNowPlaying({ artist, title, version, cover, coverFallback, queue_size }) {
        npArtist.textContent  = artist  || '';
        npTitle.textContent   = title   || '';
        npVersion.textContent = version || '';
        npQueue.textContent  = `${queue_size} in queue`;
        if (cover) {
            npCover.onerror = coverFallback ? () => {
                npCover.onerror = null;
                npCover.src = coverFallback;
            } : null;
            npCover.src = cover;
            npCover.classList.add('visible');
        } else {
            npCover.classList.remove('visible');
        }
        npWidget.classList.add('visible');
    }

    // ── WebSocket ─────────────────────────────────────────
    // Match protocol: wss on HTTPS (port 8443), ws on HTTP (port 8442)
    const [proto, port] = location.protocol === 'https:' ? ['wss:', 8443] : ['ws:', 8442];
    const WS_URL = `${proto}//${location.hostname}:${port}/obs`;

    let ws = null;
    let reconnectTimer = null;

    function connect() {
        if (document.hidden) return;
        ws = new WebSocket(WS_URL);
        ws.onopen = () => ws.send(JSON.stringify({ request: 'now_playing' }));
        ws.onmessage = ({ data }) => {
            try {
                const msg = JSON.parse(data);
                if (typeof msg.heartrate === 'number') onHeartRate(msg.heartrate);
                if (msg.now_playing) onNowPlaying(msg.now_playing);
            } catch {}
        };
        ws.onclose = () => {
            ws = null;
            if (!document.hidden) reconnectTimer = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws.close();
    }

    function freeze() {
        clearTimeout(reconnectTimer);
        ws?.close();
        document.body.classList.add('obs-hidden');
    }

    function unfreeze() {
        document.body.classList.remove('obs-hidden');
        connect();
    }

    // OBS browser source visibility API (more reliable than visibilitychange in CEF)
    if (window.obsstudio) {
        window.obsstudio.onVisibilityChange = (visible) => visible ? unfreeze() : freeze();
    }

    // Fallback for non-OBS environments (regular browser preview)
    document.addEventListener('visibilitychange', () => document.hidden ? freeze() : unfreeze());

    connect();
})();

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

    // ── Sys Info ──────────────────────────────────────────
    const sysWidget    = document.getElementById('sys-widget');
    const sysTempRow   = document.getElementById('sys-temp-row');
    const sysTempVal   = document.getElementById('sys-temp-value');
    const sysCpuVal    = document.getElementById('sys-cpu-value');
    const sysTempLine  = document.getElementById('sys-temp-line');
    const sysTempFill  = document.getElementById('sys-temp-fill');
    const sysTempDot   = document.getElementById('sys-temp-dot');
    const sysGradTemp  = document.getElementById('grad-temp');
    const sysCpuLine   = document.getElementById('sys-cpu-line');
    const sysCpuFill   = document.getElementById('sys-cpu-fill');
    const sysCpuDot    = document.getElementById('sys-cpu-dot');
    const sysGradCpu   = document.getElementById('grad-cpu');

    const SYS_MAX = 30, SYS_W = 220, SYS_H = 22;
    const SYS_STEP = SYS_W / (SYS_MAX - 1);
    const tempHistory = [], cpuHistory = [];
    const SYS_STALE_MS = 15000;
    let sysStaleTimer = null;

    function tempColor(c)  { return c >= 80 ? '#ff4444' : c >= 60 ? '#ffcc00' : '#44dd88'; }
    function cpuColor(pct) { return pct >= 80 ? '#ff4444' : pct >= 50 ? '#ffcc00' : '#44dd88'; }

    function applyMetricColor(valEl, line, fill, gradStop, dot, color) {
        line.setAttribute('stroke', color);
        dot.setAttribute('fill', color);
        gradStop.setAttribute('stop-color', color);
        valEl.style.textShadow = `0 0 14px ${color}88`;
    }

    function updateSysChart(history, line, fill, dot) {
        const n = history.length;
        if (n < 2) return;
        const lo = Math.min(...history), hi = Math.max(...history);
        const span = hi - lo || 1;
        const startX = SYS_W - (n - 1) * SYS_STEP;
        const pts = history.map((v, i) => [
            startX + i * SYS_STEP,
            SYS_H - ((v - lo) / span) * (SYS_H - 4) - 2,
        ]);
        const polyStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        line.setAttribute('points', polyStr);
        const [lx, ly] = pts[pts.length - 1];
        dot.setAttribute('cx', lx.toFixed(1));
        dot.setAttribute('cy', ly.toFixed(1));
        fill.setAttribute('points', `${polyStr} ${lx.toFixed(1)},${SYS_H} ${pts[0][0].toFixed(1)},${SYS_H}`);
    }

    function onSysInfo({ cpu_usage, cpu_temp }) {
        sysWidget.classList.add('visible');
        sysWidget.classList.remove('stale');
        clearTimeout(sysStaleTimer);
        sysStaleTimer = setTimeout(() => sysWidget.classList.add('stale'), SYS_STALE_MS);

        if (typeof cpu_temp === 'number') {
            sysTempRow.style.display = '';
            sysTempVal.textContent = cpu_temp.toFixed(1);
            const tc = tempColor(cpu_temp);
            applyMetricColor(sysTempVal, sysTempLine, sysTempFill, sysGradTemp, sysTempDot, tc);
            tempHistory.push(cpu_temp);
            if (tempHistory.length > SYS_MAX) tempHistory.shift();
            updateSysChart(tempHistory, sysTempLine, sysTempFill, sysTempDot);
        } else {
            sysTempRow.style.display = 'none';
        }

        if (typeof cpu_usage === 'number') {
            sysCpuVal.textContent = cpu_usage.toFixed(1);
            const cc = cpuColor(cpu_usage);
            applyMetricColor(sysCpuVal, sysCpuLine, sysCpuFill, sysGradCpu, sysCpuDot, cc);
            cpuHistory.push(cpu_usage);
            if (cpuHistory.length > SYS_MAX) cpuHistory.shift();
            updateSysChart(cpuHistory, sysCpuLine, sysCpuFill, sysCpuDot);
        }
    }

    // ── Climate (Zigbee sensor T1) ────────────────────────
    const climWidget   = document.getElementById('climate-widget');
    const climTempVal  = document.getElementById('clim-temp-value');
    const climHumVal   = document.getElementById('clim-hum-value');
    const climTempLine = document.getElementById('clim-temp-line');
    const climTempFill = document.getElementById('clim-temp-fill');
    const climTempDot  = document.getElementById('clim-temp-dot');
    const climGradTemp = document.getElementById('grad-clim-temp');
    const climHumLine  = document.getElementById('clim-hum-line');
    const climHumFill  = document.getElementById('clim-hum-fill');
    const climHumDot   = document.getElementById('clim-hum-dot');
    const climGradHum  = document.getElementById('grad-clim-hum');

    const climTempHistory = [], climHumHistory = [];

    // Room comfort zones (one-sided: warmer = worse)
    function roomTempColor(c) { return c >= 30 ? '#ff4444' : c >= 27 ? '#ffcc00' : '#44dd88'; }
    // Ideal 40–60%; acceptable 30–70%; else too dry / too damp
    function humColor(h) {
        if (h >= 40 && h <= 60) return '#44dd88';
        if (h >= 30 && h <= 70) return '#ffcc00';
        return '#ff4444';
    }

    // No stale timer: T1 reports on change (minutes–hours), last reading stays valid.
    function onClimate({ temperature, humidity }) {
        climWidget.classList.add('visible');
        if (typeof temperature === 'number') {
            climTempVal.textContent = temperature.toFixed(1);
            applyMetricColor(climTempVal, climTempLine, climTempFill, climGradTemp, climTempDot, roomTempColor(temperature));
            climTempHistory.push(temperature);
            if (climTempHistory.length > SYS_MAX) climTempHistory.shift();
            updateSysChart(climTempHistory, climTempLine, climTempFill, climTempDot);
        }
        if (typeof humidity === 'number') {
            climHumVal.textContent = humidity.toFixed(0);
            applyMetricColor(climHumVal, climHumLine, climHumFill, climGradHum, climHumDot, humColor(humidity));
            climHumHistory.push(humidity);
            if (climHumHistory.length > SYS_MAX) climHumHistory.shift();
            updateSysChart(climHumHistory, climHumLine, climHumFill, climHumDot);
        }
    }

    // ── WebSocket ─────────────────────────────────────────
    // Match protocol: wss on HTTPS (port 8443), ws on HTTP (port 8442)
    const [proto, port] = location.protocol === 'https:' ? ['wss:', 8443] : ['ws:', 8442];
    const WS_BASE = `${proto}//${location.hostname}:${port}/obs`;

    let ws = null;
    let reconnectTimer = null;
    // The bus now requires ?token=. This overlay runs inside OBS on localhost,
    // and /api/info returns bus_token to loopback callers only. Not shared
    // with bus-token.js because obs.html loads this as a plain script, not an
    // ES module.
    //
    // busToken is a FALLBACK, not a cache to trust — every call re-fetches.
    // Caching it across the ws.onclose → 3s → connect() reconnect loop used to
    // mean that if server/certs/ ever got wiped and regenerated the token,
    // this overlay would retry the dead one forever with no way to notice,
    // indistinguishable from any other reconnect failure — even though this
    // runs on localhost and could simply ask again. Only fall back to the
    // last-known value when the server is transiently unreachable right now.
    let busToken = null;

    async function ensureToken() {
        try {
            const { bus_token } = await (await fetch('/api/info')).json();
            if (bus_token) busToken = bus_token;
        } catch { /* fall through to whatever was last known, if anything */ }
        if (!busToken) console.error('[obs] No bus token — /obs will refuse the connection');
        return busToken;
    }

    async function connect() {
        if (document.hidden) return;
        const token = await ensureToken();
        if (!token) { reconnectTimer = setTimeout(connect, 3000); return; }
        ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}`);
        ws.onopen = () => ws.send(JSON.stringify({ request: 'now_playing' }));
        ws.onmessage = ({ data }) => {
            try {
                const msg = JSON.parse(data);
                if (typeof msg.heartrate === 'number') onHeartRate(msg.heartrate);
                if (msg.type === 'now_playing') onNowPlaying(msg);
                if (msg.type === 'sysinfo') onSysInfo(msg);
                if (msg.type === 'climate') onClimate(msg);
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

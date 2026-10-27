/**
 * Canvas helicorder (drum plot): one long trace folded into N lines of lineDurationSec each.
 * Framework-free, no dependencies. Samples live in a time-indexed buffer (NaN = no data), so
 * gaps show as gaps and live packets can be written at their own time with addSamples().
 */
import { formatTime, toMs } from './time';
import type { PWave, Samples, StreamData, ThemeName } from './types';

const HELI_COLORS = {
    white: {
        background: '#ffffff',
        text: '#0f172a',
        mutedText: '#64748b',
        grid: 'rgba(100, 116, 139, 0.25)',
        lineColors: ['#0284c7', '#1e293b'],
        crosshair: 'rgba(2, 132, 199, 0.7)',
        tooltipBg: 'rgba(255, 255, 255, 0.96)',
        tooltipText: '#0284c7',
        marker: 'rgba(220, 38, 38, 0.95)',
        markerText: '#ffffff',
    },
    dark: {
        background: '#000000',
        text: '#e2e8f0',
        mutedText: '#94a3b8',
        grid: 'rgba(148, 163, 184, 0.25)',
        lineColors: ['#00e5ff', '#e2e8f0'],
        crosshair: 'rgba(0, 229, 255, 0.6)',
        tooltipBg: 'rgba(12, 25, 44, 0.92)',
        tooltipText: '#7dd3fc',
        marker: 'rgba(239, 68, 68, 0.95)',
        markerText: '#ffffff',
    },
};
type HeliPalette = typeof HELI_COLORS.white

export interface HelicorderOptions {
    /** start of the first line (UTC ms / ISO / Date); default: start of the current UTC day */
    startTime?: number | string | Date;
    lineDurationSec?: number; // default 3600 (1 h per line)
    numLines?: number;        // default 24
    sampleRate?: number;      // default 100
    /** CSS px; default numLines * 28 + margins */
    height?: number;
    theme?: ThemeName;
    colors?: Partial<Record<ThemeName, Partial<HeliPalette>>>;
    font?: string;
    timeMode?: string; // 'local' | IANA timezone
    /** amplitude multiplier; 1 = a typical (median) line peaks at a quarter of its row */
    gain?: number;
    /** clip traces at ±1 row (default true); false lets big events overlap neighbours */
    clip?: boolean;
    title?: string;
    pWaves?: PWave[];
    /** click on a line: UTC ms of the clicked point */
    onClick?: ((ms: number) => void) | null;
}

const M = { left: 62, right: 62, top: 26, bottom: 30 };

/** anything that yields chunks over time: an async generator, a ReadableStream, streamMseed(url) ... */
export type ChunkSource = AsyncIterable<StreamData | StreamData[]>

export interface ConsumeOptions {
    /** only this channel; default: the first channel seen */
    channel?: string;
    /** start the range at the first chunk (floored to a whole line) instead of the current startTime */
    autoStart?: boolean;
    /** add lines while data arrives past the last line (instead of dropping it) */
    autoGrow?: boolean;
    signal?: AbortSignal;
    /** after each plotted chunk: the chunk and the samples plotted so far */
    onChunk?: (chunk: StreamData, total: number) => void;
}

export class HelicorderWidget {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    startMs: number;
    lineDurationSec: number;
    numLines: number;
    sampleRate: number;
    height: number | undefined;
    theme: ThemeName;
    palette: Record<ThemeName, HeliPalette>;
    font: string;
    timeMode: string;
    gain: number;
    clip: boolean;
    title: string;
    pWaves: (PWave & { t: number })[] = [];
    onClick: HelicorderOptions['onClick'];

    data: Float32Array = new Float32Array(0);
    // per-line pixel envelope, rebuilt for dirty lines only (24 h @ 100 sps = 8.6 M samples, too many per hover)
    envMin: Float32Array[] = [];
    envMax: Float32Array[] = [];
    lineMean: Float64Array = new Float64Array(0);
    lineMaxAbs: Float64Array = new Float64Array(0);
    dirty = new Set<number>();
    envWidth = 0;
    lastDataMs = NaN;

    mouseX = -1;
    mouseY = -1;
    rafId = 0;
    resizeObserver?: ResizeObserver;
    private onMove = (e: MouseEvent) => { const r = this.canvas.getBoundingClientRect(); this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top; this.schedule(); };
    private onLeave = () => { this.mouseX = this.mouseY = -1; this.schedule(); };
    private onClickEvt = (e: MouseEvent) => {
        const r = this.canvas.getBoundingClientRect();
        const t = this.timeAt(e.clientX - r.left, e.clientY - r.top);
        if (t !== null) this.onClick?.(t);
    };
    private onResize = () => this.resize();

    constructor(canvas: HTMLCanvasElement, options: HelicorderOptions = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        const now = new Date();
        this.startMs = options.startTime != null ? toMs(options.startTime) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        this.lineDurationSec = options.lineDurationSec || 3600;
        this.numLines = options.numLines || 24;
        this.sampleRate = options.sampleRate || 100;
        this.height = options.height;
        this.theme = options.theme || 'white';
        this.palette = {
            white: { ...HELI_COLORS.white, ...(options.colors?.white || {}) },
            dark: { ...HELI_COLORS.dark, ...(options.colors?.dark || {}) },
        };
        this.font = options.font || '10px monospace';
        this.timeMode = options.timeMode || 'local';
        this.gain = options.gain || 1;
        this.clip = options.clip ?? true;
        this.title = options.title || '';
        this.onClick = options.onClick || null;
        this.setPWaves(options.pWaves || []);
        this.allocate();

        canvas.addEventListener('mousemove', this.onMove);
        canvas.addEventListener('mouseleave', this.onLeave);
        canvas.addEventListener('click', this.onClickEvt);
        canvas.style.cursor = 'crosshair';
        window.addEventListener('resize', this.onResize);
        if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
            this.resizeObserver = new ResizeObserver(this.onResize);
            this.resizeObserver.observe(canvas.parentElement);
        }
        this.resize();
    }

    get colors() { return this.palette[this.theme === 'white' ? 'white' : 'dark']; }
    get totalSamples() { return Math.round(this.numLines * this.lineDurationSec * this.sampleRate); }
    get samplesPerLine() { return Math.round(this.lineDurationSec * this.sampleRate); }

    private allocate() {
        this.data = new Float32Array(this.totalSamples).fill(NaN);
        this.lineMean = new Float64Array(this.numLines);
        this.lineMaxAbs = new Float64Array(this.numLines);
        this.envMin = []; this.envMax = []; this.envWidth = 0;
        this.lastDataMs = NaN;
        this.markAllDirty();
    }

    private markAllDirty() { for (let i = 0; i < this.numLines; i++) this.dirty.add(i); this.schedule(); }

    /** change the plotted range; drops loaded data */
    setRange(startTime: number | string | Date, numLines = this.numLines, lineDurationSec = this.lineDurationSec) {
        this.startMs = toMs(startTime);
        this.numLines = numLines;
        this.lineDurationSec = lineDurationSec;
        this.allocate();
        this.resize();
    }

    /**
     * add lines so endMs fits (data already loaded is kept). The buffer grows by doubling, so growing one line
     * at a time while a day streams in stays cheap, and only the new lines get their envelopes built.
     */
    growTo(endMs: number) {
        const needed = Math.ceil((endMs - this.startMs) / (this.lineDurationSec * 1000));
        if (needed <= this.numLines) return;
        const spl = this.samplesPerLine;
        if (needed * spl > this.data.length) {
            const capLines = Math.max(needed, Math.ceil(this.data.length / spl) * 2);
            const data = new Float32Array(capLines * spl).fill(NaN);
            data.set(this.data);
            this.data = data;
            const mean = new Float64Array(capLines); mean.set(this.lineMean); this.lineMean = mean;
            const amp = new Float64Array(capLines); amp.set(this.lineMaxAbs); this.lineMaxAbs = amp;
        }
        for (let l = this.numLines; l < needed; l++) {
            if (this.envWidth) { this.envMin.push(new Float32Array(this.envWidth)); this.envMax.push(new Float32Array(this.envWidth)); }
            this.dirty.add(l); // may already hold samples written past the old last line
        }
        this.numLines = needed;
        this.resize();
    }

    /**
     * plot chunks as they arrive (historical data paged / streamed in). Each chunk lands at its own time,
     * gaps between chunks stay empty. Chunks of other channels or another sample rate are skipped.
     */
    async consume(source: ChunkSource, opts: ConsumeOptions = {}) {
        let channel = opts.channel;
        let first: StreamData | null = null;
        let total = 0;
        for await (const batch of source) {
            if (opts.signal?.aborted) break;
            for (const chunk of Array.isArray(batch) ? batch : [batch]) {
                if ((channel ??= chunk.channel) !== chunk.channel || !chunk.samples.length) continue;
                const t0 = toMs(chunk.startTime);
                if (!first) {
                    first = chunk;
                    const lineMs = this.lineDurationSec * 1000;
                    const start = opts.autoStart ? Math.floor(t0 / lineMs) * lineMs : this.startMs;
                    if (opts.autoStart || chunk.sampleRate !== this.sampleRate) {
                        this.sampleRate = chunk.sampleRate;
                        this.setRange(start, opts.autoGrow ? 1 : this.numLines);
                    }
                }
                if (Math.abs(chunk.sampleRate - this.sampleRate) > this.sampleRate * 0.001) continue;
                if (opts.autoGrow) this.growTo(t0 + (chunk.samples.length / chunk.sampleRate) * 1000);
                this.addSamples(chunk.samples, t0);
                total += chunk.samples.length;
                opts.onChunk?.(chunk, total);
            }
        }
        return { first, total };
    }

    /** replace all data with samples starting at dataStartTime (defaults to the helicorder start) */
    setData(samples: Samples, sampleRate = this.sampleRate, dataStartTime: number | string | Date = this.startMs) {
        if (sampleRate !== this.sampleRate) { this.sampleRate = sampleRate; this.allocate(); }
        else { this.data.fill(NaN); this.lastDataMs = NaN; this.markAllDirty(); }
        this.addSamples(samples, dataStartTime);
    }

    /** write samples at their own time (live packets, extra segments); outside the range is ignored */
    addSamples(samples: Samples, dataStartTime: number | string | Date) {
        if (!samples?.length) return;
        const t0 = toMs(dataStartTime);
        const offset = Math.round(((t0 - this.startMs) / 1000) * this.sampleRate);
        const from = Math.max(0, -offset);
        const to = Math.min(samples.length, this.data.length - offset);
        if (to <= from) return;
        for (let i = from; i < to; i++) this.data[offset + i] = samples[i];
        const spl = this.samplesPerLine;
        for (let l = Math.floor((offset + from) / spl); l <= Math.floor((offset + to - 1) / spl); l++) this.dirty.add(l);
        const end = t0 + ((to - 1) / this.sampleRate) * 1000;
        if (!(end <= this.lastDataMs)) this.lastDataMs = end;
        this.schedule();
    }

    setPWaves(list: PWave[] = []) {
        this.pWaves = list.map(p => ({ ...p, t: Date.parse(p.datetime) })).filter(p => !Number.isNaN(p.t));
        this.schedule();
    }
    setTheme(theme: ThemeName) { this.theme = theme; this.schedule(); }
    setColors(theme: ThemeName, overrides: Partial<HeliPalette>) { this.palette[theme] = { ...this.palette[theme], ...overrides }; this.schedule(); }
    setTimeMode(mode: string) { this.timeMode = mode; this.schedule(); }
    setGain(gain: number) { if (gain > 0) { this.gain = gain; this.schedule(); } }
    setClip(clip: boolean) { this.clip = clip; this.schedule(); }
    setTitle(title: string) { this.title = title; this.schedule(); }
    setHeight(height?: number) { this.height = height; this.resize(); }

    get cssHeight() { return this.height || this.numLines * 28 + M.top + M.bottom; }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const dpr = window.devicePixelRatio || 1;
        const style = getComputedStyle(parent);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const w = Math.floor(parent.getBoundingClientRect().width - padX) || 768;
        const h = this.cssHeight;
        if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
            this.canvas.width = w * dpr;
            this.canvas.height = h * dpr;
            this.canvas.style.width = '100%';
            this.canvas.style.height = `${h}px`;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        this.schedule();
    }

    get plot() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
        const width = Math.max(10, w - M.left - M.right);
        const height = Math.max(10, h - M.top - M.bottom);
        return { w, h, x: M.left, y: M.top, width, height, lineH: height / this.numLines };
    }

    /** UTC ms under a canvas point, or null outside the plot */
    timeAt(mx: number, my: number) {
        const p = this.plot;
        if (mx < p.x || mx > p.x + p.width || my < p.y || my > p.y + p.height) return null;
        const line = Math.min(this.numLines - 1, Math.floor((my - p.y) / p.lineH));
        return this.startMs + (line + (mx - p.x) / p.width) * this.lineDurationSec * 1000;
    }

    private buildEnvelopes(cols: number) {
        if (cols !== this.envWidth) {
            this.envWidth = cols;
            this.envMin = Array.from({ length: this.numLines }, () => new Float32Array(cols));
            this.envMax = Array.from({ length: this.numLines }, () => new Float32Array(cols));
            for (let i = 0; i < this.numLines; i++) this.dirty.add(i);
        }
        const spl = this.samplesPerLine;
        for (const l of this.dirty) {
            if (l >= this.numLines) continue; // spare capacity: built once growTo() reveals it
            this.dirty.delete(l);
            if (l < 0) continue;
            const base = l * spl;
            let sum = 0, n = 0;
            for (let i = 0; i < spl; i++) { const v = this.data[base + i]; if (v === v) { sum += v; n++; } }
            const mean = n ? sum / n : 0;
            let maxAbs = 0;
            const mn = this.envMin[l], mx = this.envMax[l];
            for (let c = 0; c < cols; c++) {
                const a = base + Math.floor((c * spl) / cols), b = base + Math.floor(((c + 1) * spl) / cols);
                let lo = Infinity, hi = -Infinity;
                for (let i = a; i < Math.max(b, a + 1); i++) { const v = this.data[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
                if (lo === Infinity) { mn[c] = NaN; mx[c] = NaN; continue; }
                mn[c] = lo - mean; mx[c] = hi - mean;
                maxAbs = Math.max(maxAbs, -mn[c], mx[c]);
            }
            this.lineMean[l] = mean;
            this.lineMaxAbs[l] = n ? maxAbs : 0;
        }
    }

    /** median of non-empty lines' peak amplitude: one big quake must not flatten the rest of the day */
    private referenceAmp() {
        const vals = Array.from(this.lineMaxAbs.subarray(0, this.numLines)).filter(v => v > 0).sort((a, b) => a - b);
        return vals.length ? vals[Math.floor(vals.length / 2)] : 1;
    }

    schedule() {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.render(); });
    }

    render() {
        const ctx = this.ctx, c = this.colors, p = this.plot;
        const cols = Math.floor(p.width);
        this.buildEnvelopes(cols);

        ctx.fillStyle = c.background;
        ctx.fillRect(0, 0, p.w, p.h);
        ctx.font = this.font;
        ctx.textBaseline = 'middle';

        // header: title left, timezone right
        ctx.fillStyle = c.text;
        ctx.textAlign = 'left';
        if (this.title) ctx.fillText(this.title, p.x, 12);
        ctx.fillStyle = c.mutedText;
        ctx.textAlign = 'right';
        ctx.fillText(`Time (${this.timeMode})`, p.x + p.width, 12);

        // grid + bottom axis: seconds for lines up to 2 min (a 1-min line would only get '0' and '1'), minutes above
        const lineSec = this.lineDurationSec;
        const inSec = lineSec <= 120;
        const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(st => (st / lineSec) * p.width >= 60) || lineSec;
        ctx.textAlign = 'center';
        for (let t = 0; t <= lineSec + 1e-9; t += step) {
            const gx = p.x + (t / lineSec) * p.width;
            ctx.strokeStyle = c.grid;
            ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(gx, p.y); ctx.lineTo(gx, p.y + p.height); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = c.text;
            ctx.fillText(inSec ? `${t}` : `${+(t / 60).toFixed(1)}`, gx, p.y + p.height + 10);
        }
        ctx.fillText(inSec ? 'Seconds' : 'Minutes', p.x + p.width / 2, p.y + p.height + 22);

        const scale = (p.lineH * 0.25 * this.gain) / this.referenceAmp();
        const lim = this.clip ? p.lineH : Infinity;
        const showSec = this.lineDurationSec < 60;
        // thin rows: label every k-th line so the times never overlap (~12px per label)
        const labelEvery = Math.max(1, Math.ceil(12 / p.lineH));

        for (let l = 0; l < this.numLines; l++) {
            const mid = p.y + (l + 0.5) * p.lineH;
            const lineStart = this.startMs + l * this.lineDurationSec * 1000;
            if (l % labelEvery === 0) {
                ctx.fillStyle = c.text;
                ctx.textAlign = 'right';
                ctx.fillText(formatTime(lineStart, this.timeMode, showSec), p.x - 8, mid);
                ctx.textAlign = 'left';
                ctx.fillText(formatTime(lineStart + this.lineDurationSec * 1000, this.timeMode, showSec), p.x + p.width + 8, mid);
            }

            const mn = this.envMin[l], mx = this.envMax[l];
            ctx.strokeStyle = c.lineColors[l % c.lineColors.length];
            ctx.lineWidth = 1;
            ctx.beginPath();
            let pen = false;
            for (let col = 0; col < cols; col++) {
                if (mn[col] !== mn[col]) { pen = false; continue; } // NaN = gap
                const y1 = mid - Math.max(-lim, Math.min(lim, mx[col] * scale));
                const y2 = mid - Math.max(-lim, Math.min(lim, mn[col] * scale));
                const xx = p.x + col + 0.5;
                if (!pen) { ctx.moveTo(xx, y1); pen = true; } else ctx.lineTo(xx, y1);
                ctx.lineTo(xx, y2);
            }
            ctx.stroke();
        }

        // markers on their line
        ctx.textAlign = 'left';
        for (const pw of this.pWaves) {
            const off = (pw.t - this.startMs) / 1000 / this.lineDurationSec;
            if (off < 0 || off >= this.numLines) continue;
            const l = Math.floor(off);
            const px = p.x + (off - l) * p.width;
            const top = p.y + l * p.lineH;
            ctx.strokeStyle = c.marker;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + p.lineH); ctx.stroke();
            const mag = Number(pw.magnitude);
            const label = `${pw.name ?? 'P'}${Number.isFinite(mag) ? ` M${mag.toFixed(1)}` : ''}`;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = c.marker;
            ctx.fillRect(px + 2, top, tw + 6, 12);
            ctx.fillStyle = c.markerText;
            ctx.fillText(label, px + 5, top + 6);
        }

        // hover: line highlight + time readout
        const t = this.mouseX >= 0 ? this.timeAt(this.mouseX, this.mouseY) : null;
        if (t !== null) {
            const l = Math.floor((this.mouseY - p.y) / p.lineH);
            ctx.strokeStyle = c.crosshair;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(p.x, p.y + l * p.lineH, p.width, p.lineH);
            ctx.beginPath(); ctx.moveTo(this.mouseX, p.y + l * p.lineH); ctx.lineTo(this.mouseX, p.y + (l + 1) * p.lineH); ctx.stroke();
            ctx.setLineDash([]);
            const label = `${formatTime(t, this.timeMode)} ${this.timeMode}`;
            const tw = ctx.measureText(label).width;
            const tx = Math.min(p.x + p.width - tw - 8, this.mouseX + 8);
            const ty = Math.max(p.y + 8, p.y + l * p.lineH - 8);
            ctx.fillStyle = c.tooltipBg;
            ctx.fillRect(tx - 4, ty - 8, tw + 8, 16);
            ctx.fillStyle = c.tooltipText;
            ctx.fillText(label, tx, ty);
        }
    }

    destroy() {
        cancelAnimationFrame(this.rafId);
        this.resizeObserver?.disconnect();
        this.canvas.removeEventListener('mousemove', this.onMove);
        this.canvas.removeEventListener('mouseleave', this.onLeave);
        this.canvas.removeEventListener('click', this.onClickEvt);
        window.removeEventListener('resize', this.onResize);
    }
}

export { HELI_COLORS };
export type { HeliPalette };

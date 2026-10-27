/**
 * Exact Raspberry Shake DataView Client-Side Seismic Spectrogram & Waveform Engine
 * Replicates the authentic DataView pipeline (rasp_shake/main.js):
 *  - 256-point Radix-2 RealFFT with 5% Cosine Taper
 *  - 8-Stop Inferno Colormap
 *  - Pitch Black Plot Canvas with Cyan Waveform & Spectrogram
 *  - 1-Pixel Circular GPU Blit
 *  - Full Historical Window Hydration
 *  - Real UTC Time Axis
 */

import { formatTime } from './time';
import type { PWave, Samples, ThemeName, ViewMode, YMode } from './types';

type RGBA = [number, number, number, number]
type Sensitivity = 'normal' | 'high' | 'low'

class InfernoColormap {
    size: number;
    lowerRange: number;
    upperRange: number;
    rangeInv: number;
    stops: { pos: number; color: RGBA }[];
    table: RGBA[];

    constructor(size = 512) {
        this.size = size;
        this.lowerRange = -1.0;
        this.upperRange = 6.0;
        this.rangeInv = 1.0 / (this.upperRange - this.lowerRange);

        // Exact stops extracted from Raspberry Shake DataView (so.generateInferno())
        this.stops = [
            { pos: 0.0000000000000000, color: [1, 0, 4, 255] },
            { pos: 0.1428571428571428, color: [48, 7, 84, 255] },
            { pos: 0.2857142857142857, color: [105, 15, 111, 255] },
            { pos: 0.4285714285714285, color: [158, 40, 100, 255] },
            { pos: 0.5714285714285714, color: [208, 72, 67, 255] },
            { pos: 0.7142857142857142, color: [239, 125, 21, 255] },
            { pos: 0.8571428571428571, color: [242, 194, 35, 255] },
            { pos: 1.0000000000000000, color: [245, 255, 163, 255] }
        ];

        this.table = new Array(this.size);
        this.compile();
    }

    setDynamicRange(lower: number, upper: number) {
        if (upper > lower) {
            this.lowerRange = lower;
            this.upperRange = upper;
            this.rangeInv = 1.0 / (this.upperRange - this.lowerRange);
        }
    }

    compile() {
        for (let i = 0; i < this.size; i++) {
            const t = i / (this.size - 1);
            let c: RGBA = this.stops[0].color;
            for (let j = 1; j < this.stops.length; j++) {
                if (t <= this.stops[j].pos) {
                    const t0 = this.stops[j - 1].pos;
                    const t1 = this.stops[j].pos;
                    const factor = (t - t0) / (t1 - t0);
                    const c0 = this.stops[j - 1].color;
                    const c1 = this.stops[j].color;
                    c = [
                        Math.round(c0[0] + (c1[0] - c0[0]) * factor),
                        Math.round(c0[1] + (c1[1] - c0[1]) * factor),
                        Math.round(c0[2] + (c1[2] - c0[2]) * factor),
                        255
                    ];
                    break;
                }
            }
            this.table[i] = c;
        }
    }

    colorAt(logPower: number) {
        let idx = Math.floor((logPower - this.lowerRange) * (this.size - 1) * this.rangeInv);
        if (idx < 0) idx = 0;
        else if (idx >= this.size) idx = this.size - 1;
        return this.table[idx];
    }
}

/**
 * Radix-2 Real FFT implementation with 5% Cosine Tapering
 */
class RealFFT {
    n: number;
    re: Float32Array;
    im: Float32Array;
    taper: Float32Array;

    constructor(n = 256) {
        this.n = n;
        this.re = new Float32Array(n);
        this.im = new Float32Array(n);
        this.taper = new Float32Array(n);

        const a = Math.floor(n * 0.05);
        for (let i = 0; i < n; i++) {
            if (i < a) {
                this.taper[i] = 0.5 * (1 - Math.cos((Math.PI * i) / a));
            } else if (i >= n - a) {
                this.taper[i] = 0.5 * (1 - Math.cos((Math.PI * (n - 1 - i)) / a));
            } else {
                this.taper[i] = 1.0;
            }
        }
    }

    forward(input: Samples) {
        const n = this.n;
        const re = this.re;
        const im = this.im;

        for (let i = 0; i < n; i++) {
            re[i] = (i < input.length ? input[i] : 0.0) * this.taper[i];
            im[i] = 0.0;
        }

        let j = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < j) {
                const tr = re[i]; re[i] = re[j]; re[j] = tr;
                const ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
            let k = n >> 1;
            while (k <= j) {
                j -= k;
                k >>= 1;
            }
            j += k;
        }

        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const angle = (-2 * Math.PI) / len;
            const wstep_r = Math.cos(angle);
            const wstep_i = Math.sin(angle);

            for (let i = 0; i < n; i += len) {
                let wr = 1.0;
                let wi = 0.0;
                for (let k = 0; k < half; k++) {
                    const pos = i + k;
                    const match = pos + half;
                    const tr = wr * re[match] - wi * im[match];
                    const ti = wr * im[match] + wi * re[match];
                    re[match] = re[pos] - tr;
                    im[match] = im[pos] - ti;
                    re[pos] += tr;
                    im[pos] += ti;

                    const next_wr = wr * wstep_r - wi * wstep_i;
                    const next_wi = wr * wstep_i + wi * wstep_r;
                    wr = next_wr;
                    wi = next_wi;
                }
            }
        }

        const numBins = n >> 1;
        const psd = new Float32Array(numBins);
        const norm = 1.0 / n;
        for (let i = 0; i < numBins; i++) {
            const r = re[i] * norm;
            const c = im[i] * norm;
            const power = r * r + c * c;
            // floor must sit far below real data: 1e-15 m/s samples give power ~1e-32, and a 1e-28 floor
            // flattened every bin to the same value (blank spectrogram). Colormap is relative to the noise floor, so absolute scale is fine.
            psd[i] = power > 0 ? Math.log10(power) : -300.0;
        }
        return psd;
    }
}

/**
 * All colours and fonts used by the widget, per theme. Change them here only.
 * Per-instance overrides: new RaspTraceWidget(canvas, { colors: { white: { text: '#111' } } })
 * or at runtime: widget.setColors('dark', { trace: '#0f0' }).
 */
const DEFAULT_COLORS = {
    white: {
        background: '#ffffff',
        frame: '#cbd5e1',
        text: '#000000',            // tick labels, time labels, axis titles
        mutedText: '#475569',       // timezone badge, 'Buffering ...' message
        tick: '#000000',            // short axis tick dashes
        grid: 'rgba(100, 116, 139, 0.35)', // dashed grid lines across the plot
        zeroLine: 'rgba(2, 132, 199, 0.2)',
        trace: '#0284c7',
        crosshair: 'rgba(2, 132, 199, 0.55)',
        tooltipBg: 'rgba(255, 255, 255, 0.96)',
        tooltipBorder: '#0284c7',
        tooltipText: '#0284c7',
        scaleBadgeBg: 'rgba(255, 255, 255, 0.85)',  // amplitude scale/unit badge (top-left of waveform)
        scaleBadgeBorder: '#cbd5e1',
        scaleBadgeText: '#000000',
    },
    dark: {
        background: '#000000',
        frame: '#172a45',
        text: '#e2e8f0',
        mutedText: '#94a3b8',
        tick: '#e2e8f0',
        grid: 'rgba(148, 163, 184, 0.3)',
        zeroLine: 'rgba(0, 229, 255, 0.15)',
        trace: '#00e5ff',
        crosshair: 'rgba(0, 229, 255, 0.4)',
        tooltipBg: 'rgba(12, 25, 44, 0.92)',
        tooltipBorder: '#0284c7',
        tooltipText: '#7dd3fc',
        scaleBadgeBg: 'rgba(0, 0, 0, 0.7)',
        scaleBadgeBorder: '#334155',
        scaleBadgeText: '#e2e8f0',
    },
    // same in both themes (drawn on the dark spectrogram or on coloured badges)
    shared: {
        spectroBackground: '#010004',
        bedloadLine: 'rgba(0, 229, 255, 0.85)',
        bedloadText: '#00e5ff',
        noiseLine: 'rgba(192, 132, 252, 0.85)',
        noiseText: '#c084fc',
        pWaveLine: 'rgba(239, 68, 68, 0.9)',
        pWaveTag: 'rgba(239, 68, 68, 0.95)',
        pWaveText: '#ffffff',
        flagBase: 'rgba(37, 99, 235, 0.95)',
        flag: 'rgba(22, 163, 74, 0.95)',
        pausedBadge: 'rgba(245, 158, 11, 0.95)',
        pausedText: '#000000',
    },
};

type ThemeColors = typeof DEFAULT_COLORS.white
type Palette = ThemeColors & typeof DEFAULT_COLORS.shared
type Fonts = typeof DEFAULT_FONTS

const DEFAULT_FONTS = {
    label: '10px monospace',        // tick + time labels, tooltip
    title: 'bold 10px monospace',   // axis titles, 'Time', badges
    small: '9px monospace',         // corridor labels on the spectrogram
    message: '12px monospace',      // 'Buffering ...' message
    scale: 'bold 12px monospace',   // amplitude scale/unit badge, e.g. '×10⁻¹⁴ m/s'
};

// tick dash length and gap between tick and its label, shared by amplitude + frequency axes
const TICK_LEN = 5;
const TICK_LABEL_GAP = 8;

/**
 * Authentic Raspberry Shake DataView Trace Controller
 */
// user time flag on the compare page; t = UTC ms, derived from datetime
export interface TraceFlag {
    id: string;
    datetime: string;
    label?: string;
    isBase?: boolean;
    channel_code?: string;
}
type PlacedFlag = TraceFlag & { t: number }
type PlacedPWave = PWave & { t: number }

export interface RaspTraceWidgetOptions {
    fftSize?: number;
    sampleRate?: number;
    stepSamples?: number;
    stationId?: string;
    viewMode?: ViewMode;
    theme?: ThemeName;
    colors?: Partial<Record<ThemeName, Partial<Palette>>>;
    fonts?: Partial<Fonts>;
    timeMode?: string; // 'local' or an IANA timezone
    timeWindowSec?: number;
    unit?: string;
    channel?: string;
    yMode?: YMode;
    displayHeight?: number;
    sensitivityPreset?: string;
    pWaves?: PWave[];
    flagEditable?: boolean;
    onTimeWindowChange?: ((sec: number | null) => void) | null;
    onPanChange?: ((sec: number) => void) | null;
    onFlagAdd?: ((t: number) => void) | null;
    onFlagMove?: ((id: string, t: number) => void) | null;
    onFlagRemove?: ((id: string) => void) | null;
}

interface WaveLayout {
    y: number; height: number; midY: number; scaleY: number; mean: number; base: number; raw: boolean;
    startIdx: number; len: number; plotStartX: number; plotDataWidth: number; ampScale: number; expLabel: string; unitLabel: string;
}

class RaspTraceWidget {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    fftSize: number;
    numBins: number;
    sampleRate: number;
    stepSamples: number;
    stationId: string;
    viewMode: ViewMode;
    theme: ThemeName;
    palette: Record<ThemeName, Palette>;
    fonts: Fonts;
    timeMode: string;
    timeWindowSec: number;
    unit: string;
    channel: string;
    yMode: YMode;
    isPaused: boolean;
    originalDisplayHeight: number;
    fft: RealFFT;
    colormap: InfernoColormap;
    rollingBaselinePower: number | null;
    sensitivityPreset: Sensitivity;
    buffer: number[];
    pWaves: PlacedPWave[];
    maxBufferLength: number;
    offscreenWidth: number;
    offscreenHeight: number;
    offscreenCanvas: HTMLCanvasElement;
    offscreenCtx: CanvasRenderingContext2D;
    rawPsdColumns: (Float32Array | null)[];
    currentX: number;
    lastFftIndex: number;
    totalColumnsPushed: number;
    lastSampleUtc: number;
    tailGapSec: number;
    mouseX: number;
    mouseY: number;
    isHovering: boolean;
    panOffsetSec: number;
    isDragging: boolean;
    dragMoved = false;
    dragStartX: number;
    dragStartPan: number;
    onTimeWindowChange: RaspTraceWidgetOptions['onTimeWindowChange'];
    onPanChange: RaspTraceWidgetOptions['onPanChange'];
    flags: PlacedFlag[];
    flagEditable: boolean;
    onFlagAdd: RaspTraceWidgetOptions['onFlagAdd'];
    onFlagMove: RaspTraceWidgetOptions['onFlagMove'];
    onFlagRemove: RaspTraceWidgetOptions['onFlagRemove'];
    draggingFlag: PlacedFlag | null;
    flagGrab: { x: number; dt: number; moved: boolean } = { x: 0, dt: 0, moved: false };
    clickTimer: ReturnType<typeof setTimeout> | undefined;
    resizeObserver?: ResizeObserver;
    rafId = 0;
    resetBtn: { x: number; y: number; w: number; h: number } | null = null;
    waveLayout: WaveLayout | null = null;
    spectroLayout: { y: number; height: number; nyquist: number } | null = null;
    handleMouseDown!: (e: MouseEvent) => void;
    handleMouseMove!: (e: MouseEvent) => void;
    handleMouseUp!: (e: MouseEvent) => void;
    handleMouseLeave!: () => void;
    handleWheel!: (e: WheelEvent) => void;
    handleContextMenu!: (e: MouseEvent) => void;
    handleDblClick!: () => void;
    handleResize!: () => void;

    constructor(canvasElement: HTMLCanvasElement, options: RaspTraceWidgetOptions = {}) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d')!;

        this.fftSize = options.fftSize || 256;
        this.numBins = this.fftSize >> 1; // 128 frequency bins
        this.sampleRate = options.sampleRate || 100.0;
        this.stepSamples = options.stepSamples || 64;
        this.stationId = options.stationId || 'AM.S8618.00.EHZ';

        this.viewMode = options.viewMode || 'dual'; // dual view by default: dual | waveform | spectrogram
        this.theme = options.theme || 'white';
        // resolved once here; render code only reads this.colors / this.fonts
        this.palette = {
            white: { ...DEFAULT_COLORS.shared, ...DEFAULT_COLORS.white, ...(options.colors?.white || {}) },
            dark: { ...DEFAULT_COLORS.shared, ...DEFAULT_COLORS.dark, ...(options.colors?.dark || {}) },
        };
        this.fonts = { ...DEFAULT_FONTS, ...(options.fonts || {}) };
        this.timeMode = options.timeMode || 'local';
        if(this.timeMode === 'local') this.timeMode = Intl.DateTimeFormat().resolvedOptions().timeZone;
        this.timeWindowSec = options.timeWindowSec || 120.0; // 2 minutes default rolling view
        this.unit = options.unit || 'm/s';
        this.channel = options.channel || '';
        this.yMode = options.yMode || 'offset'; // offset: mean removed (centre = 0) | raw: labels show real values
        this.isPaused = false;
        this.originalDisplayHeight = options.displayHeight || 430;
        // this.dualViewHeight = this.canvas.height / 2;

        this.fft = new RealFFT(this.fftSize);
        this.colormap = new InfernoColormap(512);
        this.rollingBaselinePower = null;
        this.sensitivityPreset = this.normalizePreset(options.sensitivityPreset || 'normal');
        this.updateColormapRange();

        this.buffer = [];
        this.maxBufferLength = this.sampleRate * 900; // 900s of samples

        // Offscreen Spectrogram Canvas (1000 pixels wide)
        this.offscreenWidth = 1000;
        this.offscreenHeight = this.numBins;
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = this.offscreenWidth;
        this.offscreenCanvas.height = this.offscreenHeight;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true })!;
        this.rawPsdColumns = new Array(this.offscreenWidth).fill(null);

        this.clearOffscreen();
        this.fitToSamples(this.maxBufferLength);

        this.currentX = 0;
        this.lastFftIndex = 0;
        this.totalColumnsPushed = 0;
        this.lastSampleUtc = Date.now();
        this.tailGapSec = 0; // seconds of empty space between the newest sample and the right edge

        this.mouseX = -1;
        this.mouseY = -1;
        this.isHovering = false;

        this.panOffsetSec = 0.0;
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartPan = 0;
        this.onTimeWindowChange = options.onTimeWindowChange || null;
        this.onPanChange = options.onPanChange || null;

        // P-wave flags: [{ name, magnitude, datetime (ISO), t (ms) }]
        this.pWaves = [];
        if (options.pWaves) this.setPWaves(options.pWaves);

        // user time flags (compare page): [{ id, label, isBase, datetime, t }]; click adds, drag moves
        this.flags = [];
        this.flagEditable = !!options.flagEditable; // off = flags only drawn, click/drag pan as usual
        this.onFlagAdd = options.onFlagAdd || null;
        this.onFlagMove = options.onFlagMove || null;
        this.onFlagRemove = options.onFlagRemove || null;
        this.draggingFlag = null;
        this.clickTimer = undefined;

        this.setupEventListeners();
        this.resize();

        // window 'resize' misses container changes (sidebar open/close, flex reflow); observe the parent instead
        if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(this.canvas.parentElement);
        }

        this.render = this.render.bind(this);
        this.rafId = requestAnimationFrame(this.render);
    }

    setDisplayHeight(height: number) {
        if (!height || height <= 0) return;
        this.originalDisplayHeight = height;
        this.resize();
    }

    setTimeMode(mode: string) {
        this.timeMode = mode;
    }

    getTimeStr(timestamp: number) {
        return formatTime(timestamp, this.timeMode)
    }



    /** back to live + default zoom (double-click or the in-canvas reset button) */
    resetView() {
        this.panOffsetSec = 0.0;
        if (this.onPanChange) this.onPanChange(0.0);
        // a listening parent owns the zoom: null = back to its default window; standalone falls back to 120s
        if (this.onTimeWindowChange) this.onTimeWindowChange(null);
        else this.timeWindowSec = 120.0;
    }

    /** pan set from outside (linked channels); clamped like a drag */
    setPanOffset(sec: number) {
        const maxPan = Math.max(0, (this.buffer.length / this.sampleRate) - 5.0);
        this.panOffsetSec = Math.max(0, Math.min(maxPan, sec || 0));
    }

    setTimeWindow(sec: number | null | undefined) {
        if (sec && sec > 0) {
            this.timeWindowSec = sec;
        }
    }

    setTheme(theme: ThemeName) {
        this.theme = theme;
    }

    /** current theme's colours ('white' -> white palette, anything else -> dark) */
    get colors() {
        return this.theme === 'white' ? this.palette.white : this.palette.dark;
    }

    /** override colours at runtime, e.g. setColors('white', { text: '#111' }) */
    setColors(theme: ThemeName, overrides: Partial<Palette> = {}) {
        const key = theme === 'white' ? 'white' : 'dark';
        this.palette[key] = { ...this.palette[key], ...overrides };
    }

    /** x of a P-wave flag inside a plot starting at x with given width, or null when outside the time window */
    pWaveX(p: { t: number }, x: number, width: number) {
        const rightMs = this.lastSampleUtc - this.panOffsetSec * 1000;
        const secAgo = (rightMs - p.t) / 1000;
        if (secAgo < 0 || secAgo > this.timeWindowSec) return null;
        return x + width - (secAgo / this.timeWindowSec) * width;
    }

    /** horizontal tick dash on the axis + faint dashed grid line across the plot */
    drawTick(ctx: CanvasRenderingContext2D, x: number, yPos: number, width: number) {
        const c = this.colors;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = c.tick;
        ctx.beginPath();
        ctx.moveTo(x - TICK_LEN, yPos);
        ctx.lineTo(x, yPos);
        ctx.stroke();
        ctx.strokeStyle = c.grid;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, yPos);
        ctx.lineTo(x + width, yPos);
        ctx.stroke();
        ctx.restore();
    }

    clearOffscreen() {
        this.offscreenCtx.fillStyle = DEFAULT_COLORS.shared.spectroBackground;
        this.offscreenCtx.fillRect(0, 0, this.offscreenWidth, this.offscreenHeight);
        if (this.rawPsdColumns) {
            this.rawPsdColumns.fill(null);
        }
    }

    setOnTimeWindowChange(fn: RaspTraceWidgetOptions['onTimeWindowChange']) {
        this.onTimeWindowChange = fn;
    }

    setOnPanChange(fn: RaspTraceWidgetOptions['onPanChange']) {
        this.onPanChange = fn;
    }

    /** plot area in CSS px, same geometry as render() */
    plotRect() {
        const rect = this.canvas.getBoundingClientRect();
        return { rect, x: 55, width: rect.width - 85 };
    }

    /** UTC ms under a mouse x (inverse of pWaveX), or null outside the plot */
    timeAtClientX(clientX: number) {
        const { rect, x, width } = this.plotRect();
        const mx = clientX - rect.left;
        if (mx < x || mx > x + width) return null;
        const rightMs = this.lastSampleUtc - this.panOffsetSec * 1000;
        return rightMs - ((x + width - mx) / width) * this.timeWindowSec * 1000;
    }

    flagAtClientX(clientX: number) {
        const { rect, x, width } = this.plotRect();
        const mx = clientX - rect.left;
        // nearest flag within 6px, so two close flags grab the one under the cursor, not the first in the list
        let best: PlacedFlag | null = null, bestDist = 6;
        for (const f of this.flags) {
            const px = this.pWaveX(f, x, width);
            if (px === null) continue;
            const d = Math.abs(px - mx);
            if (d <= bestDist) { best = f; bestDist = d; }
        }
        return best;
    }

    setupEventListeners() {
        this.handleMouseDown = (e) => {
            if (e.button !== 0) return; // Left click only
            const b = this.resetBtn;
            if (b) {
                const rect = this.canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                    this.resetView();
                    return;
                }
            }
            const flag = this.flagEditable ? this.flagAtClientX(e.clientX) : null;
            if (flag) {
                this.draggingFlag = flag;
                // grab offset: the flag was picked up to 6px away, keep that gap instead of jumping the line to the cursor
                const t0 = this.timeAtClientX(e.clientX);
                this.flagGrab = { x: e.clientX, dt: t0 === null ? 0 : flag.t - t0, moved: false };
                this.canvas.style.cursor = 'ew-resize';
                return;
            }
            this.isDragging = true;
            this.dragMoved = false; // pan starts only past a small threshold, so a click never shifts the view
            this.dragStartX = e.clientX;
            this.dragStartPan = this.panOffsetSec;
            this.canvas.style.cursor = 'grabbing';
        };

        this.handleMouseMove = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            // CSS px: the context is already scaled by devicePixelRatio, render() draws in CSS px
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.isHovering = true;

            if (this.draggingFlag) {
                const g = this.flagGrab;
                // same 4px threshold as pan: a plain click on a flag must not nudge it
                if (!g.moved && Math.abs(e.clientX - g.x) < 4) return;
                g.moved = true;
                const t = this.timeAtClientX(e.clientX);
                if (t !== null) this.draggingFlag.t = t + g.dt;
                return;
            }

            if (this.isDragging) {
                const dx = e.clientX - this.dragStartX;
                if (!this.dragMoved && Math.abs(dx) < 4) return;
                this.dragMoved = true;
                const plotWidth = Math.max(10, this.plotRect().width);
                const secPerPixel = this.timeWindowSec / plotWidth;
                // Dragging right pulls older samples into view (increases panOffsetSec)
                const deltaSec = dx * secPerPixel;
                const maxPan = Math.max(0, (this.buffer.length / this.sampleRate) - 5.0);
                this.panOffsetSec = Math.max(0, Math.min(maxPan, this.dragStartPan + deltaSec));
                if (this.onPanChange) this.onPanChange(this.panOffsetSec);
            } else {
                this.canvas.style.cursor = this.flagEditable && this.flagAtClientX(e.clientX) ? 'ew-resize' : 'grab';
            }
        };

        this.handleMouseUp = () => {
            if (this.draggingFlag) {
                const f = this.draggingFlag;
                this.draggingFlag = null;
                if (this.canvas) this.canvas.style.cursor = 'grab';
                if (this.onFlagMove && this.flagGrab.moved) this.onFlagMove(f.id, f.t);
                return;
            }
            if (this.isDragging) {
                this.isDragging = false;
                if (this.canvas) this.canvas.style.cursor = 'grab';
                // barely moved = click: add a flag, delayed so a double-click (reset view) can cancel it
                const t = this.flagEditable && this.onFlagAdd && !this.dragMoved ? this.timeAtClientX(this.dragStartX) : null; // press point, not release (hand jitter up to 4px)
                if (t !== null) {
                    clearTimeout(this.clickTimer);
                    this.clickTimer = setTimeout(() => this.onFlagAdd?.(t), 250);
                }
            }
        };

        this.handleMouseLeave = () => {
            this.isHovering = false;
            this.mouseX = -1;
            this.mouseY = -1;
            if (this.isDragging) {
                this.isDragging = false;
                if (this.canvas) this.canvas.style.cursor = 'grab';
            }
        };

        this.handleWheel = (e) => {
            e.preventDefault();
            const zoomIn = e.deltaY < 0;
            const factor = zoomIn ? 0.82 : 1.22;
            const minWindow = 2.0; // 2s min window (max zoom in); below this the spectrogram has too few FFT columns
            const maxWindow = 900.0; // 15min max window
            const newWindow = Math.max(minWindow, Math.min(maxWindow, this.timeWindowSec * factor));

            if (Math.abs(newWindow - this.timeWindowSec) > 0.05) {
                const { rect, x, width } = this.plotRect();
                const plotWidth = Math.max(10, width);
                const mousePlotX = Math.max(0, Math.min(plotWidth, (e.clientX - rect.left) - x));
                const fracFromRight = 1.0 - (mousePlotX / plotWidth);

                // keep the time under the mouse fixed: pan + frac * window stays constant
                const windowDiff = newWindow - this.timeWindowSec;
                const maxPan = Math.max(0, (this.buffer.length / this.sampleRate) - 5.0);
                const newPan = Math.max(0, Math.min(maxPan, this.panOffsetSec - windowDiff * fracFromRight));
                if (newPan !== this.panOffsetSec) {
                    this.panOffsetSec = newPan;
                    if (this.onPanChange) this.onPanChange(this.panOffsetSec);
                }

                this.timeWindowSec = newWindow;
                if (this.onTimeWindowChange) {
                    this.onTimeWindowChange(this.timeWindowSec);
                }
            }
        };

        // right-click on a flag removes it (only while flags are editable; otherwise the normal browser menu)
        this.handleContextMenu = (e) => {
            const flag = this.flagEditable ? this.flagAtClientX(e.clientX) : null;
            if (!flag) return;
            e.preventDefault();
            if (this.onFlagRemove) this.onFlagRemove(flag.id);
        };

        this.handleDblClick = () => {
            clearTimeout(this.clickTimer);
            this.resetView();
        };

        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        window.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
        this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
        this.canvas.addEventListener('dblclick', this.handleDblClick);
        this.canvas.addEventListener('contextmenu', this.handleContextMenu);
        this.canvas.style.cursor = 'grab';

        this.handleResize = () => {
            this.resize();
        };
        window.addEventListener('resize', this.handleResize);
    }

    destroy() {
        // stop render loop, otherwise destroyed widgets keep painting the same canvas
        cancelAnimationFrame(this.rafId);
        clearTimeout(this.clickTimer);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this.handleMouseDown);
            this.canvas.removeEventListener('mousemove', this.handleMouseMove);
            this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
            this.canvas.removeEventListener('wheel', this.handleWheel);
            this.canvas.removeEventListener('dblclick', this.handleDblClick);
            this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
        }
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('resize', this.handleResize);
    }

    get displayHeight() {
        return (this.viewMode === 'dual') ? this.originalDisplayHeight : this.originalDisplayHeight * 0.70;
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const dpr = window.devicePixelRatio || 1;
        // content box, not border box: the canvas is 100% of the parent's content width, so sizing it to the
        // padded width made the browser squeeze the drawing and mouse x no longer matched drawn x (flags/clicks off)
        const rect = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const displayWidth = Math.floor(rect.width - padX) || 768;
        const displayHeight = this.displayHeight; // default 420px

        if (this.canvas.width !== displayWidth * dpr || this.canvas.height !== displayHeight * dpr) {
            this.canvas.width = displayWidth * dpr;
            this.canvas.height = displayHeight * dpr;
            // 100% (not px) so the parent can still shrink; a fixed px width blocks flex/grid parents from narrowing
            this.canvas.style.width = '100%';
            this.canvas.style.height = `${displayHeight}px`;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    }

    setSampleRate(sr: number | null | undefined) {
        if (sr && sr > 0 && Math.abs(this.sampleRate - sr) > 0.01) {
            this.sampleRate = sr;
            this.stepSamples = sr <= 50.0 ? 32 : 64;
            this.fitToSamples(sr * 900);
        }
    }

    normalizePreset(preset: string): Sensitivity {
        if (preset === 'high' || preset === 'gain') return 'high';
        if (preset === 'low') return 'low';
        return 'normal';
    }

    updateColormapRange() {
        // Automatically anchors around the station's real background noise floor
        const base = (this.rollingBaselinePower !== null) ? this.rollingBaselinePower : 0.0;
        if (this.sensitivityPreset === 'high') {
            // High gain: compress dynamic range and lower the ceiling so faint tremors & harmonics glow vividly
            this.colormap.setDynamicRange(base - 1.2, base + 3.5);
        } else if (this.sensitivityPreset === 'low') {
            this.colormap.setDynamicRange(base + 0.5, base + 7.5);
        } else {
            this.colormap.setDynamicRange(base - 0.5, base + 5.5);
        }
    }

    recolorAllColumns() {
        let hasAny = false;
        if (this.rawPsdColumns) {
            const height = this.numBins;
            const imgData = this.offscreenCtx.createImageData(1, height);
            const data = imgData.data;

            for (let col = 0; col < this.offscreenWidth; col++) {
                const psd = this.rawPsdColumns[col];
                if (!psd) continue;
                hasAny = true;

                for (let bin = 0; bin < height; bin++) {
                    const freqIndex = (height - 1) - bin;
                    const logPower = psd[freqIndex];
                    const rgb = this.colormap.colorAt(logPower);

                    const offset = bin * 4;
                    data[offset + 0] = rgb[0];
                    data[offset + 1] = rgb[1];
                    data[offset + 2] = rgb[2];
                    data[offset + 3] = 255;
                }
                this.offscreenCtx.putImageData(imgData, col, 0);
            }
        }

        if (!hasAny && this.buffer && this.buffer.length >= this.fftSize) {
            const currentSamples = [...this.buffer];
            this.buffer = [];
            this.clearOffscreen();
            this.currentX = 0;
            this.lastFftIndex = 0;
            this.totalColumnsPushed = 0;
            this.addSamples(currentSamples);
        }
    }

    setStation(stationId: string, sampleRate = 100.0) {
        this.stationId = stationId;
        this.setSampleRate(sampleRate);
        this.rollingBaselinePower = null;
        this.updateColormapRange();
        this.buffer = [];
        this.lastFftIndex = 0;
        this.currentX = 0;
        this.totalColumnsPushed = 0;
        this.clearOffscreen();
    }

    setSensitivity(preset: string) {
        const norm = this.normalizePreset(preset);
        if (this.sensitivityPreset === norm) return;
        this.sensitivityPreset = norm;
        this.updateColormapRange();
        this.recolorAllColumns();
    }

    setViewMode(mode: ViewMode) {
        this.viewMode = mode;
        // canvas pixel size must follow displayHeight (half when not dual), otherwise the old bottom half stays painted
        this.resize();
    }

    setChannel(channel: string | null | undefined) {
        this.channel = channel || '';
    }

    setUnit(unit: string | null | undefined) {
        this.unit = unit || 'm/s';
    }

    setYMode(mode: string) {
        this.yMode = mode === 'raw' ? 'raw' : 'offset';
    }

    setPWaves(list: PWave[] = []) {
        // ISO without Z/offset is parsed as browser local time; backend should send Z or +05:45
        this.pWaves = (Array.isArray(list) ? list : [])
            .map(p => ({ ...p, t: Date.parse(p.datetime) }))
            .filter(p => !Number.isNaN(p.t));
    }

    setFlagEditable(value: boolean) {
        this.flagEditable = !!value;
    }

    setFlags(list: TraceFlag[] = []) {
        this.flags = (Array.isArray(list) ? list : [])
            .map(f => ({ ...f, t: Date.parse(f.datetime) }))
            .filter(f => !Number.isNaN(f.t));
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        return this.isPaused;
    }

    /**
     * Completely hydrates the spectrogram with up to 600s of historical samples on station load,
     * painting all sliding FFT columns across the card so it is 100% filled with NO empty space.
     */
    hydrateHistorical(samples: Samples, sr = 100, lastSampleUtc?: number, dataEndUtc?: number) {
        if (!samples || !samples.length) return;
        this.setSampleRate(sr);
        this.fitToSamples(samples.length);
        this.rollingBaselinePower = null;
        this.buffer = [];
        this.lastFftIndex = 0;
        this.currentX = 0;
        this.totalColumnsPushed = 0;
        this.clearOffscreen();

        this.addSamples(samples, lastSampleUtc);
        // time axis ends at lastSampleUtc but this channel's data ends earlier (late packet): leave that span empty
        this.tailGapSec = (lastSampleUtc && dataEndUtc) ? Math.max(0, (lastSampleUtc - dataEndUtc) / 1000) : 0;
    }

    /**
     * Grow sample buffer + spectrogram column ring so a long history (e.g. 1h) fits entirely.
     * column ring capped at 8192px (browser canvas limit); beyond that the FFT hop grows instead.
     */
    fitToSamples(count: number) {
        this.maxBufferLength = Math.max(this.maxBufferLength, count);
        // ring sized for the whole buffer, not just `count`: a smaller ring (1000 cols = 640s) let the buffer (900s+)
        // outlive its columns, so panning far back showed waveform with no spectrogram
        const need = this.maxBufferLength;

        const maxCols = 8192;
        const colsNeeded = Math.ceil(need / this.stepSamples);
        if (colsNeeded > maxCols) this.stepSamples = Math.ceil(need / maxCols);

        const width = Math.min(maxCols, Math.max(1000, Math.ceil(need / this.stepSamples)));
        if (width !== this.offscreenWidth) {
            this.offscreenWidth = width;
            this.offscreenCanvas.width = width;
            this.rawPsdColumns = new Array(width).fill(null);
            // old ring positions are meaningless now: rebuild every column from the buffer on the next addSamples
            this.clearOffscreen();
            this.currentX = 0;
            this.totalColumnsPushed = 0;
            this.lastFftIndex = 0;
        }
    }

    setLastSampleUtc(lastSampleUtc?: number) {
        this.lastSampleUtc = lastSampleUtc || Date.now();
    }

    addSamples(newSamples: Samples, lastSampleUtc?: number) {
        if (!newSamples || !newSamples.length) return;
        if (this.isPaused) return;

        for (let i = 0; i < newSamples.length; i++) {
            this.buffer.push(newSamples[i]);
        }
        this.lastSampleUtc = lastSampleUtc || Date.now();

        if (this.buffer.length > this.maxBufferLength) {
            const removeCount = this.buffer.length - this.maxBufferLength;
            this.buffer.splice(0, removeCount);
            this.lastFftIndex = Math.max(0, this.lastFftIndex - removeCount);
        }

        while (this.buffer.length - this.lastFftIndex >= this.fftSize) {
            const slice = this.buffer.slice(this.lastFftIndex, this.lastFftIndex + this.fftSize);

            let sum = 0;
            for (let i = 0; i < slice.length; i++) sum += slice[i];
            const mean = sum / slice.length;
            for (let i = 0; i < slice.length; i++) slice[i] -= mean;

            const psd = this.fft.forward(slice);

            // Compute background noise floor (25th percentile of frequency bins)
            const sortedPsd = Array.from(psd).sort((a, b) => a - b);
            const noiseFloor = sortedPsd[32]; // 25th percentile of 128 bins
            if (noiseFloor <= -299) {
                // silent/flat window (gap fill, all-zero data): don't let it drag the colour baseline down
            } else if (this.rollingBaselinePower === null) {
                this.rollingBaselinePower = noiseFloor;
                this.updateColormapRange();
            } else {
                this.rollingBaselinePower = 0.96 * this.rollingBaselinePower + 0.04 * noiseFloor;
                this.updateColormapRange();
            }

            this.fillSpectrogramColumn(psd, this.currentX);

            this.currentX = (this.currentX + 1) % this.offscreenWidth;
            this.totalColumnsPushed++;
            this.lastFftIndex += this.stepSamples;
        }
    }

    fillSpectrogramColumn(psd: Float32Array, colX: number) {
        if (this.rawPsdColumns) {
            this.rawPsdColumns[colX] = (psd instanceof Float32Array) ? psd : new Float32Array(psd);
        }

        const height = this.numBins;
        const imgData = this.offscreenCtx.createImageData(1, height);
        const data = imgData.data;

        for (let bin = 0; bin < height; bin++) {
            const freqIndex = (height - 1) - bin;
            const logPower = psd[freqIndex];
            const rgb = this.colormap.colorAt(logPower);

            const offset = bin * 4;
            data[offset + 0] = rgb[0];
            data[offset + 1] = rgb[1];
            data[offset + 2] = rgb[2];
            data[offset + 3] = 255;
        }

        this.offscreenCtx.putImageData(imgData, colX, 0);
    }

    render() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        // draw over the real canvas size (resize() keeps it in sync with displayHeight/viewMode)
        const h = this.canvas.height / dpr;
        const ctx = this.ctx;
        const c = this.colors;

        // Canvas background
        ctx.fillStyle = c.background;
        ctx.fillRect(0, 0, w, h);

        let waveformH = 0;
        let spectroH = 0;

        if (this.viewMode === 'dual') {
            waveformH = Math.floor(h * 0.42);
            spectroH = h - waveformH;
        } else if (this.viewMode === 'waveform') {
            waveformH = h;
            spectroH = 0;
        } else if (this.viewMode === 'spectrogram') {
            waveformH = 0;
            spectroH = h;
        }

        const leftMargin = 55;
        const bottomMargin = 48;
        const plotWidth = w - leftMargin - 30; // right margin fits half of the last centred 'HH:mm:ss' time label

        // geometry of what was drawn this frame, read by renderCrosshair for hover readouts
        this.waveLayout = null;
        this.spectroLayout = null;

        // 1. Waveform
        if (waveformH > 0) {
            const wavePlotH = (spectroH > 0) ? waveformH - 8 : waveformH - bottomMargin;
            this.renderWaveform(ctx, leftMargin, 8, plotWidth, wavePlotH - 10);
        }

        // 2. Spectrogram
        if (spectroH > 0) {
            const spectroY = (waveformH > 0) ? waveformH : 4;
            const spectroPlotH = spectroH - bottomMargin - 4;
            this.renderSpectrogram(ctx, leftMargin, spectroY, plotWidth, spectroPlotH);
        }

        // P-wave flags across waveform + spectrogram
        this.renderPWaves(ctx, leftMargin, 8, plotWidth, h - bottomMargin - 8);
        this.renderFlags(ctx, leftMargin, 8, plotWidth, h - bottomMargin - 8);

        // 3. Shared Time Axis
        this.renderTimeAxis(ctx, leftMargin, h - bottomMargin, plotWidth, bottomMargin);

        // Reset zoom/pan button, top-right while hovering (hit-tested in handleMouseDown)
        this.resetBtn = null;
        let badgeRight = w - 8;
        if (this.isHovering) {
            ctx.save();
            const label = '⟲ RESET';
            ctx.font = this.fonts.title;
            const bw = ctx.measureText(label).width + 10;
            this.resetBtn = { x: badgeRight - bw, y: 6, w: bw, h: 16 };
            ctx.fillStyle = c.scaleBadgeBg;
            ctx.fillRect(this.resetBtn.x, 6, bw, 16);
            ctx.strokeStyle = c.scaleBadgeBorder;
            ctx.lineWidth = 1;
            ctx.strokeRect(this.resetBtn.x, 6, bw, 16);
            ctx.fillStyle = c.scaleBadgeText;
            ctx.fillText(label, this.resetBtn.x + 5, 18);
            ctx.restore();
            badgeRight = this.resetBtn.x - 4;
        }

        // Historical inspection badge
        if (this.panOffsetSec > 0.05) {
            ctx.save();
            const tag = `PAUSED -${this.panOffsetSec.toFixed(1)}s (DBL-CLICK FOR LIVE)`;
            ctx.font = this.fonts.title;
            const tw = ctx.measureText(tag).width;
            ctx.fillStyle = c.pausedBadge;
            ctx.fillRect(badgeRight - tw - 10, 6, tw + 10, 16);
            ctx.fillStyle = c.pausedText;
            ctx.fillText(tag, badgeRight - tw - 5, 18);
            ctx.restore();
        }

        // 4. Crosshair readout
        if (this.isHovering && this.mouseX >= leftMargin && this.mouseX <= leftMargin + plotWidth) {
            this.renderCrosshair(ctx, leftMargin, 4, plotWidth, h - bottomMargin);
        }

        this.rafId = requestAnimationFrame(this.render);
    }

    renderWaveform(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        const c = this.colors;
        ctx.save();
        ctx.fillStyle = c.background;
        ctx.fillRect(x, y, width, height);

        // Subtle frame
        ctx.strokeStyle = c.frame;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, width, height);

        const midY = y + height / 2;

        // Zero center line
        ctx.strokeStyle = c.zeroLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        ctx.stroke();

        const samplesInWindow = Math.max(10, Math.floor(this.timeWindowSec * this.sampleRate));
        // panning back first eats the empty tail gap, then moves into the buffer
        const rawPan = Math.floor(this.panOffsetSec * this.sampleRate);
        const tailGap = Math.round(this.tailGapSec * this.sampleRate);
        const gapSamples = Math.max(0, tailGap - rawPan);

        if (this.buffer.length > 2 && samplesInWindow - gapSamples > 2) {
            const panSamples = Math.max(0, rawPan - tailGap);
            const availableEnd = Math.max(0, this.buffer.length - panSamples);
            const numSamplesToShow = Math.min(availableEnd, samplesInWindow - gapSamples);
            const startIdx = Math.max(0, availableEnd - numSamplesToShow);
            const slice = this.buffer.slice(startIdx, availableEnd);

            let sum = 0;
            for (let i = 0; i < slice.length; i++) sum += slice[i];
            const mean = sum / slice.length;

            let maxAmp = 0.0;
            for (let i = 0; i < slice.length; i++) {
                const a = Math.abs(slice[i] - mean);
                if (a > maxAmp) maxAmp = a;
            }
            if (maxAmp <= 0) maxAmp = 1.0;

            const gainMult = (this.sensitivityPreset === 'high') ? 2.0 : 1.0;
            const scaleY = ((height * 0.44) / maxAmp) * gainMult;
            
            // Align latest sample to right edge, minus any tail gap
            const plotDataWidth = Math.max(1, (numSamplesToShow / samplesInWindow) * width);
            const plotStartX = x + width - (gapSamples / samplesInWindow) * width - plotDataWidth;
            const ptsPerPixel = slice.length / plotDataWidth;

            // Waveform trace
            ctx.strokeStyle = c.trace;
            ctx.lineWidth = 1.0;
            ctx.beginPath();

            if (ptsPerPixel < 2) {
                // zoomed in: per-pixel min/max reused one sample across several px (staircase); line through each sample instead
                const pxPerPt = plotDataWidth / slice.length;
                for (let i = 0; i < slice.length; i++) {
                    const yy = Math.max(y + 1, Math.min(y + height - 1, midY - (slice[i] - mean) * scaleY));
                    const xx = plotStartX + i * pxPerPt;
                    if (i === 0) ctx.moveTo(xx, yy);
                    else ctx.lineTo(xx, yy);
                }
            } else for (let px = 0; px < plotDataWidth; px++) {
                const pStart = Math.floor(px * ptsPerPixel);
                const pEnd = Math.min(slice.length, Math.floor((px + 1) * ptsPerPixel));

                if (pStart >= slice.length) break;

                let minV = slice[pStart] - mean;
                let maxV = slice[pStart] - mean;
                for (let k = pStart + 1; k < pEnd; k++) {
                    const v = slice[k] - mean;
                    if (v < minV) minV = v;
                    if (v > maxV) maxV = v;
                }

                const rawY1 = midY - maxV * scaleY;
                const rawY2 = midY - minV * scaleY;
                const y1 = Math.max(y + 1, Math.min(y + height - 1, rawY1));
                const y2 = Math.max(y + 1, Math.min(y + height - 1, rawY2));

                if (px === 0) {
                    ctx.moveTo(plotStartX + px, y1);
                    ctx.lineTo(plotStartX + px, y2);
                } else {
                    ctx.lineTo(plotStartX + px, y1);
                    ctx.lineTo(plotStartX + px, y2);
                }
            }
            ctx.stroke();


            // unit comes from the stream (options.unit / setUnit), never guessed from amplitude size:
            // the old '>= 0.05 means COUNTS' guess mislabelled big physical values and small raw counts
            const unitLabel = this.unit;

            // Value at the plot's top edge: maxAmp is drawn at 0.44*height*gain from the centre line, the edge is at 0.5*height.
            // No µ-scaling here: the unit label stays `this.unit`, so values must stay in that unit.
            const displayMax = maxAmp * 0.5 / (0.44 * gainMult);
            // tiny (1e-9, 1e-15 ...) or huge values: pull one shared power of ten into the axis title (×10⁻¹⁴)
            // so tick labels stay short (+3.4, +1.7, 0 ...) and never run into the rotated title
            // raw mode: labels are mean + offset, so the exponent follows the real magnitude
            const raw = this.yMode === 'raw';
            const base = raw ? mean : 0;
            const expRef = raw ? Math.abs(mean) + displayMax : displayMax;
            const ampExp = (expRef < 0.01 || expRef >= 1e4) ? Math.floor(Math.log10(expRef)) : 0;
            const ampScale = Math.pow(10, ampExp);
            // raw: enough decimals to resolve the span (9.840 ± 0.001 must not print the same label 5 times)
            const rawDecimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(displayMax / ampScale / 2)) + 1));
            const fmtAmp = (v: number) => {
                const s = v / ampScale;
                if (raw) return s.toFixed(rawDecimals);
                return s.toFixed(Math.abs(s) >= 10 ? 0 : (ampExp ? 1 : 2));
            };
            const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
            const expLabel = ampExp ? `×10${String(ampExp).replace(/./g, ch => SUP[ch] || ch)} ` : '';

            this.waveLayout = {
                y, height, midY, scaleY, mean, base, raw, startIdx, len: slice.length,
                plotStartX, plotDataWidth, ampScale, expLabel, unitLabel,
            };

            // --- Render 5 Evenly Spaced Y-Axis Labels ---
            const levelsCount = 5;
            ctx.font = this.fonts.label;
            ctx.fillStyle = c.text;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';

            for (let i = 0; i < levelsCount; i++) {
                // Fraction goes from 0.0 (top) to 1.0 (bottom)
                const fraction = i / (levelsCount - 1);

                // Interpolate Y position along chart height
                const labelY = y + fraction * height;

                // Interpolate amplitude value from +displayMax to -displayMax
                const val = displayMax - fraction * (2 * displayMax);

                // Format label (+val, 0, or -val)
                // centre label is exactly 0; don't use an absolute threshold (1e-9 data would all read '0')
                let labelText;
                if (raw) {
                    labelText = fmtAmp(val + base);
                } else if (i * 2 === levelsCount - 1) {
                    labelText = '0';
                } else if (val > 0) {
                    labelText = `+${fmtAmp(val)}`;
                } else {
                    labelText = fmtAmp(val);
                }

                this.drawTick(ctx, x, labelY, width);
                ctx.fillText(labelText, x - TICK_LABEL_GAP, labelY);
            }
            // ctx.font = '12px monospace';
            // ctx.fillStyle = isWhite ? '#475569' : '#94a3b8';
            // ctx.textAlign = 'right';
            // ctx.fillText(topLabel, x - 6, y + 10);
            // ctx.fillText('0', x - 6, midY + 3);
            // ctx.fillText(bottomLabel, x - 6, y + height - 2);
            
            ctx.save();

            ctx.font = this.fonts.title;
            ctx.fillStyle = c.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.translate(14, midY)
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(`Amplitude - (${this.sampleRate})`, 0, 0);
            ctx.restore();

            // scale + unit badge, horizontal in the plot's top-left corner (readable, unlike the rotated title)
            const badgeText = `${expLabel}${unitLabel} · mean ${mean.toPrecision(4)} ${unitLabel} · ${raw ? 'RAW' : 'OFFSET'}`;
            ctx.save();
            ctx.font = this.fonts.scale;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const bw = ctx.measureText(badgeText).width + 10;
            const bh = 18;
            const bx = x + 4;
            // P-wave tags occupy the top ~16px; drop the badge below them if a flag falls in its area
            const flagNear = this.pWaves.some(p => {
                const px = this.pWaveX(p, x, width);
                return px !== null && px < bx + bw + 8;
            });
            const by = y + (flagNear ? 22 : 4);
            ctx.fillStyle = c.scaleBadgeBg;
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeStyle = c.scaleBadgeBorder;
            ctx.lineWidth = 1;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.fillStyle = c.scaleBadgeText;
            ctx.fillText(badgeText, bx + 5, by + bh / 2 + 1);
            ctx.restore();
        } else {
            ctx.font = this.fonts.message;
            ctx.fillStyle = c.mutedText;
            ctx.textAlign = 'center';
            ctx.fillText(`Buffering live stream for ${this.stationId}...`, x + width / 2, midY);
        }

        ctx.restore();
    }

    renderSpectrogram(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        const c = this.colors;
        ctx.save();

        ctx.fillStyle = c.spectroBackground;
        ctx.fillRect(x, y, width, height);

        ctx.imageSmoothingEnabled = false;

        const total = this.offscreenWidth;
        const secPerCol = this.stepSamples / this.sampleRate;
        // not clamped to `total`: clamping stretched short data to full width while the waveform showed it partial
        const colsInWindow = Math.max(5, Math.floor(this.timeWindowSec / secPerCol));
        // same tail-gap handling as the waveform: pan eats the gap first, then scrolls the columns
        const rawPanCols = Math.floor(this.panOffsetSec / secPerCol);
        const tailGapCols = Math.floor(this.tailGapSec / secPerCol);
        const gapCols = Math.max(0, tailGapCols - rawPanCols);
        const N = Math.min(colsInWindow - gapCols, total, this.totalColumnsPushed);

        if (N > 0) {
            const panCols = Math.min(Math.max(0, Math.min(this.totalColumnsPushed, total) - N), Math.max(0, rawPanCols - tailGapCols));
            const headCol = (this.currentX - panCols + total) % total;
            const tailCol = (headCol - N + total) % total;
            const plotDataWidth = (N / colsInWindow) * width;
            const plotStartX = x + width - (gapCols / colsInWindow) * width - plotDataWidth;
            // const plotStartX = x;
            // const plotDataWidth = width;

            if (tailCol + N <= total) {
                // Contiguous segment in circular buffer
                ctx.drawImage(
                    this.offscreenCanvas,
                    tailCol, 0, N, this.offscreenHeight,
                    plotStartX, y, plotDataWidth, height
                );
            } else {
                // Wrapped across circular buffer boundary: draw in two parts
                const seg1Width = total - tailCol;
                const seg2Width = N - seg1Width;
                const splitPlotW = (seg1Width / N) * plotDataWidth;

                if (seg1Width > 0 && splitPlotW > 0) {
                    ctx.drawImage(
                        this.offscreenCanvas,
                        tailCol, 0, seg1Width, this.offscreenHeight,
                        plotStartX, y, splitPlotW, height
                    );
                }
                if (seg2Width > 0 && (plotDataWidth - splitPlotW) > 0) {
                    ctx.drawImage(
                        this.offscreenCanvas,
                        0, 0, seg2Width, this.offscreenHeight,
                        plotStartX + splitPlotW, y, plotDataWidth - splitPlotW, height
                    );
                }
            }
        }

        // Frame
        ctx.strokeStyle = c.frame;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, width, height);

        // Bedload (2-8 Hz) and Ambient (12-20 Hz) Corridors
        const nyquist = this.sampleRate / 2.0;
        this.spectroLayout = { y, height, nyquist };
        const y2hz = y + height - (2.0 / nyquist) * height;
        const y8hz = y + height - (8.0 / nyquist) * height;
        const y12hz = y + height - (12.0 / nyquist) * height;
        const y20hz = y + height - (20.0 / nyquist) * height;

        ctx.lineWidth = 1;

        // Bedload 2–8 Hz
        if (y2hz >= y && y2hz <= y + height && y8hz >= y && y8hz <= y + height) {
            ctx.strokeStyle = c.bedloadLine;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(x, y2hz); ctx.lineTo(x + width, y2hz);
            ctx.moveTo(x, y8hz); ctx.lineTo(x + width, y8hz);
            ctx.stroke();

            ctx.font = this.fonts.small;
            ctx.fillStyle = c.bedloadText;
            ctx.textAlign = 'right';
            ctx.fillText('8.0 Hz [Bedload]', x + width - 6, y8hz - 3);
            ctx.fillText('2.0 Hz [Bedload]', x + width - 6, y2hz - 3);
        }

        // Ambient 12–20 Hz
        if (y12hz >= y && y12hz <= y + height && y20hz >= y && y20hz <= y + height) {
            ctx.strokeStyle = c.noiseLine;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(x, y12hz); ctx.lineTo(x + width, y12hz);
            ctx.moveTo(x, y20hz); ctx.lineTo(x + width, y20hz);
            ctx.stroke();

            ctx.font = this.fonts.small;
            ctx.fillStyle = c.noiseText;
            ctx.textAlign = 'right';
            ctx.fillText('20.0 Hz [Noise]', x + width - 6, y20hz - 3);
            ctx.fillText('12.0 Hz [Noise]', x + width - 6, y12hz - 3);
        }

        ctx.setLineDash([]);

        // Y-axis Frequency Labels
        ctx.font = this.fonts.label;
        ctx.fillStyle = c.text;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        // pick the smallest step that keeps labels >= 18px apart (5 Hz in tall dual view, 10 Hz in the shorter single view)
        const freqStep = [5, 10, 20, 25].find(step => (step / nyquist) * height >= 18) || 25;
        for (let freq = freqStep; freq <= nyquist; freq += freqStep) {
          const yf = y + height - (freq / nyquist) * height;
          if (yf >= y + 5 && yf <= y + height - 5) {
              this.drawTick(ctx, x, yf, width);
              ctx.fillText(`${freq}`, x - TICK_LABEL_GAP, yf);
          }
        }

        // 0 Hz sits on the bottom frame line: tick only, no grid line
        ctx.save();
        ctx.strokeStyle = c.tick;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - TICK_LEN, y + height);
        ctx.lineTo(x, y + height);
        ctx.stroke();
        ctx.restore();
        ctx.fillText('0', x - TICK_LABEL_GAP, y + height - 4);
       // --- Rotated Axis Label ---
        ctx.save();
        ctx.font = this.fonts.title;
        ctx.fillStyle = c.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Move to the middle of the Y axis
        const labelX = 12; // Adjust padding from canvas edge as needed
        const labelY = y + height / 2;
        ctx.translate(labelX, labelY);

        // Rotate -90 degrees for vertical text reading bottom-to-top
        ctx.rotate(-Math.PI / 2);

        ctx.fillText('Frequency (Hz)', 0, 0);

        ctx.restore();
    }

    renderPWaves(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        if (!this.pWaves.length) return;
        const c = this.colors;
        ctx.save();
        ctx.font = this.fonts.title;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        for (const p of this.pWaves) {
            const px = this.pWaveX(p, x, width);
            if (px === null) continue;

            // marker line
            ctx.strokeStyle = c.pWaveLine;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px, y + height);
            ctx.stroke();
            ctx.setLineDash([]);

            // flag tag
            const mag = Number(p.magnitude);
            const label = `P ${p.name ?? ''}${Number.isFinite(mag) ? ` M${mag.toFixed(1)}` : ''}`;
            const tw = ctx.measureText(label).width;
            const tagX = Math.min(px + 2, x + width - tw - 8); // keep tag inside plot near right edge
            ctx.fillStyle = c.pWaveTag;
            ctx.fillRect(tagX, y + 2, tw + 8, 14);
            ctx.fillStyle = c.pWaveText;
            ctx.fillText(label, tagX + 4, y + 9);
        }
        ctx.restore();
    }

    /** user time flags: solid line, tag at the bottom (P-wave tags sit at the top) */
    renderFlags(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        if (!this.flags.length) return;
        const c = this.colors;
        ctx.save();
        ctx.font = this.fonts.title;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        for (const f of this.flags) {
            const px = this.pWaveX(f, x, width);
            if (px === null) continue;
            const color = f.isBase ? c.flagBase : c.flag;

            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px, y + height);
            ctx.stroke();

            const label = f.label || '';
            const tw = ctx.measureText(label).width;
            const tagX = Math.min(px + 2, x + width - tw - 8);
            ctx.fillStyle = color;
            ctx.fillRect(tagX, y + height - 16, tw + 8, 14);
            ctx.fillStyle = c.pWaveText;
            ctx.fillText(label, tagX + 4, y + height - 9);
        }
        ctx.restore();
    }

    renderTimeAxis(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        const c = this.colors;
        ctx.save();
        ctx.fillStyle = c.background;
        ctx.fillRect(x, y, width, height);

        const totalSec = this.timeWindowSec;
        const numTicks = 6;
        const nowMs = this.lastSampleUtc - this.panOffsetSec * 1000; // shift with pan so axis matches crosshair/flags

        ctx.font = this.fonts.label;
        ctx.fillStyle = c.text;
        ctx.textAlign = 'center';
        ctx.strokeStyle = c.tick;
        ctx.lineWidth = 1;

        // Bottom timeline with localized or UTC clock stamps
        for (let i = 0; i <= numTicks; i++) {
            const tx = x + (i / numTicks) * width;
            const secAgo = totalSec * (1.0 - (i / numTicks));
            const tickDate = new Date(nowMs - secAgo * 1000).valueOf();
            
            const timeStr = this.getTimeStr(tickDate);
     
            ctx.beginPath();
            ctx.moveTo(tx, y);
            ctx.lineTo(tx, y + 4);
            ctx.stroke();

            ctx.fillText(timeStr, tx, y + 14);
        }


        // Vertical Y-axis label
        const centerX = x + width / 2;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 'Time' centered under the time ticks
        ctx.fillStyle = c.text;
        ctx.font = this.fonts.title;
        ctx.fillText(`Time (${this.timeMode})`, centerX, y + 26);
        if(this.channel) ctx.fillText(this.channel, centerX, y + 38);

        ctx.restore();
    }

    renderCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        const c = this.colors;
        ctx.save();
        const mx = this.mouseX;
        const my = this.mouseY;

        ctx.strokeStyle = c.crosshair;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        ctx.beginPath();
        ctx.moveTo(mx, y);
        ctx.lineTo(mx, y + height);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x, my);
        ctx.lineTo(x + width, my);
        ctx.stroke();
        ctx.setLineDash([]);

        const totalSec = this.timeWindowSec;
        const secAgo = ((x + width - mx) / width) * totalSec + this.panOffsetSec;
        const hoverDate = new Date(this.lastSampleUtc - secAgo * 1000).valueOf();

        const timeStr = this.getTimeStr(hoverDate);

        let readout = `${timeStr} ${this.timeMode} (-${secAgo.toFixed(1)}s)`;

        const wl = this.waveLayout;
        const sl = this.spectroLayout;
        let point: { x: number; y: number } | null = null; // hovered waveform sample, marked with a dot
        if (wl && my >= wl.y && my <= wl.y + wl.height) {
            // waveform: value of the sample under the cursor (demeaned, same reference as the axis labels)
            if (wl.len > 0 && mx >= wl.plotStartX) {
                const i = Math.min(wl.len - 1, Math.max(0, Math.floor(((mx - wl.plotStartX) / wl.plotDataWidth) * wl.len)));
                const v = this.buffer[wl.startIdx + i] - wl.mean;
                const vs = (v + wl.base) / wl.ampScale;
                readout += ` | ${vs >= 0 && !wl.raw ? '+' : ''}${vs.toPrecision(4)} ${wl.expLabel}${wl.unitLabel}`;
                // snap to the sample's x so the dot sits on the line when zoomed in
                point = { x: wl.plotStartX + i * wl.plotDataWidth / wl.len, y: Math.max(wl.y + 1, Math.min(wl.y + wl.height - 1, wl.midY - v * wl.scaleY)) };
            }
        } else if (sl && my >= sl.y && my <= sl.y + sl.height) {
            // spectrogram: frequency from the real plot rect (was an approximate height, so Hz drifted)
            const freq = ((sl.y + sl.height - my) / sl.height) * sl.nyquist;
            readout += ` | ${Math.max(0, freq).toFixed(1)} Hz`;
        }

        if (point) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = c.trace;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = c.background;
            ctx.stroke();
        }

        ctx.font = this.fonts.label;
        const tw = ctx.measureText(readout).width;
        const tipX = Math.min(x + width - tw - 12, Math.max(x, mx + 8));
        const tipY = Math.max(y + 14, my - 8);

        ctx.fillStyle = c.tooltipBg;
        ctx.strokeStyle = c.tooltipBorder;
        ctx.lineWidth = 1;
        ctx.fillRect(tipX - 4, tipY - 11, tw + 8, 16);
        ctx.strokeRect(tipX - 4, tipY - 11, tw + 8, 16);

        ctx.fillStyle = c.tooltipText;
        ctx.textAlign = 'left';
        ctx.fillText(readout, tipX, tipY + 1);

        ctx.restore();
    }
}

// SpectrogramWidget is the public name; RaspTraceWidget kept for code ported from alertnepal_web_v3
export { InfernoColormap, RealFFT, RaspTraceWidget, RaspTraceWidget as SpectrogramWidget, DEFAULT_COLORS, DEFAULT_FONTS };
export type { Palette, ThemeColors, Fonts };

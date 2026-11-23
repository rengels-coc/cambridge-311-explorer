/**
 * timeline.js — Interactive brushable timeline histogram & smooth animated playback engine.
 * Supports:
 *  - Dragging left/right handles to resize selection window
 *  - Dragging inside selection to scrub smoothly across time
 *  - Dragging on empty area to paint a new time window
 *  - Play / Pause continuous animation with configurable speed, step, and looping
 *  - Keyboard shortcuts: Space (Play/Pause), Left/Right arrows (step window)
 */

import { formatShortDate } from "./data.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class TimelineView {
  constructor(engine, opts) {
    this.engine = engine;
    this.svg = opts.svg;
    this.wrap = opts.wrap;
    this.tooltip = opts.tooltip;
    this.onWindowChange = opts.onWindowChange;
    this.onPlayStateChange = opts.onPlayStateChange;

    this.bins = null;
    this.state = null;
    this.pad = { left: 10, right: 10, top: 8, bottom: 20 };

    // Interaction state
    this.dragMode = null; // 'move' | 'left' | 'right' | 'create'
    this.dragOriginMin = 0;
    this.dragInitStart = 0;
    this.dragInitEnd = 0;

    // Playback state
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    this._rafId = null;
    this._lastFrameTs = 0;

    this._bindEvents();
  }

  _getPlotRect() {
    const rect = this.wrap.getBoundingClientRect();
    const w = Math.max(240, rect.width);
    const h = Math.max(70, rect.height);
    const plotW = w - this.pad.left - this.pad.right;
    const plotH = h - this.pad.top - this.pad.bottom;
    return { w, h, plotW, plotH };
  }

  _minToX(min, plotW) {
    const { horizonStartMin, horizonEndMin } = this.state;
    const frac = (min - horizonStartMin) / Math.max(1, horizonEndMin - horizonStartMin);
    return this.pad.left + Math.max(0, Math.min(1, frac)) * plotW;
  }

  _xToMin(x, plotW) {
    const { horizonStartMin, horizonEndMin } = this.state;
    const frac = Math.max(0, Math.min(1, (x - this.pad.left) / plotW));
    return Math.round(horizonStartMin + frac * (horizonEndMin - horizonStartMin));
  }

  render(state, bins) {
    this.state = state;
    this.bins = bins;

    const { w, h, plotW, plotH } = this._getPlotRect();
    const svg = this.svg;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = "";

    const { counts, maxBin, binWidth, hStart, hEnd } = bins;
    const numBins = counts.length;
    const barStep = plotW / numBins;
    const barW = Math.max(1, barStep - 1);

    const selX1 = this._minToX(state.winStartMin, plotW);
    const selX2 = this._minToX(state.winEndMin, plotW);

    // 1. Histogram bars
    const barsG = el("g");
    const safeMax = Math.max(1, maxBin);
    for (let i = 0; i < numBins; i++) {
      const cnt = counts[i];
      if (cnt === 0) continue;
      const bh = Math.max(2, (cnt / safeMax) * plotH);
      const bx = this.pad.left + i * barStep;
      const by = this.pad.top + (plotH - bh);
      const bMidMin = hStart + (i + 0.5) * binWidth;
      const inWin = bMidMin >= state.winStartMin && bMidMin <= state.winEndMin;
      barsG.appendChild(
        el("rect", {
          x: bx.toFixed(1),
          y: by.toFixed(1),
          width: barW.toFixed(1),
          height: bh.toFixed(1),
          class: inWin ? "tl-bar tl-bar--in" : "tl-bar",
        })
      );
    }
    svg.appendChild(barsG);

    // 2. X-Axis baseline + clean year/month ticks
    const axisY = this.pad.top + plotH;
    svg.appendChild(el("line", { x1: this.pad.left, y1: axisY, x2: this.pad.left + plotW, y2: axisY, class: "tl-axis-line" }));

    const ticks = this._computeTicks(hStart, hEnd, plotW);
    for (const t of ticks) {
      const tx = this._minToX(t.min, plotW);
      svg.appendChild(el("line", { x1: tx.toFixed(1), y1: axisY, x2: tx.toFixed(1), y2: axisY + 4, class: "tl-axis-line" }));
      const lbl = el("text", { x: tx.toFixed(1), y: axisY + 15, "text-anchor": t.anchor || "middle", class: "tl-axis-label" });
      lbl.textContent = t.label;
      svg.appendChild(lbl);
    }

    // 3. Brush selection overlay + resize handles
    const selW = Math.max(6, selX2 - selX1);
    const brushG = el("g");

    brushG.appendChild(
      el("rect", {
        x: selX1.toFixed(1),
        y: this.pad.top,
        width: selW.toFixed(1),
        height: plotH,
        class: "tl-brush-shade",
        "data-role": "move",
      })
    );

    const handleW = 8;
    // Left handle
    brushG.appendChild(
      el("rect", {
        x: (selX1 - handleW / 2).toFixed(1),
        y: this.pad.top,
        width: handleW,
        height: plotH,
        class: "tl-handle",
        "data-role": "left",
      })
    );
    brushG.appendChild(
      el("rect", {
        x: (selX1 - 1).toFixed(1),
        y: (this.pad.top + plotH / 2 - 9).toFixed(1),
        width: 2,
        height: 18,
        class: "tl-handle-grip",
      })
    );

    // Right handle
    brushG.appendChild(
      el("rect", {
        x: (selX1 + selW - handleW / 2).toFixed(1),
        y: this.pad.top,
        width: handleW,
        height: plotH,
        class: "tl-handle",
        "data-role": "right",
      })
    );
    brushG.appendChild(
      el("rect", {
        x: (selX1 + selW - 1).toFixed(1),
        y: (this.pad.top + plotH / 2 - 9).toFixed(1),
        width: 2,
        height: 18,
        class: "tl-handle-grip",
      })
    );

    svg.appendChild(brushG);
  }

  _computeTicks(hStart, hEnd, plotW) {
    const startMs = this.engine.minToMs(hStart);
    const endMs = this.engine.minToMs(hEnd);
    const spanDays = (endMs - startMs) / 86400000;
    const ticks = [];
    const maxTicks = Math.max(4, Math.floor(plotW / 80));

    if (spanDays > 550) {
      // Yearly ticks (Jan 1 of each year)
      const d0 = new Date(startMs);
      const yStart = d0.getUTCFullYear();
      const yEnd = new Date(endMs).getUTCFullYear();
      const step = Math.max(1, Math.ceil((yEnd - yStart + 1) / maxTicks));
      for (let y = yStart; y <= yEnd; y += step) {
        const ms = Date.UTC(y, 0, 1);
        const min = this.engine.msToMin(ms);
        if (min >= hStart && min <= hEnd) {
          ticks.push({ min, label: String(y) });
        }
      }
    } else {
      // Monthly ticks
      const d = new Date(startMs);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      const totalMonths = Math.max(1, Math.round(spanDays / 30.4));
      const step = Math.max(1, Math.ceil(totalMonths / maxTicks));
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      let idx = 0;
      while (d.getTime() <= endMs) {
        const min = this.engine.msToMin(d.getTime());
        if (min >= hStart && min <= hEnd && idx % step === 0) {
          const m = d.getUTCMonth();
          const label = m === 0 ? `${months[m]} ${d.getUTCFullYear()}` : months[m];
          ticks.push({ min, label });
        }
        d.setUTCMonth(d.getUTCMonth() + 1);
        idx++;
      }
    }
    return ticks;
  }

  _bindEvents() {
    const getPointerX = (ev) => {
      const rect = this.wrap.getBoundingClientRect();
      return ev.clientX - rect.left;
    };

    this.svg.addEventListener("pointerdown", (ev) => {
      if (!this.state) return;
      if (this.playing) this.pause();

      const { plotW } = this._getPlotRect();
      const x = getPointerX(ev);
      const role = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-role") : null;

      this.dragOriginMin = this._xToMin(x, plotW);
      this.dragInitStart = this.state.winStartMin;
      this.dragInitEnd = this.state.winEndMin;

      if (role === "left" || role === "right" || role === "move") {
        this.dragMode = role;
      } else {
        this.dragMode = "create";
      }

      this.svg.setPointerCapture(ev.pointerId);
    });

    this.svg.addEventListener("pointermove", (ev) => {
      if (!this.state || !this.bins) return;
      const { plotW } = this._getPlotRect();
      const x = getPointerX(ev);

      if (!this.dragMode) {
        // Show hover bin tooltip
        const frac = (x - this.pad.left) / plotW;
        if (frac >= 0 && frac <= 1) {
          const bIdx = Math.min(this.bins.counts.length - 1, Math.max(0, Math.floor(frac * this.bins.counts.length)));
          const bStartMs = this.engine.minToMs(this.bins.hStart + bIdx * this.bins.binWidth);
          const bEndMs = this.engine.minToMs(this.bins.hStart + (bIdx + 1) * this.bins.binWidth);
          const cnt = this.bins.counts[bIdx];
          this.tooltip.textContent = `${formatShortDate(bStartMs)} – ${formatShortDate(bEndMs)}: ${cnt.toLocaleString()} requests`;
          this.tooltip.hidden = false;
          const tipW = this.tooltip.offsetWidth || 200;
          const left = Math.max(6, Math.min(plotW - tipW + 10, x - tipW / 2));
          this.tooltip.style.left = `${left}px`;
        } else {
          this.tooltip.hidden = true;
        }
        return;
      }

      this.tooltip.hidden = true;
      const curMin = this._xToMin(x, plotW);
      const minSpan = 1440; // Minimum 1 day window
      const hStart = this.state.horizonStartMin;
      const hEnd = this.state.horizonEndMin;

      let ns = this.dragInitStart;
      let ne = this.dragInitEnd;

      if (this.dragMode === "move") {
        const delta = curMin - this.dragOriginMin;
        const winLen = this.dragInitEnd - this.dragInitStart;
        ns = Math.max(hStart, Math.min(hEnd - winLen, this.dragInitStart + delta));
        ne = ns + winLen;
      } else if (this.dragMode === "left") {
        ns = Math.max(hStart, Math.min(this.dragInitEnd - minSpan, curMin));
      } else if (this.dragMode === "right") {
        ne = Math.min(hEnd, Math.max(this.dragInitStart + minSpan, curMin));
      } else if (this.dragMode === "create") {
        const a = Math.min(this.dragOriginMin, curMin);
        const b = Math.max(this.dragOriginMin, curMin);
        ns = Math.max(hStart, a);
        ne = Math.min(hEnd, Math.max(a + minSpan, b));
      }

      this.onWindowChange(ns, ne, { fromBrush: true });
    });

    const endDrag = (ev) => {
      if (this.dragMode) {
        this.dragMode = null;
        try { this.svg.releasePointerCapture(ev.pointerId); } catch {}
      }
    };

    this.svg.addEventListener("pointerup", endDrag);
    this.svg.addEventListener("pointercancel", endDrag);
    this.svg.addEventListener("pointerleave", () => {
      this.tooltip.hidden = true;
    });

    // Double click resets selection to full horizon
    this.svg.addEventListener("dblclick", () => {
      if (!this.state) return;
      if (this.playing) this.pause();
      this.onWindowChange(this.state.horizonStartMin, this.state.horizonEndMin, { fromBrush: false });
    });

    // Re-render on resize
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (this.state && this.bins) this.render(this.state, this.bins);
      });
      ro.observe(this.wrap);
    }
  }

  setSpeed(mult) {
    this.speed = mult;
  }

  setLoop(enabled) {
    this.loop = enabled;
  }

  step(direction = 1) {
    if (!this.state) return;
    const hStart = this.state.horizonStartMin;
    const hEnd = this.state.horizonEndMin;
    const winLen = this.state.winEndMin - this.state.winStartMin;
    if (winLen >= hEnd - hStart - 1440) {
      // If full horizon is selected, snap to a 90-day window at start
      const defaultWin = Math.min(90 * 1440, Math.round((hEnd - hStart) * 0.2));
      this.onWindowChange(hStart, hStart + defaultWin, { fromPlayback: true });
      return;
    }
    const stepSize = Math.max(7 * 1440, Math.round(winLen * 0.25));
    let ns = this.state.winStartMin + direction * stepSize;
    if (ns + winLen > hEnd) ns = hEnd - winLen;
    if (ns < hStart) ns = hStart;
    this.onWindowChange(ns, ns + winLen, { fromPlayback: true });
  }

  play() {
    if (this.playing || !this.state) return;
    const hStart = this.state.horizonStartMin;
    const hEnd = this.state.horizonEndMin;
    const totalSpan = hEnd - hStart;
    let winLen = this.state.winEndMin - this.state.winStartMin;

    // If the user has the entire horizon selected, automatically switch to a 90-day sliding window from the start!
    if (winLen >= totalSpan - 1440) {
      winLen = Math.min(90 * 1440, Math.max(14 * 1440, Math.round(totalSpan * 0.15)));
      this.onWindowChange(hStart, hStart + winLen, { fromPlayback: true });
    } else if (this.state.winEndMin >= hEnd - 1440) {
      // If already at the end, restart from the beginning
      this.onWindowChange(hStart, hStart + winLen, { fromPlayback: true });
    }

    this.playing = true;
    this._lastFrameTs = performance.now();
    this.onPlayStateChange(true);

    const tick = (now) => {
      if (!this.playing) return;
      const dtSec = Math.min(0.15, (now - this._lastFrameTs) / 1000);
      this._lastFrameTs = now;

      const curHStart = this.state.horizonStartMin;
      const curHEnd = this.state.horizonEndMin;
      const curWinLen = this.state.winEndMin - this.state.winStartMin;
      const scrollable = Math.max(1, curHEnd - curHStart - curWinLen);

      // Base speed: traverse entire visible timeline in ~24 seconds at 1x speed
      const advanceMin = (scrollable / 24) * this.speed * dtSec;
      let nextStart = this.state.winStartMin + advanceMin;

      if (nextStart + curWinLen >= curHEnd) {
        if (this.loop) {
          nextStart = curHStart;
        } else {
          this.onWindowChange(curHEnd - curWinLen, curHEnd, { fromPlayback: true });
          this.pause();
          return;
        }
      }

      this.onWindowChange(Math.round(nextStart), Math.round(nextStart + curWinLen), { fromPlayback: true });
      this._rafId = requestAnimationFrame(tick);
    };

    this._rafId = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.onPlayStateChange(false);
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }
}

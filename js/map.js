/**
 * map.js — Interactive Leaflet map with:
 *  1) Stepped 6-bin Cambridge Blue choropleth maps (Neighborhoods, 2020 Census Tracts,
 *     Wards & Precincts, ZIP Codes) by Density (per sq mi), Count, or Per 1,000 residents
 *  2) High-speed HTML5 Canvas individual complaint point layer with hit-testing & inspection
 */

import { formatShortDate } from "./data.js";

// Official Cambridge Reimagined sequential blue scale (flat stepped bins)
const SEQ_COLORS = ["#CDECFF", "#70CBF7", "#30B8FF", "#00A9FF", "#196CC6", "#1D2F8D"];
const ZERO_COLOR = "#F4F6F9";

const STATUS_COLORS = {
  3: "#D20404", // Open - Mid Red
  2: "#FF6000", // Acknowledged - Bright Orange
  1: "#196CC6", // Closed - Mid Blue
  0: "#196CC6", // Archived - Mid Blue
};

const CAMBRIDGE_CENTER = [42.3736, -71.1097];
const CAMBRIDGE_ZOOM = 13;
const MAX_CANVAS_POINTS = 28000;

function formatMetricVal(val, metric) {
  if (val === null || val === undefined || !Number.isFinite(val)) return "N/A";
  if (metric === "count") return Math.round(val).toLocaleString();
  if (val >= 100) return Math.round(val).toLocaleString();
  if (val >= 10) return val.toFixed(1);
  return val.toFixed(2);
}

export function getRegionMetricValue(regMeta, count, metric) {
  if (!regMeta) return 0;
  if (metric === "count") return count;
  if (metric === "per_capita") {
    if (!regMeta.pop || regMeta.pop <= 0) return null;
    return (count / regMeta.pop) * 1000;
  }
  // density (per sq mi)
  return count / Math.max(0.001, regMeta.area_sqmi);
}

/**
 * Custom high-speed Leaflet Canvas Layer for plotting tens of thousands of individual 311 points.
 */
const PointsCanvasLayer = L.Layer.extend({
  initialize(options) {
    L.setOptions(this, options);
    this._canvas = null;
    this._ctx = null;
    this._drawData = null; // { engine, indices, colorMode, selectedIdx }
    this._drawnCoords = []; // flat [x, y, idx] for fast hover/click hit testing
  },

  onAdd(map) {
    this._map = map;
    const canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated");
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");

    const pane = map.getPanes().overlayPane;
    pane.appendChild(canvas);

    map.on("moveend zoomend resize", this._reset, this);
    this._reset();
  },

  onRemove(map) {
    L.DomUtil.remove(this._canvas);
    map.off("moveend zoomend resize", this._reset, this);
    this._canvas = null;
    this._ctx = null;
  },

  setData(drawData) {
    this._drawData = drawData;
    if (this._map && this._canvas) this._redraw();
  },

  _reset() {
    if (!this._map || !this._canvas) return;
    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = Math.round(size.x * dpr);
    this._canvas.height = Math.round(size.y * dpr);
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._redraw();
  },

  _redraw() {
    if (!this._map || !this._ctx) return;
    const size = this._map.getSize();
    const ctx = this._ctx;
    ctx.clearRect(0, 0, size.x, size.y);
    this._drawnCoords = [];

    const d = this._drawData;
    if (!d || !d.indices || d.indices.length === 0) return;

    const { engine, indices, colorMode, selectedIdx, hoveredIdx } = d;
    const map = this._map;
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.05);
    const minLatE5 = Math.floor(bounds.getSouth() * 100000);
    const maxLatE5 = Math.ceil(bounds.getNorth() * 100000);
    const minLngE5 = Math.floor(bounds.getWest() * 100000);
    const maxLngE5 = Math.ceil(bounds.getEast() * 100000);

    const latArr = engine.latE5;
    const lngArr = engine.lngE5;
    const catArr = engine.catIdx;
    const flagsArr = engine.flags;
    const catTheme = engine.catTheme;
    const themeColors = engine.meta.themes.map((t) => t.color);

    const total = indices.length;
    const stride = total > MAX_CANVAS_POINTS ? Math.ceil(total / MAX_CANVAS_POINTS) : 1;

    // Adaptive dot radius for visual clarity
    const baseR = zoom >= 16 ? 5.2 : zoom >= 15 ? 4.2 : zoom >= 14 ? 3.3 : total > 8000 ? 2.1 : 2.8;
    const alpha = total > 10000 ? 0.65 : total > 2500 ? 0.78 : 0.88;

    // Group points by color to minimize fillStyle changes!
    const buckets = new Map();
    const coords = this._drawnCoords;

    for (let k = 0; k < total; k += stride) {
      const idx = indices[k];
      const la = latArr[idx];
      const ln = lngArr[idx];
      if (la < minLatE5 || la > maxLatE5 || ln < minLngE5 || ln > maxLngE5) continue;

      const pt = map.latLngToContainerPoint([la / 100000, ln / 100000]);
      const x = pt.x;
      const y = pt.y;
      coords.push(x, y, idx);

      let color;
      if (colorMode === "status") {
        color = STATUS_COLORS[flagsArr[idx] & 3] || "#196CC6";
      } else {
        color = themeColors[catTheme[catArr[idx]]] || "#196CC6";
      }
      let arr = buckets.get(color);
      if (!arr) {
        arr = [];
        buckets.set(color, arr);
      }
      arr.push(x, y);
    }

    ctx.globalAlpha = alpha;
    const twoPi = Math.PI * 2;
    const drawStroke = zoom >= 15 || total <= 1200;

    for (const [color, pts] of buckets.entries()) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        ctx.moveTo(x + baseR, y);
        ctx.arc(x, y, baseR, 0, twoPi);
      }
      ctx.fill();
      if (drawStroke) {
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;

    // Draw hovered or selected highlight ring on top
    const drawHighlight = (idx, strokeColor, rExtra) => {
      if (idx === null || idx === undefined || idx < 0) return;
      const pt = map.latLngToContainerPoint([latArr[idx] / 100000, lngArr[idx] / 100000]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, baseR + rExtra, 0, twoPi);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, baseR + 0.5, 0, twoPi);
      ctx.fillStyle = strokeColor;
      ctx.fill();
    };

    if (hoveredIdx !== null && hoveredIdx !== selectedIdx) {
      drawHighlight(hoveredIdx, "#1D2F8D", 4);
    }
    if (selectedIdx !== null && selectedIdx >= 0) {
      drawHighlight(selectedIdx, "#FF6000", 5);
    }
  },

  hitTest(containerPt, maxDist = 9) {
    const coords = this._drawnCoords;
    if (!coords || coords.length === 0) return null;
    const mx = containerPt.x;
    const my = containerPt.y;
    let bestD2 = maxDist * maxDist;
    let bestIdx = null;
    // Iterate backwards so top-drawn point wins
    for (let i = coords.length - 3; i >= 0; i -= 3) {
      const dx = coords[i] - mx;
      const dy = coords[i + 1] - my;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        bestIdx = coords[i + 2];
      }
    }
    return bestIdx;
  },
});

export class MapView {
  constructor(engine, opts) {
    this.engine = engine;
    this.hoverCard = opts.hoverCard;
    this.legendEl = opts.legendEl;
    this.pointsNoteEl = opts.pointsNoteEl;
    this.onRegionClick = opts.onRegionClick;
    this.onTicketClick = opts.onTicketClick;

    this.map = L.map(opts.container, {
      center: CAMBRIDGE_CENTER,
      zoom: CAMBRIDGE_ZOOM,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 12,
      maxZoom: 18,
      zoomControl: true,
      preferCanvas: true,
    });

    // Clean light gray Esri Canvas basemap (free, no API key, ideal for thematic choropleths & points)
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ · Boundaries: Cambridge GIS",
        maxZoom: 16,
        maxNativeZoom: 16,
      }
    ).addTo(this.map);

    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 16,
        maxNativeZoom: 16,
        opacity: 0.85,
        pane: "overlayPane",
      }
    ).addTo(this.map);

    this.choroplethLayer = null;
    this.outlineLayer = null;
    this.labelsGroup = L.layerGroup().addTo(this.map);
    this.pointsLayer = new PointsCanvasLayer();

    this.currentRegionLayerKey = null;
    this.currentState = null;
    this.currentAgg = null;
    this.lockedScaleMax = null;
    this.lastComputedMax = 1;
    this.selectedTicketIdx = null;
    this.hoveredTicketIdx = null;
    this.hoveredRegionId = null;
    this._didInitialFit = false;

    this._bindPointInteractions();
  }

  resetView() {
    if (this.choroplethLayer) {
      this.map.fitBounds(this.choroplethLayer.getBounds(), { padding: [26, 26] });
    } else if (this.outlineLayer) {
      this.map.fitBounds(this.outlineLayer.getBounds(), { padding: [26, 26] });
    } else {
      this.map.setView(CAMBRIDGE_CENTER, CAMBRIDGE_ZOOM);
    }
  }

  setLockScale(locked) {
    if (locked) {
      this.lockedScaleMax = Math.max(1, this.lastComputedMax);
    } else {
      this.lockedScaleMax = null;
    }
    if (this.currentState && this.currentAgg) {
      this.update(this.currentState, this.currentAgg);
    }
  }

  clearLockedScale() {
    this.lockedScaleMax = null;
  }

  setSelectedTicket(idx, panTo = false) {
    this.selectedTicketIdx = idx;
    if (idx !== null && idx >= 0 && panTo) {
      const lat = this.engine.latE5[idx] / 100000;
      const lng = this.engine.lngE5[idx] / 100000;
      const targetZoom = Math.max(this.map.getZoom(), 15);
      this.map.setView([lat, lng], targetZoom, { animate: true });
    }
    if (this.currentState && this.currentState.mapMode === "points" && this.currentAgg) {
      this.pointsLayer.setData({
        engine: this.engine,
        indices: this.currentAgg.matched,
        colorMode: this.currentState.pointColorMode,
        selectedIdx: this.selectedTicketIdx,
        hoveredIdx: this.hoveredTicketIdx,
      });
    }
  }

  update(state, agg) {
    this.currentState = state;
    this.currentAgg = agg;

    if (state.mapMode === "choropleth") {
      if (this.map.hasLayer(this.pointsLayer)) this.map.removeLayer(this.pointsLayer);
      if (this.outlineLayer && this.map.hasLayer(this.outlineLayer)) this.map.removeLayer(this.outlineLayer);
      this._renderChoropleth(state, agg);
    } else {
      if (this.choroplethLayer && this.map.hasLayer(this.choroplethLayer)) {
        this.map.removeLayer(this.choroplethLayer);
      }
      this.labelsGroup.clearLayers();
      this._renderSubtleOutlines(state);
      if (!this.map.hasLayer(this.pointsLayer)) this.pointsLayer.addTo(this.map);
      this._renderPoints(state, agg);
    }
  }

  _ensureChoroplethLayer(layerKey) {
    if (this.currentRegionLayerKey === layerKey && this.choroplethLayer) {
      if (!this.map.hasLayer(this.choroplethLayer)) this.choroplethLayer.addTo(this.map);
      return;
    }
    if (this.choroplethLayer) {
      this.map.removeLayer(this.choroplethLayer);
    }
    this.currentRegionLayerKey = layerKey;
    const fc = this.engine.regions[layerKey];

    this.choroplethLayer = L.geoJSON(fc, {
      style: () => ({
        weight: 1.5,
        color: "#1D2F8D",
        fillColor: ZERO_COLOR,
        fillOpacity: 0.78,
      }),
      onEachFeature: (feature, layer) => {
        const rid = feature.properties.id;
        layer.on("mouseover", () => {
          this.hoveredRegionId = rid;
          layer.setStyle({ weight: 3, color: "#000000" });
          layer.bringToFront();
          this._showRegionHover(rid);
        });
        layer.on("mouseout", () => {
          this.hoveredRegionId = null;
          this._restyleSingleRegion(layer, rid);
          this.hoverCard.hidden = true;
        });
        layer.on("click", () => {
          this.onRegionClick(rid);
        });
      },
    }).addTo(this.map);

    if (!this._didInitialFit) {
      this._didInitialFit = true;
      this.map.fitBounds(this.choroplethLayer.getBounds(), { padding: [26, 26] });
    }
  }

  _computeBreaks(values) {
    let maxV = 0;
    for (const v of values) {
      if (v !== null && v > maxV) maxV = v;
    }
    this.lastComputedMax = maxV;
    const ceiling = this.lockedScaleMax !== null ? this.lockedScaleMax : maxV;
    if (ceiling <= 0) {
      return { ceiling: 0, edges: [0, 1, 2, 3, 4, 5, 6] };
    }
    // Clean stepped 6-bin scale from 0 -> ceiling
    const edges = [];
    for (let i = 0; i <= 6; i++) {
      edges.push((ceiling * i) / 6);
    }
    return { ceiling, edges };
  }

  _valueToColor(val, ceiling) {
    if (val === null || val === undefined || val <= 0 || ceiling <= 0) return ZERO_COLOR;
    const idx = Math.min(5, Math.floor((val / ceiling) * 6));
    return SEQ_COLORS[idx];
  }

  _restyleSingleRegion(layer, rid) {
    if (!this.currentState || !this.currentAgg) return;
    const state = this.currentState;
    const metaList = this.engine.meta.regions[state.regionLayer];
    const regMeta = metaList[rid];
    const cnt = this.currentAgg.regionCounts[rid] || 0;
    const val = getRegionMetricValue(regMeta, cnt, state.densityMetric);
    const isSelected = String(state.selectedRegion) === String(rid);
    const anySelected = state.selectedRegion !== "all";
    const ceiling = this._lastCeiling || 1;

    layer.setStyle({
      fillColor: this._valueToColor(val, ceiling),
      fillOpacity: anySelected && !isSelected ? 0.25 : 0.82,
      color: isSelected ? "#FF6000" : "#1D2F8D",
      weight: isSelected ? 3.5 : 1.25,
    });
  }

  _renderChoropleth(state, agg) {
    this._ensureChoroplethLayer(state.regionLayer);
    const metaList = this.engine.meta.regions[state.regionLayer];
    const values = metaList.map((rm, i) => getRegionMetricValue(rm, agg.regionCounts[i] || 0, state.densityMetric));
    const { ceiling, edges } = this._computeBreaks(values);
    this._lastCeiling = ceiling;

    const anySelected = state.selectedRegion !== "all";

    this.choroplethLayer.eachLayer((layer) => {
      const rid = layer.feature.properties.id;
      const val = values[rid];
      const isSelected = String(state.selectedRegion) === String(rid);
      const fill = this._valueToColor(val, ceiling);

      layer.setStyle({
        fillColor: fill,
        fillOpacity: anySelected && !isSelected ? 0.25 : 0.82,
        color: isSelected ? "#FF6000" : "#1D2F8D",
        weight: isSelected ? 3.5 : 1.25,
      });
      if (isSelected) layer.bringToFront();
    });

    // Direct labels for Neighborhoods & ZIP Codes (clean, uncluttered)
    this.labelsGroup.clearLayers();
    if (state.regionLayer === "neighborhoods" || state.regionLayer === "zipcodes") {
      this.choroplethLayer.eachLayer((layer) => {
        const rid = layer.feature.properties.id;
        const rm = metaList[rid];
        const val = values[rid];
        const center = layer.getBounds().getCenter();
        const isDarkFill = ceiling > 0 && val !== null && val / ceiling >= 0.66;
        const shortName = state.regionLayer === "zipcodes" ? rm.code : rm.name.replace("Wellington-Harrington", "Wellington-\nHarrington");
        const cntLabel = formatMetricVal(val, state.densityMetric);
        const icon = L.divIcon({
          className: "region-label-icon",
          html: `<div class="region-label-text ${isDarkFill ? "region-label-text--dark" : ""}">${shortName}<br>${cntLabel}</div>`,
          iconSize: [90, 26],
          iconAnchor: [45, 13],
        });
        L.marker(center, { icon, interactive: false }).addTo(this.labelsGroup);
      });
    }

    if (this.hoveredRegionId !== null) {
      this._showRegionHover(this.hoveredRegionId);
    }

    this._renderChoroplethLegend(state, edges, ceiling);
  }

  _showRegionHover(rid) {
    if (!this.currentState || !this.currentAgg) return;
    const state = this.currentState;
    const agg = this.currentAgg;
    const rm = this.engine.meta.regions[state.regionLayer][rid];
    if (!rm) return;

    const cnt = agg.regionCounts[rid] || 0;
    const pct = agg.total > 0 ? ((cnt / agg.total) * 100).toFixed(1) : "0.0";
    const dens = cnt / Math.max(0.001, rm.area_sqmi);
    const perCap = rm.pop ? ((cnt / rm.pop) * 1000).toFixed(1) : null;
    const topCatIdx = agg.regionTopCat[rid];
    const topCatName = topCatIdx >= 0 ? this.engine.meta.categories[topCatIdx].name : "None in window";

    this.hoverCard.innerHTML = `
      <div class="hover-title">${rm.name}</div>
      <div class="hover-stat"><span>Requests</span><strong>${cnt.toLocaleString()} (${pct}%)</strong></div>
      <div class="hover-stat"><span>Density</span><strong>${formatMetricVal(dens, "density")} / sq mi</strong></div>
      <div class="hover-stat"><span>Land area</span><strong>${rm.area_sqmi.toFixed(2)} sq mi</strong></div>
      ${perCap !== null ? `<div class="hover-stat"><span>Per 1,000 residents</span><strong>${perCap}</strong></div>` : ""}
      <div class="hover-top-cat"><strong>Top issue:</strong> ${topCatName}</div>
    `;
    this.hoverCard.hidden = false;
  }

  _renderChoroplethLegend(state, edges, ceiling) {
    const metricLabel =
      state.densityMetric === "density"
        ? "Requests per sq mi"
        : state.densityMetric === "per_capita"
          ? "Requests per 1,000 residents"
          : "Total requests";

    const swatches = SEQ_COLORS.map((c) => `<span class="legend-swatch" style="background:${c}"></span>`).join("");
    const lockTag = this.lockedScaleMax !== null ? `<span class="legend-lock-pill">Locked</span>` : "";

    this.legendEl.innerHTML = `
      <div class="legend-title"><span>${metricLabel}</span>${lockTag}</div>
      <div class="legend-scale-bins">${swatches}</div>
      <div class="legend-scale-labels">
        <span>0</span>
        <span>${formatMetricVal(ceiling / 2, state.densityMetric)}</span>
        <span>${formatMetricVal(ceiling, state.densityMetric)}${this.lockedScaleMax !== null ? "+" : ""}</span>
      </div>
    `;
  }

  _renderSubtleOutlines(state) {
    if (!this.outlineLayer) {
      this.outlineLayer = L.geoJSON(this.engine.regions.neighborhoods, {
        interactive: false,
        style: {
          color: "#1D2F8D",
          weight: 1,
          opacity: 0.35,
          fill: false,
          dashArray: "3 3",
        },
      });
    }
    if (!this.map.hasLayer(this.outlineLayer)) {
      this.outlineLayer.addTo(this.map);
    }
  }

  _renderPoints(state, agg) {
    const total = agg.matched.length;
    if (total > MAX_CANVAS_POINTS) {
      const drawn = Math.ceil(total / Math.ceil(total / MAX_CANVAS_POINTS));
      this.pointsNoteEl.textContent = `Showing ${drawn.toLocaleString()} sampled of ${total.toLocaleString()} (narrow window to show all)`;
    } else {
      this.pointsNoteEl.textContent = `${total.toLocaleString()} complaints plotted · click any dot`;
    }

    this.pointsLayer.setData({
      engine: this.engine,
      indices: agg.matched,
      colorMode: state.pointColorMode,
      selectedIdx: this.selectedTicketIdx,
      hoveredIdx: this.hoveredTicketIdx,
    });

    if (state.pointColorMode === "status") {
      this.legendEl.innerHTML = `
        <div class="legend-title"><span>Ticket status</span></div>
        <div class="legend-cat-grid">
          <div class="legend-cat-item"><span class="legend-cat-swatch" style="background:#D20404"></span><span>Open</span></div>
          <div class="legend-cat-item"><span class="legend-cat-swatch" style="background:#FF6000"></span><span>Acknowledged</span></div>
          <div class="legend-cat-item"><span class="legend-cat-swatch" style="background:#196CC6"></span><span>Closed / Archived</span></div>
        </div>
      `;
    } else {
      const items = this.engine.meta.themes
        .map(
          (t) => `<div class="legend-cat-item"><span class="legend-cat-swatch" style="background:${t.color}"></span><span>${t.name}</span></div>`
        )
        .join("");
      this.legendEl.innerHTML = `
        <div class="legend-title"><span>Topic</span></div>
        <div class="legend-cat-grid">${items}</div>
      `;
    }
  }

  _bindPointInteractions() {
    this.map.on("mousemove", (ev) => {
      if (!this.currentState || this.currentState.mapMode !== "points") return;
      const hit = this.pointsLayer.hitTest(ev.containerPoint, 9);
      if (hit !== this.hoveredTicketIdx) {
        this.hoveredTicketIdx = hit;
        this.map.getContainer().style.cursor = hit !== null ? "pointer" : "";
        if (this.currentAgg) {
          this.pointsLayer.setData({
            engine: this.engine,
            indices: this.currentAgg.matched,
            colorMode: this.currentState.pointColorMode,
            selectedIdx: this.selectedTicketIdx,
            hoveredIdx: this.hoveredTicketIdx,
          });
        }
      }
      if (hit !== null) {
        const cat = this.engine.meta.categories[this.engine.catIdx[hit]].name;
        const st = this.engine.meta.statuses[this.engine.flags[hit] & 3];
        const nh = this.engine.nhIdx[hit];
        const nhName = nh < this.engine.meta.regions.neighborhoods.length
          ? this.engine.meta.regions.neighborhoods[nh].name
          : "Cambridge";
        const dtStr = formatShortDate(this.engine.minToMs(this.engine.createdMin[hit]));
        const hasPhoto = (this.engine.flags[hit] & 4) ? " · Has photo" : "";
        this.hoverCard.innerHTML = `
          <div class="hover-title">${cat}</div>
          <div class="hover-stat"><span>Reported</span><strong>${dtStr}</strong></div>
          <div class="hover-stat"><span>Status</span><strong>${st}</strong></div>
          <div class="hover-stat"><span>Neighborhood</span><strong>${nhName}</strong></div>
          <div class="hover-top-cat">Click dot to read description${hasPhoto}</div>
        `;
        this.hoverCard.hidden = false;
      } else {
        this.hoverCard.hidden = true;
      }
    });

    this.map.on("mouseout", () => {
      if (this.currentState && this.currentState.mapMode === "points") {
        this.hoverCard.hidden = true;
      }
    });

    this.map.on("click", (ev) => {
      if (!this.currentState || this.currentState.mapMode !== "points") return;
      const hit = this.pointsLayer.hitTest(ev.containerPoint, 11);
      if (hit !== null) {
        this.onTicketClick(hit);
      }
    });
  }
}

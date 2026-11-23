/**
 * app.js — Main state controller, filter UI, URL state sharing,
 * ticket inspector drawer, and coordination across Map, Charts, and Timeline.
 */

import { DataEngine, formatDurationHours, formatShortDate } from "./data.js";
import { MapView } from "./map.js";
import { ChartsView } from "./charts.js";
import { TimelineView } from "./timeline.js";

const $ = (id) => document.getElementById(id);

const REGION_LABELS = {
  neighborhoods: "Neighborhood",
  tracts: "2020 Census tract",
  wards_precincts: "Ward & precinct",
  zipcodes: "ZIP code",
};

const POP_SUPPORTED_LAYERS = new Set(["neighborhoods", "wards_precincts"]);

class App {
  constructor() {
    this.engine = new DataEngine();
    this.mapView = null;
    this.chartsView = null;
    this.timelineView = null;

    this.state = {
      theme: "all",
      categories: new Set(),
      status: "all", // 'all' | 'active' | 'open' | 'closed'
      regionLayer: "neighborhoods",
      selectedRegion: "all",
      hasPhotoOnly: false,
      keyword: "",
      keywordIds: null,

      mapMode: "choropleth", // 'choropleth' | 'points'
      densityMetric: "density", // 'density' | 'count' | 'per_capita'
      pointColorMode: "theme", // 'theme' | 'status'
      lockScale: false,

      horizon: "modern", // 'modern' (2016+) | '3y' | '1y' | 'all'
      horizonStartMin: 0,
      horizonEndMin: 0,
      winStartMin: 0,
      winEndMin: 0,
      activePreset: null,
    };

    this.lastAgg = null;
    this.lastBins = null;
    this.timelineDirty = true;
    this._toastTimer = null;
    this._catSearchTerm = "";
  }

  async init() {
    const overlay = $("loading-overlay");
    const statusEl = $("loading-status");
    const barFill = $("loading-bar-fill");

    try {
      await this.engine.load((msg, pct) => {
        statusEl.textContent = msg;
        barFill.style.width = `${pct}%`;
      });

      this._initTimeBounds();
      this._initControls();
      this._initViews();
      this._applyHashState();

      this._syncControlsFromState();
      this._update(true);

      barFill.style.width = "100%";
      overlay.hidden = true;

      // Update freshness badge & about modal metadata
      this._updateFreshnessBadge();

      // Background live delta sync from Cambridge Open Data
      this.engine.syncLiveDelta().then((added) => {
        if (added > 0) {
          const prevMax = this.state.horizonEndMin;
          const newMax = this.engine.createdMin[this.engine.count - 1];
          if (this.state.winEndMin >= prevMax - 1440) {
            this.state.winEndMin = newMax;
          }
          this.state.horizonEndMin = newMax;
          this._updateFreshnessBadge();
          this._update(true);
          this._showToast(`Synced ${added} new service request${added === 1 ? "" : "s"} live from Cambridge Open Data`);
        }
      });
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Error loading data: ${err.message}`;
      barFill.style.background = "#F73030";
    }
  }

  _initTimeBounds() {
    const maxMin = this.engine.createdMin[this.engine.count - 1];
    this._setHorizon("modern", false);
    // Default initial window: last 1 year so individual complaints & density look crisp right away
    this.state.winEndMin = maxMin;
    this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 365 * 1440);
  }

  _setHorizon(horizonKey, preserveWindow = true) {
    this.state.horizon = horizonKey;
    const minAll = this.engine.createdMin[0];
    const maxAll = this.engine.createdMin[this.engine.count - 1];
    let hStart = minAll;

    if (horizonKey === "modern") {
      hStart = Math.max(minAll, this.engine.msToMin(Date.UTC(2016, 0, 1)));
    } else if (horizonKey === "3y") {
      hStart = Math.max(minAll, maxAll - 3 * 365 * 1440);
    } else if (horizonKey === "1y") {
      hStart = Math.max(minAll, maxAll - 365 * 1440);
    }

    this.state.horizonStartMin = hStart;
    this.state.horizonEndMin = maxAll;

    if (preserveWindow) {
      const curLen = Math.min(this.state.winEndMin - this.state.winStartMin, maxAll - hStart);
      if (this.state.winEndMin > maxAll) this.state.winEndMin = maxAll;
      if (this.state.winStartMin < hStart) {
        this.state.winStartMin = hStart;
        this.state.winEndMin = Math.min(maxAll, hStart + Math.max(7 * 1440, curLen));
      }
    }
  }

  _initViews() {
    this.mapView = new MapView(this.engine, {
      container: $("map"),
      hoverCard: $("map-hover-card"),
      legendEl: $("map-legend"),
      pointsNoteEl: $("points-count-note"),
      onRegionClick: (rid) => this._toggleRegion(rid),
      onTicketClick: (idx) => this._openTicketDrawer(idx, false),
    });

    this.chartsView = new ChartsView(this.engine, {
      elCategories: $("chart-categories"),
      elRegions: $("chart-regions"),
      elRegionsTitle: $("chart-regions-title"),
      elRegionsHint: $("chart-regions-hint"),
      elDow: $("chart-dow"),
      elHour: $("chart-hour"),
      elResolution: $("chart-resolution"),
      elTicketsList: $("recent-tickets-list"),
      onCategoryToggle: (catId) => this._toggleCategory(catId),
      onRegionToggle: (rid) => this._toggleRegion(rid),
      onTicketSelect: (idx) => {
        if (this.state.mapMode !== "points") {
          this.state.mapMode = "points";
          this._syncMapModeControls();
        }
        this._openTicketDrawer(idx, true);
      },
    });

    this.timelineView = new TimelineView(this.engine, {
      svg: $("timeline-svg"),
      wrap: $("timeline-canvas-wrap"),
      tooltip: $("timeline-tooltip"),
      onWindowChange: (ns, ne, meta) => {
        this.state.winStartMin = ns;
        this.state.winEndMin = ne;
        if (meta && meta.fromBrush) {
          this.state.activePreset = null;
          this._highlightWindowButton();
          this._syncPresetChips();
        }
        this._update(false);
      },
      onPlayStateChange: (isPlaying) => {
        const playBtn = $("btn-play");
        const playIcon = $("play-icon");
        const playText = $("play-text");
        const mapBadge = $("map-play-badge");
        playBtn.classList.toggle("playing", isPlaying);
        playIcon.textContent = isPlaying ? "❚❚" : "▶";
        playText.textContent = isPlaying ? "Pause" : "Play";
        mapBadge.hidden = !isPlaying;
        if (!isPlaying && this.lastAgg && this.chartsView.activeTab === "tickets") {
          this.chartsView.renderTicketsListNow(this.lastAgg);
        }
      },
    });
  }

  _initControls() {
    // Populate Topics (Themes) dropdown
    const themeSel = $("filter-theme");
    this.engine.meta.themes.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = t.name;
      themeSel.appendChild(opt);
    });

    themeSel.addEventListener("change", () => {
      this.state.theme = themeSel.value;
      // Clear selected categories that don't belong to the newly picked topic
      if (this.state.theme !== "all") {
        const tid = parseInt(this.state.theme, 10);
        for (const c of Array.from(this.state.categories)) {
          if (this.engine.catTheme[c] !== tid) this.state.categories.delete(c);
        }
      }
      this.state.activePreset = null;
      this._renderCategoryDropdown();
      this._update(true);
    });

    // Category searchable multi-select
    const catBtn = $("cat-dropdown-btn");
    const catMenu = $("cat-dropdown-menu");
    const catSearch = $("cat-search-input");
    const catClear = $("cat-clear-btn");

    catBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = catMenu.hidden;
      catMenu.hidden = !open;
      catBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        this._renderCategoryDropdown();
        catSearch.focus();
      }
    });

    catMenu.addEventListener("click", (ev) => ev.stopPropagation());
    document.addEventListener("click", () => {
      if (!catMenu.hidden) {
        catMenu.hidden = true;
        catBtn.setAttribute("aria-expanded", "false");
      }
    });

    catSearch.addEventListener("input", () => {
      this._catSearchTerm = catSearch.value.trim().toLowerCase();
      this._renderCategoryDropdown();
    });

    catClear.addEventListener("click", () => {
      this.state.categories.clear();
      this.state.activePreset = null;
      this._renderCategoryDropdown();
      this._update(true);
    });

    // Status segmented control
    $("filter-status").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".seg-btn");
      if (!btn) return;
      this.state.status = btn.dataset.status;
      this.state.activePreset = null;
      this._syncStatusButtons();
      this._update(true);
    });

    // Region filter dropdown
    $("filter-region").addEventListener("change", (ev) => {
      this.state.selectedRegion = ev.target.value;
      this.state.activePreset = null;
      this._update(true);
    });

    // Keyword live search via Socrata $q
    const kwInput = $("filter-keyword");
    const kwGo = $("btn-keyword-go");
    const kwClear = $("btn-keyword-clear");

    const runKeyword = async () => {
      const q = kwInput.value.trim();
      if (!q) {
        this._clearKeyword();
        return;
      }
      kwGo.disabled = true;
      kwGo.textContent = "…";
      try {
        const ids = await this.engine.searchKeyword(q);
        this.state.keyword = q;
        this.state.keywordIds = ids;
        this.state.activePreset = null;
        kwClear.hidden = false;
        this._update(true);
        this._showToast(`Found ${ids.size.toLocaleString()} tickets matching "${q}"`);
      } catch {
        this._showToast("Could not run keyword search (Open Data API unavailable)");
      } finally {
        kwGo.disabled = false;
        kwGo.textContent = "Search";
      }
    };

    kwGo.addEventListener("click", runKeyword);
    kwInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        runKeyword();
      }
    });
    kwClear.addEventListener("click", () => this._clearKeyword());

    // Has Photo checkbox
    $("filter-photo").addEventListener("change", (ev) => {
      this.state.hasPhotoOnly = ev.target.checked;
      this.state.activePreset = null;
      this._update(true);
    });

    // Reset all filters
    $("btn-reset-filters").addEventListener("click", () => this._resetFilters());

    // Quick view presets
    document.querySelectorAll(".preset-chip").forEach((btn) => {
      btn.addEventListener("click", () => this._applyPreset(btn.dataset.preset));
    });

    // Map mode toggle
    $("map-mode-toggle").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".seg-btn");
      if (!btn) return;
      this.state.mapMode = btn.dataset.mode;
      this._syncMapModeControls();
      this.mapView.update(this.state, this.lastAgg);
    });

    // Region boundary layer select
    $("region-layer-select").addEventListener("change", (ev) => {
      this.state.regionLayer = ev.target.value;
      this.state.selectedRegion = "all";
      if (!POP_SUPPORTED_LAYERS.has(this.state.regionLayer) && this.state.densityMetric === "per_capita") {
        this.state.densityMetric = "density";
      }
      this.state.lockScale = false;
      $("lock-scale-toggle").checked = false;
      this.mapView.clearLockedScale();
      this._populateRegionDropdown();
      this._syncDensityMetricSelect();
      this._update(true);
    });

    // Density metric select
    $("density-metric-select").addEventListener("change", (ev) => {
      this.state.densityMetric = ev.target.value;
      this.state.lockScale = false;
      $("lock-scale-toggle").checked = false;
      this.mapView.clearLockedScale();
      this.mapView.update(this.state, this.lastAgg);
      this.chartsView.render(this.state, this.lastAgg, this.timelineView.playing);
    });

    // Lock scale toggle
    $("lock-scale-toggle").addEventListener("change", (ev) => {
      this.state.lockScale = ev.target.checked;
      this.mapView.setLockScale(this.state.lockScale);
    });

    // Individual point color mode
    $("point-color-select").addEventListener("change", (ev) => {
      this.state.pointColorMode = ev.target.value;
      this.mapView.update(this.state, this.lastAgg);
    });

    // Map reset view
    $("btn-map-reset").addEventListener("click", () => this.mapView.resetView());

    // Right sidebar detail tabs
    const tabHints = {
      patterns: "Day of week & hour",
      resolution: "Time from open to close",
      tickets: "Latest 45 in active window",
    };
    $("detail-tabs").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".tab-btn");
      if (!btn) return;
      const tab = btn.dataset.tab;
      $("detail-tabs").querySelectorAll(".tab-btn").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      ["patterns", "resolution", "tickets"].forEach((t) => {
        $(`tab-${t}`).hidden = t !== tab;
      });
      $("detail-tab-hint").textContent = tabHints[tab];
      this.chartsView.setActiveTab(tab);
      if (this.lastAgg) {
        this.chartsView.render(this.state, this.lastAgg, false);
      }
    });

    // Timeline playback controls
    $("btn-play").addEventListener("click", () => this.timelineView.togglePlay());
    $("btn-step-back").addEventListener("click", () => {
      this.timelineView.pause();
      this.timelineView.step(-1);
    });
    $("btn-step-fwd").addEventListener("click", () => {
      this.timelineView.pause();
      this.timelineView.step(1);
    });
    $("toggle-loop").addEventListener("change", (ev) => this.timelineView.setLoop(ev.target.checked));
    $("play-speed").addEventListener("change", (ev) => this.timelineView.setSpeed(parseFloat(ev.target.value)));

    // Window preset buttons (1W, 1M, 3M, 6M, 1Y, Full)
    document.querySelectorAll(".win-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.win;
        const hStart = this.state.horizonStartMin;
        const hEnd = this.state.horizonEndMin;
        if (val === "all") {
          this.state.winStartMin = hStart;
          this.state.winEndMin = hEnd;
        } else {
          const days = parseInt(val, 10);
          const spanMin = Math.min(days * 1440, hEnd - hStart);
          // Anchor at current end (or if playing, keep start!)
          if (this.timelineView.playing) {
            this.state.winEndMin = Math.min(hEnd, this.state.winStartMin + spanMin);
            this.state.winStartMin = this.state.winEndMin - spanMin;
          } else {
            this.state.winStartMin = Math.max(hStart, this.state.winEndMin - spanMin);
          }
        }
        this._highlightWindowButton();
        this._update(false);
      });
    });

    // Horizon select
    $("horizon-select").addEventListener("change", (ev) => {
      this.timelineView.pause();
      this._setHorizon(ev.target.value, true);
      this._highlightWindowButton();
      this._update(true);
    });

    // Drawer close
    $("drawer-close").addEventListener("click", () => this._closeTicketDrawer());

    // About modal
    const aboutModal = $("about-modal");
    $("btn-about").addEventListener("click", () => { aboutModal.hidden = false; });
    $("about-close").addEventListener("click", () => { aboutModal.hidden = true; });
    aboutModal.addEventListener("click", (ev) => {
      if (ev.target === aboutModal) aboutModal.hidden = true;
    });

    // Share view button
    $("btn-share").addEventListener("click", () => this._copyShareLink());

    // Keyboard shortcuts (Space = Play/Pause, Arrows = Step, Escape = Close drawer/modal)
    document.addEventListener("keydown", (ev) => {
      const tag = ev.target && ev.target.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (ev.key === "Escape") {
        $("about-modal").hidden = true;
        this._closeTicketDrawer();
        $("cat-dropdown-menu").hidden = true;
        return;
      }
      if (inInput) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        this.timelineView.togglePlay();
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        this.timelineView.pause();
        this.timelineView.step(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        this.timelineView.pause();
        this.timelineView.step(1);
      }
    });

    this._populateRegionDropdown();
    this._syncDensityMetricSelect();
  }

  _populateRegionDropdown() {
    const sel = $("filter-region");
    const lbl = $("filter-region-label");
    lbl.textContent = REGION_LABELS[this.state.regionLayer] || "Region";
    sel.innerHTML = `<option value="all">All Cambridge</option>`;
    const list = this.engine.meta.regions[this.state.regionLayer];
    list.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = String(r.id);
      opt.textContent = r.name;
      sel.appendChild(opt);
    });
    sel.value = String(this.state.selectedRegion);
  }

  _syncDensityMetricSelect() {
    const sel = $("density-metric-select");
    const perCapOpt = sel.querySelector('option[value="per_capita"]');
    const supported = POP_SUPPORTED_LAYERS.has(this.state.regionLayer);
    perCapOpt.disabled = !supported;
    perCapOpt.textContent = supported ? "Per 1,000 residents" : "Per 1,000 residents (N/A for layer)";
    sel.value = this.state.densityMetric;
  }

  _syncMapModeControls() {
    $("map-mode-toggle").querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === this.state.mapMode);
    });
    $("choropleth-controls").hidden = this.state.mapMode !== "choropleth";
    $("points-controls").hidden = this.state.mapMode !== "points";
    $("map-hover-card").hidden = true;
  }

  _syncStatusButtons() {
    $("filter-status").querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.status === this.state.status);
    });
  }

  _syncPresetChips() {
    document.querySelectorAll(".preset-chip").forEach((b) => {
      b.classList.toggle("active", b.dataset.preset === this.state.activePreset);
    });
  }

  _syncControlsFromState() {
    $("filter-theme").value = this.state.theme;
    this._syncStatusButtons();
    this._populateRegionDropdown();
    this._syncDensityMetricSelect();
    this._syncMapModeControls();
    $("region-layer-select").value = this.state.regionLayer;
    $("point-color-select").value = this.state.pointColorMode;
    $("lock-scale-toggle").checked = this.state.lockScale;
    $("filter-photo").checked = this.state.hasPhotoOnly;
    $("horizon-select").value = this.state.horizon;
    this._updateCategoryButtonLabel();
    this._highlightWindowButton();
    this._syncPresetChips();
  }

  _renderCategoryDropdown() {
    const listEl = $("cat-options-list");
    const cats = this.engine.meta.categories;
    const themes = this.engine.meta.themes;
    const themeFilter = this.state.theme === "all" ? -1 : parseInt(this.state.theme, 10);
    const term = this._catSearchTerm;

    const visible = [];
    for (let i = 0; i < cats.length; i++) {
      const c = cats[i];
      if (themeFilter >= 0 && c.theme !== themeFilter) continue;
      if (term && !c.name.toLowerCase().includes(term)) continue;
      const winCnt = this.lastAgg ? this.lastAgg.catCounts[i] : c.count;
      visible.push({ id: i, name: c.name, color: themes[c.theme].color, cnt: winCnt, checked: this.state.categories.has(i) });
    }
    visible.sort((a, b) => Number(b.checked) - Number(a.checked) || b.cnt - a.cnt);

    listEl.innerHTML = visible
      .map(
        (c) => `
      <label class="cat-option">
        <input type="checkbox" value="${c.id}" ${c.checked ? "checked" : ""}>
        <span class="cat-dot" style="background:${c.color}"></span>
        <span class="cat-option__name" title="${c.name}">${c.name}</span>
        <span class="cat-option__cnt">${c.cnt.toLocaleString()}</span>
      </label>
    `
      )
      .join("");

    listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cid = parseInt(cb.value, 10);
        if (cb.checked) this.state.categories.add(cid);
        else this.state.categories.delete(cid);
        this.state.activePreset = null;
        this._updateCategoryButtonLabel();
        this._update(true);
      });
    });
  }

  _updateCategoryButtonLabel() {
    const el = $("cat-dropdown-text");
    const n = this.state.categories.size;
    if (n === 0) {
      el.textContent = "All categories";
    } else if (n === 1) {
      const id = Array.from(this.state.categories)[0];
      el.textContent = this.engine.meta.categories[id].name;
    } else {
      el.textContent = `${n} categories selected`;
    }
  }

  _toggleCategory(catId) {
    if (this.state.categories.has(catId)) this.state.categories.delete(catId);
    else this.state.categories.add(catId);
    this.state.activePreset = null;
    this._updateCategoryButtonLabel();
    this._update(true);
  }

  _toggleRegion(rid) {
    const ridStr = String(rid);
    this.state.selectedRegion = this.state.selectedRegion === ridStr ? "all" : ridStr;
    $("filter-region").value = this.state.selectedRegion;
    this.state.activePreset = null;
    this._update(true);
  }

  _clearKeyword() {
    this.state.keyword = "";
    this.state.keywordIds = null;
    $("filter-keyword").value = "";
    $("btn-keyword-clear").hidden = true;
    this._update(true);
  }

  _resetFilters() {
    this.timelineView.pause();
    this.state.theme = "all";
    this.state.categories.clear();
    this.state.status = "all";
    this.state.selectedRegion = "all";
    this.state.hasPhotoOnly = false;
    this.state.keyword = "";
    this.state.keywordIds = null;
    this.state.activePreset = null;
    this.state.lockScale = false;
    this.mapView.clearLockedScale();
    $("filter-keyword").value = "";
    $("btn-keyword-clear").hidden = true;
    this._setHorizon("modern", false);
    const maxMin = this.engine.createdMin[this.engine.count - 1];
    this.state.winEndMin = maxMin;
    this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 365 * 1440);
    this._syncControlsFromState();
    this._update(true);
  }

  _applyPreset(preset) {
    this.timelineView.pause();
    this.state.theme = "all";
    this.state.categories.clear();
    this.state.status = "all";
    this.state.selectedRegion = "all";
    this.state.hasPhotoOnly = false;
    this.state.keyword = "";
    this.state.keywordIds = null;
    $("filter-keyword").value = "";
    $("btn-keyword-clear").hidden = true;
    this.state.activePreset = preset;

    const maxMin = this.engine.createdMin[this.engine.count - 1];
    const findCat = (name) => this.engine.catByName.get(name);

    if (preset === "recent90") {
      this._setHorizon("1y", false);
      this.state.winEndMin = maxMin;
      this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 90 * 1440);
      this.state.mapMode = "points";
    } else if (preset === "open-now") {
      this.state.status = "active";
      this._setHorizon("modern", false);
      this.state.winStartMin = this.state.horizonStartMin;
      this.state.winEndMin = maxMin;
      this.state.mapMode = "points";
      this.state.pointColorMode = "status";
    } else if (preset === "winter") {
      this.state.theme = "6"; // Snow & Ice
      this._setHorizon("3y", false);
      // Set a crisp 30-day window ready to animate across winter storms!
      this.state.winStartMin = this.state.horizonStartMin;
      this.state.winEndMin = Math.min(maxMin, this.state.horizonStartMin + 60 * 1440);
      this.state.mapMode = "choropleth";
      this.state.densityMetric = "density";
    } else if (preset === "bikes") {
      const cid = findCat("Bike Lane Obstruction");
      if (cid !== undefined) this.state.categories.add(cid);
      this._setHorizon("3y", false);
      this.state.winEndMin = maxMin;
      this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 365 * 1440);
      this.state.mapMode = "points";
      this.state.pointColorMode = "theme";
    } else if (preset === "rodents") {
      const cid = findCat("Rodent Sighting");
      if (cid !== undefined) this.state.categories.add(cid);
      this._setHorizon("modern", false);
      this.state.winEndMin = maxMin;
      this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 365 * 1440);
      this.state.mapMode = "choropleth";
      this.state.regionLayer = "tracts";
      this.state.densityMetric = "density";
    } else if (preset === "potholes") {
      const cid = findCat("Pothole");
      if (cid !== undefined) this.state.categories.add(cid);
      this._setHorizon("modern", false);
      this.state.winEndMin = maxMin;
      this.state.winStartMin = Math.max(this.state.horizonStartMin, maxMin - 365 * 1440);
      this.state.mapMode = "points";
      this.state.pointColorMode = "theme";
    }

    this.state.lockScale = false;
    this.mapView.clearLockedScale();
    this._syncControlsFromState();
    this._update(true);
  }

  _highlightWindowButton() {
    const winDays = Math.round((this.state.winEndMin - this.state.winStartMin) / 1440);
    const fullDays = Math.round((this.state.horizonEndMin - this.state.horizonStartMin) / 1440);
    document.querySelectorAll(".win-btn").forEach((btn) => {
      const v = btn.dataset.win;
      let match = false;
      if (v === "all") match = Math.abs(winDays - fullDays) <= 2;
      else match = Math.abs(winDays - parseInt(v, 10)) <= Math.max(1, parseInt(v, 10) * 0.05);
      btn.classList.toggle("active", match);
    });
  }

  _update(recomputeTimeline = false) {
    if (recomputeTimeline || !this.lastBins) {
      this.lastBins = this.engine.queryTimelineBins(this.state, 130);
    }
    const agg = this.engine.queryWindow(this.state);
    this.lastAgg = agg;

    this._renderKPIs(agg);
    this._renderActiveChips();
    this._renderWindowReadout();
    this.mapView.update(this.state, agg);
    this.chartsView.render(this.state, agg, this.timelineView.playing);
    this.timelineView.render(this.state, this.lastBins);

    if (this.timelineView.playing) {
      const s = formatShortDate(this.engine.minToMs(this.state.winStartMin));
      const e = formatShortDate(this.engine.minToMs(this.state.winEndMin));
      $("map-play-label").textContent = `${s} – ${e} · ${agg.total.toLocaleString()} requests`;
    }
  }

  _renderWindowReadout() {
    const sMs = this.engine.minToMs(this.state.winStartMin);
    const eMs = this.engine.minToMs(this.state.winEndMin);
    const days = Math.max(1, Math.round((this.state.winEndMin - this.state.winStartMin) / 1440));
    $("window-date-range").textContent = `${formatShortDate(sMs)} – ${formatShortDate(eMs)}`;
    const spanTxt = days >= 365 ? `${(days / 365.25).toFixed(1)} years` : `${days.toLocaleString()} days`;
    $("window-span-badge").textContent = spanTxt;
  }

  _renderKPIs(agg) {
    const days = Math.max(1, (this.state.winEndMin - this.state.winStartMin) / 1440);
    const perDay = agg.total / days;
    const hTotal = this.lastBins ? this.lastBins.horizonTotal : agg.total;
    const shareOfHorizon = hTotal > 0 ? ((agg.total / hTotal) * 100).toFixed(0) : "0";

    $("kpi-total").textContent = agg.total.toLocaleString();
    $("kpi-total-sub").textContent = `${perDay >= 10 ? perDay.toFixed(0) : perDay.toFixed(1)} / day · ${shareOfHorizon}% of timeline`;

    const activeTotal = agg.openCount + agg.ackCount;
    const activePct = agg.total > 0 ? ((activeTotal / agg.total) * 100).toFixed(1) : "0.0";
    $("kpi-active").textContent = activeTotal.toLocaleString();
    $("kpi-active-sub").textContent = `${agg.openCount.toLocaleString()} open · ${agg.ackCount.toLocaleString()} acknowledged (${activePct}%)`;

    $("kpi-median").textContent = formatDurationHours(agg.medianHours);
    $("kpi-median-sub").textContent =
      agg.resolvedCount > 0
        ? `Across ${agg.resolvedCount.toLocaleString()} resolved tickets`
        : "No resolved tickets in window";

    // Top category
    let topC = -1, topV = 0;
    for (let i = 0; i < agg.catCounts.length; i++) {
      if (agg.catCounts[i] > topV) {
        topV = agg.catCounts[i];
        topC = i;
      }
    }
    if (topC >= 0) {
      const name = this.engine.meta.categories[topC].name;
      const pct = agg.total > 0 ? ((topV / agg.total) * 100).toFixed(1) : "0.0";
      $("kpi-top-cat").textContent = name;
      $("kpi-top-cat").title = name;
      $("kpi-top-cat-sub").textContent = `${topV.toLocaleString()} requests (${pct}% of window)`;
    } else {
      $("kpi-top-cat").textContent = "—";
      $("kpi-top-cat-sub").textContent = "No matching tickets";
    }
  }

  _renderActiveChips() {
    const chips = [];
    if (this.state.theme !== "all") {
      const t = this.engine.meta.themes[parseInt(this.state.theme, 10)];
      chips.push({ label: `Topic: ${t.name}`, clear: () => { this.state.theme = "all"; $("filter-theme").value = "all"; this._update(true); } });
    }
    if (this.state.categories.size > 0) {
      for (const cid of this.state.categories) {
        const name = this.engine.meta.categories[cid].name;
        chips.push({ label: name, clear: () => this._toggleCategory(cid) });
      }
    }
    if (this.state.status !== "all") {
      const map = { active: "Open / Ack", open: "Open only", closed: "Closed / Archived" };
      chips.push({ label: `Status: ${map[this.state.status]}`, clear: () => { this.state.status = "all"; this._syncStatusButtons(); this._update(true); } });
    }
    if (this.state.selectedRegion !== "all") {
      const rm = this.engine.meta.regions[this.state.regionLayer][parseInt(this.state.selectedRegion, 10)];
      if (rm) {
        chips.push({ label: rm.name, clear: () => this._toggleRegion(rm.id) });
      }
    }
    if (this.state.keyword) {
      chips.push({ label: `Keyword: "${this.state.keyword}"`, clear: () => this._clearKeyword() });
    }
    if (this.state.hasPhotoOnly) {
      chips.push({ label: "Has photo", clear: () => { this.state.hasPhotoOnly = false; $("filter-photo").checked = false; this._update(true); } });
    }

    const wrap = $("active-chips");
    wrap.innerHTML = "";
    chips.forEach((ch) => {
      const span = document.createElement("span");
      span.className = "active-chip";
      span.innerHTML = `<span>${ch.label}</span><button type="button" aria-label="Remove ${ch.label}">×</button>`;
      span.querySelector("button").addEventListener("click", ch.clear);
      wrap.appendChild(span);
    });

    $("btn-reset-filters").hidden = chips.length === 0 && !this.state.activePreset;
  }

  _updateFreshnessBadge() {
    const maxIso = this.engine.meta.max_created || "";
    const maxDate = maxIso ? maxIso.slice(0, 10) : "—";
    const liveNote = this.engine.liveAdded > 0 ? ` (+${this.engine.liveAdded} live)` : "";
    $("freshness-badge").textContent = `${this.engine.count.toLocaleString()} tickets · through ${maxDate}${liveNote}`;
    $("about-build-meta").textContent = `Loaded ${this.engine.count.toLocaleString()} service requests (${this.engine.meta.min_created.slice(0, 10)} to ${maxDate}). Snapshot built ${this.engine.meta.built_at}${liveNote}.`;
  }

  async _openTicketDrawer(idx, panTo = false) {
    const drawer = $("ticket-drawer");
    const body = $("drawer-body");
    const tid = this.engine.ticketId[idx];
    const catObj = this.engine.meta.categories[this.engine.catIdx[idx]];
    const themeObj = this.engine.meta.themes[catObj.theme];
    const st = this.engine.meta.statuses[this.engine.flags[idx] & 3];
    const createdMs = this.engine.minToMs(this.engine.createdMin[idx]);
    const durH = this.engine.durHours[idx];
    const nh = this.engine.nhIdx[idx];
    const nhName = nh < this.engine.meta.regions.neighborhoods.length
      ? this.engine.meta.regions.neighborhoods[nh].name
      : "Cambridge";
    const tr = this.engine.trIdx[idx];
    const trName = tr < this.engine.meta.regions.tracts.length
      ? this.engine.meta.regions.tracts[tr].name
      : "—";

    const tagEl = $("drawer-theme-tag");
    tagEl.textContent = themeObj.name;
    tagEl.style.background = themeObj.color;
    // Enforce black/white contrast rule on badge background
    const darkBg = ["#196CC6", "#1D2F8D", "#730FE8", "#EC1A88", "#D20404"].includes(themeObj.color);
    tagEl.style.color = darkBg ? "#FFFFFF" : "#000000";

    $("drawer-title").textContent = catObj.name;
    drawer.hidden = false;
    this.mapView.setSelectedTicket(idx, panTo);

    body.innerHTML = `
      <dl class="drawer-dl">
        <dt>Ticket ID</dt><dd>#${tid}</dd>
        <dt>Status</dt><dd><span class="status-tag status-tag--${st}">${st}</span></dd>
        <dt>Reported</dt><dd>${formatShortDate(createdMs)}</dd>
        <dt>Resolution</dt><dd>${durH < 65535 ? formatDurationHours(durH) : "Not yet closed"}</dd>
        <dt>Neighborhood</dt><dd>${nhName} (${trName})</dd>
      </dl>
      <div class="drawer-desc">Loading full description and photo from Cambridge Open Data…</div>
      <a class="drawer-link-btn" href="https://seeclickfix.com/issues/${tid}" target="_blank" rel="noopener">View ticket #${tid} on SeeClickFix ↗</a>
    `;

    try {
      const detail = await this.engine.fetchTicketDetail(tid);
      if (drawer.hidden || this.mapView.selectedTicketIdx !== idx) return;

      const desc = detail && detail.issue_description
        ? detail.issue_description
        : "No additional description provided by reporter.";
      const addr = detail && detail.address ? detail.address : `${(this.engine.latE5[idx] / 100000).toFixed(5)}, ${(this.engine.lngE5[idx] / 100000).toFixed(5)}`;
      const subj = detail && detail.issue_type && detail.issue_type !== catObj.name ? detail.issue_type : null;
      const imgUrl = detail && detail.image ? detail.image : null;
      const scfUrl = (detail && detail.html_url && detail.html_url.url) || `https://seeclickfix.com/issues/${tid}`;

      const photoHtml = imgUrl
        ? `<a href="${imgUrl}" target="_blank" rel="noopener" title="Open full photo"><img class="drawer-photo" src="${imgUrl}" alt="Submitted photo for ticket #${tid}" loading="lazy"></a>`
        : "";

      body.innerHTML = `
        ${photoHtml}
        <div class="drawer-desc">${this._escapeHtml(desc)}</div>
        <dl class="drawer-dl">
          <dt>Ticket ID</dt><dd>#${tid}</dd>
          ${subj ? `<dt>Initial subject</dt><dd>${this._escapeHtml(subj)}</dd>` : ""}
          <dt>Status</dt><dd><span class="status-tag status-tag--${st}">${st}</span></dd>
          <dt>Address</dt><dd>${this._escapeHtml(addr)}</dd>
          <dt>Neighborhood</dt><dd>${nhName} · ${trName}</dd>
          <dt>Reported</dt><dd>${formatShortDate(createdMs)}</dd>
          <dt>Resolution</dt><dd>${durH < 65535 ? formatDurationHours(durH) : "Not yet closed"}</dd>
        </dl>
        <a class="drawer-link-btn" href="${scfUrl}" target="_blank" rel="noopener">View ticket #${tid} on SeeClickFix ↗</a>
      `;
    } catch {
      // Keep basic info if API fetch fails
    }
  }

  _closeTicketDrawer() {
    $("ticket-drawer").hidden = true;
    if (this.mapView) this.mapView.setSelectedTicket(null, false);
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _serializeStateToHash() {
    const p = new URLSearchParams();
    if (this.state.theme !== "all") p.set("theme", this.state.theme);
    if (this.state.categories.size > 0) p.set("cats", Array.from(this.state.categories).join(","));
    if (this.state.status !== "all") p.set("st", this.state.status);
    if (this.state.regionLayer !== "neighborhoods") p.set("layer", this.state.regionLayer);
    if (this.state.selectedRegion !== "all") p.set("reg", this.state.selectedRegion);
    if (this.state.hasPhotoOnly) p.set("photo", "1");
    if (this.state.mapMode !== "choropleth") p.set("mode", this.state.mapMode);
    if (this.state.densityMetric !== "density") p.set("metric", this.state.densityMetric);
    if (this.state.pointColorMode !== "theme") p.set("pcol", this.state.pointColorMode);
    if (this.state.horizon !== "modern") p.set("h", this.state.horizon);
    p.set("s", String(this.state.winStartMin));
    p.set("e", String(this.state.winEndMin));
    return "#" + p.toString();
  }

  _applyHashState() {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    const p = new URLSearchParams(raw);
    if (p.has("h") && ["modern", "3y", "1y", "all"].includes(p.get("h"))) {
      this._setHorizon(p.get("h"), false);
    }
    if (p.has("theme")) this.state.theme = p.get("theme");
    if (p.has("cats")) {
      p.get("cats").split(",").forEach((v) => {
        const n = parseInt(v, 10);
        if (Number.isInteger(n) && n >= 0 && n < this.engine.meta.categories.length) {
          this.state.categories.add(n);
        }
      });
    }
    if (p.has("st") && ["all", "active", "open", "closed"].includes(p.get("st"))) {
      this.state.status = p.get("st");
    }
    if (p.has("layer") && ["neighborhoods", "tracts", "wards_precincts", "zipcodes"].includes(p.get("layer"))) {
      this.state.regionLayer = p.get("layer");
    }
    if (p.has("reg")) this.state.selectedRegion = p.get("reg");
    if (p.get("photo") === "1") this.state.hasPhotoOnly = true;
    if (p.has("mode") && ["choropleth", "points"].includes(p.get("mode"))) {
      this.state.mapMode = p.get("mode");
    }
    if (p.has("metric") && ["density", "count", "per_capita"].includes(p.get("metric"))) {
      this.state.densityMetric = p.get("metric");
      if (!POP_SUPPORTED_LAYERS.has(this.state.regionLayer) && this.state.densityMetric === "per_capita") {
        this.state.densityMetric = "density";
      }
    }
    if (p.has("pcol") && ["theme", "status"].includes(p.get("pcol"))) {
      this.state.pointColorMode = p.get("pcol");
    }
    const s = parseInt(p.get("s"), 10);
    const e = parseInt(p.get("e"), 10);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      this.state.winStartMin = Math.max(this.state.horizonStartMin, Math.min(this.state.horizonEndMin - 1440, s));
      this.state.winEndMin = Math.max(this.state.winStartMin + 1440, Math.min(this.state.horizonEndMin, e));
    }
  }

  async _copyShareLink() {
    const hash = this._serializeStateToHash();
    window.history.replaceState(null, "", hash);
    const fullUrl = window.location.href;
    try {
      await navigator.clipboard.writeText(fullUrl);
      this._showToast("Shareable link copied to clipboard!");
    } catch {
      this._showToast("URL updated in address bar — copy to share!");
    }
  }

  _showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 3400);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new App();
  window.__c311App = app;
  app.init();
});

/**
 * charts.js — Fast, flat, interactive City of Cambridge data visualizations
 * that live-update on every filter change, timeline brush drag, and animation frame.
 */

import { formatDurationHours, formatShortDate } from "./data.js";
import { getRegionMetricValue } from "./map.js";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RES_LABELS = [
  { label: "Under 24 hours", color: "#00A9FF" },
  { label: "1 to 3 days", color: "#30B8FF" },
  { label: "3 to 7 days", color: "#196CC6" },
  { label: "1 to 4 weeks", color: "#1D2F8D" },
  { label: "1 to 3 months", color: "#730FE8" },
  { label: "Over 3 months", color: "#EC1A88" },
  { label: "Open / unresolved", color: "#D20404" },
];

const REGION_TITLES = {
  neighborhoods: "Neighborhoods",
  tracts: "2020 Census tracts",
  wards_precincts: "Wards & precincts",
  zipcodes: "ZIP codes",
};

function fmtMetric(val, metric) {
  if (val === null || val === undefined || !Number.isFinite(val)) return "N/A";
  if (metric === "count") return Math.round(val).toLocaleString();
  if (val >= 100) return Math.round(val).toLocaleString();
  return val.toFixed(1);
}

export class ChartsView {
  constructor(engine, opts) {
    this.engine = engine;
    this.elCategories = opts.elCategories;
    this.elRegions = opts.elRegions;
    this.elRegionsTitle = opts.elRegionsTitle;
    this.elRegionsHint = opts.elRegionsHint;
    this.elDow = opts.elDow;
    this.elHour = opts.elHour;
    this.elResolution = opts.elResolution;
    this.elTicketsList = opts.elTicketsList;

    this.onCategoryToggle = opts.onCategoryToggle;
    this.onRegionToggle = opts.onRegionToggle;
    this.onTicketSelect = opts.onTicketSelect;

    this.activeTab = "patterns";
  }

  setActiveTab(tab) {
    this.activeTab = tab;
  }

  render(state, agg, isPlaying = false) {
    this._renderCategories(state, agg);
    this._renderRegions(state, agg);

    // Only render the currently visible detail tab for extra speed during animation
    if (this.activeTab === "patterns") {
      this._renderPatterns(agg);
    } else if (this.activeTab === "resolution") {
      this._renderResolution(agg);
    } else if (this.activeTab === "tickets" && !isPlaying) {
      this._renderTicketsList(agg);
    }
  }

  renderTicketsListNow(agg) {
    this._renderTicketsList(agg);
  }

  _renderCategories(state, agg) {
    const cats = this.engine.meta.categories;
    const themes = this.engine.meta.themes;
    const rows = [];
    for (let i = 0; i < cats.length; i++) {
      const cnt = agg.catCounts[i];
      if (cnt > 0) rows.push({ id: i, name: cats[i].name, count: cnt, color: themes[cats[i].theme].color });
    }
    rows.sort((a, b) => b.count - a.count);
    const top = rows.slice(0, 10);

    if (top.length === 0) {
      this.elCategories.innerHTML = `<div class="empty-state">No requests match your current filters and time window.</div>`;
      return;
    }

    const maxV = top[0].count;
    this.elCategories.innerHTML = top
      .map((r) => {
        const pct = Math.max(2, (r.count / maxV) * 100);
        const sel = state.categories.has(r.id) ? "selected" : "";
        return `
          <div class="bar-row ${sel}" data-cat-id="${r.id}" role="button" tabindex="0" title="Click to toggle filter for ${r.name}">
            <div class="bar-label-line">
              <span class="cat-dot" style="background:${r.color}"></span>
              <span>${r.name}</span>
            </div>
            <div class="bar-val">${r.count.toLocaleString()}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${r.color}"></div></div>
          </div>
        `;
      })
      .join("");

    this.elCategories.querySelectorAll(".bar-row").forEach((row) => {
      const toggle = () => this.onCategoryToggle(parseInt(row.dataset.catId, 10));
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  _renderRegions(state, agg) {
    const metaList = this.engine.meta.regions[state.regionLayer];
    const metric = state.densityMetric;
    const layerLabel = REGION_TITLES[state.regionLayer] || "Regions";

    const metricTitle =
      metric === "density"
        ? "density"
        : metric === "per_capita"
          ? "rate"
          : "volume";
    const metricUnit =
      metric === "density"
        ? "Requests per sq mi"
        : metric === "per_capita"
          ? "Requests per 1,000 residents"
          : "Total requests";

    this.elRegionsTitle.textContent = `${layerLabel} by ${metricTitle}`;
    this.elRegionsHint.textContent = `${metricUnit} · Click to filter`;

    const rows = [];
    for (let i = 0; i < metaList.length; i++) {
      const cnt = agg.regionCounts[i] || 0;
      const val = getRegionMetricValue(metaList[i], cnt, metric);
      rows.push({ id: i, name: metaList[i].name, count: cnt, val });
    }
    rows.sort((a, b) => (b.val ?? -1) - (a.val ?? -1));
    const display = rows.slice(0, 13);

    const maxV = display.reduce((m, r) => (r.val !== null && r.val > m ? r.val : m), 0);
    if (maxV <= 0) {
      this.elRegions.innerHTML = `<div class="empty-state">No geographic matches in the selected time window.</div>`;
      return;
    }

    this.elRegions.innerHTML = display
      .map((r) => {
        const pct = r.val !== null && r.val > 0 ? Math.max(2, (r.val / maxV) * 100) : 0;
        const sel = String(state.selectedRegion) === String(r.id) ? "selected" : "";
        const fillColor = sel ? "#FF6000" : "#196CC6";
        return `
          <div class="bar-row ${sel}" data-region-id="${r.id}" role="button" tabindex="0" title="${r.name}: ${r.count.toLocaleString()} requests (${fmtMetric(r.val, metric)} ${metricUnit.toLowerCase()})">
            <div class="bar-label-line"><span>${r.name}</span></div>
            <div class="bar-val">${fmtMetric(r.val, metric)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${fillColor}"></div></div>
          </div>
        `;
      })
      .join("");

    this.elRegions.querySelectorAll(".bar-row").forEach((row) => {
      const toggle = () => this.onRegionToggle(parseInt(row.dataset.regionId, 10));
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  _renderPatterns(agg) {
    // Day of week
    let maxDow = 1;
    let peakDow = 0;
    for (let i = 0; i < 7; i++) {
      if (agg.dowCounts[i] > maxDow) {
        maxDow = agg.dowCounts[i];
        peakDow = i;
      }
    }
    this.elDow.innerHTML = DOW_LABELS.map((lbl, i) => {
      const cnt = agg.dowCounts[i];
      const h = agg.total > 0 ? Math.max(3, Math.round((cnt / maxDow) * 76)) : 2;
      const peak = cnt > 0 && i === peakDow ? "vbar-col--peak" : "";
      return `
        <div class="vbar-col ${peak}" title="${lbl}: ${cnt.toLocaleString()} requests">
          <div class="vbar-fill" style="height:${h}px"></div>
          <div class="vbar-lbl">${lbl}</div>
        </div>
      `;
    }).join("");

    // Hour of day
    let maxHr = 1;
    let peakHr = 0;
    for (let h = 0; h < 24; h++) {
      if (agg.hourCounts[h] > maxHr) {
        maxHr = agg.hourCounts[h];
        peakHr = h;
      }
    }
    let hrHtml = "";
    for (let h = 0; h < 24; h++) {
      const cnt = agg.hourCounts[h];
      const px = agg.total > 0 ? Math.max(2, Math.round((cnt / maxHr) * 76)) : 2;
      const peak = cnt > 0 && h === peakHr ? "vbar-col--peak" : "";
      const showLbl = h % 6 === 0 ? (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`) : "";
      const hrFmt = h === 0 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
      hrHtml += `
        <div class="vbar-col ${peak}" title="${hrFmt}: ${cnt.toLocaleString()} requests">
          <div class="vbar-fill" style="height:${px}px"></div>
          <div class="vbar-lbl">${showLbl || "&nbsp;"}</div>
        </div>
      `;
    }
    this.elHour.innerHTML = hrHtml;
  }

  _renderResolution(agg) {
    if (agg.total === 0) {
      this.elResolution.innerHTML = `<div class="empty-state">No requests in the selected window.</div>`;
      return;
    }
    let maxB = 1;
    for (let i = 0; i < RES_LABELS.length; i++) {
      if (agg.resBuckets[i] > maxB) maxB = agg.resBuckets[i];
    }

    this.elResolution.innerHTML = RES_LABELS.map((b, i) => {
      const cnt = agg.resBuckets[i];
      const pct = cnt > 0 ? Math.max(2, (cnt / maxB) * 100) : 0;
      const share = agg.total > 0 ? ((cnt / agg.total) * 100).toFixed(0) : "0";
      return `
        <div class="bar-row bar-row--static" title="${b.label}: ${cnt.toLocaleString()} (${share}%)">
          <div class="bar-label-line">
            <span class="cat-dot" style="background:${b.color}"></span>
            <span>${b.label}</span>
          </div>
          <div class="bar-val">${cnt.toLocaleString()}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${b.color}"></div></div>
        </div>
      `;
    }).join("");
  }

  _renderTicketsList(agg) {
    const matched = agg.matched;
    if (matched.length === 0) {
      this.elTicketsList.innerHTML = `<div class="empty-state">No tickets match the current view.</div>`;
      return;
    }
    const cats = this.engine.meta.categories;
    const statuses = this.engine.meta.statuses;
    const nhs = this.engine.meta.regions.neighborhoods;
    const limit = Math.min(45, matched.length);
    let html = "";

    // Newest first (matched is sorted ascending by createdMin)
    for (let k = matched.length - 1; k >= matched.length - limit; k--) {
      const idx = matched[k];
      const cat = cats[this.engine.catIdx[idx]].name;
      const st = statuses[this.engine.flags[idx] & 3];
      const hasPhoto = (this.engine.flags[idx] & 4) ? " · Photo" : "";
      const nh = this.engine.nhIdx[idx];
      const nhName = nh < nhs.length ? nhs[nh].name : "Cambridge";
      const dt = formatShortDate(this.engine.minToMs(this.engine.createdMin[idx]));
      const dh = this.engine.durHours[idx];
      const durTxt = dh < 65535 ? ` · Closed in ${formatDurationHours(dh)}` : "";

      html += `
        <button type="button" class="ticket-row" data-ticket-idx="${idx}">
          <div class="ticket-row__main">
            <div class="ticket-row__cat">${cat}</div>
            <div class="ticket-row__meta">${dt} · ${nhName}${durTxt}${hasPhoto}</div>
          </div>
          <span class="status-tag status-tag--${st}">${st}</span>
        </button>
      `;
    }

    this.elTicketsList.innerHTML = html;
    this.elTicketsList.querySelectorAll(".ticket-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.onTicketSelect(parseInt(btn.dataset.ticketIdx, 10));
      });
    });
  }
}

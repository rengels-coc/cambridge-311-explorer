/**
 * data.js — Compact binary loader, live Socrata delta sync, spatial join helper,
 * fast TypedArray filter/aggregation engine, and live keyword/ticket-detail API.
 */

const SOCRATA_API = "https://data.cambridgema.gov/resource/2z9k-mv9g.json";
const STATUS_MAP = { Archived: 0, Closed: 1, Acknowledged: 2, Open: 3 };

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function locateInCollection(lng, lat, fc) {
  if (!fc || !fc.features) return 255;
  for (let i = 0; i < fc.features.length; i++) {
    const geom = fc.features[i].geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (let p = 0; p < polys.length; p++) {
      const poly = polys[p];
      if (pointInRing(lng, lat, poly[0])) {
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
          if (pointInRing(lng, lat, poly[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return i;
      }
    }
  }
  return 255;
}

export class DataEngine {
  constructor() {
    this.meta = null;
    this.regions = null;
    this.count = 0;
    this.epochSec = 1230768000;
    this.liveAdded = 0;

    // Columnar arrays
    this.ticketId = null;
    this.createdMin = null;
    this.latE5 = null;
    this.lngE5 = null;
    this.durHours = null;
    this.catIdx = null;
    this.flags = null;
    this.nhIdx = null;
    this.trIdx = null;
    this.wpIdx = null;
    this.zpIdx = null;

    // Lookup tables
    this.catTheme = null;
    this.catByName = new Map();
    this.detailCache = new Map();
  }

  async load(onProgress = () => {}) {
    onProgress("Fetching metadata and Cambridge GIS boundaries…", 20);
    const [metaRes, regionsRes, binRes] = await Promise.all([
      fetch("data/meta.json"),
      fetch("data/regions.json"),
      fetch("data/tickets.bin"),
    ]);

    if (!metaRes.ok || !regionsRes.ok || !binRes.ok) {
      throw new Error("Could not load static data files.");
    }

    onProgress("Parsing 158,000+ service requests…", 60);
    const [meta, regions, buf] = await Promise.all([
      metaRes.json(),
      regionsRes.json(),
      binRes.arrayBuffer(),
    ]);

    this.meta = meta;
    this.regions = regions;
    this._parseBinary(buf);

    this.catTheme = new Uint8Array(meta.categories.length);
    this.catByName.clear();
    meta.categories.forEach((c, idx) => {
      this.catTheme[idx] = c.theme;
      this.catByName.set(c.name, idx);
    });

    onProgress("Ready!", 95);
    return this;
  }

  _parseBinary(buf) {
    const header = new DataView(buf, 0, 16);
    const magic = String.fromCharCode(
      header.getUint8(0),
      header.getUint8(1),
      header.getUint8(2),
      header.getUint8(3)
    );
    if (magic !== "C311") {
      throw new Error(`Unexpected binary header: ${magic}`);
    }
    const n = header.getUint32(8, true);
    this.epochSec = header.getUint32(12, true);
    this.count = n;

    let off = 16;
    this.ticketId = new Uint32Array(buf, off, n); off += 4 * n;
    this.createdMin = new Uint32Array(buf, off, n); off += 4 * n;
    this.latE5 = new Int32Array(buf, off, n); off += 4 * n;
    this.lngE5 = new Int32Array(buf, off, n); off += 4 * n;
    this.durHours = new Uint16Array(buf, off, n); off += 2 * n;
    if (n % 2 === 1) off += 2;
    this.catIdx = new Uint8Array(buf, off, n); off += n;
    this.flags = new Uint8Array(buf, off, n); off += n;
    this.nhIdx = new Uint8Array(buf, off, n); off += n;
    this.trIdx = new Uint8Array(buf, off, n); off += n;
    this.wpIdx = new Uint8Array(buf, off, n); off += n;
    this.zpIdx = new Uint8Array(buf, off, n);
  }

  /**
   * Fetch any brand-new tickets submitted after meta.max_created directly from Socrata.
   * Runs non-blocking after initial render so startup stays instant.
   */
  async syncLiveDelta() {
    if (!this.meta || !this.meta.max_created) return 0;
    const where = `ticket_created_date_time > '${this.meta.max_created}'`;
    const params = new URLSearchParams({
      $select: "ticket_id,issue_category,ticket_status,ticket_created_date_time,ticket_closed_date_time,lat,lng,image,address,issue_description,issue_type,html_url,acknowledged_at",
      $where: where,
      $order: "ticket_created_date_time ASC",
      $limit: "5000",
    });

    try {
      const resp = await fetch(`${SOCRATA_API}?${params.toString()}`);
      if (!resp.ok) return 0;
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length === 0) return 0;

      const existingTail = new Set();
      for (let i = Math.max(0, this.count - 500); i < this.count; i++) {
        existingTail.add(this.ticketId[i]);
      }

      const fresh = [];
      for (const r of rows) {
        const tid = parseInt(r.ticket_id, 10);
        if (!tid || existingTail.has(tid)) continue;
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const cMs = Date.parse(r.ticket_created_date_time.endsWith("Z") ? r.ticket_created_date_time : r.ticket_created_date_time + "Z");
        if (!Number.isFinite(cMs)) continue;
        const cMin = Math.floor((cMs / 1000 - this.epochSec) / 60);

        let durH = 65535;
        if (r.ticket_closed_date_time) {
          const clMs = Date.parse(r.ticket_closed_date_time.endsWith("Z") ? r.ticket_closed_date_time : r.ticket_closed_date_time + "Z");
          if (Number.isFinite(clMs) && clMs >= cMs) {
            durH = Math.min(65534, Math.floor((clMs - cMs) / 3600000));
          }
        }

        const catName = (r.issue_category || "Other").trim() || "Other";
        let cIdx = this.catByName.get(catName);
        if (cIdx === undefined) cIdx = this.catByName.get("Other") ?? 0;

        const st = STATUS_MAP[r.ticket_status] ?? 3;
        const hasImg = r.image ? 1 : 0;

        fresh.push({
          tid,
          cMin,
          latE5: Math.round(lat * 100000),
          lngE5: Math.round(lng * 100000),
          durH,
          cIdx,
          flags: (st & 3) | (hasImg << 2),
          nh: locateInCollection(lng, lat, this.regions.neighborhoods),
          tr: locateInCollection(lng, lat, this.regions.tracts),
          wp: locateInCollection(lng, lat, this.regions.wards_precincts),
          zp: locateInCollection(lng, lat, this.regions.zipcodes),
          raw: r,
        });
        this.detailCache.set(tid, r);
      }

      if (fresh.length === 0) return 0;
      fresh.sort((a, b) => a.cMin - b.cMin || a.tid - b.tid);

      const oldN = this.count;
      const newN = oldN + fresh.length;

      const append = (ArrType, src, getter) => {
        const out = new ArrType(newN);
        out.set(src, 0);
        for (let i = 0; i < fresh.length; i++) out[oldN + i] = getter(fresh[i]);
        return out;
      };

      this.ticketId = append(Uint32Array, this.ticketId, (x) => x.tid);
      this.createdMin = append(Uint32Array, this.createdMin, (x) => x.cMin);
      this.latE5 = append(Int32Array, this.latE5, (x) => x.latE5);
      this.lngE5 = append(Int32Array, this.lngE5, (x) => x.lngE5);
      this.durHours = append(Uint16Array, this.durHours, (x) => x.durH);
      this.catIdx = append(Uint8Array, this.catIdx, (x) => x.cIdx);
      this.flags = append(Uint8Array, this.flags, (x) => x.flags);
      this.nhIdx = append(Uint8Array, this.nhIdx, (x) => x.nh);
      this.trIdx = append(Uint8Array, this.trIdx, (x) => x.tr);
      this.wpIdx = append(Uint8Array, this.wpIdx, (x) => x.wp);
      this.zpIdx = append(Uint8Array, this.zpIdx, (x) => x.zp);

      this.count = newN;
      this.liveAdded = fresh.length;
      const lastRaw = fresh[fresh.length - 1].raw;
      if (lastRaw && lastRaw.ticket_created_date_time) {
        this.meta.max_created = lastRaw.ticket_created_date_time;
      }
      return fresh.length;
    } catch {
      return 0;
    }
  }

  minToMs(min) {
    return (this.epochSec + min * 60) * 1000;
  }

  msToMin(ms) {
    return Math.floor(ms / 60000 - this.epochSec / 60);
  }

  getRegionArray(regionLayer) {
    switch (regionLayer) {
      case "tracts": return this.trIdx;
      case "wards_precincts": return this.wpIdx;
      case "zipcodes": return this.zpIdx;
      default: return this.nhIdx;
    }
  }

  lowerBound(targetMin) {
    const arr = this.createdMin;
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < targetMin) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  upperBound(targetMin) {
    const arr = this.createdMin;
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= targetMin) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _buildFilterPredicate(state) {
    const themeFilter = state.theme === "all" ? -1 : parseInt(state.theme, 10);
    const hasCatSet = state.categories.size > 0;
    let catAllowed = null;
    if (hasCatSet || themeFilter >= 0) {
      catAllowed = new Uint8Array(this.meta.categories.length);
      for (let c = 0; c < this.meta.categories.length; c++) {
        const themeOk = themeFilter < 0 || this.catTheme[c] === themeFilter;
        const catOk = !hasCatSet || state.categories.has(c);
        catAllowed[c] = themeOk && catOk ? 1 : 0;
      }
    }

    // Status bitmask: 0=Archived, 1=Closed, 2=Acknowledged, 3=Open
    let statusMask = 0b1111;
    if (state.status === "active") statusMask = 0b1100; // Open + Acknowledged
    else if (state.status === "open") statusMask = 0b1000; // Open only
    else if (state.status === "closed") statusMask = 0b0011; // Closed + Archived

    const regionArr = this.getRegionArray(state.regionLayer);
    const selRegion = state.selectedRegion === "all" ? -1 : parseInt(state.selectedRegion, 10);
    const photoOnly = !!state.hasPhotoOnly;
    const kwSet = state.keywordIds; // null or Set<number>

    return { catAllowed, statusMask, regionArr, selRegion, photoOnly, kwSet };
  }

  /**
   * Compute full aggregates + matching ticket indices for the active brushed window [winStartMin, winEndMin].
   * Designed to execute in < 2ms on 158K tickets so animation stays buttery smooth.
   */
  queryWindow(state) {
    const startIdx = this.lowerBound(state.winStartMin);
    const endIdx = this.upperBound(state.winEndMin);
    const { catAllowed, statusMask, regionArr, selRegion, photoOnly, kwSet } = this._buildFilterPredicate(state);

    const numCats = this.meta.categories.length;
    const numThemes = this.meta.themes.length;
    const numRegions = this.meta.regions[state.regionLayer].length;

    const catCounts = new Uint32Array(numCats);
    const themeCounts = new Uint32Array(numThemes);
    const regionCounts = new Uint32Array(numRegions);
    // For hover tooltip "top issue" per region: keep region x cat flat counts
    const regionCatCounts = new Uint32Array(numRegions * numCats);
    const dowCounts = new Uint32Array(7);
    const hourCounts = new Uint32Array(24);
    const resBuckets = new Uint32Array(7); // <24h, 1-3d, 3-7d, 1-4w, 1-3m, 3m+, Open/Unresolved

    const durSamples = [];
    const matched = [];

    const catIdxArr = this.catIdx;
    const flagsArr = this.flags;
    const durArr = this.durHours;
    const createdArr = this.createdMin;
    const tidArr = this.ticketId;
    const catTheme = this.catTheme;
    const epochSec = this.epochSec;

    let total = 0;
    let openCount = 0;
    let ackCount = 0;
    let closedCount = 0;
    let photoCount = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const c = catIdxArr[i];
      if (catAllowed && !catAllowed[c]) continue;

      const fl = flagsArr[i];
      const st = fl & 3;
      if (!((statusMask >> st) & 1)) continue;
      if (photoOnly && !(fl & 4)) continue;

      const reg = regionArr[i];
      if (selRegion >= 0 && reg !== selRegion) continue;
      if (kwSet && !kwSet.has(tidArr[i])) continue;

      total++;
      matched.push(i);
      catCounts[c]++;
      themeCounts[catTheme[c]]++;
      if (reg < numRegions) {
        regionCounts[reg]++;
        regionCatCounts[reg * numCats + c]++;
      }

      if (st === 3) openCount++;
      else if (st === 2) ackCount++;
      else closedCount++;
      if (fl & 4) photoCount++;

      // Local day-of-week & hour (Cambridge timestamps from Socrata are local wall clock stored as UTC)
      const sec = epochSec + createdArr[i] * 60;
      const daysSince1970 = Math.floor(sec / 86400);
      const dow = (daysSince1970 + 3) % 7; // 0=Mon .. 6=Sun (1970-01-01 was Thu=3)
      const hour = Math.floor((sec % 86400) / 3600);
      dowCounts[dow >= 0 ? dow : dow + 7]++;
      hourCounts[hour >= 0 ? hour : hour + 24]++;

      const dh = durArr[i];
      if (dh === 65535) {
        resBuckets[6]++;
      } else {
        durSamples.push(dh);
        if (dh < 24) resBuckets[0]++;
        else if (dh < 72) resBuckets[1]++;
        else if (dh < 168) resBuckets[2]++;
        else if (dh < 672) resBuckets[3]++;
        else if (dh < 2160) resBuckets[4]++;
        else resBuckets[5]++;
      }
    }

    // Top category per region
    const regionTopCat = new Int16Array(numRegions).fill(-1);
    for (let r = 0; r < numRegions; r++) {
      if (regionCounts[r] === 0) continue;
      let bestC = -1, bestV = 0;
      const base = r * numCats;
      for (let c = 0; c < numCats; c++) {
        const v = regionCatCounts[base + c];
        if (v > bestV) {
          bestV = v;
          bestC = c;
        }
      }
      regionTopCat[r] = bestC;
    }

    // Median resolution time
    let medianHours = null;
    if (durSamples.length > 0) {
      durSamples.sort((a, b) => a - b);
      const mid = durSamples.length >> 1;
      medianHours = durSamples.length % 2 === 1
        ? durSamples[mid]
        : (durSamples[mid - 1] + durSamples[mid]) / 2;
    }

    return {
      total,
      openCount,
      ackCount,
      closedCount,
      photoCount,
      resolvedCount: durSamples.length,
      medianHours,
      catCounts,
      themeCounts,
      regionCounts,
      regionTopCat,
      dowCounts,
      hourCounts,
      resBuckets,
      matched,
    };
  }

  /**
   * Compute timeline histogram bins over the visible horizon [horizonStartMin, horizonEndMin].
   * Applies all non-time filters so the timeline reflects the user's active topic/category/region/keyword!
   */
  queryTimelineBins(state, numBins = 120) {
    const hStart = state.horizonStartMin;
    const hEnd = state.horizonEndMin;
    const span = Math.max(1, hEnd - hStart);
    const binWidth = span / numBins;
    const counts = new Uint32Array(numBins);

    const startIdx = this.lowerBound(hStart);
    const endIdx = this.upperBound(hEnd);
    const { catAllowed, statusMask, regionArr, selRegion, photoOnly, kwSet } = this._buildFilterPredicate(state);

    const catIdxArr = this.catIdx;
    const flagsArr = this.flags;
    const createdArr = this.createdMin;
    const tidArr = this.ticketId;

    let horizonTotal = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const c = catIdxArr[i];
      if (catAllowed && !catAllowed[c]) continue;
      const fl = flagsArr[i];
      if (!((statusMask >> (fl & 3)) & 1)) continue;
      if (photoOnly && !(fl & 4)) continue;
      if (selRegion >= 0 && regionArr[i] !== selRegion) continue;
      if (kwSet && !kwSet.has(tidArr[i])) continue;

      horizonTotal++;
      let b = Math.floor((createdArr[i] - hStart) / binWidth);
      if (b < 0) b = 0;
      else if (b >= numBins) b = numBins - 1;
      counts[b]++;
    }

    let maxBin = 0;
    for (let b = 0; b < numBins; b++) {
      if (counts[b] > maxBin) maxBin = counts[b];
    }

    return { counts, maxBin, binWidth, hStart, hEnd, horizonTotal };
  }

  /**
   * Full-text keyword search across descriptions & addresses via Cambridge Open Data Socrata $q API.
   */
  async searchKeyword(query) {
    const clean = query.trim();
    if (!clean) return null;
    const params = new URLSearchParams({
      $select: "ticket_id",
      $q: clean,
      $limit: "50000",
    });
    const resp = await fetch(`${SOCRATA_API}?${params.toString()}`);
    if (!resp.ok) throw new Error("Keyword search request failed.");
    const rows = await resp.json();
    const ids = new Set();
    for (const r of rows) {
      const tid = parseInt(r.ticket_id, 10);
      if (tid) ids.add(tid);
    }
    return ids;
  }

  /**
   * Fetch rich full details for a single ticket (description, address, photo, SeeClickFix URL).
   */
  async fetchTicketDetail(ticketId) {
    if (this.detailCache.has(ticketId)) {
      return this.detailCache.get(ticketId);
    }
    const params = new URLSearchParams({
      ticket_id: String(ticketId),
      $limit: "1",
    });
    const resp = await fetch(`${SOCRATA_API}?${params.toString()}`);
    if (!resp.ok) throw new Error("Could not load ticket details.");
    const rows = await resp.json();
    const detail = rows && rows.length ? rows[0] : null;
    if (detail) this.detailCache.set(ticketId, detail);
    return detail;
  }
}

export function formatDurationHours(hours) {
  if (hours === null || hours === undefined || hours >= 65535) return "—";
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(1)}d`;
  if (days < 90) return `${Math.round(days)}d`;
  return `${(days / 30.4).toFixed(1)} mo`;
}

export function formatShortDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatCompactDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

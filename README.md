# Cambridge 311 Explorer

An interactive web explorer for City of Cambridge **Commonwealth Connect (311)** service requests, styled with the official City of Cambridge "Cambridge Reimagined" brand system and published via GitHub Pages.

## Live site

**https://rengels-coc.github.io/cambridge-311-explorer/**

## Features

- **Live-updating filters**: Filter by Topic, multi-select Issue Category, Ticket Status, Geographic Region, Photo availability, and live full-text Keyword Search (via the Cambridge Open Data Socrata API), plus one-click Quick Views.
- **Dual-mode interactive map**:
  - **Region density choropleth** across four official Cambridge GIS boundary layers: **Neighborhoods (13)**, **2020 Census Tracts (33)**, **Wards & Precincts (33)**, and **ZIP Codes (5)**, viewable by **Density (per sq mi)**, **Total requests**, or **Per 1,000 residents**, with an optional **Lock scale** toggle for time-series animation.
  - **Individual complaints canvas map** plotting thousands of points smoothly at 60 FPS, colored by Topic or Status, with click-to-inspect details, resident descriptions, submitted photos, and direct SeeClickFix links.
- **Cross-filtering charts**: Live-updating Top Issue Categories, Regional Breakdown, Day-of-Week & Hour-of-Day patterns, Resolution Speed distribution, and a browsable list of matching tickets.
- **Interactive brushable timeline & playback animation**: Drag handles to resize the active date window, drag inside to scrub through time, or click **Play** (or press `Space`) to animate the moving window automatically across the map and all charts.
- **Shareable views**: Click **Share view** to copy a permalink encoding your exact filters, map mode, region layer, and timeline window.

## Data sources

- **Service requests**: [Commonwealth Connect Service Requests (`2z9k-mv9g`)](https://data.cambridgema.gov/Public-Works/Commonwealth-Connect-Service-Requests/2z9k-mv9g/about_data) on Cambridge Open Data. A nightly GitHub Action rebuilds the compact binary snapshot (`data/tickets.bin`), and the app automatically delta-syncs newly created tickets live on startup.
- **Geographic boundaries**: [Cambridge GIS Open Data](https://github.com/cambridgegis/cambridgegis_data) (`BOUNDARY_CDDNeighborhoods`, `DEMOGRAPHICS_Tracts2020`, `ELECTIONS_WardsPrecincts`, `BOUNDARY_Zipcodes`).
- **2020 Census populations**: Cambridge Open Data (`rqau-pwa4`) and Cambridge GIS `ELECTIONS_WardsPrecincts`.

## Local development

```bash
# Rebuild the compact dataset from Cambridge Open Data + Cambridge GIS
python scripts/build_data.py

# Serve locally
python -m http.server 8000
```

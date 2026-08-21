# Site-of-Service Price Comparison

A separate tool from the main `hospital-price-transparency` app — no shared code, no shared live database. The idea: for a lot of procedures, Medicare pays a different amount depending on *where* the procedure happens — a doctor's office, an ambulatory surgical center (ASC), or a hospital outpatient department (HOPD) — even though it's the same CPT/HCPCS code. Most people never see that gradient. This makes it searchable.

## What's in the database (`data/prices.db`)

A fresh SQLite database, independent of the hospital app's `prices.db` (that one has 1.9GB of hospital-specific charge data this tool doesn't need). Three tables:

- **`medicare_rates`** — copied from the hospital app's Medicare reference data (CMS Physician Fee Schedule, CY2026). Has both `nonfac_rate` (office) and `facility_rate` (physician payment when done in a facility) per code, plus OPPS hospital-facility-fee columns (`opps_austin_payment` etc.) for the hospital-outpatient total.
- **`medicare_asc_rates`** — new, built today from the CMS ASC Payment System quarterly addenda (July 2026). 7,387 codes, 5,724 with a separately payable ASC rate.
- **`friendly_names`** — copied from the hospital app; plain-language names for ~19,865 codes, ready for search.

## The three site-of-service price points, per code

| Setting | Source | Column(s) |
|---|---|---|
| Doctor's office | PFS non-facility rate | `medicare_rates.nonfac_rate` |
| Ambulatory surgical center | ASC Payment System | `medicare_asc_rates.payment_rate_austin` (null/not payable if `payable = 0`) |
| Hospital outpatient | PFS facility rate + OPPS facility fee | `medicare_rates.facility_rate` + `medicare_rates.opps_austin_payment` |

**4,456 codes have all three price points populated** — a solid working set for the comparison UI. Coverage isn't universal: some procedures (like most E&M office visits) aren't done in an ASC or hospital OR at all; some hospital-only procedures don't have an office rate; ASC payment indicator `N1` means "packaged, no separate ASC payment" for a given code even though the other two settings apply.

## Real numbers, sanity-checked (Austin wage index, CY2026)

| Code | Procedure | Office | ASC | Hospital outpatient |
|---|---|---|---|---|
| 45380 | Colonoscopy w/ biopsy | $498.91 | $645.76 | $1,381.19 |
| 66984 | Cataract removal | $472.92 | $1,234.71 | $2,791.26 |
| 29881 | Knee arthroscopy/meniscectomy | $524.77 | $1,617.33 | $3,811.68 |
| 43239 | EGD w/ biopsy | $437.23 | $489.52 | $1,035.96 |

Consistent office < ASC < hospital-outpatient ordering, matching well-documented site-of-service cost gradients (cataract surgery being dramatically cheaper in an ASC than a hospital is a famous example in health policy). Re-run `npm run fetch-asc` to print more samples or refresh the data.

## Data sourcing notes

- **ASC files are AMA-license-gated.** The CMS download links route through `cms.gov/apps/ama/license.asp` (CPT short descriptors are AMA-copyrighted). The "Accept" button is a plain GET with `?agree=yes&next=Accept` appended to the real file URL — no session or cookie needed, confirmed by inspecting the license page's form markup. `scripts/fetch-asc.js` hits that URL directly.
- **Wage adjustment**: ASC payments use the *same* OPPS wage index and the same 60% labor / 40% non-labor split as hospital outpatient (confirmed in the CY2026 final rule — no separate ASC-specific labor share). Reuses the Austin wage index constant (0.9721, floor-adjusted CBSA 12420) already established in the hospital app's OPPS ingestion, for consistency.
- **Quarter alignment**: ASC data is July 2026 (most current quarter as of ingestion). The copied `medicare_rates`/OPPS data is whatever quarter the hospital app last refreshed (January 2026 vintage) — a minor quarter mismatch, not corrected here. Fine for now; worth aligning if this becomes the primary dataset rather than a comparison prototype.

## The app (`public/index.html`)

Built for a different audience than the consumer-facing hospital app — healthcare finance/operations people who want to pull a clean price list, not a single "should I worry about this bill" banner. Fully static: the entire dataset (7,557 codes, ~3MB) is embedded inline in the HTML as a `<script>` tag, so the file opens directly via `file://` in any browser — no server, no fetch, nothing to install. Rebuild it with `npm run build` after any data change.

**Search**: by curated category (a starter list of ~16 CPT body-region/specialty ranges — Hand and Fingers, Knee, Digestive System, etc.), by a raw CPT/HCPCS range you type in directly, by pasting a specific list of codes, or by keyword against the plain-language description. Filters combine; there's also a checkbox to show only codes priced in all three settings.

**Columns**: Code, Type, Description, Office (total), ASC – Physician / Facility / Total, Hospital Outpatient – Physician / Facility / Total, Notes. The ASC and hospital-outpatient physician-fee columns are deliberately the same number for a given code — Medicare's Physician Fee Schedule only distinguishes facility vs. non-facility, not which facility type, so that's not a bug. A setting's Total is left blank (not a $0 or a misleading physician-only number) whenever that setting's facility fee isn't separately payable for that code — the Notes column explains why (packaged, inpatient-only, not on the ASC list, etc.), sourced from the same OPPS/ASC indicator legends the main app uses.

**Export**: "Export CSV" downloads exactly what's in the results table — UTF-8 with a BOM (opens correctly in Excel, no mangled characters), proper comma/quote escaping. Tested end to end (category search, the "all 3 settings" filter, a specific-code lookup, column sort, and the CSV download itself) via a headless Chrome + puppeteer-core script — real numbers, e.g. code 26055 (trigger finger release): Office $657.12, ASC total $1,153.52 ($295.26 physician + $858.26 facility), Hospital Outpatient total $1,910.58 ($295.26 physician + $1,615.32 facility).

Click any column header to sort by it.

## Not built yet

- Hosting/deployment — currently local-file-only by design ("static/serverless during testing," per direction). Revisit if this needs to be shared with others who can't run the build scripts themselves.
- The category list is a starter set (16 ranges, mostly musculoskeletal). Easy to extend — it's a plain array at the top of `scripts/build-html.js`.
- Re-fetch/refresh script for `medicare_rates` itself (currently a one-time copy, not wired to re-pull from the hospital app or CMS directly).
- Quarter alignment between the copied PFS/OPPS data (January 2026) and the new ASC data (July 2026) — noted above, not corrected.

## Setup from a fresh clone

`data/prices.db` isn't in git (data artifacts are gitignored, same convention as the hospital-price-transparency repo — regenerate, don't commit). It also isn't fully self-fetchable yet: the `medicare_rates` and `friendly_names` tables were copied one time from the [hospital-price-transparency](https://github.com/smorrel9/hospital-price-transparency) repo's own database rather than fetched independently by a script in this repo (see "Not built yet" below).

```bash
npm install

# Seed data/prices.db with medicare_rates + friendly_names — for now, copy
# from a checkout of hospital-price-transparency:
#   sqlite3 <path-to-that-repo>/prices.db ".backup /path/to/this/repo/data/prices.db"
# then continue:
npm run fetch-asc    # downloads CMS ASC addenda, adds medicare_asc_rates
npm run build         # rebuilds data/site-of-service-dataset.json + public/index.html
```

The pre-built `public/index.html` (data embedded inline, ~3MB) is committed to this repo, so you can also just open that file directly without running any of the above — only needed if you're changing the data or the app itself.

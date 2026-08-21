# Site-of-Service Price Comparison

**Live at [smorrel9.github.io/site-of-service-comparison](https://smorrel9.github.io/site-of-service-comparison/)** (GitHub Pages, deployed automatically on push to `main` via `.github/workflows/pages.yml`).

A separate tool from the main `hospital-price-transparency` app — no shared code, no shared live database. The idea: for a lot of procedures, Medicare pays a different amount depending on *where* the procedure happens — a doctor's office, an ambulatory surgical center (ASC), or a hospital outpatient department (HOPD) — even though it's the same CPT/HCPCS code. Most people never see that gradient. This makes it searchable.

**See [`Healthcare Finance Exceptions Log.md`](./Healthcare%20Finance%20Exceptions%20Log.md) for the running list of non-obvious billing rules found while building this** — none of them were visible from the data alone; each one needed real healthcare finance/operations knowledge to catch. It's the clearest evidence for why this kind of tool needs a domain expert in the loop, not just a script.

## What's in the database (`data/prices.db`)

A fresh SQLite database, independent of the hospital app's `prices.db` (that one has 1.9GB of hospital-specific charge data this tool doesn't need). Three tables:

- **`medicare_rates`** — copied from the hospital app's Medicare reference data (CMS Physician Fee Schedule, CY2026). Has both `nonfac_rate` (office) and `facility_rate` (physician payment when done in a facility) per code, plus OPPS hospital-facility-fee columns (`opps_austin_payment` etc.) for the hospital-outpatient total.
- **`medicare_asc_rates`** — new, built today from the CMS ASC Payment System quarterly addenda (July 2026). 7,387 codes, 5,724 with a separately payable ASC rate.
- **`friendly_names`** — copied from the hospital app; plain-language names for ~19,865 codes, ready for search.

## The three site-of-service price points, per code

| Setting | Source | Column(s) |
|---|---|---|
| Doctor's office | PFS non-facility rate | `medicare_rates.nonfac_rate` |
| Ambulatory surgical center | PFS facility rate (physician) + ASC Payment System (facility) | `medicare_rates.facility_rate` + `medicare_asc_rates.payment_rate_austin` |
| Hospital outpatient | PFS facility rate (physician) + OPPS facility fee | `medicare_rates.facility_rate` + `medicare_rates.opps_austin_payment` |

ASC and hospital outpatient are both physician-fee + facility-fee — same physician component (Medicare's fee schedule only distinguishes facility vs. non-facility, not which facility type), different facility payer.

### Office exclusion — four passes, decreasing confidence

CMS publishes a non-facility (office) PE RVU for nearly every code, even ones never actually performed in an office. Getting this right took four passes, found through real usage, not upfront design. Full narrative (with the specific codes that caught each one) in [`Healthcare Finance Exceptions Log.md`](./Healthcare%20Finance%20Exceptions%20Log.md).

**Pass 1 — exact match (confident).** When `nonfac_pe_rvu` exactly equals `facility_pe_rvu`, CMS didn't calculate a genuine differentiated office rate, it just defaulted to the facility value (e.g. `50045`, Nephrotomy w/exploration — major open surgery). No real practice pattern of doing this in-office. This is the norm, not the edge case: **71% of codes hit this pattern** before the exemptions below are applied.

**Exemption 1 — PC/TC split codes (confident).** ~1,132 codes, mostly radiology/imaging, have a genuine professional (`26`) / technical (`TC`) component split in the raw CMS RVU file. For these, equal PE RVU on the *global* (no-modifier) row does **not** mean facility-only — it's a structural side effect of how PC/TC RVUs are built (the global row's PE RVU is just the 26 + TC rows summed, and technical/equipment cost doesn't carry a facility-vs-non-facility differential the way genuinely site-flexible procedures do). Chest X-ray (`71046`) and even MRI (`73721`) are routinely billed globally by practices/imaging centers that own their own equipment — confirmed by hand against the raw RVU file for both codes. These codes are exempted from Pass 1 and get a real office price (829 codes rescued). Extracted via `scripts/extract-pc-tc-codes.js` → `data/pc-tc-split-codes.json`.

**Pass 2 — ratio threshold (unverified heuristic, tagged for hand-curation).** Some codes get a genuinely *differentiated* but implausibly large non-facility PE RVU — CMS's methodology still allocates a theoretical equipment/supply cost to an office setting that wouldn't realistically stock it (e.g. `61626`, vascular embolization: nonfac PE RVU is 76x the facility value, producing a $10,248 "office" price against a $746.74 facility rate). No clean CMS data flag exists for this — checked the raw file's `NON-FAC NA INDICATOR` column directly, it's blank for this code. The heuristic: exclude Office when the ratio exceeds **15x**, a threshold calibrated against known-legitimate office procedures (EKG, laceration repair, eye exam, joint injection — all ran 1x–8x). **This will have false positives/negatives at the margin** — flagged rows carry a `⚠` badge in the app and in the Notes column, and there's an "only office-flagged codes" filter to review them. Treat as a first pass, not a final answer; the plan is to hand-curate this list later.

**Exemption 2 — Cardiovascular System chapter, office-based labs (confident).** Pass 2 alone flagged 133 codes (54% of its exclusions) in the cardiovascular/vascular chapter — mostly peripheral vascular intervention (`37220`–`37799`: atherectomy, IVL/lithotripsy, endovascular stenting, averaging a **108.8x** ratio) and percutaneous dialysis access creation (`36836`, `36837`, ~172x). These aren't artifacts — they're real, well-documented **office-based labs (OBLs)**, a widely-recognized trend in health policy literature directly tied to CMS's non-facility payment for these codes. The huge ratio reflects genuinely expensive disposables ($3,000–$10,000+ devices), not an unrealistic allocation. Exempted the whole Cardiovascular System chapter (`33016`–`37799`) from Pass 2 — verified safe since Pass 1 already independently catches genuinely facility-only codes in this same chapter (e.g. `33533`, CABG, exact-match ratio of 1.0, never reaches Pass 2). Neuro-interventional codes like `61626` live in a different chapter (Nervous System) and correctly remain excluded — same procedure type ("embolization"), opposite site-of-service reality, because the specialty context differs. Catches 172 codes after this exemption (down from 248).

**Net effect**: 5,778 codes have at least one usable price point. 1,671 have all three settings priced, 3,459 have two, 648 have one.

## Real numbers, sanity-checked (Austin wage index, CY2026)

| Code | Procedure | Office | ASC | Hospital outpatient |
|---|---|---|---|---|
| 26055 | Trigger finger release (tendon sheath incision) | $657.12 | $1,153.52 | $1,910.58 |
| 66984 | Cataract removal | — (Pass 1: facility-only) | $1,707.63 | $2,791.26 |
| 29881 | Knee arthroscopy/meniscectomy | — (Pass 1: facility-only) | $2,142.10 | $3,811.68 |
| 43239 | EGD w/ biopsy | $437.23 | $614.36 | $1,035.96 |
| 71046 | Chest X-ray, 2 views | $34.48 | $56.93 | $121.90 |
| 61626 | Vascular embolization (non-CNS) | — (Pass 2: ⚠ unverified) | $7,498.28 | $12,343.53 |

71046 is the PC/TC exemption in action — it would show blank under Pass 1 alone (equal PE RVU) but is a completely normal in-office X-ray. 61626 is Pass 2 catching a case Pass 1 missed entirely (its PE RVUs are genuinely different, just implausibly so).

Consistent office < ASC < hospital-outpatient ordering where all three are priced, matching well-documented site-of-service cost gradients (cataract surgery being dramatically cheaper in an ASC than a hospital is a famous example in health policy). Re-run `npm run fetch-asc` to print more samples or refresh the data.

## Data sourcing notes

- **ASC files are AMA-license-gated.** The CMS download links route through `cms.gov/apps/ama/license.asp` (CPT short descriptors are AMA-copyrighted). The "Accept" button is a plain GET with `?agree=yes&next=Accept` appended to the real file URL — no session or cookie needed, confirmed by inspecting the license page's form markup. `scripts/fetch-asc.js` hits that URL directly.
- **Wage adjustment**: ASC payments use the *same* OPPS wage index and the same 60% labor / 40% non-labor split as hospital outpatient (confirmed in the CY2026 final rule — no separate ASC-specific labor share). Reuses the Austin wage index constant (0.9721, floor-adjusted CBSA 12420) already established in the hospital app's OPPS ingestion, for consistency.
- **Quarter alignment**: ASC data is July 2026 (most current quarter as of ingestion). The copied `medicare_rates`/OPPS data is whatever quarter the hospital app last refreshed (January 2026 vintage) — a minor quarter mismatch, not corrected here. Fine for now; worth aligning if this becomes the primary dataset rather than a comparison prototype.

## The app (`public/index.html`)

Built for a different audience than the consumer-facing hospital app — healthcare finance/operations people who want to pull a clean price list, not a single "should I worry about this bill" banner. Fully static: the entire dataset (5,778 codes, ~2.9MB) is embedded inline in the HTML as a `<script>` tag, so the file opens directly via `file://` in any browser — no server, no fetch, nothing to install. Rebuild it with `npm run build` after any data change.

**Search**: by curated category (a starter list of ~20 CPT body-region/specialty ranges — Hand and Fingers, Knee, Digestive System, plus four radiology sub-specialties: Diagnostic Radiology, Diagnostic Ultrasound, Radiation Oncology, Nuclear Medicine), by a raw CPT/HCPCS range you type in directly, by pasting a specific list of codes, or by keyword against the plain-language description. Typing into the range or code-list fields clears any selected category so it doesn't silently keep overriding what you just typed (a real bug in the first version — category always won). Checkboxes: show only codes priced in all three settings, or show only office-flagged codes (the unverified 15x-ratio exclusions — see Known Limitations) for review.

Radiology is a good stress test of the PC/TC exemption (see above): 99% of Diagnostic Radiology and Nuclear Medicine codes, and 100% of Diagnostic Ultrasound codes, now show a real office price with zero ratio-heuristic false flags — consistent with practices/imaging centers routinely owning this equipment and billing globally. Radiation Oncology comes in lower (81%) — clinically sensible, since linear accelerators and similar equipment are less commonly practice-owned.

**Columns**: Code, Type, Description, Office (total), ASC – Physician / Facility / Total, Hospital Outpatient – Physician / Facility / Total, Notes. The ASC and hospital-outpatient physician-fee columns are deliberately the same number for a given code — Medicare's Physician Fee Schedule only distinguishes facility vs. non-facility, not which facility type, so that's not a bug. A setting's Total is left blank (not a $0 or a misleading physician-only number) whenever that setting's facility fee isn't separately payable for that code — the Notes column explains why (packaged, inpatient-only, not on the ASC list, etc.), sourced from the same OPPS/ASC indicator legends the main app uses. A `⚠ unverified` badge on the Office column marks the Pass 2 ratio-heuristic exclusions specifically, distinct from confident Pass 1 exclusions (which just show a plain blank).

**Export**: "Export CSV" downloads exactly what's in the results table — UTF-8 with a BOM (opens correctly in Excel, no mangled characters), proper comma/quote escaping. Tested end to end (category search, the "all 3 settings" filter, a specific-code lookup, column sort, and the CSV download itself) via a headless Chrome + puppeteer-core script — real numbers, e.g. code 26055 (trigger finger release): Office $657.12, ASC total $1,153.52 ($295.26 physician + $858.26 facility), Hospital Outpatient total $1,910.58 ($295.26 physician + $1,615.32 facility).

Click any column header to sort by it.

## Known limitations (tagged for follow-up)

- **⚠ The 15x ratio office-exclusion heuristic (Pass 2 above) is unverified.** 172 codes currently show no office price based on a calibrated-but-arbitrary threshold, not a confirmed clinical fact (down from 248 after exempting the Cardiovascular System chapter — see Exemption 2 above; there may well be other specialty-specific false positives still in this list). Plan: hand-curate this list against real practice patterns. Until then, treat every ⚠-flagged row as "probably right, not confirmed" — filterable in the app via "only office-flagged codes," and marked in CSV exports via the "Office flagged" column.
  - **Real fix, not a modifier — Medicare claims/utilization data by place of service.** Checked whether CPT/HCPCS modifiers could resolve this more cleanly than the ratio heuristic. Modifiers 26/TC already do the heavy lifting (the PC/TC exemption below); checked OPPS status indicator `C` (inpatient-only) as an independent cross-check too — only 1 code in the whole dataset was inpatient-only *and* not already caught by the existing two passes, and that one was already caught by the ratio rule anyway, so it's redundant, not a new signal. There's no modifier in the fee-schedule reference data that means "clinically restricted from office." The actual authoritative answer lives in claims data: CMS publishes the "Medicare Physician & Other Practitioner" public use files, which include real billing counts by HCPCS code and place of service — i.e., what % of a code was actually billed in POS 11 (office) in real practice, directly, instead of inferring it from RVU construction. That's a genuinely separate, larger data-sourcing project (a new public dataset to source and join in), not a quick fix — the natural target for the hand-curation pass above, replacing the ratio heuristic with ground truth rather than refining the threshold further.
- **PC/TC exemption is a one-time extraction, not a live pipeline.** `data/pc-tc-split-codes.json` was generated once from a specific RVU file snapshot. If `medicare_rates` gets refreshed from a newer PFS file, re-run `npm run extract-pc-tc` against the matching raw RVU CSV first.
- Only the *global* (no-modifier) PFS row is used for the physician component in every setting. For PC/TC-split codes this is correct for Office (global billing) but hasn't been separately verified for whether ASC/hospital-outpatient physician billing should instead use the professional-only (`26`) rate rather than the global row's facility column — they were equal in both codes checked (71046, 73721) so it didn't matter there, but that may not hold universally. Worth spot-checking more PC/TC codes.
- **⚠ Anesthesia professional fee isn't captured anywhere — a real gap, not yet started.** For procedures that need an anesthesiologist/CRNA (not just local anesthesia the proceduralist administers themselves), Medicare pays that separately, under its own CPT codes (00100–01999) and a completely different formula: `(base units + time units) × anesthesia conversion factor`. Confirmed these codes exist in the CMS RVU file but carry Status Code `J` ("priced under a separate methodology") with every RVU zeroed — our pipeline already filters status `J` out, so anesthesia isn't showing as $0, it's just absent. Findings so far:
  - **CMS publishes the pricing inputs for free**: an annual, locality-specific anesthesia conversion factor, and a base-units-per-CPT-code table (unchanged for CY2026, so a recent year's file is still valid) — both on CMS's Anesthesiologists Center page.
  - **Time units are genuinely case-specific** — there's no single fixed Medicare payment for an anesthesia code the way there is for a facility fee. Any number shown would have to rest on an assumed typical duration, clearly flagged as illustrative rather than fetched, similar in spirit to the placeholder inputs already flagged elsewhere in this project's sibling Decision Dry Run work.
  - **No 1:1 crosswalk from surgical/procedure code to anesthesia code.** The standard mapping (ASA Crosswalk) is part of a paid ASA resource. A rougher approximation might be possible by matching anesthesia code descriptions (which do name body region/procedure type, e.g. "Anes px salivary gland w/bx") against our existing procedure descriptions — but that's a heuristic needing the same hand-curation treatment as the ratio threshold above, not an authoritative mapping.
  - Not every procedure needs this: many office-based minor procedures use local anesthesia bundled into the proceduralist's own fee, no separate anesthesiologist involved. Scoping which procedures typically do need it is itself part of the work.

## Not built yet

- Hosting/deployment — currently local-file-only by design ("static/serverless during testing," per direction). Revisit if this needs to be shared with others who can't run the build scripts themselves.
- The category list is a starter set (20 ranges, mostly musculoskeletal plus radiology). Easy to extend — it's a plain array at the top of `scripts/build-html.js`.
- Re-fetch/refresh script for `medicare_rates` itself (currently a one-time copy, not wired to re-pull from the hospital app or CMS directly).
- Quarter alignment between the copied PFS/OPPS data (January 2026) and the new ASC data (July 2026) — noted above, not corrected.

## Setup from a fresh clone

`data/prices.db` isn't in git (data artifacts are gitignored, same convention as the hospital-price-transparency repo — regenerate, don't commit). It also isn't fully self-fetchable yet: the `medicare_rates` and `friendly_names` tables were copied one time from the [hospital-price-transparency](https://github.com/smorrel9/hospital-price-transparency) repo's own database rather than fetched independently by a script in this repo (see "Not built yet" above).

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

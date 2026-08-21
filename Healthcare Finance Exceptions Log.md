# Healthcare Finance Exceptions Log

A running record of every non-obvious rule, exception, or gotcha found while building this tool. The point of keeping it: none of these were visible from the data alone. Every one required either domain knowledge of how healthcare billing actually works, or a real person with that background looking at a specific number and saying "that's not right" — a purely mechanical read of CMS's published rates would have shipped every one of these wrong. That's the whole argument for why this kind of work needs someone who's actually worked in healthcare finance and operations, not just someone who can write a SQL query.

Ordered roughly as found, since the sequence itself is part of the point — each fix revealed the next exception.

---

## 1. Facility vs. non-facility isn't a clean toggle — CMS often just defaults one to the other

**Looked like**: every CPT code has a non-facility (office) rate and a facility rate, so every code should have a real office price.

**Actually**: CMS publishes a non-facility PE RVU for nearly every code, including ones never performed in an office in real practice (e.g. `50045`, Nephrotomy w/exploration — major open surgery). For these, the published non-facility rate isn't a real calculation — it's the facility rate, copied over, because there's no practice pattern to model.

**Signal used**: when `nonfac_pe_rvu` exactly equals `facility_pe_rvu`, treat it as "not differentiated," not a real office rate.

**Scale**: this is the norm, not the exception — hit ~71% of all codes before any exemptions were applied.

---

## 2. Equal PE RVU means something different for radiology than it does for surgery

**Looked like**: the same signal from #1 (equal non-facility/facility PE RVU) should mean the same thing everywhere.

**Actually**: for codes with a genuine professional (`26`) / technical (`TC`) component split — mostly radiology and imaging — equal PE RVU on the *global* (no-modifier) billing row is a structural side effect of how those RVUs are built (global = 26 + TC summed, and technical/equipment cost doesn't carry a facility-vs-non-facility differential the way genuinely site-flexible procedures do). It does **not** mean "never done in an office." Chest X-ray and MRI are routinely billed globally by practices and imaging centers that own their own equipment — the "global tier" for practice-licensed outpatient imaging.

**Fix**: extracted every code with a genuine 26/TC split from the raw CMS RVU file (~1,132 codes) and exempted them from rule #1. Rescued 829 codes that were being wrongly excluded, including routine, common imaging.

**Why this needed a person**: the exact-match signal is real and correct for major surgery. Applying it uniformly to radiology was exactly the kind of mistake that looks reasonable in the data and is wrong in practice.

---

## 3. A code with no CMS flag at all can still have an unrealistic office price

**Caught by**: a specific example — CPT `61626` (transcatheter embolization of non-CNS extracranial head/neck vessels) — flagged as clinically impossible in a standard physician office: "requires complex endovascular catheterization, advanced fluoroscopic imaging guidance, and specialized angiography suite equipment."

**The data problem**: this code's non-facility and facility PE RVUs are *genuinely different* (not the equal-value case from #1), so rule #1 didn't catch it. CMS calculated a real, differentiated, but implausible non-facility rate — $10,248 in an office vs. $746.74 in a facility — because its methodology still allocates a theoretical equipment/supply cost to a non-facility setting that wouldn't realistically stock it.

**Checked and ruled out**: the raw CMS RVU file has a dedicated `NON-FAC NA INDICATOR` column that looked like it should flag exactly this. It's blank for this code. No clean CMS data flag exists for "this is never done in an office."

**Fix (unverified heuristic, explicitly flagged as such)**: exclude office pricing when the non-facility PE RVU exceeds 15x the facility PE RVU, calibrated against known-legitimate office procedures (EKG, laceration repair, eye exam, joint injection — all ran 1x–8x). Tagged for hand-curation, not treated as ground truth — every flagged row carries a visible warning badge in the app, not just a silent blank cell.

---

## 4. A huge ratio can mean the *opposite* of what it meant in #3 — and it depends entirely on specialty

**Caught by**: the same person asking "what about interventional radiology — some IR can be done in a physician-licensed space."

**The problem with the #3 fix**: checking the numbers, 133 of the 248 codes flagged by the 15x rule (54%) were in the cardiovascular/vascular chapter — specifically peripheral vascular intervention (atherectomy, IVL/lithotripsy, endovascular stenting: `37220`–`37799`, averaging a **108.8x** ratio) and percutaneous dialysis access creation (`36836`, `36837`, ~172x). These are not data artifacts. This is a well-documented, well-established category of **office-based labs (OBLs)** — CMS's own non-facility payment for these codes is widely credited in health policy literature with *driving* the growth of office-based peripheral vascular intervention since around 2008. The huge ratio reflects the real cost of expensive disposables (atherectomy catheters, drug-coated balloons, IVL devices — often $3,000–$10,000+ each) that an office genuinely has to be paid for.

**The tell**: `61626` (excluded, correctly) and `37271` (wrongly excluded) can have similar-looking ratios for opposite reasons — one because CMS's theoretical office costing is unrealistic, the other because the office costing is completely real. The number alone can't tell you which. The CPT chapter and clinical context can.

**Fix**: exempted the whole Cardiovascular System chapter (`33016`–`37799`) from the ratio-heuristic rule. Verified this is safe rather than a blunt instrument: rule #1 (exact match) already independently catches genuinely facility-only codes within this same chapter — e.g. `33533` (CABG) has an exact-match ratio of 1.0 and never even reaches the ratio check. The neuro-interventional codes that motivated the original fix (`61626` and similar) live in a *different* CPT chapter (Nervous System, `61000`–`64999`) and correctly remain excluded — same procedure family conceptually ("embolization"), opposite site-of-service reality, because the anatomic/specialty context is different.

**Why this needed a person**: an algorithm optimizing purely on the ratio number would have kept the threshold and just accepted a large false-positive rate, or lowered the threshold and caught even more legitimate OBL procedures. Knowing that peripheral vascular intervention specifically is where the office-based-lab trend lives — and that neuro-interventional isn't the same trend — is industry knowledge, not something in the RVU file.

---

## 5. The physician fee is identical across ASC and hospital outpatient — by design, not omission

Medicare's Physician Fee Schedule only has two tiers: facility and non-facility. It does not distinguish *which* facility. So the physician's professional payment for a given code is the same whether the procedure happens in an ASC or a hospital outpatient department — only the separate facility fee (paid to whoever owns the building) differs between the two. Looks like a data-duplication bug the first time you see it in a table. It isn't.

---

## 6. Office has no separate "facility fee" line item to go looking for

Asked directly: is there an additional in-office fee we're missing, the way ASC and hospital outpatient each have a physician component *and* a facility component? No — by CMS design, the non-facility rate is a single bundled payment that already includes everything a separate facility fee would otherwise cover (equipment, staff, supplies). That's specifically *why* office totals run lower than ASC/hospital totals for the same code — the physician is compensated for absorbing the overhead directly, not because something's missing from the office number.

---

## 7. Modifiers matter, but not the way you might reach for first

Checked whether CPT/HCPCS modifiers could resolve the ratio-heuristic problem (#3/#4) more cleanly. The 26/TC split (#2) is a modifier-based fix, and it's the right one for radiology. But there's no modifier in the fee-schedule reference data that means "clinically restricted from office" in general. Also checked OPPS status indicator `C` (inpatient-only) as an independent signal — found it's redundant with the existing rules (only 1 code in the dataset was inpatient-only and not already caught elsewhere). The actual ground-truth answer for "is this realistically done in an office" lives in **claims/utilization data by place of service** (real billing counts by HCPCS code and POS), which CMS publishes separately — a bigger, separate data-sourcing project, logged as a follow-up rather than solved today.

---

## 8. Anesthesia is billed by a completely different provider, under a completely different system

Triggered by picking a colonoscopy as a README example — colonoscopy sedation is commonly billed separately by an anesthesiologist or CRNA, under its own CPT code family (`00100`–`01999`), using a totally different payment formula: `(base units + time units) × anesthesia conversion factor`. This isn't a variant of the RVU-based methodology used everywhere else in this tool — it's a different system entirely, with a variable (actual anesthesia time) that's genuinely case-specific rather than a fixed fee-schedule number. Confirmed these codes exist in the CMS RVU file but carry Status Code `J` ("priced under a separate methodology") with every RVU zeroed out — meaning our pipeline was already silently filtering them out, not showing them as free. Logged as a follow-up, not started — the scope (new payment system, a code crosswalk problem, a case-specific input) is real.

---

## The pattern across all eight

Nothing here was hidden. Every number was sitting in a CMS public data file. What made each one non-obvious was needing to know *what kind of code this is, in real practice* — which specialty, which billing structure, which era of technology adoption — well enough to know when a data pattern that looks like "the answer" is actually an artifact, and when a data pattern that looks like an artifact is actually the answer. That's the case for this whole project in one list.

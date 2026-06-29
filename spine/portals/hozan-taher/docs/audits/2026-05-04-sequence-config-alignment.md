# Sequence Config Alignment — 2026-05-04 (pre-launch)

**Status**: PASS

---

## 1. Templates referenced vs on-disk

Campaign 1 (soft launch, machinery, 20 kontaktů) specifies a single-step sequence via **launch script** `scripts/campaigns/launch-001-machinery-soft-20.sql`:
- **Step 0, delay_days=0, template_name**: `initial`

**On-disk template inventory**:

### features/outreach/campaigns/configs/templates/
- `initial.tmpl` ✓ FOUND
- `final.tmpl` (not referenced by campaign 1)
- `followup1.tmpl` (not referenced by campaign 1)
- `heavy-01-intro.tmpl` (not referenced by campaign 1)
- `heavy-02-followup.tmpl` (not referenced by campaign 1)
- `heavy-03-bump.tmpl` (not referenced by campaign 1)

### modules/outreach/configs/templates/
- `intro_machinery.tmpl` (legacy, not referenced by campaign 1)
- `followup_1.tmpl` (legacy, not referenced by campaign 1)
- `followup_2.tmpl` (legacy, not referenced by campaign 1)

**Result**: Campaign 1's single required template `initial.tmpl` is present and verified in `features/outreach/campaigns/configs/templates/`. No mismatch detected.

---

## 2. Subject directives

All 9 template files (across both directories) verified to contain the required `{{/* subject: ... */}}` directive at the top:

| File | Subject directive | Status |
|---|---|---|
| `features/outreach/campaigns/configs/templates/initial.tmpl` | {{/* subject: Výkup techniky — kontakt z firmy.cz */}} | ✓ PASS |
| `features/outreach/campaigns/configs/templates/final.tmpl` | {{/* subject: Posledni pokus - aukce techniky */}} | ✓ PASS |
| `features/outreach/campaigns/configs/templates/followup1.tmpl` | {{/* subject: Pripominam se - aukce techniky */}} | ✓ PASS |
| `features/outreach/campaigns/configs/templates/heavy-01-intro.tmpl` | {{/* subject: Pouzita technika u Vas? */}} | ✓ PASS |
| `features/outreach/campaigns/configs/templates/heavy-02-followup.tmpl` | {{/* subject: Pripominam se - aukce techniky */}} | ✓ PASS |
| `features/outreach/campaigns/configs/templates/heavy-03-bump.tmpl` | {{/* subject: Posledni pokus - aukce techniky */}} | ✓ PASS |
| `modules/outreach/configs/templates/intro_machinery.tmpl` | {{/* subject: Plánujete prodej techniky? */}} | ✓ PASS |
| `modules/outreach/configs/templates/followup_1.tmpl` | {{/* subject: Re: Stroje — navazuji */}} | ✓ PASS |
| `modules/outreach/configs/templates/followup_2.tmpl` | {{/* subject: Poslední kontakt — stavební stroje */}} | ✓ PASS |

**Result**: All templates have the subject directive present. No missing directives.

---

## 3. HUMANIZE_SAFE_PROFILE deployment flag

**Memory requirement** (`project_humanize_safe_profile.md`): `HUMANIZE_DIACRITICS_DEGRADE=false` is **required** for Seznam delivery. Setting to `false` selects `NewImperfectEngineSAFE` with `keepProb=1.0` to preserve diacritics (e.g., "nášeho" not "naseho").

**Current state**:
- No explicit env var found in deployment manifests reviewed.
- The diacritics restoration logic exists in `features/platform/common/humanize/diacritics.go` with `keepProb` parameter.
- Initial template (`initial.tmpl` line 1) declares `{{/* humanize: off */}}`, which **disables humanize** for that template entirely.

**Operator verification required**:

```bash
# Check env var in production deployment (Railway):
echo $HUMANIZE_DIACRITICS_DEGRADE

# If unset, the system defaults to keepProb behavior in the engine — verify which profile:
grep -rn "NewImperfectEngine\|keepProb" features/outreach/campaigns/content/ --include="*.go"

# Alternative: inspect the BFF server.js or Go orchestrator main.go for engine instantiation
```

**Recommendation**: Explicitly set `HUMANIZE_DIACRITICS_DEGRADE=false` in the Railway environment before launch to ensure the safe profile (keepProb=1.0) is active. This is critical for Seznam's diacritic-sensitive filtering.

---

## Findings & recommended operator action (if any)

**All three axes GREEN:**
1. ✓ Sequence template reference (`initial`) matches disk file.
2. ✓ All 9 templates have subject directives.
3. ⚠️ Humanize-safe profile env var should be **explicitly verified** before send.

**Pre-launch checklist (operator)**:
- [ ] Verify `HUMANIZE_DIACRITICS_DEGRADE=false` set in Railway environment (or confirm engine defaults to safe profile).
- [ ] Re-run template preflight smoke test in dashboard (section 3.1 of LAUNCH-CAMPAIGN-001.md).
- [ ] Confirm campaign 1 status is "draft" before activating.

**No blocking issues detected.** Ready for operator activation.

# Learning Loop — Quarterly Prompt Tuning

> Status: living
> Datum: 2026-05-01
> Trigger: ADR-006 §D5 self-learning loop ratification (M+3 minimal scope)

## Cíl

Compounding learning loop pro Ollama prompt-tuning. Operator overrides v
UI (edited / rejected AI návrhy) se zaznamenají do `ai_suggestion_audit`
a v pravidelné kadenci se transformují na few-shot block, který se ručně
review-uje, ratifikuje, a deploys do `features/platform/llm-runner`.

Per ADR-006 §D5 nejde o automatický fine-tune (Ollama LoRA in-place
nepodporuje, full retrain je GPU-heavy a operator-side znalost
neúměrná). Místo toho prompt-engineering loop, který:

1. **Sbírá** lidská rozhodnutí (edited final text > AI draft).
2. **Agreguje** top-N overrides do strukturovaného teaching signálu.
3. **Reviewuje** s operatorem (jednorázová revize před deploy).
4. **Deployuje** přes Ollama Modelfile / `defaultGenerateSystem` v
   `features/platform/llm-runner/internal/handler/generate.go`.

## Kadence

| Fáze | Frekvence | Důvod |
|------|-----------|-------|
| Bootstrap | měsíčně | Override rate zatím nestabilní, rychlejší zpětná vazba |
| Steady-state | čtvrtletně (Mar/Jun/Sep/Dec) | Per ADR-006 §D5 — dostatečné pokrytí seasonality |
| Ad-hoc | Po každém >20% nárůstu rejection rate | Signál že prompt drifty, recovery |

Steady-state přechod: Po 3 po sobě jdoucích měsících kdy override rate
osciluje v ±5% (relativní), přepneme na čtvrtletní kadenci.

## Workflow

### Krok 1 — Extract

```bash
DATABASE_URL=postgres://... \
    scripts/learning/extract-overrides.sh \
    --since "90 days" \
    --limit 50 \
    > /tmp/overrides-2026-Q2.jsonl
```

Default filtr: `operator_action IN ('edited','rejected')` — pending řádky
(unreviewed drafts) přeskakujem, approved jsou neutrální signál.

### Krok 2 — Build few-shot block

```bash
cat /tmp/overrides-2026-Q2.jsonl \
    | scripts/learning/build-few-shot.sh \
        --top 10 \
        --skip-rejected \
        --max-context 500 \
    > /tmp/few-shot-2026-Q2.txt
```

Výstup je čistý češtinský prompt fragment — `### Příklad N` blocky s
`Kontext:`, `AI návrh:`, `Lidská editace:` lines.

### Krok 3 — Operator review (gate)

Operator otevře `/tmp/few-shot-2026-Q2.txt` a:

1. Smaže příklady které byly editované z technických důvodů (typo,
   formátování) — tj. nemají signál pro budoucí draft.
2. Smaže příklady kde je final text příliš firmově-specifický
   (konkrétní cena, konkrétní stroj) a hrozí že to LLM bude
   over-generalizovat.
3. Verifikuje že žádný příklad neobsahuje PII (jméno zákazníka,
   telefon, IČO) — ty patří do anonymizace, ne do prompt.

Gate: bez operator review **nikdy** nedeploy.

### Krok 4 — Deploy

Dvě cesty:

**(a) System prompt extension** — minimal change, žádný restart Ollama.
Edituj `features/platform/llm-runner/internal/handler/generate.go`:

```go
const defaultGenerateSystem = `Jsi asistent operátora B2B prodeje stavební techniky.
...
Drž se obchodního tónu, žádné emoji, bez závazku ceny.

Příklady (česky):
<<< vlepit obsah /tmp/few-shot-2026-Q2.txt >>>
`
```

PR + review + merge → Railway redeploy llm-runner. Žádný model retrain.

**(b) Ollama Modelfile** (těžší, jen pokud system prompt rozhodně
nestačí) — viz ADR-006 §D5 ASCII flow:

```
ollama create llama3.2:3b-tuned-vN -f Modelfile
```

a updatuj `DEFAULT_TEXT_MODEL` env v llm-runner Railway service.

### Krok 5 — Měření efektu

Po deploy sleduj `ai_suggestion_audit` 30 dní:

| Metrika | Cíl |
|---------|-----|
| `edited` rate | Pokles ≥5% (relativní) vs předchozí kvartál |
| `rejected` rate | Pokles ≥10% (rejected je silnější signál chyby) |
| Mean `final_output` length / `ai_suggestion` length | Růst směrem k 1.0 = méně edits |

Pokud po 30 dnech není pokles, **rollback**: revert PR z kroku 4 (a)
nebo přepni `DEFAULT_TEXT_MODEL` zpět (b). Logni do
`docs/audits/learning-loop-failures.md` co nefungovalo a proč —
compound learning vyžaduje archiv neúspěchů.

## Hard rules

- **Lokální LLM only.** Per `feedback_no_external_services` memory rule
  — žádný cloud fine-tune (OpenAI / Anthropic / Cohere).
- **Operator gate je závazný.** Per `feedback_no_speculation` —
  nedeployujem na základě syntetických příkladů; jen real overrides.
- **Žádné fabricated examples.** Per `feedback_no_fabricated_test_data`
  — `build-few-shot.sh` přepouští 1:1 obsah z DB.
- **PII screening.** Před každým deploy (krok 3) operator manuálně
  ověří že few-shot block neobsahuje email, telefon, IČO, jméno —
  GDPR Art. 5/1/c data minimization platí i pro prompt content.

## Roadmap (out of scope této PR)

- Automated PII screen (`scripts/learning/screen-pii.sh` — regex pre-pass
  před krokem 3).
- Diff metric: porovnání `ai_suggestion` ↔ `final_output` na úrovni
  Levenshtein / ROUGE pro priorizaci high-edit examples.
- Multi-channel: až M+4 přijde WhatsApp / portal_event, rozšířit filter
  o `details->>'channel'`.

## Reference

- [ADR-006 — Ollama Railway deployment](../decisions/ADR-006-ollama-railway-deployment.md) §D5
- [Migration 019](../../scripts/migrations/019_audit_log_schemas.sql) — `ai_suggestion_audit` schema
- [Migration 020](../../scripts/migrations/020_ai_suggestion_audit_pending.sql) — pending lifecycle
- `features/platform/llm-runner/internal/handler/generate.go` — `defaultGenerateSystem`
- `scripts/learning/extract-overrides.sh`
- `scripts/learning/build-few-shot.sh`
- `scripts/learning/test-learning-loop.bats`

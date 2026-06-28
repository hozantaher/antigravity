# Intervention log

Záznam okamžiků, kdy uživatel přerušil / opravil / přesměroval orchestrátora. Slouží jako data pro retrospective agenta — najde patterns a navrhne memory rule updates.

## Formát

Každý zápis = jeden řádek v `interventions.jsonl` (JSON Lines). Pole:

```json
{
  "ts": "2026-04-30T14:30:00Z",
  "session_id": "77448e4f-...",
  "what_i_was_doing": "Sequential cherry-pick batch in main thread",
  "what_user_wanted": "Spawn parallel agents instead",
  "user_quote": "Není už na čase v rámci vývoje začít používat agenty?",
  "root_cause_hypothesis": "Default to sequential work in orchestrator role; missed agent fleet pattern",
  "memory_rule_added": "feedback_agent_fleet.md",
  "ratchet": "first_occurrence | repeat_2nd | repeat_3rd_plus"
}
```

## Kdy zapsat

- User řekne "stop X" / "místo Y udělej Z" / "rozděl jinak"
- User explicitně řekne "to je špatně" nebo "ne, ne, ne"
- User opraví styl/formulaci v dokumentu, který jsem napsal
- User přidá pravidlo přes "zapiš si to jako rule"
- User přerušuje (Ctrl+C ekvivalent, "[Request interrupted by user]")

## Kdy NEzapsat

- User mění business priority (legitimní authority)
- User žádá novou feature (work, ne intervence)
- User klade otázku (klarifikace, ne korekce)
- User akceptuje moji práci ("OK, dál")

## Týdenní retrospective

Retrospective agent (viz `docs/playbooks/autonomous-self-improvement.md`) přečte `interventions.jsonl` za posledních 7 dní:

1. Spočte interventions per session, per category
2. Najde patterns (3+ stejných intervencí = chybí memory rule)
3. Najde ratchety (stejná intervence v rostoucí frekvenci = rule existuje, ignoruje se)
4. Vystoupí navrhované memory updates

Cíl: **klesající interventions per session over time** = orchestrátor se učí.

## Příklady (ilustrativní, neházet do produkce)

```jsonl
{"ts":"2026-04-30T13:00:00Z","what_i_was_doing":"Schedule wakeup for 30min","what_user_wanted":"Continuous work, no wakeups","user_quote":"Seru na wake-up, pracuj non-stop","root_cause_hypothesis":"Defaulted to wakeup pattern from /loop dynamic mode despite user fatigue with idle ticks","memory_rule_added":null,"ratchet":"first_occurrence"}
{"ts":"2026-04-30T14:30:00Z","what_i_was_doing":"Sequential cherry-pick batch","what_user_wanted":"Parallel agent fleet","user_quote":"Není už na čase v rámci vývoje začít používat agenty?","root_cause_hypothesis":"Orchestrator default = serial; missed parallelizable batch pattern","memory_rule_added":"feedback_agent_fleet.md","ratchet":"first_occurrence"}
```

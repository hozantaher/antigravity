# _archive

Místo pro věci, které už v projektu nepotřebujeme, ale nechceme je úplně ztratit — pro případ, že se k nim budeme chtít vrátit (reference, ukázka, forensika).

## Co sem patří

- Dokončené initiative/plan dokumenty, které nahradil někdo další
- Legacy kód/config, který byl nahrazen, ale historie je užitečná
- Staré playbook verze po refactoru

## Co sem NEpatří

- Secrets, credentials, .env
- Vygenerované artefakty (build outputs, coverage reporty) — ty do `.gitignore`
- Soubory, co vlastně ještě někde používáme
- `node_modules`, velké binární soubory

## Struktura

Organizuj podle tématu, ne podle data:

```
_archive/
├── nuxt-residue/      # Nuxt→React migrace artefakty
├── <téma>/
└── README.md          # tento soubor
```

Každá podsložka má vlastní `README.md` s krátkým popisem *proč* archivováno a *kdy*.

## Mazání z _archive

Po 6 měsících nepoužívání → smaž úplně. Git history stále drží.

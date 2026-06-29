#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════
# T2.4 — Memory rule conflict detector
# ════════════════════════════════════════════════════════════════════════
#
# Scanuje Claude memory rule directory a detekuje:
#   1. Direct contradictions    — rule A "REPLACES/nahrazuje" rule B,
#                                  ale rule B stále existuje (deprecated-but-not-deleted)
#   2. Duplicate scope          — 2+ rules sdílejí >=3 description keyword tokens
#   3. Malformed frontmatter    — chybí name/type/description nebo je type=feedback
#                                  ale chybí "Why:" / "How to apply:" sekce
#   4. Orphan rules             — soubor není zmíněn v MEMORY.md indexu
#
# Použití:
#   scripts/audits/memory-rule-conflict-check.py
#   scripts/audits/memory-rule-conflict-check.py --memory-dir <path>
#   scripts/audits/memory-rule-conflict-check.py --output docs/audits/memory-rule-conflicts-<date>.md
#
# Hard rules (per PR brief):
#   - Read-only — script NIKDY nemodifikuje memory adresář
#   - Stdlib only (žádné 3rd party deps)
#   - Output je markdown report co lze gh pr commit-mergnout
#
# Exit codes:
#   0  bez konfliktů
#   1  detekovány konflikty (count = počet flagged items)
#   2  invalid args / memory dir not found
# ════════════════════════════════════════════════════════════════════════

from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Defaultní memory dir — Claude project memory pro tento monorepo.
DEFAULT_MEMORY_DIR = Path(
    "/Users/messingtomas/.claude/projects/"
    "-Users-messingtomas-Documents-Projekty-hozan-taher/memory"
)

# Tokens to ignore when computing description keyword overlap. Czech + English
# stopwords + memory-domain noise tokens (rule, memory, user, etc.).
STOPWORDS = {
    # English
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
    "have", "in", "is", "it", "of", "on", "or", "that", "the", "to", "was",
    "were", "with", "this", "these", "those", "but", "not", "no", "yes",
    "do", "does", "did", "use", "uses", "used", "user", "users", "should",
    "must", "can", "will", "rule", "rules", "memory", "session", "session-only",
    "tool", "via", "after", "before", "when", "if", "than", "then", "any",
    "all", "always", "never", "more", "less", "some", "such", "into", "out",
    # Czech
    "a", "i", "k", "o", "s", "u", "v", "z", "že", "se", "si", "je", "jsou",
    "byl", "byla", "bylo", "byly", "být", "není", "ne", "ano", "také", "jen",
    "už", "při", "pro", "pod", "nad", "na", "do", "od", "nebo", "ale",
    "když", "kdy", "co", "jak", "to", "ten", "ta", "ty", "ji", "ho", "jeho",
    "její", "jejich", "můj", "tvoj", "náš", "váš", "se", "ze", "ke", "ve",
    "po", "před", "pak", "jako", "pokud", "takže", "tam", "tady", "kde",
    "tedy", "užívat", "musí", "nesmí", "můžu", "uživatele",
    # Numbers / dates
    "2026", "0430", "2026-04-30",
}

# Type-tag → required prose-section fingerprints (after frontmatter).
REQUIRED_SECTIONS = {
    "feedback": ["Why:", "How to apply:"],
}

# ── Data classes ──────────────────────────────────────────────────────


@dataclass
class Rule:
    """Parsed memory rule."""

    path: Path
    name: str = ""
    description: str = ""
    rule_type: str = ""
    body: str = ""
    has_frontmatter: bool = False
    raw: str = ""


@dataclass
class Findings:
    contradictions: list[dict] = field(default_factory=list)
    duplicates: list[dict] = field(default_factory=list)
    malformed: list[dict] = field(default_factory=list)
    orphans: list[dict] = field(default_factory=list)

    def total(self) -> int:
        return (
            len(self.contradictions)
            + len(self.duplicates)
            + len(self.malformed)
            + len(self.orphans)
        )


# ── Parsing ───────────────────────────────────────────────────────────


def parse_rule(path: Path) -> Rule:
    """Parse a memory rule MD file. Tolerant of missing frontmatter."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    rule = Rule(path=path, raw=raw)

    # Frontmatter must start at line 1 with "---" and close with "---".
    fm_match = re.match(r"^---\n(.*?)\n---\n", raw, flags=re.DOTALL)
    if not fm_match:
        rule.body = raw
        return rule

    rule.has_frontmatter = True
    fm_block = fm_match.group(1)
    rule.body = raw[fm_match.end():]

    for line in fm_block.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().lower()
        val = val.strip().strip('"').strip("'")
        if key == "name":
            rule.name = val
        elif key == "description":
            rule.description = val
        elif key == "type":
            rule.rule_type = val

    return rule


def load_rules(memory_dir: Path) -> list[Rule]:
    """Load all rules from memory_dir (excluding MEMORY.md index + archives)."""
    rules: list[Rule] = []
    for path in sorted(memory_dir.glob("*.md")):
        if path.name == "MEMORY.md":
            continue
        rules.append(parse_rule(path))
    return rules


# ── Detection ─────────────────────────────────────────────────────────

# Patterns indicating one rule supersedes another.
REPLACES_PATTERNS = [
    re.compile(r"\b(REPLACES|replaces|nahrazeno|nahrazuje|supersedes|superseded)\b"),
]

# Filename references — rules cite each other by stem (filename without .md).
def _stem_refs(rule: Rule, all_stems: set[str]) -> set[str]:
    """Find stems of OTHER rules referenced in body (e.g. `feedback_max_mode_throughput`)."""
    refs: set[str] = set()
    for stem in all_stems:
        if stem == rule.path.stem:
            continue
        # Match stem as identifier-token (backticks, parens, whitespace bounded).
        if re.search(rf"\b{re.escape(stem)}\b", rule.raw):
            refs.add(stem)
    return refs


def detect_contradictions(rules: list[Rule]) -> list[dict]:
    """Rule A says it REPLACES rule B but rule B file still exists.

    Precision rule: a "REPLACES X" phrase must appear within ~80 chars of
    the referenced stem; "STILL VALID" / "stále platí" within the same
    window suppresses the finding.
    """
    findings: list[dict] = []
    by_stem = {r.path.stem: r for r in rules}
    all_stems = set(by_stem)

    suppressors = re.compile(
        r"STILL VALID|stále platí|stále plat|posiluje|preserved|kept",
        flags=re.IGNORECASE,
    )

    for rule in rules:
        body = rule.body
        if not any(p.search(body) for p in REPLACES_PATTERNS):
            continue
        refs = _stem_refs(rule, all_stems)
        for ref_stem in refs:
            if ref_stem not in by_stem:
                continue
            for pat in REPLACES_PATTERNS:
                for m in pat.finditer(body):
                    # Tight window: REPLACES → stem must be close together
                    # (avoids matching unrelated rules in the same paragraph).
                    window = body[max(0, m.start() - 80): m.end() + 80]
                    if ref_stem not in window:
                        continue
                    # Per-stem suppressor scan: if the ref stem's own line
                    # carries a "STILL VALID" / "stále platí" qualifier, skip.
                    stem_line_iter = re.finditer(
                        rf".*\b{re.escape(ref_stem)}\b.*",
                        body,
                    )
                    suppressed = False
                    for line_m in stem_line_iter:
                        if suppressors.search(line_m.group(0)):
                            suppressed = True
                            break
                    if suppressed:
                        continue
                    findings.append({
                        "winner": rule.path.name,
                        "loser": ref_stem + ".md",
                        "evidence": _trim(window, 200),
                    })
                    break
    # Dedupe (winner, loser) pairs.
    seen = set()
    uniq = []
    for f in findings:
        key = (f["winner"], f["loser"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(f)
    return uniq


def _tokenise(text: str) -> set[str]:
    """Lowercase tokens of length >=4, stopword-filtered."""
    tokens = re.findall(r"[\wáčďéěíňóřšťúůýž]+", text.lower())
    return {t for t in tokens if len(t) >= 4 and t not in STOPWORDS}


def detect_duplicates(rules: list[Rule], min_overlap: int = 3) -> list[dict]:
    """Pairs of rules sharing >=min_overlap description keyword tokens."""
    findings: list[dict] = []
    rules_with_desc = [r for r in rules if r.description]
    for i, a in enumerate(rules_with_desc):
        ta = _tokenise(a.description + " " + a.name)
        for b in rules_with_desc[i + 1:]:
            tb = _tokenise(b.description + " " + b.name)
            shared = ta & tb
            if len(shared) >= min_overlap:
                findings.append({
                    "rule_a": a.path.name,
                    "rule_b": b.path.name,
                    "shared_tokens": sorted(shared),
                    "overlap": len(shared),
                })
    findings.sort(key=lambda f: -f["overlap"])
    return findings


def detect_malformed(rules: list[Rule]) -> list[dict]:
    """Frontmatter or required-section problems."""
    findings: list[dict] = []
    for rule in rules:
        problems: list[str] = []
        if not rule.has_frontmatter:
            problems.append("missing frontmatter (--- ... ---)")
        else:
            if not rule.name:
                problems.append("frontmatter.name missing")
            if not rule.description:
                problems.append("frontmatter.description missing")
            if not rule.rule_type:
                problems.append("frontmatter.type missing")

        required = REQUIRED_SECTIONS.get(rule.rule_type, [])
        for token in required:
            if token not in rule.body:
                problems.append(f"missing prose section: '{token}'")

        if problems:
            findings.append({
                "rule": rule.path.name,
                "problems": problems,
            })
    return findings


def detect_orphans(rules: list[Rule], memory_dir: Path) -> list[dict]:
    """Rules not linked from MEMORY.md."""
    index_path = memory_dir / "MEMORY.md"
    if not index_path.exists():
        return []
    index_text = index_path.read_text(encoding="utf-8", errors="replace")
    findings: list[dict] = []
    for rule in rules:
        if rule.path.name not in index_text:
            findings.append({
                "rule": rule.path.name,
                "hint": "not referenced in MEMORY.md index",
            })
    return findings


# ── Reporting ─────────────────────────────────────────────────────────


def _trim(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def render_markdown(findings: Findings, memory_dir: Path, total_rules: int) -> str:
    today = _dt.date.today().isoformat()
    lines: list[str] = []
    lines.append(f"# Memory rule conflicts — {today}")
    lines.append("")
    lines.append(
        "Generated by `scripts/audits/memory-rule-conflict-check.py` "
        "(T2.4, north-star aspirace #3 self-consolidating memory)."
    )
    lines.append("")
    lines.append(f"- Memory directory: `{memory_dir}`")
    lines.append(f"- Total rules scanned: **{total_rules}**")
    lines.append(f"- Total findings: **{findings.total()}**")
    lines.append(
        f"  - Contradictions (REPLACES but still present): **{len(findings.contradictions)}**"
    )
    lines.append(f"  - Duplicate-scope candidates: **{len(findings.duplicates)}**")
    lines.append(f"  - Malformed rules: **{len(findings.malformed)}**")
    lines.append(f"  - Orphan rules (not in MEMORY.md): **{len(findings.orphans)}**")
    lines.append("")

    lines.append("## 1. Direct contradictions / deprecated-but-not-deleted")
    lines.append("")
    if not findings.contradictions:
        lines.append("_None detected._")
    else:
        lines.append("| Surviving rule | Marked-replaced rule | Evidence |")
        lines.append("|---|---|---|")
        for f in findings.contradictions:
            ev = f["evidence"].replace("|", "\\|")
            lines.append(f"| `{f['winner']}` | `{f['loser']}` | {ev} |")
    lines.append("")

    lines.append("## 2. Duplicate-scope candidates")
    lines.append("")
    if not findings.duplicates:
        lines.append("_None detected._")
    else:
        lines.append("| Rule A | Rule B | Overlap | Shared tokens |")
        lines.append("|---|---|---|---|")
        for f in findings.duplicates[:50]:  # cap at 50 for readability
            tokens = ", ".join(f["shared_tokens"][:8])
            if len(f["shared_tokens"]) > 8:
                tokens += ", …"
            lines.append(
                f"| `{f['rule_a']}` | `{f['rule_b']}` | {f['overlap']} | {tokens} |"
            )
        if len(findings.duplicates) > 50:
            lines.append(f"| _… {len(findings.duplicates) - 50} more rows truncated_ | | | |")
    lines.append("")

    lines.append("## 3. Malformed rules")
    lines.append("")
    if not findings.malformed:
        lines.append("_None detected._")
    else:
        lines.append("| Rule | Problems |")
        lines.append("|---|---|")
        for f in findings.malformed:
            problems = "; ".join(f["problems"])
            lines.append(f"| `{f['rule']}` | {problems} |")
    lines.append("")

    lines.append("## 4. Orphan rules")
    lines.append("")
    if not findings.orphans:
        lines.append("_None detected._")
    else:
        lines.append("| Rule | Hint |")
        lines.append("|---|---|")
        for f in findings.orphans:
            lines.append(f"| `{f['rule']}` | {f['hint']} |")
    lines.append("")

    lines.append("## Recommended actions")
    lines.append("")
    lines.append(
        "1. **Contradictions** — archive the marked-replaced rule "
        "(move to `_archived-<date>/`) and update MEMORY.md index."
    )
    lines.append(
        "2. **Duplicate scope** — top-overlap pairs are candidates for "
        "merge into a single rule; lower-overlap pairs may be coincidental wording."
    )
    lines.append(
        "3. **Malformed** — add missing frontmatter or required prose sections."
    )
    lines.append(
        "4. **Orphans** — either link from MEMORY.md or archive."
    )
    lines.append("")
    return "\n".join(lines) + "\n"


# ── CLI ───────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Detect contradictions, duplicates, malformed, and orphan memory rules."
    )
    parser.add_argument(
        "--memory-dir",
        type=Path,
        default=DEFAULT_MEMORY_DIR,
        help=f"Memory directory (default: {DEFAULT_MEMORY_DIR})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output markdown path (default: docs/audits/memory-rule-conflicts-<date>.md)",
    )
    parser.add_argument(
        "--min-overlap",
        type=int,
        default=3,
        help="Minimum description-token overlap to flag duplicate-scope (default: 3)",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Emit report to stdout instead of file.",
    )
    args = parser.parse_args(argv)

    if not args.memory_dir.is_dir():
        print(f"ERROR: memory dir not found: {args.memory_dir}", file=sys.stderr)
        return 2

    rules = load_rules(args.memory_dir)
    findings = Findings(
        contradictions=detect_contradictions(rules),
        duplicates=detect_duplicates(rules, min_overlap=args.min_overlap),
        malformed=detect_malformed(rules),
        orphans=detect_orphans(rules, args.memory_dir),
    )

    report = render_markdown(findings, args.memory_dir, total_rules=len(rules))

    if args.stdout:
        sys.stdout.write(report)
    else:
        out = args.output
        if out is None:
            today = _dt.date.today().isoformat()
            out = Path("docs/audits") / f"memory-rule-conflicts-{today}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report, encoding="utf-8")
        print(f"Report written: {out}")
        print(
            f"Findings: {len(findings.contradictions)} contradictions, "
            f"{len(findings.duplicates)} duplicates, "
            f"{len(findings.malformed)} malformed, "
            f"{len(findings.orphans)} orphans"
        )

    return 1 if findings.total() > 0 else 0


if __name__ == "__main__":
    sys.exit(main())

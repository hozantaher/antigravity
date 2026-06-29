import sys
import json
import os

total = 0
with_lore = 0
with_promise = 0
with_both = 0

paths_without_story = []

for line in sys.stdin:
    path = line.strip()
    if not path: continue
    
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            total += 1
            has_lore = bool(data.get('loreLine'))
            has_promise = bool(data.get('promise'))
            
            if has_lore:
                with_lore += 1
            if has_promise:
                with_promise += 1
            if has_lore and has_promise:
                with_both += 1
            else:
                paths_without_story.append(path)
    except Exception as e:
        pass

print(f"Total nodes: {total}")
print(f"With LoreLine: {with_lore} ({(with_lore/total)*100:.1f}%)")
print(f"With Promise: {with_promise} ({(with_promise/total)*100:.1f}%)")
print(f"With Complete Story (Both): {with_both} ({(with_both/total)*100:.1f}%)")
print(f"Nodes missing story ({len(paths_without_story)}):")
for p in paths_without_story[:10]:
    print(f"  - {p}")
if len(paths_without_story) > 10:
    print(f"  - ... and {len(paths_without_story) - 10} more.")


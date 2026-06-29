import sys
import json
import os
from collections import defaultdict

def add_path(tree, path, story_data):
    parts = path.strip().split('/')
    parts = [p for p in parts if p and p != '.' and p != 'vektor.json']
    current = tree
    for i, part in enumerate(parts):
        if part not in current['children']:
            current['children'][part] = {'children': defaultdict(dict), 'story': None}
        if i == len(parts) - 1:
            current['children'][part]['story'] = story_data
        current = current['children'][part]

def print_tree(tree, prefix=''):
    keys = sorted(tree.keys())
    for i, key in enumerate(keys):
        is_last = (i == len(keys) - 1)
        connector = '└── ' if is_last else '├── '
        
        node = tree[key]
        story_str = ""
        if node['story']:
            lore = node['story'].get('loreLine', '')
            promise = node['story'].get('promise', '')
            parts = []
            if lore:
                parts.append(f"📖 {lore}")
            if promise:
                parts.append(f"✨ {promise}")
            if parts:
                story_str = "  [" + " | ".join(parts) + "]"
                
        print(prefix + connector + key + story_str)
        extension = '    ' if is_last else '│   '
        print_tree(node['children'], prefix + extension)

root = {'children': defaultdict(dict), 'story': None}

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    
    try:
        with open(line, 'r', encoding='utf-8') as f:
            data = json.load(f)
            story_data = {
                'loreLine': data.get('loreLine'),
                'promise': data.get('promise')
            }
            add_path(root, line, story_data)
    except Exception as e:
        pass

print_tree(root['children'])

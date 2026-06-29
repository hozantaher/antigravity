import sys
from collections import defaultdict

def add_path(tree, path):
    parts = path.strip().split('/')
    parts = [p for p in parts if p and p != '.' and p != 'vektor.json']
    current = tree
    for part in parts:
        current = current[part]

def print_tree(tree, prefix=''):
    keys = sorted(tree.keys())
    for i, key in enumerate(keys):
        is_last = (i == len(keys) - 1)
        connector = '└── ' if is_last else '├── '
        print(prefix + connector + key)
        extension = '    ' if is_last else '│   '
        print_tree(tree[key], prefix + extension)

tree = lambda: defaultdict(tree)
root = tree()

for line in sys.stdin:
    if 'vektor.json' in line:
        add_path(root, line)

print_tree(root)

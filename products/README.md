# products/

Sovereign **product instances**. Each `products/<folder>/` is a **standalone, separately-owned
git repo** — its own remote, its own branches, its own stack. They are **gitignored**: octavius
commits **0 product source** (engine shared, content sovereign).

The Octavius engine (`src/*.mjs`, dependency-free) reads each product's **native** `features/`
tree **in place** — the tree IS the system (see [docs/adr/0001](../docs/adr/0001-tree-is-the-engine.md)).
A product is resolved by its **engine id** through the `FOLDER` map in `src/product.mjs`
(`engine id → clone folder`); octavius never copies, subtrees, or swallows the repo.

## Products

| folder | engine id | domain | remote |
|---|---|---|---|
| `auction24/` | `auction24` | B2B vehicle-auction marketplace | `danielkrul97/garaaage-auction` |
| `hozan-taher/` | `data-core` | Node/Go data project (pnpm + go.work workspace) | `hozantaher/hozan-taher` |
| `properlak/` | `properlak` | ALU-wheel renovation marketing site (Nuxt 4 SSG, feature-layer architecture) | `hozantaher/properlak` |
| `frontier/` | `frontier` | bot platform — operate loop (discover→learn→drive→heal); external portal → asset-model | `hozantaher/frontier` |

> The folder name is the repo's own name; the **engine id** (the `<product>` arg) can differ —
> the data project's folder is `hozan-taher`, its engine id is `data-core`. **Add a product =
> add a line to the `FOLDER` map in `src/product.mjs`.**

## Populating a working copy (fresh clone)

`products/` is empty in a fresh octavius checkout. Clone each product into its folder:

```bash
git clone https://github.com/danielkrul97/garaaage-auction.git products/auction24
git clone https://github.com/hozantaher/hozan-taher.git        products/hozan-taher   # engine id: data-core
git clone https://github.com/hozantaher/properlak.git          products/properlak     # engine id: properlak
git clone https://github.com/hozantaher/frontier.git           products/frontier      # engine id: frontier
```

Then the engine resolves them by id:

```bash
node bin/octavius.mjs tree  auction24      # render the gate-decorated features/ tree
node bin/octavius.mjs check auction24      # validate every node's shape + rollup
node bin/octavius.mjs gate  data-core      # shippability: shape ✓ + 0 drift + ledger intact
```

A command targeting an **absent** working copy **fails fast** with a clear
`product '<id>' not checked out (products/ is gitignored — clone it first)` error — never a
silent empty result or fabricated data.

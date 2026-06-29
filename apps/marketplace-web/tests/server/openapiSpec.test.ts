import { describe, expect, it } from 'vitest'
import { generateOpenAPIDocument } from '~/server/openapi/spec'

// Backs the DoD criterion api-docs/spec-validity (test:openapiValid): the generated spec is a
// well-formed OpenAPI 3.1 document with a non-empty path set. The non-empty paths assertion is
// also the tree-shake guard spec.ts warns about (bare side-effect imports silently empty the spec).
describe('OpenAPI spec validity', () => {
  const doc = generateOpenAPIDocument()

  it('is an OpenAPI 3.1 document with info title + version', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info?.title).toBeTruthy()
    expect(doc.info?.version).toBeTruthy()
  })

  it('registered a non-empty path set', () => {
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0)
  })

  it('every path exposes at least one operation', () => {
    for (const [path, ops] of Object.entries(doc.paths ?? {})) {
      expect(Object.keys(ops as object).length, `path ${path} has no operations`).toBeGreaterThan(0)
    }
  })
})

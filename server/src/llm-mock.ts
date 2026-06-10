/**
 * LLM_MOCK=1 test double, mocking at the gemini.ts call boundary: same surface
 * as createGemini() (interpretQuery, agenticSearch, ocrLabel, embedImage) but
 * fully deterministic and offline, so e2e runs are reproducible and free.
 *
 * Fixtures (keyed by normalized-query regex, first match wins):
 *   - washington case (J7): "…washington crossing a river in a boat…" →
 *     ftsQuery 'washington crossing delaware' (mirrors the benchmarked live
 *     rewrite; ranks objectID 11417 first against the real met.sqlite).
 *   - monet / gold swords / restroom: representative rewrites for J5/J6/J12.
 *   - default: alphanumeric tokens of the query joined with OR.
 * agenticSearch executes one canned search_catalog call through the same
 * executor the live loop would use and returns a canned "why".
 * ocrLabel/embedImage get fixed, content-independent fixtures (extend when the
 * locate-photo e2e needs richer ones).
 */
import type {
  AgenticResult,
  CatalogRow,
  GeminiClient,
  InterpretedQuery,
  LabelRead,
  SearchVocabulary,
} from './gemini.js'

interface InterpretFixture {
  pattern: RegExp
  interpreted: InterpretedQuery
}

const INTERPRET_FIXTURES: InterpretFixture[] = [
  {
    // J7: "that huge painting of washington crossing a river in a boat"
    pattern: /washington.*(crossing|river|boat|delaware)/,
    interpreted: { ftsQuery: 'washington crossing delaware', filters: {} },
  },
  {
    pattern: /monet/,
    interpreted: { ftsQuery: 'monet', filters: { artist: 'Claude Monet' } },
  },
  {
    pattern: /gold.*sword|sword.*gold/,
    interpreted: {
      ftsQuery: 'gold OR sword',
      filters: { classification: 'Swords' },
    },
  },
  {
    pattern: /restroom|bathroom|toilet/,
    interpreted: { ftsQuery: 'restroom', filters: {} },
  },
]

function fallbackInterpreted(query: string): InterpretedQuery {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return { ftsQuery: tokens.join(' OR ') || 'art', filters: {} }
}

export function mockInterpret(query: string): InterpretedQuery {
  const normalized = query.toLowerCase()
  for (const f of INTERPRET_FIXTURES) {
    if (f.pattern.test(normalized)) return f.interpreted
  }
  return fallbackInterpreted(query)
}

export function createMockGemini(): GeminiClient {
  async function interpretQuery(
    query: string,
    _vocab: SearchVocabulary,
  ): Promise<InterpretedQuery> {
    return mockInterpret(query)
  }

  async function agenticSearch(
    query: string,
    _vocab: SearchVocabulary,
    executeSearch: (interpreted: InterpretedQuery) => CatalogRow[],
  ): Promise<AgenticResult> {
    // One canned tool call through the real executor, mirroring the live loop.
    const interpreted = mockInterpret(query)
    const rows = executeSearch(interpreted)
    return {
      objectIDs: rows.map((r) => r.objectID),
      why: `Mock agentic search matched ${rows.length} object(s) for "${query}".`,
      searches: [interpreted],
    }
  }

  async function ocrLabel(
    _imageBase64: string,
    _mimeType = 'image/jpeg',
  ): Promise<LabelRead> {
    // Content-independent: no label legible. Locate-photo e2e fixtures extend this.
    return { confidence: 0 }
  }

  async function embedImage(
    _imageBase64: string,
    _mimeType = 'image/jpeg',
  ): Promise<Float32Array> {
    // Fixed unit vector; deterministic cosine results against any index.
    const v = new Float32Array(768)
    v[0] = 1
    return v
  }

  return { interpretQuery, agenticSearch, ocrLabel, embedImage }
}

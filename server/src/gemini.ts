/**
 * Thin Gemini client — the ONLY LLM integration point (locked: Gemini only,
 * no provider abstraction). Call shapes per the plan's "Gemini integration
 * reference": structured output via responseMimeType + responseJsonSchema
 * (the docs' newer config.responseFormat shape is NOT in @google/genai 2.8.0's
 * GenerateContentConfig type — verified against the installed SDK; the
 * benchmarked legacy shape is what the SDK actually exposes), thinkingLevel
 * MINIMAL on flash-lite, embeddings at 768 dims.
 */
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  type Content,
} from '@google/genai'
import { z } from 'zod'

const INTERPRET_MODEL = 'gemini-3.1-flash-lite' // benchmarked: 100% interpret + label OCR, fastest
const EMBED_MODEL = 'gemini-embedding-2' // benchmarked: 90% top-1 / 95% top-5 on real guest photos

/** Structured output of interpretQuery — matches InterpretedQuery in shared/openapi.yaml. */
export const interpretedQuerySchema = z.object({
  ftsQuery: z.string(),
  filters: z.object({
    artist: z.string().optional(),
    classification: z.string().optional(),
    material: z.string().optional(),
    culture_or_period: z.string().optional(),
  }),
})
export type InterpretedQuery = z.infer<typeof interpretedQuerySchema>

/** Flash-lite sometimes fills optional filters with literal "null"/"none" strings; drop them. */
export function cleanInterpreted(interpreted: InterpretedQuery): InterpretedQuery {
  const filters: InterpretedQuery['filters'] = {}
  for (const [k, v] of Object.entries(interpreted.filters)) {
    if (v && !['null', 'none', 'n/a'].includes(v.trim().toLowerCase())) {
      filters[k as keyof InterpretedQuery['filters']] = v
    }
  }
  return { ftsQuery: interpreted.ftsQuery, filters }
}

/** Structured output of ocrLabel. Fields omitted when not legible in the photo. */
export const labelReadSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  accession: z.string().optional(),
  confidence: z.number().min(0).max(1),
})
export type LabelRead = z.infer<typeof labelReadSchema>

/** Distinct-value lists generated from met.sqlite (~1k tokens) — the prompt carries vocabulary, never the catalog. */
export interface SearchVocabulary {
  classifications: string[]
  cultures: string[]
}

/** What the search_catalog tool hands back to the model per row (lean on purpose). */
export interface CatalogRow {
  objectID: number
  title: string
  artist: string
  classification: string
  galleryNumber: string
}

/** Final structured answer of the agentic escalation (search tier 3b). */
export const agenticAnswerSchema = z.object({
  objectIDs: z.array(z.number().int()),
  why: z.string(),
})
export type AgenticAnswer = z.infer<typeof agenticAnswerSchema>

export interface AgenticResult extends AgenticAnswer {
  /** Every search_catalog invocation the model made, in order (last one is reported as interpretedQuery). */
  searches: InterpretedQuery[]
}

function vocabBlock(vocab: SearchVocabulary): string {
  return [
    `Valid classification values: ${vocab.classifications.join(', ')}`,
    `Valid culture/period values: ${vocab.cultures.join(', ')}`,
  ].join('\n')
}

/** Reads GEMINI_API_KEY from the environment when no key is passed. */
export function createGemini(apiKey = process.env.GEMINI_API_KEY) {
  const ai = new GoogleGenAI(apiKey ? { apiKey } : {})

  /** Rewrite a visitor query into an executable FTS5 query + filters (search tier 3a). */
  async function interpretQuery(
    query: string,
    vocab: SearchVocabulary,
  ): Promise<InterpretedQuery> {
    const response = await ai.models.generateContent({
      model: INTERPRET_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Convert a museum visitor search query into an SQLite FTS5 query over columns title, artist, culture, classification, medium, tags.',
                'Prefer few, high-signal stemmed terms joined with OR so recall stays high; put exact-match constraints in filters.',
                vocabBlock(vocab),
                `Query: ${query}`,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(interpretedQuerySchema),
      },
    })
    return cleanInterpreted(interpretedQuerySchema.parse(JSON.parse(response.text ?? '{}')))
  }

  /**
   * Bounded agentic escalation (search tier 3b): flash-lite gets ONE tool,
   * search_catalog, executed in-process by the caller against met.sqlite.
   * Manual while-loop per the official JS SDK shape (no automatic function
   * calling): echo each call's `id` in the functionResponse, push the FULL
   * model content back so Gemini-3 thought signatures survive, mode ANY forces
   * the first call. Hard cap: 3 tool executions, then one structured-output
   * call (tools and responseJsonSchema cannot be combined) for the final
   * ranked objectIDs + one-line why.
   */
  async function agenticSearch(
    query: string,
    vocab: SearchVocabulary,
    executeSearch: (interpreted: InterpretedQuery) => CatalogRow[],
  ): Promise<AgenticResult> {
    const searchCatalogDeclaration = {
      name: 'search_catalog',
      description:
        'Full-text search over the Met on-view catalog. Returns the top 10 matching objects. ftsQuery is an SQLite FTS5 expression over columns title, artist, culture, classification, medium, tags (terms joined with OR for recall). Optional filters are exact-ish matches.',
      parametersJsonSchema: z.toJSONSchema(interpretedQuerySchema),
    }
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            text: [
              'You are a search agent for the Metropolitan Museum of Art on-view catalog.',
              'A simple keyword rewrite of the visitor query found fewer than 3 objects. Use the search_catalog tool (vary terms: synonyms, broader/narrower words, artist or culture guesses) to find what the visitor means. You may call it up to 3 times.',
              vocabBlock(vocab),
              `Visitor query: ${query}`,
            ].join('\n'),
          },
        ],
      },
    ]
    const searches: InterpretedQuery[] = []

    while (searches.length < 3) {
      const response = await ai.models.generateContent({
        model: INTERPRET_MODEL,
        contents,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          tools: [{ functionDeclarations: [searchCatalogDeclaration] }],
          toolConfig: {
            functionCallingConfig: {
              mode:
                searches.length === 0
                  ? FunctionCallingConfigMode.ANY
                  : FunctionCallingConfigMode.AUTO,
            },
          },
        },
      })
      const modelContent = response.candidates?.[0]?.content
      if (!modelContent) break
      contents.push(modelContent) // full parts back → thought signatures preserved
      const calls = response.functionCalls ?? []
      if (calls.length === 0) break // model is done searching
      const responseParts = []
      for (const call of calls) {
        // Every functionCall must get a functionResponse (echoing its id) or
        // the next turn is rejected; parallel calls past the cap get an error.
        if (searches.length >= 3) {
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { error: 'search_catalog call limit (3) reached' },
            },
          })
          continue
        }
        const interpreted = cleanInterpreted(
          interpretedQuerySchema.parse({ filters: {}, ...(call.args ?? {}) }),
        )
        searches.push(interpreted)
        responseParts.push({
          functionResponse: {
            id: call.id, // echo the call id
            name: call.name,
            response: { rows: executeSearch(interpreted) },
          },
        })
      }
      contents.push({ role: 'user', parts: responseParts })
    }

    contents.push({
      role: 'user',
      parts: [
        {
          text: 'Based on your searches, output the final answer: objectIDs of the matching objects ranked best-first (empty array if nothing plausibly matches), and a one-line "why" explaining the match for the visitor.',
        },
      ],
    })
    const final = await ai.models.generateContent({
      model: INTERPRET_MODEL,
      contents,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(agenticAnswerSchema),
      },
    })
    const answer = agenticAnswerSchema.parse(JSON.parse(final.text ?? '{}'))
    return { ...answer, searches }
  }

  /** Read a wall label out of a visitor photo (vision OCR; LOW media resolution is plenty for label text). */
  async function ocrLabel(
    imageBase64: string,
    mimeType = 'image/jpeg',
  ): Promise<LabelRead> {
    const response = await ai.models.generateContent({
      model: INTERPRET_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            {
              text: 'If a museum wall label is legible in this photo, transcribe its artwork title, artist, and accession number. Omit any field you cannot read. Set confidence (0-1) that the transcription identifies a single artwork; use confidence 0 when no label is visible.',
            },
          ],
        },
      ],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(labelReadSchema),
      },
    })
    return labelReadSchema.parse(JSON.parse(response.text ?? '{}'))
  }

  /** Embed a query photo for cosine retrieval against the in-RAM index (768d, matches the index build). */
  async function embedImage(
    imageBase64: string,
    mimeType = 'image/jpeg',
  ): Promise<Float32Array> {
    const response = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: [{ parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
      config: { outputDimensionality: 768 },
    })
    const values = response.embeddings?.[0]?.values
    if (!values) throw new Error('embedContent returned no embedding')
    return Float32Array.from(values)
  }

  return { interpretQuery, agenticSearch, ocrLabel, embedImage }
}

export type GeminiClient = ReturnType<typeof createGemini>

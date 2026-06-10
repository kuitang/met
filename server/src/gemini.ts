/**
 * Thin Gemini client — the ONLY LLM integration point (locked: Gemini only,
 * no provider abstraction). Call shapes per the plan's "Gemini integration
 * reference": structured output via responseMimeType + responseJsonSchema
 * (the docs' newer config.responseFormat shape is NOT in @google/genai 2.8.0's
 * GenerateContentConfig type — verified against the installed SDK; the
 * benchmarked legacy shape is what the SDK actually exposes), thinkingLevel
 * MINIMAL on flash-lite, embeddings at 768 dims.
 */
import { GoogleGenAI, MediaResolution, ThinkingLevel } from '@google/genai'
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
                `Valid classification values: ${vocab.classifications.join(', ')}`,
                `Valid culture/period values: ${vocab.cultures.join(', ')}`,
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
    return interpretedQuerySchema.parse(JSON.parse(response.text ?? '{}'))
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

  return { interpretQuery, ocrLabel, embedImage }
}

export type GeminiClient = ReturnType<typeof createGemini>

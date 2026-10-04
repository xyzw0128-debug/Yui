/**
 * Study RAG — Retriever.
 *
 * Embeds a user query and searches the vector store for
 * the most relevant study material chunks.
 */
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { embedText } from './embedder.js';
import { searchSimilar } from './vector-store.js';
import type { SearchResult, StudyRagConfig } from './types.js';

const DEFAULT_TOP_K = 5;
/**
 * Casual chat ("답장 왔어?") must stay below this, course questions above.
 * The old untyped embeddings put chat at 0.61–0.69 and course questions at
 * 0.72–0.88; tune against the "no match above threshold" log line.
 * Override with STUDY_RAG_THRESHOLD.
 */
const DEFAULT_THRESHOLD = 0.7;

function configuredThreshold(): number {
  const raw = process.env.STUDY_RAG_THRESHOLD || envValue('STUDY_RAG_THRESHOLD');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : DEFAULT_THRESHOLD;
}

/**
 * Search for study chunks relevant to a user query.
 */
export async function retrieveRelevantChunks(query: string, config?: Partial<StudyRagConfig>): Promise<SearchResult[]> {
  const topK = config?.topK ?? DEFAULT_TOP_K;
  const threshold = config?.similarityThreshold ?? configuredThreshold();

  // Embed the user query
  const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY');
  if (queryEmbedding.length === 0) return [];

  // Search unfiltered so a miss can still report its best score for tuning.
  const candidates = searchSimilar(queryEmbedding, topK, 0);
  const results = candidates.filter((r) => r.similarity >= threshold);
  if (results.length === 0 && candidates.length > 0) {
    log.info('Study RAG: no match above threshold', {
      query: query.slice(0, 50),
      best: candidates[0].similarity.toFixed(3),
      threshold,
    });
  }
  return results;
}

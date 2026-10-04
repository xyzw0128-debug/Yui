/**
 * Study RAG module — type definitions.
 */

/** A single chunk of study material with metadata. */
export interface StudyChunk {
  id: string;
  course: string;
  file: string;
  section: string;
  text: string;
  embeddingJson: string;
  fileHash: string;
}

/** A chunk paired with its similarity score from a search. */
export interface SearchResult {
  chunk: StudyChunk;
  similarity: number;
}

/** Configuration for the Study RAG module. */
export interface StudyRagConfig {
  /** Root path to the study vault, e.g. /home/lael/University/2학년 2학기 */
  vaultPath: string;
  /** Minimum cosine similarity to include a result (0–1). */
  similarityThreshold: number;
  /** Maximum number of results to return. */
  topK: number;
}

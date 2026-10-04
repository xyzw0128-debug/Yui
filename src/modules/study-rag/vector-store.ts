/**
 * Study RAG — SQLite-based vector store.
 *
 * Stores chunks with their embeddings in SQLite and performs
 * brute-force cosine similarity search in TypeScript.
 * Fine for the expected scale (hundreds to low thousands of chunks).
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import type { StudyChunk, SearchResult } from './types.js';

const DB_FILENAME = 'study-rag.sqlite';

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (_db) return _db;

  const dbPath = path.join(DATA_DIR, DB_FILENAME);

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS study_chunks (
      id           TEXT PRIMARY KEY,
      course       TEXT NOT NULL,
      file         TEXT NOT NULL,
      section      TEXT NOT NULL,
      text         TEXT NOT NULL,
      embedding_json TEXT NOT NULL DEFAULT '',
      file_hash    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_study_chunks_course ON study_chunks(course);
    CREATE INDEX IF NOT EXISTS idx_study_chunks_file ON study_chunks(file);
    CREATE INDEX IF NOT EXISTS idx_study_file_hash ON study_chunks(file_hash);
    CREATE TABLE IF NOT EXISTS study_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  log.info('Study RAG vector store initialized', { path: dbPath });
  return _db;
}

/**
 * Read a persisted setting (e.g. the on/off toggle) from study_meta.
 */
export function getMeta(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM study_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Persist a setting to study_meta.
 */
export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO study_meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Drop every stored chunk when the embedding scheme changed (model, task
 * type, …) — vectors from different schemes are not comparable, so the next
 * indexing pass must re-embed everything. Returns true if a reset happened.
 */
export function ensureEmbeddingVersion(version: string): boolean {
  if (getMeta('embedding_version') === version) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM study_chunks').run();
    db.prepare('INSERT OR REPLACE INTO study_meta (key, value) VALUES (?, ?)').run('embedding_version', version);
  })();
  return true;
}

/**
 * Get the set of file hashes currently stored for a course.
 */
export function getStoredFileHashes(course: string): Map<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT file, file_hash FROM study_chunks WHERE course = ?').all(course) as Array<{
    file: string;
    file_hash: string;
  }>;
  return new Map(rows.map((r) => [r.file, r.file_hash]));
}

/**
 * Remove all chunks for a specific file within a specific course.
 */
export function removeChunksForFile(fileName: string, course?: string): void {
  const db = getDb();
  if (course) {
    db.prepare('DELETE FROM study_chunks WHERE file = ? AND course = ?').run(fileName, course);
  } else {
    db.prepare('DELETE FROM study_chunks WHERE file = ?').run(fileName);
  }
}

/**
 * Insert chunks in bulk (within a transaction).
 */
export function insertChunks(chunks: StudyChunk[]): void {
  if (chunks.length === 0) return;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO study_chunks (id, course, file, section, text, embedding_json, file_hash)
    VALUES (@id, @course, @file, @section, @text, @embeddingJson, @fileHash)
  `);
  const tx = db.transaction(() => {
    for (const chunk of chunks) {
      insert.run({
        id: chunk.id,
        course: chunk.course,
        file: chunk.file,
        section: chunk.section,
        text: chunk.text,
        embeddingJson: chunk.embeddingJson,
        fileHash: chunk.fileHash,
      });
    }
  });
  tx();
}

/**
 * Search for the top-K most similar chunks by cosine similarity.
 */
export function searchSimilar(
  queryEmbedding: number[],
  topK: number,
  threshold: number,
  courseFilter?: string,
): SearchResult[] {
  const db = getDb();

  let rows: Array<{
    id: string;
    course: string;
    file: string;
    section: string;
    text: string;
    embedding_json: string;
    file_hash: string;
  }>;
  if (courseFilter) {
    rows = db
      .prepare("SELECT * FROM study_chunks WHERE course = ? AND embedding_json != ''")
      .all(courseFilter) as typeof rows;
  } else {
    rows = db.prepare("SELECT * FROM study_chunks WHERE embedding_json != ''").all() as typeof rows;
  }

  const scored: SearchResult[] = [];
  for (const row of rows) {
    let embedding: number[];
    try {
      embedding = JSON.parse(row.embedding_json) as number[];
    } catch {
      continue;
    }
    if (embedding.length === 0) continue;

    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity >= threshold) {
      scored.push({
        chunk: {
          id: row.id,
          course: row.course,
          file: row.file,
          section: row.section,
          text: row.text,
          embeddingJson: row.embedding_json,
          fileHash: row.file_hash,
        },
        similarity,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Get indexing statistics.
 */
export function getStats(): { totalChunks: number; courses: string[]; files: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM study_chunks').get() as { cnt: number }).cnt;
  const courses = (db.prepare('SELECT DISTINCT course FROM study_chunks').all() as Array<{ course: string }>).map(
    (r) => r.course,
  );
  const files = (db.prepare('SELECT COUNT(DISTINCT file) as cnt FROM study_chunks').get() as { cnt: number }).cnt;
  return { totalChunks: total, courses, files };
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Close the database connection (for clean shutdown).
 */
export function closeStudyDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

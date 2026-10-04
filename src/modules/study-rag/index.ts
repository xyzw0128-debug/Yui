/**
 * Study RAG module — entry point.
 *
 * Provides two main functions:
 * 1. initStudyRag() — auto-indexes study materials on startup
 * 2. attachStudyContext() — attaches relevant study context to an engaged
 *    inbound message (called by the router after engage + command gate)
 *
 * The module scans .md files under STUDY_VAULT_PATH, chunks them,
 * generates embeddings, and stores in SQLite. For each message the router
 * hands to an agent it performs a vector search and, if anything clears the
 * threshold, adds a `study_context` field to the message content. The user's
 * `text` is never rewritten, so command detection and engage patterns keep
 * seeing exactly what the user typed.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { chunkMarkdownFile, fileHash } from './chunker.js';
import { EMBEDDING_VERSION, embedBatch } from './embedder.js';
import { formatStudyContext } from './generator.js';
import { retrieveRelevantChunks } from './retriever.js';
import { envValue } from '../../env.js';
import {
  getStoredFileHashes,
  removeChunksForFile,
  insertChunks,
  getStats,
  closeStudyDb,
  getMeta,
  setMeta,
  ensureEmbeddingVersion,
} from './vector-store.js';
import type { StudyChunk } from './types.js';

let _initialized = false;
let _enabled = true; // toggle: /study on|off — persisted in study_meta so it survives restarts
let _vaultPath = '';

/** Upper bound on the query-embedding round trip; it sits on the routing path. */
const QUERY_TIMEOUT_MS = 5_000;
/** Messages that are commands (/clear, !model, …) never get study context. */
const COMMAND_PREFIX = /^[/!]/;
/** One retrieval per inbound message even when it fans out to several agents. */
const CONTEXT_CACHE_MAX = 50;
const _contextCache = new Map<string, Promise<string | null>>();

/**
 * Initialize the Study RAG module.
 * Scans the study vault and indexes new/changed .md files.
 * Skips files that haven't changed (hash comparison).
 */
export async function initStudyRag(): Promise<void> {
  _vaultPath = process.env.STUDY_VAULT_PATH || envValue('STUDY_VAULT_PATH') || '/home/lael/University/2학년 2학기';
  if (!_vaultPath) {
    log.info('Study RAG: STUDY_VAULT_PATH not set, module disabled');
    return;
  }

  if (!fs.existsSync(_vaultPath)) {
    log.warn('Study RAG: vault path does not exist', { path: _vaultPath });
    return;
  }

  log.info('Study RAG: starting auto-indexing', { vaultPath: _vaultPath });

  try {
    _enabled = getMeta('enabled') !== 'false';

    if (ensureEmbeddingVersion(EMBEDDING_VERSION)) {
      log.info('Study RAG: embedding scheme changed, re-indexing all files', { version: EMBEDDING_VERSION });
    }

    const courses = discoverCourses(_vaultPath);
    let totalNewChunks = 0;
    let totalSkipped = 0;

    for (const course of courses) {
      const result = await indexCourse(course.name, course.path);
      totalNewChunks += result.indexed;
      totalSkipped += result.skipped;
    }

    const stats = getStats();
    log.info('Study RAG: auto-indexing complete', {
      courses: stats.courses.length,
      totalFiles: stats.files,
      totalChunks: stats.totalChunks,
      newlyIndexed: totalNewChunks,
      skipped: totalSkipped,
    });

    _initialized = true;
  } catch (err) {
    log.error('Study RAG: initialization failed', { err });
  }
}

/**
 * Attach relevant study context to an inbound message's content.
 *
 * Takes the serialized message content (JSON) and returns it with a
 * `study_context` field added when relevant material is found; otherwise the
 * content is returned unchanged. Never throws — study context is best-effort.
 */
export async function attachStudyContext(messageId: string, content: string): Promise<string> {
  if (!_initialized || !_enabled) return content;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (typeof parsed.text !== 'string') return content;

  let pending = _contextCache.get(messageId);
  if (!pending) {
    pending = studyContextFor(parsed.text);
    _contextCache.set(messageId, pending);
    if (_contextCache.size > CONTEXT_CACHE_MAX) {
      _contextCache.delete(_contextCache.keys().next().value as string);
    }
  }

  const context = await pending;
  if (!context) return content;
  return JSON.stringify({ ...parsed, study_context: context });
}

/**
 * Retrieve and format study context for a message text, or null when the
 * message is a command, too short, unrelated, or the lookup fails/times out.
 */
async function studyContextFor(messageText: string): Promise<string | null> {
  // Strip leading platform mentions (<@123>) before the command check.
  const trimmed = messageText.replace(/^(\s*<@!?\d+>)+/, '').trim();
  if (trimmed.length < 5 || COMMAND_PREFIX.test(trimmed)) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUERY_TIMEOUT_MS);
    });
    const results = await Promise.race([retrieveRelevantChunks(trimmed), timeout]);
    if (!results || results.length === 0) return null;

    const context = formatStudyContext(results);
    if (context) {
      log.info('Study RAG: context attached', {
        query: trimmed.slice(0, 50),
        topSimilarity: results[0].similarity.toFixed(3),
        resultsCount: results.length,
        topFile: results[0].chunk.file,
      });
    }
    return context;
  } catch (err) {
    log.debug('Study RAG: retrieval failed (non-fatal)', { err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if the Study RAG module is active.
 */
export function isStudyRagActive(): boolean {
  return _initialized;
}

/**
 * Get current indexing statistics.
 */
export function getStudyRagStats() {
  return getStats();
}

/**
 * Shut down the Study RAG module.
 */
export function stopStudyRag(): void {
  closeStudyDb();
  _initialized = false;
}

/**
 * Toggle the Study RAG module on or off at runtime.
 * When disabled, attachStudyContext() leaves messages untouched.
 */
export function setStudyRagEnabled(enabled: boolean): void {
  _enabled = enabled;
  try {
    setMeta('enabled', String(enabled));
  } catch (err) {
    log.warn('Study RAG: failed to persist toggle', { err });
  }
  log.info(`Study RAG: ${enabled ? 'enabled' : 'disabled'} by user`);
}

/**
 * Check whether the Study RAG module is currently enabled.
 */
export function isStudyRagEnabled(): boolean {
  return _enabled;
}

// ─── Internal helpers ──────────────────────────────────────

interface CourseInfo {
  name: string;
  path: string;
}

/**
 * Discover course directories under the vault path.
 * Each subdirectory is treated as a course.
 */
function discoverCourses(vaultPath: string): CourseInfo[] {
  const courses: CourseInfo[] = [];

  try {
    const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        courses.push({ name: entry.name, path: path.join(vaultPath, entry.name) });
      }
    }
  } catch (err) {
    log.warn('Study RAG: failed to scan vault', { err });
  }

  return courses;
}

/**
 * Discover all .md files recursively under a course directory.
 */
function discoverMdFiles(coursePath: string): Array<{ fileName: string; filePath: string }> {
  const files: Array<{ fileName: string; filePath: string }> = [];

  function scan(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'index.md') {
        files.push({ fileName: entry.name, filePath: fullPath });
      }
    }
  }

  scan(coursePath);
  return files;
}

/**
 * Index a single course: chunk new/changed .md files and generate embeddings.
 */
async function indexCourse(courseName: string, coursePath: string): Promise<{ indexed: number; skipped: number }> {
  const mdFiles = discoverMdFiles(coursePath);
  if (mdFiles.length === 0) return { indexed: 0, skipped: 0 };

  const storedHashes = getStoredFileHashes(courseName);
  let indexed = 0;
  let skipped = 0;

  // Clean up stale chunks for files that were deleted from disk
  const currentFiles = new Set(mdFiles.map((f) => f.fileName));
  for (const [storedFile] of storedHashes) {
    if (!currentFiles.has(storedFile)) {
      removeChunksForFile(storedFile, courseName);
      log.info('Study RAG: removed stale chunks for deleted file', {
        course: courseName,
        file: storedFile,
      });
    }
  }

  for (const { fileName, filePath } of mdFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const currentHash = fileHash(content);

      // Skip if file hasn't changed
      if (storedHashes.get(fileName) === currentHash) {
        skipped++;
        continue;
      }

      // Remove old chunks for this file (if any)
      removeChunksForFile(fileName, courseName);

      // Chunk the file
      const chunks = chunkMarkdownFile(content, courseName, fileName);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      // Generate embeddings in batch
      const texts = chunks.map((c) => c.text);
      const embeddings = await embedBatch(texts, 'RETRIEVAL_DOCUMENT');

      // Attach embeddings to chunks
      const enrichedChunks: StudyChunk[] = chunks.map((chunk, i) => ({
        ...chunk,
        embeddingJson: embeddings[i] && embeddings[i].length > 0 ? JSON.stringify(embeddings[i]) : '',
      }));

      const validChunks = enrichedChunks.filter((c) => c.embeddingJson.length > 10);
      if (validChunks.length > 0) {
        insertChunks(validChunks);
        indexed += validChunks.length;
        log.info('Study RAG: indexed file', {
          course: courseName,
          file: fileName,
          chunks: validChunks.length,
        });
      } else {
        log.warn('Study RAG: no valid embeddings generated for file', { file: fileName });
      }
    } catch (err) {
      log.warn('Study RAG: failed to index file', { file: fileName, err });
    }
  }

  return { indexed, skipped };
}

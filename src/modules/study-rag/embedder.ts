/**
 * Study RAG — Multi-key Gemini Embedding API client.
 *
 * Utilizes the 14-key pool from cliproxyapi with round-robin rotation
 * and automatic failover on 429 Quota Exceeded.
 */
import fs from 'fs';

import { envValue } from '../../env.js';
import { log } from '../../log.js';

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}`;
const BATCH_SIZE = 25; // 25 chunks per batch per key ensures safe quota usage

/**
 * Asymmetric retrieval task types: documents and queries are embedded
 * differently, which separates related from unrelated text far better than
 * the untyped default (where unrelated Korean sentences still score ~0.6).
 */
export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/**
 * Identifies the embedding scheme stored in the vector store. Bump whenever
 * the model or task-type handling changes so stale vectors get re-embedded.
 */
export const EMBEDDING_VERSION = `${EMBED_MODEL}:retrieval-v1`;

let _apiKeys: string[] = [];
let _keyIndex = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load all available Gemini API keys into the pool.
 */
function getApiKeys(): string[] {
  if (_apiKeys.length > 0) return _apiKeys;

  const candidatePaths = [
    process.env.CLIPROXY_CONFIG_PATH,
    envValue('CLIPROXY_CONFIG_PATH'),
    process.env.HOME ? `${process.env.HOME}/cliproxyapi/config.yaml` : null,
    '/home/lael/cliproxyapi/config.yaml',
    'cliproxyapi/config.yaml',
  ].filter(Boolean) as string[];

  for (const configPath of candidatePaths) {
    try {
      if (fs.existsSync(configPath)) {
        const text = fs.readFileSync(configPath, 'utf-8');
        const matches = [...text.matchAll(/api-key:\s*"([^"]+)"/g)].map((m) => m[1]);
        if (matches.length > 0) {
          _apiKeys = Array.from(new Set(matches));
          log.info('Study RAG: loaded API key pool for embeddings', { count: _apiKeys.length });
          return _apiKeys;
        }
      }
    } catch {
      // try next
    }
  }

  // Fallback to env (process env first, then .env)
  const envKey = process.env.GEMINI_API_KEY || envValue('GEMINI_API_KEY');
  if (envKey) {
    _apiKeys = [envKey];
    return _apiKeys;
  }

  throw new Error('Study RAG: No Gemini API key found. Set GEMINI_API_KEY or ensure cliproxyapi config exists.');
}

/**
 * Get the next API key in round-robin fashion.
 */
function getNextKey(): string {
  const keys = getApiKeys();
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
}

/**
 * Embed a single text string with key rotation and retry.
 */
export async function embedText(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const keys = getApiKeys();
  const maxAttempts = Math.min(keys.length, 5);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getNextKey();
    try {
      const resp = await fetch(`${EMBED_URL}:embedContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.status === 429) {
        log.warn('Study RAG: 429 rate limit on embedding key, rotating to next key', { attempt });
        await sleep(300);
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Embedding API error ${resp.status}: ${body}`);
      }

      const data = (await resp.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;
      if (values && Array.isArray(values)) {
        return values;
      }
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      await sleep(300);
    }
  }

  return [];
}

/**
 * Embed multiple texts in batches with key pool rotation.
 */
export async function embedBatch(texts: string[], taskType: EmbedTaskType): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedText(texts[0], taskType)];

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let success = false;
    const keys = getApiKeys();
    const maxAttempts = Math.min(keys.length, 4);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = getNextKey();
      try {
        const batchResult = await executeBatchRequest(batch, key, taskType);
        results.push(...batchResult);
        success = true;
        break;
      } catch (err: unknown) {
        const is429 = err instanceof Error && err.message.includes('429');
        if (is429 && attempt < maxAttempts - 1) {
          log.warn('Study RAG: 429 on batch embed, switching key in pool', { attempt });
          await sleep(500);
          continue;
        }
        if (attempt === maxAttempts - 1) {
          log.warn('Study RAG: batch embed failed across keys, falling back to sequential', { err });
          for (const text of batch) {
            try {
              results.push(await embedText(text, taskType));
            } catch {
              results.push([]);
            }
          }
          success = true;
          break;
        }
      }
    }

    if (!success) {
      for (let j = 0; j < batch.length; j++) results.push([]);
    }

    // Gentle pacing to respect provider limits
    await sleep(250);
  }

  return results;
}

async function executeBatchRequest(texts: string[], apiKey: string, taskType: EmbedTaskType): Promise<number[][]> {
  const requests = texts.map((text) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType,
  }));

  const resp = await fetch(`${EMBED_URL}:batchEmbedContents?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Batch embedding API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> };
  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    throw new Error('Batch embedding API returned no embeddings');
  }

  return data.embeddings.map((e) => e.values ?? []);
}

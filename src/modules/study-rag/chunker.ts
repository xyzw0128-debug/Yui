/**
 * Study RAG — Markdown-aware chunker.
 *
 * Splits `.md` files into chunks that respect heading boundaries,
 * preserve tables and code blocks, and carry source metadata.
 */
import crypto from 'crypto';

import type { StudyChunk } from './types.js';

const TARGET_TOKENS = 400;
const MAX_TOKENS = 600;
const OVERLAP_WORDS = 50;

/** Rough token estimate: ~1.5 chars per token for mixed Korean/English. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

/** Compute MD5 hash of file content for change detection. */
export function fileHash(content: string): string {
  return crypto.createHash('md5').update(content, 'utf-8').digest('hex');
}

interface RawSection {
  heading: string;
  body: string;
}

/**
 * Split markdown into sections by headings (##, ###).
 * Top-level content before any heading goes into a "(서론)" section.
 */
function splitByHeadings(md: string): RawSection[] {
  const sections: RawSection[] = [];
  const lines = md.split('\n');
  let currentHeading = '(서론)';
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n') });
      }
      currentHeading = headingMatch[2].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n') });
  }

  return sections;
}

/**
 * Split a section body into token-bounded chunks.
 * Preserves code blocks and table blocks as atomic units.
 */
function splitIntoChunks(body: string): string[] {
  const paragraphs = splitPreservingBlocks(body);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    // If a single block exceeds MAX, keep it as-is (don't break tables/code)
    if (paraTokens > MAX_TOKENS && current === '') {
      chunks.push(para.trim());
      continue;
    }

    const combined = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(combined) > TARGET_TOKENS && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Split text into paragraphs while preserving code blocks and tables as atomic units.
 */
function splitPreservingBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let inCodeBlock = false;
  let inTable = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        current.push(line);
        blocks.push(current.join('\n'));
        current = [];
        inCodeBlock = false;
      } else {
        if (current.length > 0) blocks.push(current.join('\n'));
        current = [line];
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      current.push(line);
      continue;
    }

    const isTableLine = line.trim().startsWith('|') || /^\s*\|?[\s:]*-+[\s:]*\|/.test(line);
    if (isTableLine) {
      if (!inTable && current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      inTable = true;
      current.push(line);
      continue;
    }

    if (inTable) {
      blocks.push(current.join('\n'));
      current = [];
      inTable = false;
    }

    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks.filter((b) => b.trim().length > 0);
}

/**
 * Apply overlap: prepend the last OVERLAP_WORDS words of the previous chunk
 * to the current chunk for context continuity.
 */
function applyOverlap(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const result = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const words = prev.split(/\s+/);
    // Take ~last OVERLAP_WORDS worth of words
    const overlapWords = Math.min(words.length, OVERLAP_WORDS);
    const overlap = words.slice(-overlapWords).join(' ');
    result.push(`${overlap}\n\n${chunks[i]}`);
  }
  return result;
}

/**
 * Chunk a single markdown file into StudyChunks.
 */
export function chunkMarkdownFile(content: string, course: string, fileName: string): StudyChunk[] {
  const hash = fileHash(content);
  const sections = splitByHeadings(content);
  const allChunks: StudyChunk[] = [];

  for (const section of sections) {
    const body = section.body.trim();
    if (!body || estimateTokens(body) < 20) continue;

    const rawChunks = splitIntoChunks(body);
    const overlapped = applyOverlap(rawChunks);

    for (let i = 0; i < overlapped.length; i++) {
      const text = overlapped[i].trim();
      if (!text || estimateTokens(text) < 10) continue;

      const id = crypto
        .createHash('sha256')
        .update(`${course}:${fileName}:${section.heading}:${i}`)
        .digest('hex')
        .slice(0, 16);

      allChunks.push({
        id,
        course,
        file: fileName,
        section: section.heading,
        text,
        embeddingJson: '', // filled by embedder
        fileHash: hash,
      });
    }
  }

  return allChunks;
}

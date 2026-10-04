/**
 * Study RAG — Context generator.
 *
 * Formats retrieved chunks into a context block. The router attaches it to
 * the inbound message as `study_context` (the user's text stays untouched);
 * the container formatter renders it alongside the message.
 */
import type { SearchResult } from './types.js';

const MAX_CONTEXT_LENGTH = 3000; // chars, leave room within Discord + LLM limits

/**
 * Format retrieved search results into a context block for LLM injection.
 * Returns null if no relevant results were found.
 */
export function formatStudyContext(results: SearchResult[]): string | null {
  if (results.length === 0) return null;

  let contextBlock = '📚 [관련 학습 자료 - 자동 검색됨]\n━━━━━━━━━━━━━━━━━━━━━━\n';
  let totalLength = contextBlock.length;

  for (const result of results) {
    const { chunk, similarity } = result;
    const confidence = similarity >= 0.6 ? '🟢' : similarity >= 0.4 ? '🟡' : '🔵';
    const entry = `${confidence} 📄 ${chunk.file} > ${chunk.section}\n"${truncateText(chunk.text, 500)}"\n\n`;

    if (totalLength + entry.length > MAX_CONTEXT_LENGTH) break;
    contextBlock += entry;
    totalLength += entry.length;
  }

  contextBlock += '━━━━━━━━━━━━━━━━━━━━━━\n';
  contextBlock += '질문이 이 자료와 관련 있을 때만 참고하고, 참고했다면 출처(파일명, 섹션)를 표시하세요.\n';
  contextBlock += '교재에 없는 내용은 "교재에는 없지만..."으로 구분하세요. 관련 없는 질문이면 이 자료는 무시하세요.';

  return contextBlock;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

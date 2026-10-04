import { describe, expect, it } from 'vitest';
import { chunkMarkdownFile, fileHash } from './chunker.js';
import { formatStudyContext } from './generator.js';
import type { SearchResult, StudyChunk } from './types.js';

describe('Study RAG Chunker', () => {
  it('splits markdown content by headings and attaches metadata', () => {
    const md = `
# 데이터베이스 개요

## 1. 데이터와 정보
데이터는 단순한 사실이나 관측값이다.
정보는 데이터를 가공하여 의미 있는 형태로 변환한 것이다.

## 2. 데이터베이스의 정의
데이터베이스는 특정 조직의 여러 사용자가 공유하여 사용할 수 있도록 통합해서 저장한 운영 데이터의 집합이다.
- 실시간 접근성
- 계속적인 변화
- 동시 공용
- 내용 기반 참조
`;

    const chunks = chunkMarkdownFile(md, '데이터베이스', 'DB_교재_Ch01.md');
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const sectionNames = chunks.map((c) => c.section);
    expect(sectionNames).toContain('1. 데이터와 정보');
    expect(sectionNames).toContain('2. 데이터베이스의 정의');

    for (const chunk of chunks) {
      expect(chunk.course).toBe('데이터베이스');
      expect(chunk.file).toBe('DB_교재_Ch01.md');
      expect(chunk.fileHash).toBe(fileHash(md));
      expect(chunk.text.length).toBeGreaterThan(10);
    }
  });

  it('preserves code blocks without tearing them apart', () => {
    const md = `
## SQL 쿼리 실습
다음은 학생 테이블을 조회하는 쿼리이다.

\`\`\`sql
SELECT student_id, name, department
FROM students
WHERE gpa >= 3.5
ORDER BY gpa DESC;
\`\`\`
`;

    const chunks = chunkMarkdownFile(md, '데이터베이스', 'DB_교재_Ch05.md');
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('SELECT student_id, name, department');
    expect(chunks[0].text).toContain('ORDER BY gpa DESC;');
  });

  it('preserves markdown tables without tearing them apart', () => {
    const md = `
## 프로세스 상태 전이표
다음은 프로세스 5가지 상태를 요약한 표이다.

| 상태 | 설명 |
| :--- | :--- |
| 생성 (New) | 프로세스가 막 생성된 상태 |
| 준비 (Ready) | CPU 할당을 대기하는 상태 |
| 실행 (Running) | CPU를 할당받아 명령어를 실행 중인 상태 |
| 대기 (Waiting) | I/O나 특정 이벤트를 기다리는 상태 |
| 종료 (Terminated) | 실행을 마치고 자원을 반납한 상태 |
`;

    const chunks = chunkMarkdownFile(md, '운영체제', 'OS_교재_Ch03.md');
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('| 생성 (New) |');
    expect(chunks[0].text).toContain('| 종료 (Terminated) |');
  });
});

describe('Study RAG Generator / Context Formatter', () => {
  it('returns null when no results are provided', () => {
    expect(formatStudyContext([])).toBeNull();
  });

  it('formats retrieved chunks into a clear context prompt with sources', () => {
    const mockChunk: StudyChunk = {
      id: 'chk-1',
      course: '데이터베이스',
      file: 'DB_교재_Ch05_SQL기초.md',
      section: 'B+ 트리 분할',
      text: 'B+ 트리에서 노드가 가득 차면 중간 키를 부모로 올리고 분할한다.',
      embeddingJson: '',
      fileHash: 'abc',
    };

    const results: SearchResult[] = [
      {
        chunk: mockChunk,
        similarity: 0.85,
      },
    ];

    const formatted = formatStudyContext(results);
    expect(formatted).not.toBeNull();
    expect(formatted).toContain('📚 [관련 학습 자료 - 자동 검색됨]');
    expect(formatted).toContain('🟢 📄 DB_교재_Ch05_SQL기초.md > B+ 트리 분할');
    expect(formatted).toContain('B+ 트리에서 노드가 가득 차면 중간 키를 부모로 올리고 분할한다.');
    expect(formatted).toContain('출처(파일명, 섹션)를 표시하세요');
    // The user's question is not embedded — it stays in content.text.
    expect(formatted).not.toContain('B+ 트리 분할이 뭐야?');
  });
});

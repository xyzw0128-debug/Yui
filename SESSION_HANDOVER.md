# NanoClaw 세션 인계 문서 (Session Handover)

이 문서는 이전 개발 세션에서 완료된 모든 작업과 아키텍처 상태를 다음 새 세션에 100% 완벽히 전달하기 위한 인계서입니다.

---

## 📌 핵심 시스템 정보
- **프로젝트 경로**: `/home/lael/NanoClaw` (브랜치 `main`)
- **최신 커밋**: `8b71c96c` (`feat(discord): support multi-way flash failover rotation among 3.5, 3.6, and 3.7`)
- **시스템 데몬**: `nanoclaw-v2-09435e69.service` (현재 active running)
- **프록시 API**: Docker `cliproxyapi` (`http://172.17.0.1:8317`, 설정: `/home/lael/cliproxyapi/config.yaml`)
- **API 키 풀**: Google AI Studio 키 7개 정상 가동 중 (Round-Robin, 정지된 7개 키 정리 완료)
- **소유자 디스코드 ID**: `631432379889745930` (Lael)
- **이전 대화 링크**: conversation://703c673e-2a00-4795-be81-0b1424012ee6

---

## 🛠️ 완료된 개발 내역 요약

### 1. Discord 5종 모델 제어 콘솔 (`/model`, `!model`)
- 파일: `src/channels/discord-model-console.ts`, `src/channels/chat-sdk-bridge.ts`
- 3단 7버튼 구조:
  - Row 1: `[ ⚡ 3.1 Flash-Lite ]`, `[ 🛡️ 3.5 Flash-Lite (추천⭐) ]` (일 ~7,000회 풀, 15 RPM)
  - Row 2: `[ 🚀 3.5 Flash ]`, `[ 🚀 3.6 Flash ]`, `[ 🧠 3.7 Flash (추론형) ]` (일 280회 풀, 5 RPM)
  - Row 3: `[ 📊 상태 점검 ]`, `[ 🔄 프록시 재시작 ]`, `[ 🗑️ 닫기 ]`
- 권한 제어: 소유자(Lael)만 제어 가능 (타인 클릭 시 Ephemeral 경고)
- 동시성 제어: 빠른 연속 클릭 시 Mutex Lock(`isActionInProgress`)으로 도커 중복 재시작 및 충돌 방지
- 키 실시간 프로빙: `[ 📊 상태 점검 ]` 클릭 시 14개 키를 병렬 테스트하여 `14/14개 정상 가동` 실시간 출력

### 2. 스마트 429 감시자 & Flash 상호 순환 페일오버
- **감시 방식**: Docker `cliproxyapi` 로그를 백그라운드에서 실시간 스트리밍 (`docker logs -f -n 0 cliproxyapi`).
  Gin logger의 429 에러(`/429\s*\|.*POST\s+"\/v1\/messages/`) 포착.
- **429 트리거 시점**: 14개 키가 전부 소진되었을 때만 Cliproxy가 429를 반환하므로 완벽히 일치함.
- **동작 원칙**:
  1. **Flash-Lite (`3.5 Lite`, `3.1 Lite`)**:
     - 완전 무개입(Ignored). 429 발생 시 다른 모델로 전환하지 않으며, 알림도 보내지 않음.
     - Claude Code 본래의 지수 백오프 재시도 및 순정 에러 처리에 100% 자율 위임.
  2. **고성능 Flash (`3.5`, `3.6`, `3.7`)**:
     - 3.5든 3.6이든 3.7이든 어떤 Flash 모델에서 작업하든, 429 발생 시 **소진되지 않은 다른 Flash 모델로 상호 자동 순환 전환**!
     - 예: `3.5 Flash` ➔ `3.6 Flash` ➔ `3.7 Flash` ➔ 3개 모두 소진 시 Lite로 절대 가지 않고 Claude Code에 자율 위임.
     - 예: `3.7 Flash` ➔ `3.6 Flash` ➔ `3.5 Flash` ➔ 3개 모두 소진 시 중단.
  3. **비침습성 보장**:
     - Claude Code를 강제로 kill하거나 중단하지 않음.
     - 3.5 Flash까지 모두 소진되어도 인위적인 "작업 중단 알림"을 보내지 않고 Claude Code의 내장 루틴대로 깔끔하게 처리됨.

### 3. API 키 추가 시 100% 동적 할당량 자동 계산 (Auto-scaling)
- `config.yaml`에 키가 추가되어 15개, 20개로 늘어나면:
  - 안내 문구: `(15개 키 풀 기준)`, `(20개 키 풀 기준)`
  - 할당량: Lite는 `keyCount * 500`, Flash는 `keyCount * 20`으로 자동 곱셈 연산되어 실시간 렌더링.
  - 하드코딩 완전 제거 완료.

### 4. 검증 결과
- 단위 테스트: `pnpm vitest run src/channels/discord-model-console.test.ts` (24개 전원 통과)
- 빌드: `pnpm build` 성공 (TypeScript 컴파일 에러 0)
- 현재 활성 모델: `gemini-3.5-flash-lite`

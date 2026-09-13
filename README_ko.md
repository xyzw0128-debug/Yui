# 💙 Yui_NanoClaw — Upstream NanoClaw 기반 경량 Carry 레이어

> **"오픈소스의 강력한 엔진 위에 얹어 쓰는 유이(Yui) 전용 두뇌 & 디스코드 스택"**

이 저장소는 거대한 NanoClaw 본체 코드를 복제해 보관하는 대신, **EJClaw(눈쟁이 스택)의 미니멀 Carry 아키텍처**를 채택하여 공식 NanoClaw 위에 유이 전용 커스텀 기능만 얇고 안전하게 얹어놓은 독립 저장소입니다.

---

## 🌟 아키텍처 구조

```text
upstream nanoclaw (github.com/nanocoai/nanoclaw, main)
  └─ Yui Carry Layer (이 저장소)
       ├─ patches/yui-carry.patch          # 본체 연동 패치 (Discord 라우팅, 컨테이너 주입)
       ├─ src/channels/discord-model-console.ts # Gemini /model 디스코드 대화형 콘솔 & 429 감시
       ├─ src/modules/progress-card/        # 실시간 진행 상태 요약 카드
       ├─ yui/instructions.template.md      # 유이 인격 및 행동 지침 템플릿
       └─ setup-yui.sh                      # 원클릭 자동 클론/패치/빌드 스크립트
```

---

## 🚀 빠른 시작 (설치 및 복구)

새로운 컴퓨터나 환경에서 단 3줄로 유이를 복원할 수 있습니다:

```bash
# 1. Yui 저장소 클론
git clone https://github.com/xyzw0128-debug/Yui.git
cd Yui

# 2. 원클릭 자동 설치 스크립트 실행
./setup-yui.sh
```

설치가 완료된 후 `~/NanoClaw/.env` 파일에 Discord 봇 토큰과 API 키를 입력하고 실행합니다:
```bash
cd ~/NanoClaw
pnpm build
bash nanoclaw.sh
```

---

## 💎 핵심 기능

1. **Google Gemini 3.8 Flash 고성능 백엔드**:
   * 최신 Gemini 3.8 Flash 및 멀티 키 풀(14개 등) 자동 순환.
2. **디스코드 /model 실시간 콘솔**:
   * 디스코드에서 버튼 클릭으로 간편하게 활성 모델 전환 (3.1 Lite, 3.5 Lite, 3.5, 3.6, 3.7, 3.8).
3. **스마트 429 페일오버 감시**:
   * Gemini 쿼터 소진 시 다른 고성능 Flash 모델로 무중단 자동 회피.
4. **실시간 Progress Card**:
   * AI 작업 진행 상황을 깔끔한 디스코드 임베드로 요약 전달.

---

## 🛡️ 보안 원칙

* 본 저장소에는 **개인 대화 기록, 일기(`DREAMS.md`), 실제 API 키, 토큰이 일절 커밋되지 않습니다.**
* 모든 민감 정보는 로컬 `.env` 파일과 환경변수로 100% 격리됩니다.

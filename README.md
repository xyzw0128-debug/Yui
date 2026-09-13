# 💙 Yui_NanoClaw — Lightweight Carry Layer on Upstream NanoClaw

A clean, modular carry layer for **Yui** personal assistant on top of upstream [NanoClaw](https://github.com/nanocoai/nanoclaw).

Inspired by the minimal carry architecture of [EJClaw](https://github.com/phj1081/EJClaw), this repository maintains zero bloat by carrying only Yui-exclusive components and clean upstream patches instead of vendoring the entire NanoClaw codebase.

---

## 🌟 Key Features

* **Gemini 3.8 Flash Integration**: Seamless multi-key pooling and high-throughput LLM proxy setup.
* **Interactive Discord `/model` Console**: Real-time Discord UI with interactive buttons for switching between Gemini Flash & Flash-Lite models.
* **Smart 429 Quota Failover Watchdog**: Automatic non-degrading rotation across performance Flash models when rate limits occur.
* **Discord Progress Cards**: Rich embed summaries streaming real-time agent execution status.
* **One-Click Automated Setup**: Fast deployment onto clean upstream NanoClaw checkouts.

---

## 🚀 Quick Setup

Deploy Yui onto a fresh environment in three steps:

```bash
git clone https://github.com/xyzw0128-debug/Yui.git
cd Yui
./setup-yui.sh
```

Then configure your credentials in `~/NanoClaw/.env` and launch:

```bash
cd ~/NanoClaw
pnpm build
bash nanoclaw.sh
```

---

## 📂 Repository Structure

```text
Yui/
├── setup-yui.sh                     # One-click installer & patch orchestrator
├── README.md                        # Documentation (English)
├── README_ko.md                     # Documentation (Korean)
├── .env.example                     # Environment template
│
├── patches/
│   └── yui-carry.patch              # Clean upstream diff for routing & container runner
│
├── src/                             # Yui-exclusive source components
│   ├── channels/
│   │   ├── discord-model-console.ts # Interactive Discord model console
│   │   └── discord-model-console.test.ts
│   └── modules/
│       └── progress-card/           # Execution progress card module
│
└── yui/
    ├── instructions.template.md     # Persona & behavioral guidelines template
    └── config/
        └── cliproxyapi.example.yaml # Key pool & model mapping template
```

---

## 🛡️ Security & Privacy

* This repository contains **NO personal diaries, conversation databases, raw API keys, or Discord bot tokens**.
* All state, memories, and secrets are strictly isolated in local `.env` and SQLite stores on the host.

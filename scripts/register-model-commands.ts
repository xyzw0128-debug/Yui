/**
 * Register /model and /boost slash commands on Discord for Antigravity.
 * Registers both at Guild level (instant propagation) and Global level (DMs/all guilds).
 *
 * Usage:
 *   pnpm exec tsx scripts/register-model-commands.ts
 */
import fs from 'fs';
import path from 'path';

// Load .env manually
const envPath = path.resolve(import.meta.dirname || '.', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = '1529437821532635166'; // Yui 디스코드 서버

if (!BOT_TOKEN || !APP_ID) {
  console.error('❌ DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'model',
    description: '🎮 AI 모델 설정 및 Antigravity 프록시 제어 콘솔',
    type: 1, // CHAT_INPUT
    dm_permission: true,
    integration_types: [0, 1], // Guild install, User install
    contexts: [0, 1, 2], // Guild, Bot DM, Private Channel
    options: [
      {
        name: 'mode',
        description: '전환할 모델 모드 (선택 사항)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '🚀 Pro Agent (최고 성능/심층 코딩)', value: 'gemini-pro-agent' },
          { name: '⚡ Gemini 3 Flash (초고속 - 기본 모드)', value: 'gemini-3-flash' },
        ],
      },
    ],
  },
];

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bot ${BOT_TOKEN}`,
};

async function registerCommands() {
  for (const cmd of commands) {
    // 1. Guild command (instant update)
    const guildUrl = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;
    const guildRes = await fetch(guildUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(cmd),
    });

    if (!guildRes.ok) {
      console.error(`❌ Failed to register guild command /${cmd.name}: ${guildRes.status} ${guildRes.statusText}`);
      const errText = await guildRes.text();
      console.error(errText);
    } else {
      const result = await guildRes.json();
      console.log(`✅ 길드 슬래시 명령어 /${cmd.name} 등록 성공 (ID: ${result.id})`);
    }

    // 2. Global command (DMs & global)
    const globalUrl = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
    const globalRes = await fetch(globalUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(cmd),
    });

    if (!globalRes.ok) {
      console.error(`❌ Failed to register global command /${cmd.name}: ${globalRes.status} ${globalRes.statusText}`);
      const errText = await globalRes.text();
      console.error(errText);
    } else {
      const result = await globalRes.json();
      console.log(`✅ 글로벌 슬래시 명령어 /${cmd.name} 등록 성공 (ID: ${result.id})`);
    }
  }
}

await registerCommands();

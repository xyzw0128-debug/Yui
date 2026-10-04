/**
 * Register the /study slash command on Discord as a GUILD command (instant propagation).
 * Also cleans up the previously registered global command.
 *
 * Usage:
 *   pnpm exec tsx scripts/register-study-command.ts
 *
 * Requires DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in .env (already set).
 */
import fs from 'fs';
import path from 'path';

// Load .env manually (no dotenv dependency)
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

const command = {
  name: 'study',
  description: '📚 학습 RAG (강의자료 자동 검색) 켜기/끄기/상태 확인',
  type: 1, // CHAT_INPUT
  dm_permission: true,
  integration_types: [0, 1], // 0: Guild install, 1: User install
  contexts: [0, 1, 2], // 0: Guild, 1: Bot DM, 2: Private Channel
  options: [
    {
      name: 'action',
      description: '수행할 동작',
      type: 3, // STRING
      required: false,
      choices: [
        { name: '🟢 켜기 (on)', value: 'on' },
        { name: '🔴 끄기 (off)', value: 'off' },
        { name: '📊 상태 확인 (status)', value: 'status' },
      ],
    },
  ],
};

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bot ${BOT_TOKEN}`,
};

async function registerGuildCommand() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Failed to register guild command: ${res.status} ${res.statusText}`);
    console.error(body);
    process.exit(1);
  }

  const result = await res.json();
  console.log('✅ /study 슬래시 명령어가 길드에 등록되었습니다! (서버 채널 즉시 반영)');
  console.log(`   Command ID: ${result.id}`);
  console.log(`   Guild ID: ${GUILD_ID}`);
}

async function registerGlobalCommand() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Failed to register global command: ${res.status} ${res.statusText}`);
    console.error(body);
    process.exit(1);
  }

  const result = await res.json();
  console.log('✅ /study 슬래시 명령어가 글로벌(DM 포함)로 등록되었습니다!');
  console.log(`   Command ID: ${result.id}`);
  console.log(`   DM Permission: ${result.dm_permission}`);
  console.log(`   Contexts: ${JSON.stringify(result.contexts)}`);
}

await registerGuildCommand();
await registerGlobalCommand();

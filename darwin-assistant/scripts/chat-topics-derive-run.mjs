#!/usr/bin/env node
// Batch runner for Chat Topics derivation. Invokes the compiled dist functions.
//   --backfill N  topic-ify the N most-recently-active eligible cockpit chats
//   --stale N     (re)derive up to N chats that need it (shouldRederive)
// Model calls go through the subscription claude CLI → MUST run under
// CLAUDE_CONFIG_DIR=/home/kevin/.claude-b (Claude B automation rule).
import { deriveStaleTopics, backfillRecentCockpitChats } from '../dist/chat-topics-derive.js';

const args = process.argv.slice(2);
const mode = args.includes('--backfill') ? 'backfill' : 'stale';
const nIdx = args.findIndex((a) => a === '--backfill' || a === '--stale');
const limit = Number(args[nIdx + 1]) > 0 ? Number(args[nIdx + 1]) : (mode === 'backfill' ? 40 : 15);

const run = mode === 'backfill' ? backfillRecentCockpitChats : deriveStaleTopics;
run(limit)
  .then((r) => { console.log(`[chat-topics-derive] ${mode} limit=${limit} →`, JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error(`[chat-topics-derive] ${mode} failed:`, e?.message ?? e); process.exit(1); });

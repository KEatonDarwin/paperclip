import 'dotenv/config';
import { revokeApiKey, getApiKey } from '../api-keys.js';

function usage(): never {
  console.error('Usage: node dist/scripts/revoke-api-key.js <id>');
  process.exit(1);
}

const [, , idArg] = process.argv;
if (!idArg) usage();
const id = Number(idArg);
if (!Number.isFinite(id)) usage();

const row = getApiKey(id);
if (!row) {
  console.error(`No API key with id=${id}`);
  process.exit(2);
}
if (row.revoked_at) {
  console.log(`API key ${id} (${row.caller_label}) already revoked at ${row.revoked_at}`);
  process.exit(0);
}

const ok = revokeApiKey(id);
if (!ok) {
  console.error(`Failed to revoke API key ${id}`);
  process.exit(3);
}
console.log(`Revoked API key ${id} (${row.caller_label}). Threads scoped to api:${id}:* remain but are no longer accessible.`);

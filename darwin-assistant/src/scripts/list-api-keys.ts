import 'dotenv/config';
import { listApiKeys } from '../api-keys.js';

const rows = listApiKeys();
if (rows.length === 0) {
  console.log('No API keys minted yet.');
  process.exit(0);
}

const header = ['id', 'label', 'scope', 'created_at', 'revoked_at'];
const table = [header, ...rows.map((r) => [
  String(r.id),
  r.caller_label,
  r.scope,
  r.created_at,
  r.revoked_at ?? '—',
])];
const widths = header.map((_, col) => Math.max(...table.map((row) => row[col].length)));
for (const row of table) {
  console.log(row.map((cell, col) => cell.padEnd(widths[col])).join('  '));
}

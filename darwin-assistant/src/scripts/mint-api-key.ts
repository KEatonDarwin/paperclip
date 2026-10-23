import 'dotenv/config';
import { mintApiKey } from '../api-keys.js';

function usage(): never {
  console.error('Usage: node dist/scripts/mint-api-key.js <caller-label> [scope]');
  console.error('  caller-label  Human-readable label for the caller (e.g. "acme-lovable-app").');
  console.error('  scope         Optional scope (default: "jarvis").');
  process.exit(1);
}

const [, , label, scope] = process.argv;
if (!label) usage();

const { id, plaintext } = mintApiKey(label, scope ?? 'jarvis');
console.log('');
console.log('  API key minted.');
console.log('  ---------------');
console.log(`  id:            ${id}`);
console.log(`  caller_label:  ${label}`);
console.log(`  scope:         ${scope ?? 'jarvis'}`);
console.log('');
console.log('  Plaintext key (shown ONCE — capture it now):');
console.log('');
console.log(`      ${plaintext}`);
console.log('');
console.log('  Threads created with this key will have external_id shape:');
console.log(`      api:${id}:<uuid>`);
console.log('');

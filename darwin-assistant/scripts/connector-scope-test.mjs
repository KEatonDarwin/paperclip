import assert from 'node:assert/strict';
import {
  connectorServerEntries,
  parseStoredConnectorAllowlist,
  validateConnectorAllowlist,
} from '../dist/connector-scope.js';

assert.deepEqual(validateConnectorAllowlist([]), []);
assert.deepEqual(validateConnectorAllowlist(['smarty-pants', 'smarty-pants']), ['smarty-pants']);
assert.equal(validateConnectorAllowlist(null), null);
assert.throws(() => validateConnectorAllowlist(['lovable']), /one of smarty-pants/);
assert.deepEqual(parseStoredConnectorAllowlist('["smarty-pants"]'), ['smarty-pants']);
assert.deepEqual(parseStoredConnectorAllowlist('broken'), []);
assert.equal(parseStoredConnectorAllowlist(null), null);
assert.deepEqual(connectorServerEntries([]), {});
assert.deepEqual(connectorServerEntries(['smarty-pants']), {
  'smarty-pants': { type: 'http', url: 'https://mcp.thedarwinhub.com/mcp/kevin-connected' },
});

console.log('connector-scope: 9 checks passed');

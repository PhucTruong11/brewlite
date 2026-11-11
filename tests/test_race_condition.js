// Demo race condition chạy trong DB test, không ghi đè kho của cửa hàng local.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const backend = path.resolve(__dirname, '../backend');
console.log('Test hai khách tranh ly cuối và hủy/trả kho trong brewlite_test.');
const result = spawnSync(process.execPath, [
  path.join(backend, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', 'vitest.config.e2e.ts', 'test/cart-checkout.e2e-spec.ts',
], {
  cwd: backend, stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://brewlite:brewlite@localhost:5433/brewlite_test', E2E_DATABASE: '1', JWT_SECRET: 'race-test-only' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

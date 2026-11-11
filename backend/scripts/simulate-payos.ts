// Test webhook được cô lập: không tạo đơn RESERVED giả trong DB cửa hàng,
// không dùng khóa PayOS thật, không gửi webhook vào API đang phục vụ người dùng.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backend = fileURLToPath(new URL('..', import.meta.url));
console.log('Kiểm thử PayOS: đúng/thiếu tiền, chữ ký sai và webhook lặp trong brewlite_test.');
const result = spawnSync(process.execPath, [
  path.join(backend, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', 'vitest.config.e2e.ts',
  'test/rewards-checkout.e2e-spec.ts', 'test/order-compensation.e2e-spec.ts',
], {
  cwd: backend, stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://brewlite:brewlite@localhost:5433/brewlite_test', E2E_DATABASE: '1', JWT_SECRET: 'payos-test-only' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

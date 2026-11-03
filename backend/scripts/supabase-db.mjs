import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { PrismaClient } from '@prisma/client';

// Keep the cloud database configuration separate from the local backend/.env.
const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'status';
let client;
let sensitiveValues = [];
const redact = (value) => {
  let result = String(value ?? '').replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    '[DATABASE_URL REDACTED]',
  );
  for (const secret of sensitiveValues.filter(Boolean)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
};

try {
  if (!['status', 'migrate', 'secure', 'psql-status'].includes(mode)) {
    throw new Error(
      'Use: node scripts/supabase-db.mjs [status|migrate|secure|psql-status]',
    );
  }
  const config = parseEnv(
    readFileSync(resolve(root, '.env.production'), 'utf8'),
  );
  if (!config.DATABASE_URL?.trim()) {
    throw new Error(
      'backend/.env.production still has an empty DATABASE_URL. Save the connection string before retrying.',
    );
  }
  const target = new URL(config.DATABASE_URL);
  sensitiveValues = [
    config.DATABASE_URL,
    target.password,
    decodeURIComponent(target.password),
  ];
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !target.hostname.endsWith('.pooler.supabase.com') ||
    target.port !== '5432' ||
    target.searchParams.get('sslmode') !== 'require' ||
    !target.password ||
    /YOUR-PASSWORD|\[|\]/i.test(decodeURIComponent(target.password))
  ) {
    throw new Error(
      'Expected a Supabase Session pooler URI on port 5432 with a password and sslmode=require.',
    );
  }

  await lookup(target.hostname);
  await new Promise((resolveConnection, reject) => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    socket.setTimeout(10_000);
    socket.once('connect', () => {
      socket.destroy();
      resolveConnection();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Supabase TCP connection timed out.'));
    });
    socket.once('error', reject);
  });
  console.log(JSON.stringify({ dnsResolved: true, tcpConnected: true }));

  if (mode === 'psql-status') {
    const result = spawnSync(
      process.env.PSQL_PATH ?? 'psql',
      [
        '-X',
        '--no-password',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        "SELECT current_database(), current_setting('server_version'); SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PGHOST: target.hostname,
          PGPORT: target.port,
          PGDATABASE: decodeURIComponent(target.pathname.slice(1)),
          PGUSER: decodeURIComponent(target.username),
          PGPASSWORD: decodeURIComponent(target.password),
          PGSSLMODE: 'require',
          PGCONNECT_TIMEOUT: '15',
        },
        encoding: 'utf8',
        timeout: 45_000,
      },
    );
    if (result.stdout) console.log(redact(result.stdout));
    if (result.stderr) console.error(redact(result.stderr));
    if (result.error || result.status !== 0)
      throw new Error('PostgreSQL native connection check failed.');
  } else {
    client = new PrismaClient({
      datasources: { db: { url: config.DATABASE_URL } },
      log: [],
    });
    await client.$connect();
    const tables = await client.$queryRawUnsafe(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const hasHistory = tables.some(
      (row) => row.tablename === '_prisma_migrations',
    );
    const migrations = hasHistory
      ? await client.$queryRawUnsafe(
          'SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY started_at',
        )
      : [];
    const access = await client.$queryRawUnsafe(
      "SELECT tablename, rowsecurity, has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'SELECT') AS anon_select, has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'INSERT') AS anon_insert, has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'SELECT') AS authenticated_select FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    console.log(
      JSON.stringify(
        {
          connected: true,
          target: 'Supabase Session pooler',
          tables: tables.map((row) => row.tablename),
          migrations,
          allTablesProtected:
            access.length > 0 &&
            access.every(
              (row) =>
                row.rowsecurity &&
                !row.anon_select &&
                !row.anon_insert &&
                !row.authenticated_select,
            ),
          access,
        },
        null,
        2,
      ),
    );

    if (mode === 'secure') {
      const appTables = [
        '_prisma_migrations',
        'email_verifications',
        'ingredients',
        'order_items',
        'orders',
        'password_resets',
        'payments',
        'point_transactions',
        'product_prices',
        'products',
        'promotions',
        'recipes',
        'reward_items',
        'toppings',
        'user_vouchers',
        'users',
      ];
      if (
        tables.length !== appTables.length ||
        tables.some((row) => !appTables.includes(row.tablename))
      ) {
        throw new Error(
          'Unexpected public schema: assess table ownership before applying BrewLite access restrictions.',
        );
      }
      await client.$transaction(
        async (tx) => {
          // Identifiers come only from the fixed BrewLite table list above.
          for (const table of appTables) {
            await tx.$executeRawUnsafe(
              'ALTER TABLE public."' + table + '" ENABLE ROW LEVEL SECURITY',
            );
            await tx.$executeRawUnsafe(
              'REVOKE ALL PRIVILEGES ON TABLE public."' +
                table +
                '" FROM PUBLIC, anon, authenticated',
            );
          }
          await tx.$executeRawUnsafe(
            'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
          );
        },
        { timeout: 60_000 },
      );
      console.log(
        JSON.stringify({
          accessRestricted: true,
          tablesProtected: appTables.length,
        }),
      );
      console.log(
        JSON.stringify({
          backendReadVerified: true,
          counts: {
            users: await client.user.count(),
            products: await client.product.count(),
            orders: await client.order.count(),
            ingredients: await client.ingredient.count(),
          },
        }),
      );
    }

    if (mode === 'migrate') {
      if (tables.length && !hasHistory) {
        throw new Error(
          'Existing public tables without Prisma migration history: stop and assess before migrating.',
        );
      }
      if (
        migrations.some(
          (migration) => !migration.finished && !migration.rolled_back,
        )
      ) {
        throw new Error(
          'Unresolved failed migration: stop and assess before migrating.',
        );
      }
      await client.$disconnect();
      client = undefined;
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: config.DATABASE_URL },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );
      // Redact connection URLs and passwords from child process diagnostics.
      if (result.stdout) console.log(redact(result.stdout));
      if (result.stderr) console.error(redact(result.stderr));
      if (result.error || result.status !== 0) {
        throw new Error('Prisma migrate deploy did not complete successfully.');
      }
    }
  }
} catch (error) {
  // Prisma errors can include connection details; expose only error codes.
  console.error(
    JSON.stringify({
      ok: false,
      code: error?.errorCode ?? error?.code ?? error?.name ?? 'UNKNOWN',
      message: redact(error?.message ?? 'Database check failed.'),
    }),
  );
  process.exitCode = 1;
} finally {
  if (client) await client.$disconnect();
}

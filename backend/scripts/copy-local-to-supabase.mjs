import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'inspect';
const binOption = process.argv.indexOf('--pg-bin');
const pgBin = binOption >= 0 ? process.argv[binOption + 1] : process.env.PG_BIN;
const tables = [
  'users',
  'email_verifications',
  'products',
  'product_prices',
  'toppings',
  'ingredients',
  'recipes',
  'orders',
  'order_items',
  'payments',
  'promotions',
  'password_resets',
  'reward_items',
  'user_vouchers',
  'point_transactions',
];
const expectedTables = [...tables, '_prisma_migrations'].sort();
const credentials = [];
const clients = [];
const quote = (name) => 'public."' + name + '"';
const clean = (text) => {
  let output = String(text ?? '').replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    '[DATABASE_URL REDACTED]',
  );
  for (const value of credentials.filter(Boolean))
    output = output.split(value).join('[REDACTED]');
  return output;
};

function configuration(file, cloud) {
  const config = parseEnv(readFileSync(join(root, file), 'utf8'));
  const url = new URL(config.DATABASE_URL);
  credentials.push(
    config.DATABASE_URL,
    url.password,
    decodeURIComponent(url.password),
  );
  const valid = cloud
    ? url.hostname.endsWith('.pooler.supabase.com') &&
      url.port === '5432' &&
      url.searchParams.get('sslmode') === 'require'
    : ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === '5433' &&
      url.pathname === '/brewlite';
  if (!valid || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(
      'Unexpected ' +
        (cloud ? 'Supabase' : 'local Docker') +
        ' database target.',
    );
  }
  const client = new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
    log: [],
  });
  clients.push(client);
  return { url, client, cloud };
}

const fingerprintSql = (table) =>
  "SELECT '" +
  table +
  "' AS table_name, count(*)::text AS row_count, " +
  "md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '')) AS digest FROM " +
  quote(table) +
  ' AS t';

async function fingerprints(tx) {
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  return tx.$queryRawUnsafe(tables.map(fingerprintSql).join(' UNION ALL '));
}

async function inspect(database) {
  return database.client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const version = await tx.$queryRawUnsafe(
        "SELECT current_setting('server_version') AS version",
      );
      const names = await tx.$queryRawUnsafe(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      if (
        JSON.stringify(names.map((row) => row.tablename)) !==
        JSON.stringify(expectedTables)
      ) {
        throw new Error(
          'Expected exactly the 16 BrewLite public tables on each database.',
        );
      }
      const columns = await tx.$queryRawUnsafe(
        "SELECT table_name, column_name, udt_schema, udt_name, is_nullable, column_default, numeric_precision, numeric_scale, datetime_precision, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name",
      );
      const enums = await tx.$queryRawUnsafe(
        "SELECT t.typname, e.enumlabel, e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder",
      );
      const constraints = await tx.$queryRawUnsafe(
        "SELECT c.relname AS table_name, p.conname, p.contype::text AS constraint_type, pg_get_constraintdef(p.oid, true) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY c.relname, p.conname",
      );
      const migrations = await tx.$queryRawUnsafe(
        'SELECT migration_name, checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      );
      const access = database.cloud
        ? await tx.$queryRawUnsafe(
            "SELECT tablename, rowsecurity, has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_access, has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS authenticated_access FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
          )
        : [];
      return {
        version: version[0].version,
        columns,
        enums,
        constraints,
        migrations,
        access,
        rows: await fingerprints(tx),
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
}

function environment(url, readOnly) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
    PGCONNECT_TIMEOUT: '15',
    PGOPTIONS: readOnly
      ? '-c default_transaction_read_only=on'
      : '-c application_name=brewlite_data_migration',
  };
}

function run(name, args, env, directory) {
  const executable = pgBin
    ? join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''))
    : name;
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const log = join(directory, name + '.log');
  writeFileSync(log, clean((result.stdout ?? '') + (result.stderr ?? '')));
  if (result.error || result.status !== 0)
    throw new Error(name + ' failed; see ' + relative(root, log));
  return result.stdout ?? '';
}

function compare(source, target) {
  for (const field of ['columns', 'enums', 'constraints']) {
    if (JSON.stringify(source[field]) !== JSON.stringify(target[field])) {
      if (field === 'columns') {
        const key = (row) => row.table_name + '.' + row.column_name;
        const localColumns = new Map(
          source.columns.map((row) => [key(row), row]),
        );
        const cloudColumns = new Map(
          target.columns.map((row) => [key(row), row]),
        );
        console.log(
          JSON.stringify(
            {
              columnDifferences: [
                ...new Set([...localColumns.keys(), ...cloudColumns.keys()]),
              ]
                .filter(
                  (name) =>
                    JSON.stringify(localColumns.get(name)) !==
                    JSON.stringify(cloudColumns.get(name)),
                )
                .map((name) => ({
                  column: name,
                  local: localColumns.get(name),
                  cloud: cloudColumns.get(name),
                })),
            },
            null,
            2,
          ),
        );
      }
      if (field === 'constraints')
        console.log(
          JSON.stringify(
            {
              constraintDifferences: {
                local: source.constraints,
                cloud: target.constraints,
              },
            },
            null,
            2,
          ),
        );
      throw new Error(
        'Source and target differ in ' + field + '; no data imported.',
      );
    }
  }
  const migrationNames = (database) =>
    database.migrations.map((row) => row.migration_name);
  if (
    JSON.stringify(migrationNames(source)) !==
    JSON.stringify(migrationNames(target))
  ) {
    throw new Error(
      'Applied migration names differ; assess database versions before copying.',
    );
  }
  for (const migration of target.migrations) {
    const expected = createHash('sha256')
      .update(
        readFileSync(
          join(
            root,
            'prisma',
            'migrations',
            migration.migration_name,
            'migration.sql',
          ),
        ),
      )
      .digest('hex');
    if (migration.checksum !== expected)
      throw new Error(
        'Supabase migration checksum differs from the repository.',
      );
  }
  if (
    !target.access.every(
      (row) => row.rowsecurity && !row.anon_access && !row.authenticated_access,
    )
  ) {
    throw new Error(
      'Supabase table access must be restricted before importing user data.',
    );
  }
}

try {
  if (!['inspect', 'copy'].includes(mode))
    throw new Error(
      'Use: node scripts/copy-local-to-supabase.mjs [inspect|copy] [--pg-bin PATH]',
    );
  const source = configuration('.env', false);
  const target = configuration('.env.production', true);
  await Promise.all(clients.map((client) => client.$connect()));
  // Read-only independent inspections use their own repeatable-read transactions.
  const [local, cloud] = await Promise.all([inspect(source), inspect(target)]);
  compare(local, cloud);
  console.log(
    JSON.stringify(
      {
        schemaMatches: true,
        sourceVersion: local.version,
        targetVersion: cloud.version,
        targetProtected: true,
        localMigrationChecksumsDiffer:
          JSON.stringify(local.migrations) !== JSON.stringify(cloud.migrations),
        counts: local.rows.map((row, index) => ({
          table: row.table_name,
          local: Number(row.row_count),
          cloud: Number(cloud.rows[index].row_count),
        })),
      },
      null,
      2,
    ),
  );

  if (mode === 'copy') {
    if (cloud.rows.some((row) => row.row_count !== '0'))
      throw new Error(
        'Supabase already contains application data; refusing to overwrite it.',
      );
    if (!local.rows.some((row) => row.row_count !== '0'))
      throw new Error('Local database has no application data to copy.');
    const backupRoot = join(root, '.backups');
    if (!existsSync(join(backupRoot, '.gitignore')))
      throw new Error('Backup directory must be excluded from Git first.');
    const directory = join(
      backupRoot,
      'supabase-' + new Date().toISOString().replace(/[:.]/g, '-'),
    );
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, 'local-public.dump');
    const restoreFile = join(directory, 'application-data.sql');
    const guardFile = join(directory, 'guard.sql');
    const verifyFile = join(directory, 'verify.sql');
    let snapshotRows;

    await source.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const exported = await tx.$queryRawUnsafe(
          'SELECT pg_export_snapshot() AS snapshot',
        );
        snapshotRows = await fingerprints(tx);
        run(
          'pg_dump',
          [
            '--no-password',
            '--format=custom',
            '--schema=public',
            '--snapshot=' + exported[0].snapshot,
            '--file=' + archive,
          ],
          environment(source.url, true),
          directory,
        );
      },
      { isolationLevel: 'RepeatableRead', timeout: 300_000 },
    );

    const manifest = {
      capturedAt: new Date().toISOString(),
      source: 'local Docker PostgreSQL brewlite',
      target: 'Supabase BrewLite',
      archiveSha256: createHash('sha256')
        .update(readFileSync(archive))
        .digest('hex'),
      rows: snapshotRows,
      imported: false,
    };
    const manifestFile = join(directory, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(
      JSON.stringify({
        backupCreated: relative(root, archive),
        snapshotRows: snapshotRows.reduce(
          (sum, row) => sum + Number(row.row_count),
          0,
        ),
      }),
    );

    // A full archive normally restores data before creating foreign keys.
    // Our target already has its constraints: explicitly order TABLE DATA entries.
    const importOrder = [
      'users',
      'products',
      'product_prices',
      'toppings',
      'ingredients',
      'recipes',
      'promotions',
      'reward_items',
      'orders',
      'order_items',
      'payments',
      'user_vouchers',
      'point_transactions',
      'email_verifications',
      'password_resets',
    ];
    const archiveList = run(
      'pg_restore',
      ['--list', archive],
      process.env,
      directory,
    );
    const dataEntries = new Map();
    for (const line of archiveList.split(/\r?\n/)) {
      const match = line.match(/^\d+;\s+\d+\s+\d+\s+TABLE DATA public (\S+) /);
      if (match && tables.includes(match[1])) dataEntries.set(match[1], line);
    }
    if (dataEntries.size !== tables.length)
      throw new Error('Backup does not contain all 15 application tables.');
    const listFile = join(directory, 'application-data.list');
    writeFileSync(
      listFile,
      importOrder.map((table) => dataEntries.get(table)).join('\n') + '\n',
    );
    run(
      'pg_restore',
      [
        '--data-only',
        '--no-owner',
        '--no-privileges',
        '--use-list=' + listFile,
        '--file=' + restoreFile,
        archive,
      ],
      process.env,
      directory,
    );
    // All target checks, COPY statements and content verification share one transaction.
    writeFileSync(
      guardFile,
      "SET LOCAL lock_timeout = '10s';\nLOCK TABLE " +
        tables.map(quote).join(', ') +
        ' IN ACCESS EXCLUSIVE MODE;\nDO $guard$ BEGIN\n' +
        tables
          .map(
            (table) =>
              'IF EXISTS (SELECT 1 FROM ' +
              quote(table) +
              ") THEN RAISE EXCEPTION 'Target table " +
              table +
              " is not empty'; END IF;",
          )
          .join('\n') +
        '\nEND $guard$;\n',
    );
    writeFileSync(
      verifyFile,
      "SET LOCAL TIME ZONE 'UTC';\nDO $verify$ DECLARE actual_count text; actual_digest text; BEGIN\n" +
        snapshotRows
          .map(
            (row) =>
              'SELECT row_count, digest INTO actual_count, actual_digest FROM (' +
              fingerprintSql(row.table_name) +
              ') AS check_rows;\n' +
              "IF actual_count <> '" +
              row.row_count +
              "' OR actual_digest <> '" +
              row.digest +
              "' THEN RAISE EXCEPTION 'Snapshot verification failed for " +
              row.table_name +
              "'; END IF;",
          )
          .join('\n') +
        '\nEND $verify$;\n',
    );
    run(
      'psql',
      [
        '-X',
        '--no-password',
        '--single-transaction',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=sqlstate',
        '-f',
        guardFile,
        '-f',
        restoreFile,
        '-f',
        verifyFile,
      ],
      environment(target.url, false),
      directory,
    );
    manifest.imported = true;
    manifest.importedAt = new Date().toISOString();
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const after = await inspect(target);
    compare(local, after);
    const contentMatches = snapshotRows.every(
      (row, index) =>
        row.row_count === after.rows[index].row_count &&
        row.digest === after.rows[index].digest,
    );
    if (!contentMatches)
      throw new Error(
        'Import committed, but post-import content changed; inspect the saved manifest before retrying.',
      );
    console.log(
      JSON.stringify(
        {
          imported: true,
          all15TablesMatchSnapshot: true,
          targetProtected: true,
          backupDirectory: relative(root, directory),
          counts: after.rows.map((row) => ({
            table: row.table_name,
            rows: Number(row.row_count),
          })),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      code: error?.errorCode ?? error?.code ?? error?.name,
      message: clean(error?.message),
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map((client) => client.$disconnect()));
}

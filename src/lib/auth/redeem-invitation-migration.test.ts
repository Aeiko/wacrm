import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name), 'utf8'),
  }));

// Terminal gate receipts are not domain data; a deletion trigger protects unresolved work.
const tablesWithDeletionGuards = new Set(['connection_operations']);

const tablesWithoutDomainData = new Set([
  'profiles',
  'account_invitations',
  'member_presence',
  'pending_message_statuses',
]);

function accountScopedTables(): Set<string> {
  const tables = new Set<string>();

  const accountForeignKey =
    /\baccount_id\s+uuid\b[^,;]*references\s+(?:public\.)?accounts\s*\(\s*id\s*\)/i;

  const tableName =
    /(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table)\s+(?:public\.)?(\w+)/i;

  for (const { sql } of migrations) {
    for (const statement of sql.split(';')) {
      if (!accountForeignKey.test(statement)) continue;
      const match = statement.match(tableName);

      if (match) tables.add(match[1].toLowerCase());
    }
  }

  return tables;
}

function latestFunctionBody(functionName: string): string {
  const header = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${functionName}\\s*\\(`,
    'i'
  );

  const latest = migrations.filter(({ sql }) => header.test(sql)).at(-1);

  if (!latest)
    throw new Error(`${functionName} is not defined in any migration`);
  const start = latest.sql.search(header);
  const bodyStart = latest.sql.indexOf('$$', start);
  const bodyEnd = latest.sql.indexOf('$$', bodyStart + 2);

  return latest.sql.slice(bodyStart + 2, bodyEnd);
}

describe('redeem_invitation migration', () => {
  const body = latestFunctionBody('redeem_invitation');

  it('finds the account-scoped tables it is meant to guard', () => {
    const tables = accountScopedTables();
    expect(tables).toContain('contacts');
    expect(tables).toContain('api_keys');
    expect(tables).toContain('quick_replies');
  });

  it('checks every account-scoped table for data before deleting the old account', () => {
    const missing = [...accountScopedTables()]
      .filter(
        (table) =>
          !tablesWithoutDomainData.has(table) &&
          !tablesWithDeletionGuards.has(table)
      )
      .filter(
        (table) =>
          !new RegExp(
            `from\\s+${table}\\s+where\\s+account_id\\s*=\\s*v_old_account_id`,
            'i'
          ).test(body)
      );

    expect(missing).toEqual([]);
  });

  it('protects unresolved connection operations through the account deletion trigger', () => {
    const guard = latestFunctionBody('connection_account_write_guard');
    expect(guard).toMatch(
      /from\s+connection_operations\s+where\s+account_id\s*=\s*OLD\.id\s+and\s+state\s+in\s*\(\s*'reserved'\s*,\s*'active'\s*,\s*'blocked'\s*\)/i
    );
    expect(guard).toContain(
      "RAISE EXCEPTION 'connection_operation_outstanding'"
    );
    expect(migrations.map(({ sql }) => sql).join('\n')).toMatch(
      /create\s+trigger\s+connection_account_delete_guard\s+before\s+delete\s+on\s+public\.accounts\s+for\s+each\s+row\s+execute\s+function\s+public\.connection_account_write_guard\(\)/i
    );
  });

  it('refuses when the old account has other members', () => {
    expect(body).toMatch(
      /from\s+profiles\s+where\s+account_id\s*=\s*v_old_account_id\s+and\s+user_id\s*<>\s*v_caller_id/i
    );
  });
});

describe('member RPC migrations', () => {
  it.each([
    'set_member_role',
    'remove_account_member',
    'transfer_account_ownership',
  ])(
    '%s locks the caller and target profiles in user_id order',
    (functionName) => {
      expect(latestFunctionBody(functionName)).toMatch(
        /from\s+profiles\s+where\s+user_id\s+in\s*\(\s*auth\.uid\(\),\s*p_\w+\s*\)\s+order\s+by\s+user_id\s+for\s+update/i
      );
    }
  );
});

import { Pool } from "pg";
import { PostgresFinancialMarketStateStore, type SqlClient } from "../apps/financial-market/src/infrastructure/postgres-state-store";
import { PostgresFinancialRevisionStore } from "../apps/financial-market/src/infrastructure/postgres-revision-store";
import { PostgresSocialStateStore, type SqlQueryClient } from "../apps/social-environment/src/infrastructure/postgres-state-store";

void main();

async function main(): Promise<void> {
  const financialUrl = required("OPENLEEK_VALIDATION_FINANCIAL_DATABASE_URL");
  const socialUrl = required("OPENLEEK_VALIDATION_SOCIAL_DATABASE_URL");
  const financialPool = new Pool({ connectionString: financialUrl, max: 4 });
  const socialPool = new Pool({ connectionString: socialUrl, max: 4 });
  try {
  const financialClient = sqlClient(financialPool);
  const marketStore = new PostgresFinancialMarketStateStore(financialClient, 0);
  const revisionStore = new PostgresFinancialRevisionStore(financialClient, 16 * 1024 * 1024);
  await marketStore.migrate();
  await revisionStore.migrate();
  const market = await marketStore.load();
  const financialRevisions = await revisionStore.load();

  const socialStore = new PostgresSocialStateStore(sqlClient(socialPool), 16 * 1024 * 1024);
  await socialStore.initialise();
  const social = await socialStore.load();
  const coldFinancialRef = firstColdRevision(financialRevisions?.runs ?? {});
  const coldSocialRef = firstColdRevision(social?.runs ?? {});
  const [coldFinancial, coldSocial] = await Promise.all([
    coldFinancialRef === undefined ? undefined : revisionStore.loadRevision(coldFinancialRef),
    coldSocialRef === undefined ? undefined : socialStore.loadRevision(coldSocialRef),
  ]);

  const report = {
    financial: {
      runs: market?.runs.length ?? 0,
      sealHeaders: market?.runs.reduce((total, run) => total + run.sealed.length, 0) ?? 0,
      residentSealBodies: market?.runs.reduce(
        (total, run) => total + run.sealed.filter((seal) => seal.material !== undefined).length,
        0,
      ) ?? 0,
      revisionHeaders: Object.values(financialRevisions?.runs ?? {})
        .reduce((total, run) => total + Object.keys(run.revisions).length, 0),
      residentRevisionBodies: Object.values(financialRevisions?.runs ?? {})
        .reduce((total, run) => total + Object.values(run.revisions).filter((revision) => revision.snapshot !== undefined).length, 0),
      residentWorkspaces: Object.values(financialRevisions?.runs ?? {})
        .reduce((total, run) => total + Object.keys(run.roundWorkspaces).length, 0),
      historicalReadResolved: coldFinancialRef === undefined || coldFinancial?.ref === coldFinancialRef,
    },
    social: {
      runs: Object.keys(social?.runs ?? {}).length,
      revisionHeaders: Object.values(social?.runs ?? {})
        .reduce((total, run) => total + Object.keys(run.revisions).length, 0),
      residentRevisionBodies: Object.values(social?.runs ?? {})
        .reduce((total, run) => total + Object.values(run.revisions).filter((revision) => revision.snapshot !== undefined).length, 0),
      residentWorkspaces: Object.values(social?.runs ?? {})
        .reduce((total, run) => total + Object.keys(run.roundWorkspaces).length, 0),
      historicalReadResolved: coldSocialRef === undefined || coldSocial?.ref === coldSocialRef,
    },
    memoryMiB: {
      rss: toMiB(process.memoryUsage().rss),
      heapUsed: toMiB(process.memoryUsage().heapUsed),
    },
  };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await Promise.all([financialPool.end(), socialPool.end()]);
  }
}

function sqlClient(pool: Pool): SqlClient & SqlQueryClient {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await pool.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Row[] };
    },
    async transaction<T>(operation: (client: SqlClient & SqlQueryClient) => Promise<T>) {
      const connection = await pool.connect();
      const client = {
        async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const result = await connection.query(text, values as unknown[] | undefined);
          return { rows: result.rows as Row[] };
        },
        async transaction<Nested>(nested: (nestedClient: SqlClient & SqlQueryClient) => Promise<Nested>) {
          return nested(client);
        },
      } satisfies SqlClient & SqlQueryClient;
      try {
        await connection.query("BEGIN");
        const result = await operation(client);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function toMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function firstColdRevision(
  runs: Record<string, { revisions: Record<string, { snapshot?: unknown }> }>,
): string | undefined {
  for (const run of Object.values(runs)) {
    for (const [revisionRef, revision] of Object.entries(run.revisions)) {
      if (revision.snapshot === undefined) return revisionRef;
    }
  }
  return undefined;
}

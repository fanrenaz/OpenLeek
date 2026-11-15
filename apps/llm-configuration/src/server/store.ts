import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { graphFor, normalizeConfig, parseFullConfig, revisionFor, type FullConfig } from "./model";

export interface ConfigSnapshot {
  revision: string;
  config: FullConfig;
  createdAt: string;
}

export interface ConfigStore {
  migrate(): Promise<void>;
  current(): Promise<ConfigSnapshot | undefined>;
  get(revision: string): Promise<ConfigSnapshot | undefined>;
  commit(config: FullConfig, expectedRevision?: string): Promise<{ snapshot: ConfigSnapshot; committed: boolean }>;
}

export class InMemoryConfigStore implements ConfigStore {
  private readonly snapshots = new Map<string, ConfigSnapshot>();
  private currentRevision?: string;

  async migrate() {}

  async current() {
    return this.currentRevision ? structuredClone(this.snapshots.get(this.currentRevision)) : undefined;
  }

  async get(revision: string) {
    return structuredClone(this.snapshots.get(revision));
  }

  async commit(config: FullConfig, expectedRevision?: string) {
    if (expectedRevision !== undefined && this.currentRevision !== expectedRevision) {
      const current = await this.current();
      if (!current) throw new Error("configuration has not been initialized");
      return { snapshot: current, committed: false };
    }
    const normalized = normalizeConfig(parseFullConfig(config));
    const revision = revisionFor(normalized);
    const snapshot = this.snapshots.get(revision) ?? {
      revision,
      config: normalized,
      createdAt: new Date().toISOString(),
    };
    this.snapshots.set(revision, snapshot);
    this.currentRevision = revision;
    return { snapshot: structuredClone(snapshot), committed: true };
  }
}

export class PostgresConfigStore implements ConfigStore {
  constructor(private readonly pool: Pool, private readonly encryption: SnapshotEncryption) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS llm_config_revisions (
        revision text PRIMARY KEY,
        encrypted_payload text NOT NULL,
        redacted_graph jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS llm_config_current (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        revision text NOT NULL REFERENCES llm_config_revisions(revision),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON llm_config_revisions, llm_config_current FROM PUBLIC;
    `);
  }

  async current() {
    const result = await this.pool.query<SnapshotRow>(`
      SELECT r.revision, r.encrypted_payload, r.created_at::text
      FROM llm_config_current c
      JOIN llm_config_revisions r ON r.revision = c.revision
      WHERE c.singleton = true
    `);
    return result.rows[0] ? this.decode(result.rows[0]) : undefined;
  }

  async get(revision: string) {
    const result = await this.pool.query<SnapshotRow>(
      "SELECT revision, encrypted_payload, created_at::text FROM llm_config_revisions WHERE revision = $1",
      [revision],
    );
    return result.rows[0] ? this.decode(result.rows[0]) : undefined;
  }

  async commit(config: FullConfig, expectedRevision?: string) {
    const normalized = normalizeConfig(parseFullConfig(config));
    const revision = revisionFor(normalized);
    const encrypted = this.encryption.encrypt(JSON.stringify(normalized));
    const redacted = graphFor(normalized, revision);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('openleek.llm-configuration.current'))");
      const currentResult = await client.query<{ revision: string }>("SELECT revision FROM llm_config_current WHERE singleton = true FOR UPDATE");
      const currentRevision = currentResult.rows[0]?.revision;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        await client.query("ROLLBACK");
        const current = await this.current();
        if (!current) throw new Error("configuration has not been initialized");
        return { snapshot: current, committed: false };
      }
      await client.query(
        `INSERT INTO llm_config_revisions(revision, encrypted_payload, redacted_graph)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (revision) DO NOTHING`,
        [revision, encrypted, JSON.stringify(redacted)],
      );
      await client.query(
        `INSERT INTO llm_config_current(singleton, revision)
         VALUES (true, $1)
         ON CONFLICT (singleton) DO UPDATE SET revision = EXCLUDED.revision, updated_at = now()`,
        [revision],
      );
      await client.query("COMMIT");
      const snapshot = await this.get(revision);
      if (!snapshot) throw new Error("committed configuration snapshot is missing");
      return { snapshot, committed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private decode(row: SnapshotRow): ConfigSnapshot {
    return {
      revision: row.revision,
      config: parseFullConfig(JSON.parse(this.encryption.decrypt(row.encrypted_payload))),
      createdAt: row.created_at,
    };
  }
}

interface SnapshotRow {
  revision: string;
  encrypted_payload: string;
  created_at: string;
}

export class SnapshotEncryption {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("LLM configuration encryption key must decode to exactly 32 bytes");
  }

  static from(value: string) {
    const trimmed = value.trim();
    const decoded = /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
    return new SnapshotEncryption(decoded);
  }

  encrypt(plaintext: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(envelope: string) {
    const [version, nonceValue, tagValue, ciphertextValue] = envelope.split(".");
    if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) throw new Error("invalid encrypted LLM configuration envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
  }
}

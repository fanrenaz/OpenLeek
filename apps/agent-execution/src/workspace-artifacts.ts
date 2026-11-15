import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";

import { sha256 } from "./canonical";
import {
  instructionPolicyDigest,
  OPENLEEK_BASE_INSTRUCTIONS,
  OPENLEEK_CONTEXT_COMPACTION_POLICY,
  OPENLEEK_INSTRUCTION_POLICY_VERSION,
  renderOpenLeekEnvironmentContext,
} from "./runtime-instructions";
import type { AgentIdentity, CodexRuntimeProfile, ContextCompactionPolicy, ContextMcpConnection, StaticArtifact, ToolCallBudget } from "./types";

export interface WorkspaceArtifactOptions {
  /** Agent Execution's locally mounted directory for materialized workspaces. */
  readonly workspaceRoot?: string;
  /** Directory mounted at the same run-hash structure inside each sandbox. */
  readonly sandboxRunsRoot?: string;
  /** Docker-host directory used only when creating/removing a sandbox bind mount. */
  readonly sandboxHostRunsRoot?: string;
  readonly sandboxMode?: "workspace-write" | "danger-full-access";
}

/**
 * Generates the only static material supplied to an agent. Dynamic market,
 * portfolio, and social data deliberately have no representation here.
 */
export class WorkspaceArtifacts {
  private readonly workspaceRoot: string | undefined;
  private readonly sandboxRunsRoot: string | undefined;
  private readonly sandboxHostRunsRoot: string | undefined;
  private readonly sandboxMode: "workspace-write" | "danger-full-access";

  constructor(options: WorkspaceArtifactOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.sandboxRunsRoot = options.sandboxRunsRoot;
    this.sandboxHostRunsRoot = options.sandboxHostRunsRoot;
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
  }

  async create(input: {
    runId: string;
    agent: AgentIdentity;
    /** A published AGENTS.md artifact. This text is never rendered or patched by core. */
    agentsMd: string;
    profile: CodexRuntimeProfile;
    mcpConnections: readonly ContextMcpConnection[];
    toolCallBudget?: ToolCallBudget;
  }): Promise<StaticArtifact> {
    const skills = input.agent.skills.map((skill) => structuredClone(skill));
    const conditionDigest = sha256({
      agentsMdDigest: input.agent.agentsMdDigest,
      skills: skills.map(({ versionRef, artifactDigest, skillName }) => ({ versionRef, artifactDigest, skillName })),
    });
    const workspacePath = this.path(input.runId, input.agent.agentId);
    const sandboxWorkspacePath = this.sandboxPath(input.runId, input.agent.agentId);
    const agentsMd = input.agentsMd;
    const mcpConnections = [...input.mcpConnections].sort((left, right) => left.context.localeCompare(right.context));
    const codexConfig = renderCodexConfig(input.profile.providerConfigToml, mcpConnections, OPENLEEK_CONTEXT_COMPACTION_POLICY, input.profile.modelsJson.length > 0);
    const developerInstructions = renderOpenLeekEnvironmentContext(sandboxWorkspacePath, this.sandboxMode, input.toolCallBudget?.maxCallsPerToolPerTurn);
    const policyDigest = instructionPolicyDigest(developerInstructions);
    const manifestDigest = artifactDigest({
      agentsMd,
      skills: digestSkills(skills),
      codexConfig,
      instructionPolicyDigest: policyDigest,
      transportVersion: "openleek-context-mcp-http/v2",
      conditionDigest,
      ...(input.toolCallBudget ? { toolCallBudget: input.toolCallBudget } : {}),
    });
    const artifact: StaticArtifact = {
      agentId: input.agent.agentId,
      workspacePath,
      sandboxWorkspacePath,
      agentsMd,
      skills,
      codexConfig,
      baseInstructions: OPENLEEK_BASE_INSTRUCTIONS,
      developerInstructions,
      instructionPolicyVersion: OPENLEEK_INSTRUCTION_POLICY_VERSION,
      instructionPolicyDigest: policyDigest,
      contextCompactionPolicy: OPENLEEK_CONTEXT_COMPACTION_POLICY,
      ...(input.toolCallBudget ? { toolCallBudget: structuredClone(input.toolCallBudget) } : {}),
      mcpConnections,
      conditionDigest,
      manifestDigest,
    };
    await this.restore(artifact);
    return artifact;
  }

  async inspect(artifact: StaticArtifact): Promise<string | undefined> {
    if (this.workspaceRoot === undefined) return undefined;
    try {
      const [agentsMd, codexConfig, skills] = await Promise.all([
        readFile(join(artifact.workspacePath, "AGENTS.md"), "utf8"),
        readFile(join(artifact.workspacePath, ".codex", "config.toml"), "utf8"),
        inspectSkills(artifact.workspacePath),
      ]);
      return artifactDigest({
        agentsMd,
        skills,
        codexConfig,
        instructionPolicyDigest: artifact.instructionPolicyDigest,
        transportVersion: "openleek-context-mcp-http/v2",
        conditionDigest: artifact.conditionDigest,
        ...(artifact.toolCallBudget ? { toolCallBudget: artifact.toolCallBudget } : {}),
      });
    } catch {
      return "missing";
    }
  }

  async restore(artifact: StaticArtifact): Promise<void> {
    if (this.workspaceRoot === undefined) return;
    // The separate sandbox uid joins Agent Execution's Node group only for
    // this run bind mount. Keep every directory group-writable so its
    // per-run CODEX_HOME and Agent workspaces can survive a container restart.
    const runRoot = this.runRootFromWorkspace(artifact.workspacePath);
    const codexHome = join(runRoot, "codex-home");
    const codexDirectory = join(artifact.workspacePath, ".codex");
    const skillsDirectory = join(artifact.workspacePath, ".agents", "skills");
    await mkdir(codexHome, { recursive: true, mode: 0o770 });
    await ensureCodexHomeLink(runRoot);
    await mkdir(codexDirectory, { recursive: true, mode: 0o770 });
    await Promise.all([runRoot, codexHome, artifact.workspacePath, codexDirectory].map((directory) => chmod(directory, 0o770)));
    await rm(skillsDirectory, { recursive: true, force: true });
    await Promise.all([
      writeFile(join(artifact.workspacePath, "AGENTS.md"), artifact.agentsMd, "utf8"),
      writeFile(join(artifact.workspacePath, ".codex", "config.toml"), artifact.codexConfig, "utf8"),
    ]);
    for (const skill of artifact.skills) {
      for (const file of skill.files) {
        const path = join(skillsDirectory, skill.skillName, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true, mode: 0o770 });
        await writeFile(path, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
        await chmod(path, file.executable ? 0o770 : 0o660);
      }
    }
  }

  /** Materialize the profile's complete catalog once per run, outside Agent workspaces. */
  async restoreProfile(runId: string, profile: CodexRuntimeProfile, contextCompactionPolicy?: ContextCompactionPolicy): Promise<void> {
    if (this.workspaceRoot === undefined) return;
    const runRoot = this.runRoot(runId);
    const codexHome = join(runRoot, "codex-home");
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "models.json");
    await mkdir(codexHome, { recursive: true, mode: 0o770 });
    await ensureCodexHomeLink(runRoot);
    await chmod(runRoot, 0o770);
    await chmod(codexHome, 0o770);
    // Codex intentionally tightens CODEX_HOME/config.toml to 0600 after it
    // starts. The sandbox uid then owns that inode, so later Agent jobs must
    // not rewrite this run-shared profile. Initialization creates both files
    // before the sandbox starts; subsequent calls only repair missing files.
    await Promise.all([
      writeSharedFileIfMissing(configPath, renderCodexConfig(profile.providerConfigToml, [], contextCompactionPolicy, profile.modelsJson.length > 0)),
      ...(profile.modelsJson.length === 0 ? [] : [writeFile(catalogPath, profile.modelsJson, "utf8").then(() => chmod(catalogPath, 0o660))]),
    ]);
  }

  upgrade(runId: string, profile: CodexRuntimeProfile, artifact: LegacyStaticArtifact): StaticArtifact {
    const codexConfig = renderCodexConfig(profile.providerConfigToml, artifact.mcpConnections, undefined, profile.modelsJson.length > 0);
    const developerInstructions = renderOpenLeekEnvironmentContext(artifact.sandboxWorkspacePath, this.sandboxMode);
    const policyDigest = instructionPolicyDigest(developerInstructions);
    return {
      ...artifact,
      skills: [],
      codexConfig,
      baseInstructions: OPENLEEK_BASE_INSTRUCTIONS,
      developerInstructions,
      instructionPolicyVersion: OPENLEEK_INSTRUCTION_POLICY_VERSION,
      instructionPolicyDigest: policyDigest,
      manifestDigest: artifactDigest({
        agentsMd: artifact.agentsMd,
        skills: [],
        codexConfig,
        instructionPolicyDigest: policyDigest,
        transportVersion: "openleek-context-mcp-http/v2",
        conditionDigest: artifact.conditionDigest,
      }),
    };
  }

  catalogPath(runId: string): string {
    return join(this.runRoot(runId), "codex-home", "models.json");
  }

  private path(runId: string, agentId: string): string {
    const runRoot = this.runRoot(runId);
    return join(runRoot, "workspaces", agentDirectoryName(agentId));
  }

  /** Local root visible to Agent Execution. It contains workspaces and Codex home. */
  runRoot(runId: string): string {
    const runHash = runDirectoryName(runId);
    return this.workspaceRoot === undefined ? `opaque:${runHash}` : join(this.workspaceRoot, runHash);
  }

  /** Docker-host root bound into the sandbox. It is never used for local I/O. */
  sandboxHostRunRoot(runId: string): string {
    const runHash = runDirectoryName(runId);
    return this.sandboxHostRunsRoot === undefined ? this.runRoot(runId) : join(this.sandboxHostRunsRoot, runHash);
  }

  /** The same root as seen from inside the sandbox container. */
  sandboxRunRoot(runId: string): string {
    const runHash = runDirectoryName(runId);
    return this.sandboxRunsRoot === undefined ? `opaque:${runHash}` : posix.join(this.sandboxRunsRoot, runHash);
  }

  private sandboxPath(runId: string, agentId: string): string {
    return posix.join(this.sandboxRunRoot(runId), "workspaces", agentDirectoryName(agentId));
  }

  private runRootFromWorkspace(workspacePath: string): string {
    return join(workspacePath, "..", "..");
  }
}

async function writeSharedFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await stat(path);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o660 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function ensureCodexHomeLink(runRoot: string): Promise<void> {
  try {
    await symlink("codex-home", join(runRoot, ".codex"), "dir");
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Stable opaque names avoid exposing run or agent identifiers in host paths. */
export function runDirectoryName(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

export function agentDirectoryName(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex");
}

export function renderCodexConfig(
  providerConfigToml: string,
  connections: readonly ContextMcpConnection[],
  contextCompactionPolicy?: ContextCompactionPolicy,
  useModelCatalog = true,
): string {
  const provider = providerConfigToml.trim();
  const tableStart = provider.search(/^\s*\[/m);
  const root = tableStart === -1 ? provider : provider.slice(0, tableStart).trimEnd();
  const tables = tableStart === -1 ? "" : provider.slice(tableStart).trim();
  return [
    root,
    ...(useModelCatalog ? ['model_catalog_json = "~/.codex/models.json"'] : []),
    'web_search = "disabled"',
    "include_environment_context = false",
    "allow_login_shell = false",
    ...(contextCompactionPolicy ? [
      `model_auto_compact_token_limit = ${contextCompactionPolicy.tokenLimit}`,
      `model_auto_compact_token_limit_scope = ${JSON.stringify(contextCompactionPolicy.scope)}`,
    ] : []),
    "",
    tables,
    ...(tables ? [""] : []),
    "[agents]",
    "enabled = false",
    "",
    "[features]",
    "goals = false",
    "multi_agent = false",
    "shell_snapshot = false",
    "",
    "[tools.experimental_request_user_input]",
    "enabled = false",
    "",
    "[tools.update_plan]",
    "enabled = false",
    "",
    "[shell_environment_policy]",
    'exclude = ["DEEPSEEK_API_KEY"]',
    "",
    ...connections.flatMap((connection) => [
    `[mcp_servers.${connection.context}]`,
    `url = ${JSON.stringify(connection.endpoint)}`,
    "required = true",
    `http_headers = { \"Authorization\" = ${JSON.stringify(`Bearer ${connection.credential}`)} }`,
    "",
    ]),
  ].join("\n");
}

interface DigestedSkillTree {
  readonly skillName: string;
  readonly files: readonly { readonly path: string; readonly content: string; readonly executable: boolean }[];
}

function artifactDigest(input: { agentsMd: string; skills: readonly DigestedSkillTree[]; codexConfig: string; instructionPolicyDigest: string; transportVersion: string; conditionDigest: string; toolCallBudget?: ToolCallBudget }): string {
  return sha256(input);
}

export type LegacyStaticArtifact = Omit<
  StaticArtifact,
  "skills" | "baseInstructions" | "developerInstructions" | "instructionPolicyVersion" | "instructionPolicyDigest" | "toolCallBudget"
>;

function digestSkills(skills: StaticArtifact["skills"]): DigestedSkillTree[] {
  return skills.map((skill) => ({
    skillName: skill.skillName,
    files: skill.files.map((file) => ({
      path: file.path,
      content: file.encoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64"),
      executable: file.executable,
    })).sort((left, right) => left.path.localeCompare(right.path)),
  })).sort((left, right) => left.skillName.localeCompare(right.skillName));
}

async function inspectSkills(workspacePath: string): Promise<DigestedSkillTree[]> {
  const root = join(workspacePath, ".agents", "skills");
  let skillNames: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.some((entry) => !entry.isDirectory())) throw new Error("unexpected entry in Skill root");
    skillNames = entries
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: DigestedSkillTree[] = [];
  for (const skillName of skillNames) {
    const directory = join(root, skillName);
    const paths = await walkFiles(directory);
    const files = await Promise.all(paths.map(async (path) => {
      const [content, metadata] = await Promise.all([readFile(path), stat(path)]);
      return {
        path: relative(directory, path).split(posix.sep).join("/"),
        content: content.toString("base64"),
        executable: Boolean(metadata.mode & 0o111),
      };
    }));
    result.push({ skillName, files });
  }
  return result;
}

async function walkFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(path));
    else if (entry.isFile()) output.push(path);
    else output.push(`${path}:unsupported`);
  }
  return output.sort();
}

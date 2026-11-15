import { mcpPolicyDefinitionSchema, skillDefinitionSchema, skillNameSchema, type SkillDefinition, type SkillFile } from "@openleek/contracts/agent";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

import { invalidArgument } from "./errors";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 250 * 1024;

export interface ValidatedSkillDefinition extends SkillDefinition {
  readonly skillName: string;
  readonly description: string;
}

export function validateSkillDefinition(input: SkillDefinition): ValidatedSkillDefinition {
  const parsed = skillDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    invalidArgument("Skill definition is invalid", Object.fromEntries(parsed.error.issues.map((issue) => [
      issue.path.join(".") || "definition",
      issue.message,
    ])));
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = parsed.data.files.map((file, index) => {
    const path = normalizePath(file.path, index);
    const collision = path.toLocaleLowerCase("en-US");
    if (seen.has(collision)) invalidArgument("Skill file paths must be unique ignoring case", { [`files.${index}.path`]: "duplicates another path" });
    seen.add(collision);
    const bytes = decode(file, index);
    if (bytes.byteLength > MAX_FILE_BYTES) invalidArgument("Skill file is too large", { [`files.${index}.content`]: "decoded file must not exceed 2 MiB" });
    if (path === "SKILL.md" && bytes.byteLength > MAX_SKILL_MD_BYTES) invalidArgument("SKILL.md is too large", { [`files.${index}.content`]: "must not exceed 250 KiB" });
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) invalidArgument("Skill bundle is too large", { files: "decoded bundle must not exceed 10 MiB" });
    return {
      path,
      encoding: file.encoding,
      content: file.encoding === "base64" ? bytes.toString("base64") : file.content,
      executable: file.executable,
    } satisfies SkillFile;
  }).sort((left, right) => left.path.localeCompare(right.path));

  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) invalidArgument("Skill bundle must contain a root SKILL.md", { files: "SKILL.md is required at the bundle root" });
  if (skillMd.encoding !== "utf8") invalidArgument("SKILL.md must be UTF-8 text", { files: "SKILL.md cannot use base64 encoding" });
  const metadata = parseSkillFrontmatter(skillMd.content);
  validateOpenAiMetadata(files, parsed.data.requirements);
  const requirements = mcpPolicyDefinitionSchema.parse({
    tools: [...new Set(parsed.data.requirements.tools)].sort(),
    resources: [...new Set(parsed.data.requirements.resources)].sort(),
  });
  return { files, requirements, ...metadata };
}

function normalizePath(value: string, index: number): string {
  const path = value.normalize("NFC");
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.endsWith("/")) {
    invalidArgument("Skill file path is unsafe", { [`files.${index}.path`]: "must be a relative POSIX file path" });
  }
  if (path !== posix.normalize(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    invalidArgument("Skill file path is unsafe", { [`files.${index}.path`]: "path traversal and empty segments are not allowed" });
  }
  return path;
}

function decode(file: SkillFile, index: number): Buffer {
  if (file.encoding === "utf8") return Buffer.from(file.content, "utf8");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
    invalidArgument("Skill file has malformed base64", { [`files.${index}.content`]: "must be canonical base64" });
  }
  return Buffer.from(file.content, "base64");
}

function parseSkillFrontmatter(source: string): { skillName: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match?.[1]) invalidArgument("SKILL.md must start with YAML frontmatter", { "files.SKILL.md": "name and description are required" });
  let value: unknown;
  try { value = parseYaml(match[1]); } catch (error) {
    invalidArgument("SKILL.md frontmatter is invalid YAML", { "files.SKILL.md": error instanceof Error ? error.message : "invalid YAML" });
  }
  const record = object(value);
  const name = typeof record.name === "string" ? record.name : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const parsedName = skillNameSchema.safeParse(name);
  if (!parsedName.success) invalidArgument("SKILL.md has an invalid name", { "files.SKILL.md.name": "use lowercase words separated by hyphens, at most 64 characters" });
  if (!description) invalidArgument("SKILL.md description must not be empty", { "files.SKILL.md.description": "must not be empty" });
  return { skillName: parsedName.data, description };
}

function validateOpenAiMetadata(files: readonly SkillFile[], requirements: SkillDefinition["requirements"]): void {
  const metadata = files.find((file) => file.path === "agents/openai.yaml");
  if (!metadata) return;
  if (metadata.encoding !== "utf8") invalidArgument("agents/openai.yaml must be UTF-8 text");
  let value: unknown;
  try { value = parseYaml(metadata.content); } catch (error) {
    invalidArgument("agents/openai.yaml is invalid YAML", { "files.agents/openai.yaml": error instanceof Error ? error.message : "invalid YAML" });
  }
  const dependencies = object(object(value).dependencies).tools;
  if (dependencies === undefined) return;
  if (!Array.isArray(dependencies)) invalidArgument("agents/openai.yaml dependencies.tools must be an array");
  for (const [index, dependency] of dependencies.entries()) {
    const item = object(dependency);
    if (item.type !== "mcp" || typeof item.value !== "string") continue;
    if (!/^[a-z][a-z0-9_-]{0,239}$/.test(item.value)) invalidArgument("Skill declares an invalid MCP server", { [`agents.openai.yaml.dependencies.tools.${index}.value`]: "must be a valid Context ID" });
    if (!requirements.tools.some((tool) => tool.startsWith(`${item.value}.`))
      && !requirements.resources.some((resource) => resource.startsWith(`${item.value}.`))) {
      invalidArgument("Skill MCP metadata is missing matching capability requirements", {
        [`agents.openai.yaml.dependencies.tools.${index}.value`]: `declare at least one ${item.value} tool or resource requirement`,
      });
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

"use client";

import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { type McpResourceId, type McpToolId, type SkillFile, type SkillRequirements } from "@openleek/contracts/agent";
import { TURN_PROMPT_SYSTEM_VARIABLES, turnPromptPlaceholderNames, type TurnPromptVariableDefinition } from "@openleek/contracts/turn-prompt";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { assetVersionHref } from "./asset-routes";
import type {
  AssetLibraryItem,
  PublishedVersionData,
} from "./asset-studio";

export type PublishedAssetKind =
  | "agents-md"
  | "agentBlueprint"
  | "feed-algorithm"
  | "financialPreset"
  | "market-maker"
  | "mcp-policy"
  | "network"
  | "population"
  | "skill"
  | "turn-prompt";

type RecordValue = Record<string, unknown>;
type PopulationPublishedData = PublishedVersionData & {
  entries: Array<{
    key: string;
    count: number;
    agentBlueprintVersionRef: string;
  }>;
};
type PythonPublishedData = PublishedVersionData & {
  source: string;
  defaultConfig: RecordValue;
  configSchema: RecordValue;
  dependencies: string[];
  limits: { maxRuntimeMs: number; maxMemoryMb: number };
};
type AgentBlueprintPublishedData = PublishedVersionData & {
  agentsMdVersionRef?: string;
  mcpPolicyVersionRef?: string;
  skillVersionRefs?: string[];
  contexts?: RecordValue;
};
type FinancialPresetPublishedData = PublishedVersionData & {
  cash?: number;
  positions?: Record<string, number>;
};
type SourcePublishedData = PublishedVersionData & { source: string };
type TurnPromptPublishedData = PublishedVersionData & {
  source: string;
  variables: TurnPromptVariableDefinition[];
};
type McpPolicyPublishedData = PublishedVersionData & {
  tools: McpToolId[];
  resources: McpResourceId[];
};
type SkillPublishedData = PublishedVersionData & {
  skillName: string;
  description: string;
  files: SkillFile[];
  requirements: SkillRequirements;
};

export type PublishedAssetDataByKind = {
  "agents-md": SourcePublishedData;
  agentBlueprint: AgentBlueprintPublishedData;
  "feed-algorithm": PythonPublishedData;
  financialPreset: FinancialPresetPublishedData;
  "market-maker": PythonPublishedData;
  "mcp-policy": McpPolicyPublishedData;
  network: PythonPublishedData;
  population: PopulationPublishedData;
  skill: SkillPublishedData;
  "turn-prompt": TurnPromptPublishedData;
};

const versionBases = {
  agentsMdVersionRef: "/assets/individual/agents-md",
  agentBlueprintVersionRef: "/assets/individual/agent-blueprints",
  financialInitialStatePresetVersionRef: "/assets/individual/financial-presets",
  mcpPolicyVersionRef: "/assets/individual/mcp-policies",
  skillVersionRef: "/assets/individual/skills",
} as const;

export function publishedVersionHref(referenceType: keyof typeof versionBases, reference: string) {
  return assetVersionHref(versionBases[referenceType], reference);
}

export function publishedAssetDetails<TKind extends PublishedAssetKind>(kind: TKind) {
  return (item: AssetLibraryItem<PublishedAssetDataByKind[TKind]>) => {
    if (!item.data) return <IncompleteData />;
    const props = { kind, value: item.data } as PublishedAssetDetailsProps;
    return <PublishedAssetDetails {...props} />;
  };
}

export function PublishedVersionMetadata<TData extends PublishedVersionData>({ item }: { item: AssetLibraryItem<TData> }) {
  const t = useTranslations("PublishedDetails");
  const data = item.data;
  const facts: Array<[string, ReactNode]> = [
    [t("versionReference"), <VersionReferenceValue key="version" value={item.id} />],
  ];
  if (item.timestamp) facts.push([t("publishedAt"), formatTimestamp(item.timestamp)]);
  if (data) facts.push([t("sourceDraft"), `r${data.draftRevision}`]);
  if (data) {
    facts.push([t("artifactDigest"), <Mono key="digest">{data.artifactDigest}</Mono>]);
  }
  return <FactGrid facts={facts} />;
}

function VersionReferenceValue({ value }: { value: string }) {
  const t = useTranslations("PublishedDetails");
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    });
  };
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Mono>{value}</Mono>
      <Button
        aria-label={t("copyVersionReference")}
        onClick={copy}
        size="small"
        sx={{ minWidth: 0, p: .5 }}
      >
        <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />
      </Button>
      {copied ? <Typography color="text.secondary" variant="caption">{t("copied")}</Typography> : null}
    </Stack>
  );
}

export function RawDataDisclosure({ value }: { value: unknown }) {
  const t = useTranslations("PublishedDetails");
  const [copied, setCopied] = useState(false);
  const serialized = JSON.stringify(sanitizeRawData(value), null, 2);
  const copy = () => {
    void navigator.clipboard.writeText(serialized).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    });
  };
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        borderTop: 1,
        borderColor: "divider",
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: 0, py: 1 }}>
        <Box>
          <Typography sx={{ fontWeight: 650 }}>{t("rawData")}</Typography>
          <Typography color="text.secondary" variant="body2">{t("rawDataHelp")}</Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0, pb: 0 }}>
        <Stack spacing={1.25}>
          <Button
            onClick={copy}
            size="small"
            startIcon={<ContentCopyRoundedIcon />}
            sx={{ alignSelf: "flex-start" }}
            variant="outlined"
          >
            {copied ? t("copied") : t("copyRawData")}
          </Button>
          <CodeBlock ariaLabel={t("rawData")} value={serialized} />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function sanitizeRawData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRawData);
  if (!value || typeof value !== "object") return value;
  const item = value as RecordValue;
  return Object.fromEntries(Object.entries(item).map(([key, child]) => {
    if (
      key === "content" &&
      item.encoding === "base64" &&
      typeof child === "string"
    ) {
      return [key, `[base64 content omitted · ${base64DecodedByteLength(child)} bytes]`];
    }
    return [key, sanitizeRawData(child)];
  }));
}

export function base64DecodedByteLength(value: string): number {
  const normalized = value.replace(/\s/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

type PublishedAssetDetailsProps = {
  [TKind in PublishedAssetKind]: {
    kind: TKind;
    value: PublishedAssetDataByKind[TKind];
  }
}[PublishedAssetKind];

function PublishedAssetDetails(props: PublishedAssetDetailsProps) {
  switch (props.kind) {
    case "population":
      return <PopulationDetails data={props.value} />;
    case "network":
    case "feed-algorithm":
    case "market-maker":
      return <PythonAssetDetails data={props.value} />;
    case "agentBlueprint":
      return <AgentBlueprintDetails data={props.value} />;
    case "financialPreset":
      return <FinancialPresetDetails data={props.value} />;
    case "agents-md":
      return <SourceDetails data={props.value} />;
    case "turn-prompt":
      return <TurnPromptDetails data={props.value} />;
    case "mcp-policy":
      return <McpPolicyDetails data={props.value} />;
    case "skill":
      return <SkillDetails data={props.value} />;
  }
}

function PopulationDetails({ data }: { data: PopulationPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const entries = data.entries;
  const total = entries.reduce((sum, entry) => sum + (number(entry.count) ?? 0), 0);
  return (
    <Stack spacing={4}>
      <DetailSection title={t("overview")}>
        <FactGrid facts={[
          [t("participants"), total.toLocaleString()],
          [t("cohorts"), entries.length.toLocaleString()],
        ]} />
      </DetailSection>
      <DetailSection title={t("cohortComposition")}>
        {entries.length ? (
          <TableContainer component={Paper} elevation={0} variant="outlined">
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>{t("stableKey")}</TableCell>
                <TableCell align="right">{t("count")}</TableCell>
                <TableCell>{t("agentBlueprint")}</TableCell>
              </TableRow></TableHead>
              <TableBody>{entries.map((entry, index) => (
                <TableRow key={`${text(entry.key) ?? "cohort"}-${index}`}>
                  <TableCell><Mono>{text(entry.key) ?? t("notSet")}</Mono></TableCell>
                  <TableCell align="right">{number(entry.count) ?? 0}</TableCell>
                  <TableCell>
                    <Stack spacing={0.75}>
                      <VersionReference label={t("agentBlueprint")} reference={text(entry.agentBlueprintVersionRef)} referenceType="agentBlueprintVersionRef" />
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        ) : <EmptyValue />}
      </DetailSection>
    </Stack>
  );
}

function PythonAssetDetails({ data }: { data: PythonPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const dependencies = data.dependencies;
  const limits = data.limits;
  return (
    <Stack spacing={4}>
      <DetailSection title={t("runtimeContract")}>
        <FactGrid facts={[
          [t("runtimeLimit"), formatLimit(limits.maxRuntimeMs, "ms")],
          [t("memoryLimit"), formatLimit(limits.maxMemoryMb, "MiB")],
        ]} />
        <LabelledValues label={t("dependencies")} values={dependencies} />
      </DetailSection>
      <DetailSection title={t("sourceCode")}>
        <CodeBlock ariaLabel={t("sourceCode")} value={data.source} />
      </DetailSection>
      <DetailSection title={t("configuration")}>
        <Stack spacing={2.5}>
          <JsonValue label={t("defaultConfiguration")} value={data.defaultConfig} />
          <JsonValue label={t("configurationSchema")} value={data.configSchema} />
        </Stack>
      </DetailSection>
    </Stack>
  );
}

function AgentBlueprintDetails({ data }: { data: AgentBlueprintPublishedData }) {
  const t = useTranslations("PublishedDetails");
  return (
    <Stack spacing={4}>
      <DetailSection title={t("boundAssets")}>
        <Stack spacing={1.25}>
          <VersionReference label={t("agentsMd")} reference={data.agentsMdVersionRef} referenceType="agentsMdVersionRef" />
          <VersionReference label={t("mcpPolicy")} reference={data.mcpPolicyVersionRef} referenceType="mcpPolicyVersionRef" />
        </Stack>
      </DetailSection>
      <DetailSection title={t("skills")}>
        <ReferenceList references={data.skillVersionRefs ?? []} referenceType="skillVersionRef" />
      </DetailSection>
      <DetailSection title={t("contexts")}><JsonValue label={t("contexts")} value={data.contexts ?? {}} /></DetailSection>
    </Stack>
  );
}

function FinancialPresetDetails({ data }: { data: FinancialPresetPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const positions = data.positions ?? {};
  return (
    <Stack spacing={4}>
      <DetailSection title={t("financialConfiguration")}>
        <FactGrid facts={[[t("startingCash"), formatNumber(data.cash)]]} />
      </DetailSection>
      <DetailSection title={t("initialPositions")}>
        {Object.keys(positions).length ? (
          <TableContainer component={Paper} elevation={0} variant="outlined">
            <Table size="small">
              <TableHead><TableRow><TableCell>{t("instrument")}</TableCell><TableCell align="right">{t("quantity")}</TableCell></TableRow></TableHead>
              <TableBody>{Object.entries(positions).map(([symbol, quantity]) => (
                <TableRow key={symbol}><TableCell><Mono>{symbol}</Mono></TableCell><TableCell align="right">{formatNumber(quantity)}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        ) : <EmptyValue />}
      </DetailSection>
    </Stack>
  );
}

function SourceDetails({ data }: { data: SourcePublishedData }) {
  const t = useTranslations("PublishedDetails");
  return <DetailSection title={t("sourceContent")}>
    <CodeBlock ariaLabel={t("sourceContent")} value={data.source} />
  </DetailSection>;
}

function TurnPromptDetails({ data }: { data: TurnPromptPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const placeholders = new Set(turnPromptPlaceholderNames(data.source));
  const systemVariables = TURN_PROMPT_SYSTEM_VARIABLES.filter(({ name }) => placeholders.has(name));
  return (
    <Stack spacing={4}>
      <DetailSection title={t("promptTemplate")}>
        <CodeBlock ariaLabel={t("promptTemplate")} value={data.source} />
      </DetailSection>
      <DetailSection title={t("systemVariables")}>
        {systemVariables.length ? (
          <TableContainer component={Paper} elevation={0} variant="outlined">
            <Table size="small">
              <TableHead><TableRow><TableCell>{t("variable")}</TableCell><TableCell>{t("type")}</TableCell><TableCell>{t("providedBy")}</TableCell></TableRow></TableHead>
              <TableBody>{systemVariables.map((variable) => (
                <TableRow key={variable.name}>
                  <TableCell><Mono>{variable.name}</Mono></TableCell>
                  <TableCell>{variable.type}</TableCell>
                  <TableCell>{t("runtimeInjected")}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        ) : <Typography color="text.secondary" variant="body2">{t("noSystemVariables")}</Typography>}
      </DetailSection>
      <DetailSection title={t("customVariables")}>
        {data.variables.length ? (
          <TableContainer component={Paper} elevation={0} variant="outlined">
            <Table size="small">
              <TableHead><TableRow><TableCell>{t("variable")}</TableCell><TableCell>{t("type")}</TableCell><TableCell>{t("requirement")}</TableCell><TableCell>{t("defaultValue")}</TableCell><TableCell>{t("description")}</TableCell></TableRow></TableHead>
              <TableBody>{data.variables.map((variable) => (
                <TableRow key={variable.name}>
                  <TableCell><Mono>{variable.name}</Mono></TableCell>
                  <TableCell>{variable.type}</TableCell>
                  <TableCell>{variable.required === true ? t("required") : t("optional")}</TableCell>
                  <TableCell>{variable.defaultValue === undefined ? t("noDefaultValue") : formatVariableValue(variable.defaultValue)}</TableCell>
                  <TableCell>{variable.description ?? t("notSet")}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        ) : <Typography color="text.secondary" variant="body2">{t("noCustomVariables")}</Typography>}
      </DetailSection>
    </Stack>
  );
}

function McpPolicyDetails({ data }: { data: McpPolicyPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const policyT = useTranslations("McpPolicies");
  const tools = [...data.tools];
  const resources = [...data.resources];
  const contexts = ["social", "financial"] as const;
  const otherTools = tools.filter((value) => !contexts.some((context) => value.startsWith(`${context}.`)));
  const otherResources = resources.filter((value) => !contexts.some((context) => value.startsWith(`${context}.`)));
  return (
    <Stack spacing={4}>
      {contexts.map((context) => {
        const contextTools = tools.filter((value) => value.startsWith(`${context}.`));
        const contextResources = resources.filter((value) => value.startsWith(`${context}.`));
        return (
          <DetailSection key={context} title={context === "social" ? policyT("socialTitle") : policyT("financialTitle")}>
            <Stack spacing={2.5}>
              <LabelledValues label={policyT("tools")} values={contextTools.map((value) => capabilityLabel(policyT, value))} />
              <LabelledValues label={policyT("resources")} values={contextResources.map((value) => capabilityLabel(policyT, value))} />
            </Stack>
          </DetailSection>
        );
      })}
      {otherTools.length || otherResources.length ? (
        <DetailSection title={t("otherCapabilities")}>
          <Stack spacing={2.5}>
            <LabelledValues label={policyT("tools")} values={otherTools} />
            <LabelledValues label={policyT("resources")} values={otherResources} />
          </Stack>
        </DetailSection>
      ) : null}
      {!tools.length && !resources.length ? <Typography color="text.secondary">{t("emptyPolicy")}</Typography> : null}
    </Stack>
  );
}

function SkillDetails({ data }: { data: SkillPublishedData }) {
  const t = useTranslations("PublishedDetails");
  const policyT = useTranslations("McpPolicies");
  const files = data.files;
  const requirements = data.requirements;
  const [selectedPath, setSelectedPath] = useState(() => files[0]?.path ?? "");
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  return (
    <Stack spacing={4}>
      <DetailSection title={t("skillIdentity")}>
        <FactGrid facts={[
          [t("skillName"), data.skillName],
          [t("description"), data.description || t("notSet")],
          [t("fileCount"), files.length.toLocaleString()],
        ]} />
      </DetailSection>
      <DetailSection title={t("requiredCapabilities")}>
        <Stack spacing={2.5}>
          <LabelledValues label={policyT("tools")} values={requirements.tools.map((value) => capabilityLabel(policyT, value))} />
          <LabelledValues label={policyT("resources")} values={requirements.resources.map((value) => capabilityLabel(policyT, value))} />
        </Stack>
      </DetailSection>
      <DetailSection title={t("bundleFiles")}>
        {files.length ? (
          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "240px minmax(0, 1fr)" } }}>
            <Paper component="nav" elevation={0} sx={{ overflow: "hidden" }} variant="outlined">
              <Stack divider={<Divider flexItem />} sx={{ maxHeight: 520, overflow: "auto" }}>
                {files.map((file) => {
                  const path = file.path;
                  return <Button
                    key={path}
                    onClick={() => setSelectedPath(path)}
                    sx={{ borderRadius: 0, justifyContent: "flex-start", px: 2, py: 1.25, textTransform: "none" }}
                    variant={path === (selected?.path ?? "") ? "contained" : "text"}
                  >
                    <Mono>{path}</Mono>
                  </Button>;
                })}
              </Stack>
            </Paper>
            <Box sx={{ minWidth: 0 }}>
              {selected ? (
                <Stack spacing={1.25}>
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                    <Mono>{selected.path}</Mono>
                    <Stack direction="row" spacing={0.75}>
                      <Chip label={selected.encoding} size="small" />
                      {selected.executable === true ? <Chip label={t("executable")} size="small" variant="outlined" /> : null}
                    </Stack>
                  </Stack>
                  {selected.encoding === "base64"
                    ? <Paper elevation={0} sx={{ bgcolor: "grey.50", p: 3, textAlign: "center" }} variant="outlined">
                      <Typography color="text.secondary">{t("binaryFile", { count: base64DecodedByteLength(selected.content) })}</Typography>
                    </Paper>
                    : <CodeBlock ariaLabel={selected.path} value={selected.content} />}
                </Stack>
              ) : <EmptyValue />}
            </Box>
          </Box>
        ) : <EmptyValue />}
      </DetailSection>
    </Stack>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <Box component="section">
      <Typography component="h2" sx={{ fontSize: "1.05rem", fontWeight: 720, letterSpacing: "-.01em", mb: 1.5 }}>{title}</Typography>
      {children}
    </Box>
  );
}

function FactGrid({ facts }: { facts: Array<[string, ReactNode]> }) {
  return (
    <Box
      component="dl"
      sx={{
        borderBottom: 1,
        borderColor: "divider",
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" },
        m: 0,
      }}
    >
      {facts.map(([label, value]) => (
        <Box key={label} sx={{ borderTop: 1, borderColor: "divider", minWidth: 0, py: 1.5, pr: 2 }}>
          <Typography component="dt" color="text.secondary" variant="caption">{label}</Typography>
          <Typography component="dd" sx={{ fontSize: ".9rem", fontVariantNumeric: "tabular-nums", m: 0, mt: .45, overflowWrap: "anywhere" }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function LabelledValues({ label, values }: { label: string; values: string[] }) {
  return (
    <Box sx={{ mt: 2 }}>
      <Typography color="text.secondary" variant="caption">{label}</Typography>
      {values.length ? (
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75, mt: .75 }}>
          {values.map((value) => <Chip key={value} label={value} size="small" variant="outlined" />)}
        </Stack>
      ) : <EmptyValue />}
    </Box>
  );
}

function VersionReference({ label, reference, referenceType }: {
  label: string;
  reference: string | undefined;
  referenceType: keyof typeof versionBases;
}) {
  const t = useTranslations("PublishedDetails");
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: .2, sm: 1 }} sx={{ alignItems: { sm: "baseline" } }}>
      <Typography color="text.secondary" sx={{ minWidth: 116 }} variant="caption">{label}</Typography>
      {reference
        ? <Typography component={Link} href={publishedVersionHref(referenceType, reference)} sx={{ color: "primary.main", fontFamily: "monospace", fontSize: ".78rem", overflowWrap: "anywhere", textDecorationColor: "transparent", "&:hover": { textDecorationColor: "currentColor" } }}>{reference}</Typography>
        : <Typography color="text.secondary" variant="body2">{t("notSet")}</Typography>}
    </Stack>
  );
}

function ReferenceList({ references, referenceType }: { references: string[]; referenceType: keyof typeof versionBases }) {
  if (!references.length) return <EmptyValue />;
  return <Stack spacing={1}>{references.map((reference) => (
    <Typography component={Link} href={publishedVersionHref(referenceType, reference)} key={reference} sx={{ color: "primary.main", fontFamily: "monospace", fontSize: ".82rem", overflowWrap: "anywhere", textDecorationColor: "transparent", "&:hover": { textDecorationColor: "currentColor" } }}>{reference}</Typography>
  ))}</Stack>;
}

function JsonValue({ label, value }: { label: string; value: unknown }) {
  return (
    <Box>
      <Typography color="text.secondary" sx={{ mb: .75 }} variant="caption">{label}</Typography>
      <CodeBlock ariaLabel={label} value={JSON.stringify(value ?? {}, null, 2)} />
    </Box>
  );
}

function CodeBlock({ ariaLabel, value }: { ariaLabel: string; value: string }) {
  return (
    <Paper
      aria-label={ariaLabel}
      component="pre"
      elevation={0}
      sx={{
        bgcolor: "grey.900",
        color: "grey.100",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: ".79rem",
        lineHeight: 1.7,
        m: 0,
        maxHeight: 560,
        overflow: "auto",
        p: { xs: 2, sm: 2.5 },
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {value || "—"}
    </Paper>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <Box component="span" sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: ".82rem", overflowWrap: "anywhere" }}>{children}</Box>;
}

function EmptyValue() {
  const t = useTranslations("PublishedDetails");
  return <Typography color="text.secondary" sx={{ mt: .5 }} variant="body2">{t("none")}</Typography>;
}

function IncompleteData() {
  const t = useTranslations("PublishedDetails");
  return <Alert severity="error">{t("incompleteData")}</Alert>;
}

function formatVariableValue(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: unknown): string {
  const parsed = number(value);
  return parsed === undefined ? "—" : parsed.toLocaleString();
}

function formatLimit(value: number | undefined, unit: string): string {
  return value === undefined ? "—" : `${value.toLocaleString()} ${unit}`;
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function capabilityLabel(
  translator: ReturnType<typeof useTranslations<"McpPolicies">>,
  value: string,
): string {
  const [context, capability] = value.split(".");
  if ((context !== "social" && context !== "financial") || !capability) return value;
  return translator(`capabilities.${context}.${capability}` as never);
}

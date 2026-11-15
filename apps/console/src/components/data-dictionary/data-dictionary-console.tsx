"use client";

import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import {
  dataDictionaryCatalogSchema,
  type DataDictionaryCatalog,
  type DataDictionaryEntry,
} from "@openleek/contracts/data-dictionary";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import Fuse from "fuse.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { localized } from "../ui/settings-dialog";
import { SchemaDocumentation } from "./schema-documentation";

type CatalogClient = {
  console: {
    dataDictionary: {
      catalog: { query(input: {}): Promise<unknown> };
    };
  };
};

type IndexedEntry = {
  entry: DataDictionaryEntry;
  ownerLabel: string;
  revision: string | undefined;
  searchText: string;
};

function api(): CatalogClient {
  return createTRPCProxyClient<AnyRouter>({
    links: [httpBatchLink({ url: "/api/trpc" })],
  }) as unknown as CatalogClient;
}

export function DataDictionaryConsole({ initialEntryId }: { initialEntryId?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("DataDictionary");
  const client = useMemo(api, []);
  const [catalog, setCatalog] = useState<DataDictionaryCatalog>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("all");
  const [category, setCategory] = useState("all");

  useEffect(() => {
    let active = true;
    void client.console.dataDictionary.catalog.query({}).then((value) => {
      if (!active) return;
      setCatalog(dataDictionaryCatalogSchema.parse(value));
      setError(undefined);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    });
    return () => { active = false; };
  }, [client, t]);

  const indexed = useMemo<IndexedEntry[]>(() => {
    if (!catalog) return [];
    return catalog.sources.flatMap((source) => source.entries.map((entry) => ({
      entry,
      ownerLabel: localized(source.owner, locale),
      revision: source.revision,
      searchText: [
        localized(entry.label, locale),
        localized(entry.description, locale),
        source.ownerId,
        entry.categoryId,
        entry.entryKind,
        entry.management.surface,
        entry.management.key,
        entry.management.idField ?? "",
        entry.management.capabilities.join(" "),
        entry.id,
        JSON.stringify(entry.definitionSchema),
        entry.programming?.className ?? "",
        entry.programming?.constructor ?? "",
        entry.programming?.methods.map((method) => method.signature).join(" ") ?? "",
      ].join(" "),
    })));
  }, [catalog, locale]);

  const fuse = useMemo(() => new Fuse(indexed, {
    keys: ["searchText"],
    threshold: .28,
    ignoreLocation: true,
    useExtendedSearch: true,
  }), [indexed]);

  const filtered = useMemo(() => {
    const searched = query.trim() ? fuse.search(query.trim()).map((result) => result.item) : indexed;
    return searched.filter((item) =>
      (owner === "all" || item.entry.ownerId === owner)
      && (category === "all" || item.entry.categoryId === category)
    );
  }, [category, fuse, indexed, owner, query]);

  const selected = indexed.find((item) => item.entry.id === initialEntryId)
    ?? filtered[0]
    ?? indexed[0];
  const categories = [...new Set(indexed.map((item) => item.entry.categoryId))].sort();
  const availableSources = catalog?.sources.filter((source) => source.available) ?? [];
  const unavailableSources = catalog?.sources.filter((source) => !source.available) ?? [];

  if (error) {
    return <PageFrame>
      <Alert severity="error">{error}</Alert>
    </PageFrame>;
  }

  return <PageFrame>
    <Box component="header" sx={{ maxWidth: 760 }}>
      <Typography color="primary.main" variant="overline">{t("eyebrow")}</Typography>
      <Typography component="h1" sx={{ mt: .5, textWrap: "balance" }} variant="h1">{t("title")}</Typography>
      <Typography color="text.secondary" sx={{ fontSize: "1rem", lineHeight: 1.7, mt: 1.5, textWrap: "pretty" }}>
        {t("description")}
      </Typography>
    </Box>

    {!catalog ? <DictionarySkeleton /> : <>
      {unavailableSources.map((source) => <Alert key={source.ownerId} severity="warning">
        {t("sourceUnavailable", { owner: localized(source.owner, locale) })}
      </Alert>)}
      <Box sx={{
        display: "grid",
        gap: 3,
        gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "19rem minmax(0, 1fr)" },
        alignItems: "start",
      }}>
        <Paper
          component="aside"
          elevation={0}
          sx={{
            bgcolor: "rgba(255,255,255,.76)",
            border: 1,
            borderColor: "divider",
            p: 2,
            position: { lg: "sticky" },
            top: { lg: 24 },
          }}
        >
          <Stack spacing={1.5}>
            <TextField
              fullWidth
              label={t("search")}
              onChange={(event) => setQuery(event.target.value)}
              value={query}
              slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> } }}
            />
            <Stack direction={{ xs: "column", sm: "row", lg: "column" }} spacing={1.25}>
              <FormControl fullWidth>
                <InputLabel>{t("owner")}</InputLabel>
                <Select label={t("owner")} onChange={(event) => setOwner(event.target.value)} value={owner}>
                  <MenuItem value="all">{t("allOwners")}</MenuItem>
                  {availableSources.map((source) => <MenuItem key={source.ownerId} value={source.ownerId}>{localized(source.owner, locale)}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>{t("category")}</InputLabel>
                <Select label={t("category")} onChange={(event) => setCategory(event.target.value)} value={category}>
                  <MenuItem value="all">{t("allCategories")}</MenuItem>
                  {categories.map((value) => <MenuItem key={value} value={value}>{categoryLabel(value, t)}</MenuItem>)}
                </Select>
              </FormControl>
            </Stack>
            <Typography color="text.secondary" variant="caption">{t("resultCount", { count: filtered.length })}</Typography>
            <Divider />
            <Box
              component="nav"
              aria-label={t("entries")}
              sx={{
                display: "grid",
                gap: .5,
                maxHeight: { xs: 320, lg: "calc(100dvh - 310px)" },
                overflowY: "auto",
                pr: .5,
              }}
            >
              {filtered.map((item) => {
                const active = item.entry.id === selected?.entry.id;
                return <Box
                  component={Link}
                  href={`/data-dictionary/${encodeURIComponent(item.entry.id)}`}
                  key={item.entry.id}
                  onClick={(event) => {
                    event.preventDefault();
                    router.push(`/data-dictionary/${encodeURIComponent(item.entry.id)}`);
                  }}
                  sx={{
                    bgcolor: active ? "primary.light" : "transparent",
                    borderRadius: 1.5,
                    color: "text.primary",
                    p: 1.25,
                    textDecoration: "none",
                    transition: "background-color 180ms ease, transform 180ms ease",
                    "&:hover": { bgcolor: active ? "primary.light" : "rgba(23,107,77,.06)", transform: "translateX(2px)" },
                    "&:active": { transform: "translateX(1px)" },
                  }}
                >
                  <Typography sx={{ fontSize: ".86rem", fontWeight: active ? 720 : 620 }}>{localized(item.entry.label, locale)}</Typography>
                  <Typography color="text.secondary" sx={{ mt: .25 }} variant="caption">{item.ownerLabel} · {item.entry.id}</Typography>
                </Box>;
              })}
              {!filtered.length ? <Alert severity="info">{t("noResults")}</Alert> : null}
            </Box>
          </Stack>
        </Paper>

        <Box component="main" sx={{ minWidth: 0 }}>
          {selected ? <EntryDocumentation
            entry={selected.entry}
            ownerLabel={selected.ownerLabel}
            revision={selected.revision}
          /> : <Alert severity="info">{t("empty")}</Alert>}
        </Box>
      </Box>
    </>}
  </PageFrame>;
}

function EntryDocumentation({ entry, ownerLabel, revision }: { entry: DataDictionaryEntry; ownerLabel: string; revision: string | undefined }) {
  const locale = useLocale();
  const t = useTranslations("DataDictionary");
  return <Paper component="article" elevation={0} sx={{ border: 1, borderColor: "divider", overflow: "hidden" }}>
    <Box sx={{
      background: "radial-gradient(circle at 100% 0%, rgba(23,107,77,.11), transparent 42%), linear-gradient(180deg, #fff 0%, #f8fbf9 100%)",
      px: { xs: 2.5, md: 4.5 },
      pb: { xs: 3.5, md: 4.5 },
      pt: { xs: 3, md: 4 },
    }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: .5 }}>
        <Chip label={ownerLabel} size="small" />
        <Chip label={categoryLabel(entry.categoryId, t)} size="small" variant="outlined" />
        <Chip label={entryKindLabel(entry.entryKind, t)} size="small" variant="outlined" />
        <Chip label={managementSurfaceLabel(entry.management.surface, t)} size="small" variant="outlined" />
        <Chip label={entry.id} size="small" variant="outlined" />
      </Stack>
      <Typography component="h2" sx={{ fontSize: { xs: "1.8rem", md: "2.45rem" }, fontWeight: 680, letterSpacing: "-.035em", lineHeight: 1.1, mt: 2.5 }}>
        {localized(entry.label, locale)}
      </Typography>
      <Typography color="text.secondary" sx={{ lineHeight: 1.75, maxWidth: "68ch", mt: 1.25 }}>
        {localized(entry.description, locale)}
      </Typography>
      {revision ? <Typography color="text.disabled" sx={{ display: "block", mt: 2, fontVariantNumeric: "tabular-nums" }} variant="caption">
        {t("currentRevision", { revision })}
      </Typography> : null}
    </Box>

    <Stack divider={<Divider flexItem />} spacing={0}>
      <DocSection title={t("management")} description={t("managementHelp")}>
        <Stack spacing={2}>
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" } }}>
            <Fact label={t("managementSurface")} value={entry.management.surface} />
            <Fact label={t("managementKey")} value={entry.management.key} />
            <Fact label={t("managementIdField")} value={entry.management.idField ?? t("notApplicable")} />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 680, mb: 1 }} variant="subtitle2">{t("managementCapabilities")}</Typography>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75 }}>
              {entry.management.capabilities.map((capability) => <Chip key={capability} label={capability} size="small" variant="outlined" />)}
            </Stack>
          </Box>
        </Stack>
      </DocSection>

      {entry.references.length ? <DocSection title={t("references")} description={t("referencesHelp")}>
        <Stack spacing={1}>
          {entry.references.map((reference) => <Box key={`${reference.path}:${reference.targetEntryId}`} sx={{ alignItems: { sm: "center" }, display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 1.25 }}>
            <Typography component="code" sx={{ bgcolor: "grey.100", borderRadius: 1, fontSize: ".78rem", px: 1, py: .5 }}>{reference.path}</Typography>
            <Typography color="text.disabled">→</Typography>
            <Button component={Link} href={`/data-dictionary/${encodeURIComponent(reference.targetEntryId)}`} size="small" variant="text">
              {reference.targetEntryId}
            </Button>
            {reference.description ? <Typography color="text.secondary" variant="body2">{localized(reference.description, locale)}</Typography> : null}
          </Box>)}
        </Stack>
      </DocSection> : null}

      <DocSection title={t("definition")} description={t("definitionHelp")}>
        <SchemaDocumentation schema={entry.definitionSchema} />
      </DocSection>

      {entry.programming ? <DocSection title={t("pythonContract")} description={t("pythonHelp")}>
        <Stack spacing={3}>
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" } }}>
            <Fact label={t("className")} value={entry.programming.className} />
            <Fact label={t("constructor")} value={entry.programming.constructor} />
            <Fact label={t("limits")} value={`${entry.programming.limits.maxRuntimeMs} ms · ${entry.programming.limits.maxMemoryMb} MiB`} />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 680, mb: 1 }} variant="subtitle2">{t("methods")}</Typography>
            <Stack spacing={1}>
              {entry.programming.methods.map((method) => <Box key={method.signature}>
                <Typography component="code" sx={{ fontSize: ".82rem", fontWeight: 700 }}>{method.signature}</Typography>
                <Typography color="text.secondary" sx={{ mt: .25 }} variant="body2">{localized(method.description, locale)}</Typography>
              </Box>)}
            </Stack>
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 680, mb: 1 }} variant="subtitle2">{t("allowedImports")}</Typography>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75 }}>
              {entry.programming.allowedImports.map((item) => <Chip key={item} label={item} size="small" variant="outlined" />)}
            </Stack>
          </Box>
          <CodeDisclosure label={t("minimalExample")} source={entry.programming.exampleSource} />
          <Box>
            <Typography component="h4" sx={{ fontWeight: 680, mb: 1.5 }} variant="h6">{t("contextSchema")}</Typography>
            <SchemaDocumentation schema={entry.programming.contextSchema} />
          </Box>
          <Box>
            <Typography component="h4" sx={{ fontWeight: 680, mb: 1.5 }} variant="h6">{t("resultSchema")}</Typography>
            <SchemaDocumentation schema={entry.programming.resultSchema} />
          </Box>
        </Stack>
      </DocSection> : null}

      {entry.examples.length ? <DocSection title={t("examples")} description={t("examplesHelp")}>
        <Stack spacing={1}>
          {entry.examples.map((example, index) => <Accordion disableGutters elevation={0} key={index} sx={{ border: 1, borderColor: "divider", "&:before": { display: "none" } }}>
            <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}>
              <Box>
                <Typography sx={{ fontWeight: 680 }}>{localized(example.title, locale)}</Typography>
                {example.description ? <Typography color="text.secondary" variant="body2">{localized(example.description, locale)}</Typography> : null}
              </Box>
            </AccordionSummary>
            <AccordionDetails><JsonCode value={example.value} /></AccordionDetails>
          </Accordion>)}
        </Stack>
      </DocSection> : null}

      <DocSection title={t("rawSchema")} description={t("rawSchemaHelp")}>
        <CopyableJson value={entry.definitionSchema} />
      </DocSection>
    </Stack>
  </Paper>;
}

function PageFrame({ children }: { children: ReactNode }) {
  return <Stack spacing={3.5} sx={{ maxWidth: 1500, mx: "auto", px: { xs: 2, sm: 3.5, md: 5 }, py: { xs: 3, md: 5 } }}>{children}</Stack>;
}

function DocSection({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return <Box component="section" sx={{ px: { xs: 2.5, md: 4.5 }, py: { xs: 3, md: 4 } }}>
    <Typography component="h3" sx={{ fontWeight: 680, letterSpacing: "-.02em" }} variant="h5">{title}</Typography>
    <Typography color="text.secondary" sx={{ lineHeight: 1.7, mb: 2.5, mt: .5, maxWidth: "68ch" }} variant="body2">{description}</Typography>
    {children}
  </Box>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <Box sx={{ bgcolor: "rgba(23,107,77,.055)", borderRadius: 1.5, p: 1.5 }}>
    <Typography color="text.secondary" variant="caption">{label}</Typography>
    <Typography component="code" sx={{ display: "block", fontSize: ".82rem", fontWeight: 700, mt: .5, overflowWrap: "anywhere" }}>{value}</Typography>
  </Box>;
}

function CodeDisclosure({ label, source }: { label: string; source: string }) {
  return <Box>
    <Typography sx={{ fontWeight: 680, mb: 1 }} variant="subtitle2">{label}</Typography>
    <Box component="pre" sx={{ bgcolor: "#13211b", borderRadius: 1.5, color: "#dcece4", fontSize: ".78rem", lineHeight: 1.65, overflow: "auto", p: 2.25, whiteSpace: "pre" }}>{source}</Box>
  </Box>;
}

function JsonCode({ value }: { value: unknown }) {
  return <Box component="pre" sx={{ bgcolor: "#f3f7f5", borderRadius: 1.25, fontSize: ".78rem", lineHeight: 1.65, overflow: "auto", p: 2, whiteSpace: "pre" }}>{JSON.stringify(value, null, 2)}</Box>;
}

function CopyableJson({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const t = useTranslations("DataDictionary");
  const serialized = JSON.stringify(value, null, 2);
  return <Stack spacing={1.25}>
    <Button
      onClick={() => void navigator.clipboard.writeText(serialized).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      })}
      size="small"
      startIcon={<ContentCopyRoundedIcon />}
      sx={{ alignSelf: "flex-start" }}
      variant="outlined"
    >
      {copied ? t("copied") : t("copySchema")}
    </Button>
    <JsonCode value={value} />
  </Stack>;
}

function DictionarySkeleton() {
  return <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", lg: "19rem minmax(0, 1fr)" } }}>
    <Skeleton height={520} variant="rounded" />
    <Skeleton height={760} variant="rounded" />
  </Box>;
}

function categoryLabel(
  value: string,
  t: (key: "categories.agent" | "categories.world" | "categories.experiment") => string,
) {
  if (value === "agent") return t("categories.agent");
  if (value === "world") return t("categories.world");
  if (value === "experiment") return t("categories.experiment");
  return value;
}

function entryKindLabel(
  value: DataDictionaryEntry["entryKind"],
  t: (key: `entryKinds.${DataDictionaryEntry["entryKind"]}`) => string,
) {
  return t(`entryKinds.${value}`);
}

function managementSurfaceLabel(
  value: DataDictionaryEntry["management"]["surface"],
  t: (key: `managementSurfaces.${DataDictionaryEntry["management"]["surface"]}`) => string,
) {
  return t(`managementSurfaces.${value}`);
}

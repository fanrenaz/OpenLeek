"use client";

import { Alert, Skeleton, Stack } from "@mui/material";
import dynamic from "next/dynamic";

const StoplightSchemaViewer = dynamic(
  () => import("@stoplight/json-schema-viewer").then((module) => module.JsonSchemaViewer),
  {
    ssr: false,
    loading: () => <Stack spacing={1.25}><Skeleton height={28} /><Skeleton height={74} /><Skeleton height={108} /></Stack>,
  },
);

export function SchemaDocumentation({ schema }: { schema: Record<string, unknown> }) {
  return <div className="openleek-schema-docs">
    <StoplightSchemaViewer
      defaultExpandedDepth={2}
      disableCrumbs
      emptyText="No schema published."
      schema={schema}
    />
    {!Object.keys(schema).length ? <Alert severity="info">No schema published.</Alert> : null}
  </div>;
}

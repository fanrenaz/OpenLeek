declare module "@stoplight/json-schema-viewer" {
  import type { ComponentType } from "react";

  export type JsonSchemaViewerProps = {
    className?: string;
    defaultExpandedDepth?: number;
    disableCrumbs?: boolean;
    emptyText?: string;
    hideExamples?: boolean;
    maxHeight?: number;
    schema: Record<string, unknown> | boolean;
    skipTopLevelDescription?: boolean;
  };

  export const JsonSchemaViewer: ComponentType<JsonSchemaViewerProps>;
}

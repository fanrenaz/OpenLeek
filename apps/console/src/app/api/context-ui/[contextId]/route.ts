import { createHash } from "node:crypto";
import { contextPluginDescriptorSchema } from "@openleek/contracts/context";

export const runtime = "nodejs";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function managementHeaders() { return { authorization: `Bearer ${required("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN")}` }; }

export async function GET(request: Request, context: { params: Promise<{ contextId: string }> }) {
  try {
    const { contextId } = await context.params;
    const registry = required("OPENLEEK_CONTEXT_REGISTRY_URL");
    const [catalogResponse, installationsResponse] = await Promise.all([
      fetch(new URL("/internal/catalog", registry), { headers: managementHeaders(), cache: "no-store" }),
      fetch(new URL("/internal/installations", registry), { headers: managementHeaders(), cache: "no-store" }),
    ]);
    if (!catalogResponse.ok || !installationsResponse.ok) throw new Error("Context Registry lookup failed");
    const catalog = await catalogResponse.json() as { contexts?: unknown[] };
    const descriptor = contextPluginDescriptorSchema.parse((catalog.contexts ?? []).find((value) => value && typeof value === "object" && (value as { contextId?: unknown }).contextId === contextId));
    if (!descriptor.uiModule) return Response.json({ error: "Context has no UI module" }, { status: 404 });
    const installations = await installationsResponse.json() as { installations?: Array<{ installationRef: string; contextId: string; state: string }> };
    const installation = (installations.installations ?? []).find((item) => item.contextId === contextId && item.state === "active");
    if (!installation) return Response.json({ error: "Context installation is not active" }, { status: 404 });
    const resolvedResponse = await fetch(new URL(`/internal/installations/${encodeURIComponent(installation.installationRef)}`, registry), { headers: managementHeaders(), cache: "no-store" });
    if (!resolvedResponse.ok) throw new Error("Context installation resolution failed");
    const resolved = await resolvedResponse.json() as { installation: { endpoint: string }; bearerToken: string };
    if (new URL(request.url).searchParams.get("meta") === "1") return Response.json({ contextId, revision: descriptor.revision, uiModule: descriptor.uiModule }, { headers: { "cache-control": "no-store" } });
    const moduleResponse = await fetch(new URL(descriptor.uiModule.path, resolved.installation.endpoint), { headers: { authorization: `Bearer ${resolved.bearerToken}` }, cache: "no-store" });
    if (!moduleResponse.ok) throw new Error(`Context UI module returned HTTP ${moduleResponse.status}`);
    const source = await moduleResponse.text();
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== descriptor.uiModule.sha256) throw new Error("Context UI module digest does not match its activated descriptor");
    return new Response(source, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", etag: `"${digest}"`, "x-content-type-options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Context UI module failed" }, { status: 502 });
  }
}

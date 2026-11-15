import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TurnPromptConsole } from "../../../../../components/turn-prompt-console";
import { isAssetRouteSegments } from "../../../../../components/assets/asset-routes";

export const metadata: Metadata = { title: "Turn Prompt assets · OpenLeek" };

export default async function Page({ params }: { params: Promise<{ assetPath: string[] }> }) {
  const { assetPath } = await params;
  if (!isAssetRouteSegments(assetPath)) notFound();
  return <TurnPromptConsole />;
}

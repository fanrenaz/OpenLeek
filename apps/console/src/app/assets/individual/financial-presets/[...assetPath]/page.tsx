import { notFound } from "next/navigation";
import { FinancialPresetConsole } from "../../../../../components/financial-preset-console";
import { isAssetRouteSegments } from "../../../../../components/assets/asset-routes";

export default async function Page({ params }: { params: Promise<{ assetPath: string[] }> }) {
  const { assetPath } = await params;
  if (!isAssetRouteSegments(assetPath)) notFound();
  return <FinancialPresetConsole />;
}

import { ContextCollectionConsole } from "../../../../../../components/context-collection-console";

export default async function Page({ params }: { params: Promise<{ contextId: string; collectionId: string }> }) {
  const { contextId, collectionId } = await params;
  return <ContextCollectionConsole contextId={contextId} collectionId={collectionId} />;
}

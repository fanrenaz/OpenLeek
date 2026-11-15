import { DataDictionaryConsole } from "../../../components/data-dictionary/data-dictionary-console";

export default async function Page({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  return <DataDictionaryConsole initialEntryId={decodeURIComponent(entryId)} />;
}

import { DocumentClient } from "./DocumentClient";

export default function DocPage({ params }: { params: { docId: string } }) {
  return <DocumentClient docId={params.docId} />;
}

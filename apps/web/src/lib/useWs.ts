"use client";

import { useEffect, useMemo, useRef } from "react";
import { WsClient } from "./ws";

/**
 * React hook that provides a stable WsClient instance per docId.
 * The consumer wires onMessage / onOpen callbacks as needed.
 */
export function useWs(docId: number | string | null | undefined): WsClient | null {
  const ref = useRef<WsClient | null>(null);
  const memoKey = docId == null ? null : String(docId);

  const client = useMemo(() => {
    if (memoKey == null) return null;
    const c = new WsClient(memoKey);
    ref.current = c;
    return c;
  }, [memoKey]);

  useEffect(() => {
    if (!client) return;
    client.connect();
    return () => client.close();
  }, [client]);

  return client;
}

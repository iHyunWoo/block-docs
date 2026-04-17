import { API_URL } from "./env";
import type {
  BlockOperation,
  BlocksResponse,
  PresignResponse,
  User,
} from "./types";

const jsonHeaders = { "Content-Type": "application/json" } as const;

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchBlocks(docId: number | string): Promise<BlocksResponse> {
  const res = await fetch(`${API_URL}/api/v1/docs/${docId}/blocks`, {
    credentials: "include",
  });
  return handle<BlocksResponse>(res);
}

export async function postOperations(
  docId: number | string,
  clientSeq: number,
  ops: BlockOperation[],
): Promise<{ results: Array<{ blockId: string; newVersion: number; status: "applied" | "conflict" }> }> {
  const res = await fetch(`${API_URL}/api/v1/docs/${docId}/operations`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ clientSeq, ops }),
  });
  return handle(res);
}

export async function fetchMe(): Promise<User> {
  const res = await fetch(`${API_URL}/api/v1/users/me`, {
    credentials: "include",
  });
  return handle<User>(res);
}

export async function presignImage(
  contentType: string,
  size: number,
): Promise<PresignResponse> {
  const res = await fetch(`${API_URL}/api/v1/images/presign`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ contentType, size }),
  });
  return handle<PresignResponse>(res);
}

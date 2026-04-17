import { v7 as uuidv7 } from "uuid";

/** Client-generated UUIDv7. Used for new blocks so server never re-issues ids. */
export function newBlockId(): string {
  return uuidv7();
}

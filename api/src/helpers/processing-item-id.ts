import { ProcessingItemType } from "../types";

export type ProcessingItemId = string | number;

export function normalizeProcessingId(id: ProcessingItemId): string {
  return String(id);
}

export function normalizeProcessingItemId<T extends ProcessingItemType>(
  item: T,
): T {
  item.id = normalizeProcessingId(item.id);
  return item;
}

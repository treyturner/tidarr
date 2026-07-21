import { queueDb } from "../services/db-json";
import { ProcessingItemType } from "../types";

import {
  normalizeProcessingId,
  normalizeProcessingItemId,
  ProcessingItemId,
} from "./processing-item-id";

const QUEUE_PATH = "/";

export function insertBeforeFirstQueued<T extends { status: string }>(
  list: T[],
  ...items: T[]
): void {
  const firstQueueIndex = list.findIndex((i) => i.status === "queue_download");
  if (firstQueueIndex !== -1) {
    list.splice(firstQueueIndex, 0, ...items);
  } else {
    list.push(...items);
  }
}

function cleanItemBeforeSave(item: ProcessingItemType): ProcessingItemType {
  normalizeProcessingItemId(item);
  delete item.process;
  delete item.progress;
  delete item.retryCount;
  delete item.networkError;
  delete item.skipped;

  return item;
}

// In-memory cache to avoid disk reads
let queueCache: ProcessingItemType[] | null = null;
let queueCacheMap: Map<string, ProcessingItemType> | null = null;

/**
 * Load queue from file (only on first call, then uses cache)
 */
export async function loadQueueFromFile(): Promise<ProcessingItemType[]> {
  if (queueCache !== null) {
    return queueCache;
  }

  let data: unknown;
  try {
    data = await queueDb.getData(QUEUE_PATH);
  } catch {
    // Database doesn't exist yet or path not found, initialize with empty array
    await queueDb.push(QUEUE_PATH, []);
    queueCache = [];
    queueCacheMap = new Map();
    return queueCache;
  }

  const records: ProcessingItemType[] = Array.isArray(data) ? data : [];
  let migratedIds = 0;

  queueCache = records.map((item) => {
    const originalId: unknown = item.id;
    normalizeProcessingItemId(item);
    if (originalId !== item.id) migratedIds += 1;
    return item;
  });
  queueCacheMap = new Map(queueCache.map((item) => [item.id, item]));

  if (migratedIds > 0) {
    await queueDb.push(QUEUE_PATH, queueCache);
    console.log(
      `✅ [QUEUE] Normalized ${migratedIds} persisted processing item ID(s).`,
    );
  }

  return queueCache;
}

export const addItemToFile = async (
  item: ProcessingItemType,
  insertAtFront?: boolean,
) => {
  normalizeProcessingItemId(item);
  const saveList = await loadQueueFromFile();

  // Check if item with this ID already exists
  if (queueCacheMap?.has(item.id)) {
    return;
  }

  item = cleanItemBeforeSave(item);

  if (insertAtFront) {
    insertBeforeFirstQueued(saveList, item);
  } else {
    saveList.push(item);
  }

  queueCache = saveList;
  queueCacheMap?.set(item.id, item);

  // Write to disk (auto-saves with saveOnPush=true)
  await queueDb.push(QUEUE_PATH, saveList);
};

export const addItemsToFile = async (
  items: ProcessingItemType[],
  insertAtFront?: boolean,
) => {
  items.forEach(normalizeProcessingItemId);
  const saveList = await loadQueueFromFile();

  const newItems = items
    .filter((item) => !queueCacheMap?.has(item.id))
    .map((item) => cleanItemBeforeSave(item));

  if (newItems.length === 0) return;

  if (insertAtFront) {
    insertBeforeFirstQueued(saveList, ...newItems);
  } else {
    saveList.push(...newItems);
  }

  queueCache = saveList;
  for (const item of newItems) {
    queueCacheMap?.set(item.id, item);
  }

  await queueDb.push(QUEUE_PATH, saveList);
};

export const clearQueueFile = async () => {
  queueCache = [];
  queueCacheMap = new Map();
  await queueDb.push(QUEUE_PATH, []);
};

export const removeItemsFromFile = async (ids: ProcessingItemId[]) => {
  const saveList = await loadQueueFromFile();
  const normalizedIds = ids.map(normalizeProcessingId);
  const idSet = new Set(normalizedIds);
  const filteredList = saveList.filter((item) => !idSet.has(item.id));
  queueCache = filteredList;
  for (const id of normalizedIds) queueCacheMap?.delete(id);
  await queueDb.push(QUEUE_PATH, filteredList);
};

export const removeItemFromFile = async (id: ProcessingItemId) => {
  const normalizedId = normalizeProcessingId(id);
  const saveList = await loadQueueFromFile();
  const filteredList = saveList.filter((item) => item.id !== normalizedId);

  // Update cache
  queueCache = filteredList;
  queueCacheMap?.delete(normalizedId);

  // Write to disk (auto-saves with saveOnPush=true)
  await queueDb.push(QUEUE_PATH, filteredList);
};

export const updateItemInQueueFile = async (item: ProcessingItemType) => {
  normalizeProcessingItemId(item);
  const saveList = await loadQueueFromFile();

  // O(1) lookup using Map instead of O(n) findIndex
  if (!queueCacheMap?.has(item.id)) {
    // Item not found - it may have been removed already (e.g., auto-remove finished items)
    // This is not an error, just skip the update
    console.log(
      `[QUEUE] Item ${item.id} not found in queue file - may have been removed already`,
    );
    return;
  }

  const itemIndex = saveList.findIndex((current) => current.id === item.id);

  item = cleanItemBeforeSave(item);

  // Keep in queue, just update
  saveList[itemIndex] = { ...item };

  // Update cache
  queueCache = saveList;
  queueCacheMap?.set(item.id, item);

  // Write to disk (auto-saves with saveOnPush=true)
  await queueDb.push(QUEUE_PATH, saveList);
};

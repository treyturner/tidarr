import { getAppInstance } from "../helpers/app-instance";
import { historyDb } from "../services/db-json";

const QUEUE_PATH = "/";
let pendingHistoryWrite: Promise<void> = Promise.resolve();

function serializeHistoryWrite(write: () => Promise<void>): Promise<void> {
  const queuedWrite = pendingHistoryWrite.then(write, write);
  pendingHistoryWrite = queuedWrite.catch(() => undefined);
  return queuedWrite;
}

export async function loadHistoryFromFile(): Promise<string[]> {
  if (process.env.ENABLE_HISTORY !== "true") {
    return [];
  }

  try {
    const data = await historyDb.getData(QUEUE_PATH);
    console.log("✅ [HISTORY] Processing history loaded.");
    // Convert numeric-keyed object to array of values
    return Array.isArray(data) ? data : Object.values(data);
  } catch {
    // Database doesn't exist yet or path not found, initialize with empty array
    await historyDb.push(QUEUE_PATH, []);
    return [];
  }
}

export async function addItemToHistory(itemId: string) {
  if (process.env.ENABLE_HISTORY !== "true") {
    return;
  }

  const app = getAppInstance();
  const id = itemId.toString();

  // O(1) lookup using Set instead of O(n) array.includes()
  if (app.locals.historySet.has(id)) {
    return;
  }

  app.locals.history.push(id);
  app.locals.historySet.add(id);

  // Write only the new item at the end of the array (more efficient than rewriting entire file)
  const newIndex = app.locals.history.length - 1;
  await serializeHistoryWrite(() => historyDb.push(`/${newIndex}`, id, false));
  console.log(`✅ [HISTORY] Item "${id}" added to history.`);
}

export async function removeItemFromHistory(itemId: string): Promise<boolean> {
  if (process.env.ENABLE_HISTORY !== "true") {
    return false;
  }

  const app = getAppInstance();
  const id = itemId.toString();

  if (!app.locals.historySet.has(id) && !app.locals.history.includes(id)) {
    return false;
  }

  const nextHistory = app.locals.history.filter(
    (historyId: string) => historyId !== id,
  );

  // Persist first so a failed write leaves the in-memory history and the
  // processing item available for a later acknowledgement retry.
  await serializeHistoryWrite(() => historyDb.push(QUEUE_PATH, nextHistory));

  app.locals.history = nextHistory;
  app.locals.historySet.delete(id);

  console.log(`🧹 [HISTORY] Item "${id}" removed from history.`);
  return true;
}

export async function flushHistory() {
  if (process.env.ENABLE_HISTORY !== "true") {
    return;
  }

  const app = getAppInstance();
  app.locals.history = [];
  app.locals.historySet.clear();

  await serializeHistoryWrite(() => historyDb.push(QUEUE_PATH, []));

  console.log("🚽 [HISTORY] History has been flushed.");
}

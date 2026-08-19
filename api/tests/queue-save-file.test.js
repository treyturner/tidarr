const assert = require("node:assert/strict");
const test = require("node:test");

const { queueDb } = require("../dist/src/services/db-json.js");
const {
  addItemsToFile,
  clearQueueFile,
  loadQueueFromFile,
  updateItemsInQueueFile,
} = require("../dist/src/helpers/queue_save_file.js");

test("persisted numeric processing IDs are migrated to strings", async (t) => {
  const persistedItem = {
    id: 515863434,
    artist: "Tricky",
    title: "Different When It's Silent",
    type: "album",
    status: "finished",
    quality: "high",
    url: "album/515863434",
    loading: false,
    error: false,
    source: "tidarr",
  };
  const writes = [];

  t.mock.method(queueDb, "getData", async () => [persistedItem]);
  t.mock.method(queueDb, "push", async (path, value) => {
    writes.push([path, value]);
  });

  const records = await loadQueueFromFile();

  assert.equal(records[0].id, "515863434");
  assert.equal(typeof records[0].id, "string");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "/");
  assert.equal(writes[0][1][0].id, "515863434");
});

test("bulk queue updates persist only matching items", async (t) => {
  const writes = [];
  t.mock.method(queueDb, "getData", async () => []);
  t.mock.method(queueDb, "push", async (path, value) => {
    writes.push([path, value]);
  });

  await clearQueueFile();
  await addItemsToFile([
    {
      id: "1",
      artist: "Daft Punk",
      title: "Discovery",
      type: "album",
      status: "error",
      quality: "high",
      url: "album/1",
      loading: false,
      error: true,
      source: "tidarr",
    },
    {
      id: "2",
      artist: "Daft Punk",
      title: "Homework",
      type: "album",
      status: "finished",
      quality: "high",
      url: "album/2",
      loading: false,
      error: false,
      source: "tidarr",
    },
  ]);

  await updateItemsInQueueFile([
    {
      id: "1",
      artist: "Daft Punk",
      title: "Discovery",
      type: "album",
      status: "queue_download",
      quality: "high",
      url: "album/1",
      loading: false,
      error: false,
      retryCount: 0,
      networkError: false,
      source: "tidarr",
    },
    {
      id: "missing",
      artist: "Missing",
      title: "Missing",
      type: "album",
      status: "queue_download",
      quality: "high",
      url: "album/missing",
      loading: false,
      error: false,
      source: "tidarr",
    },
  ]);

  const records = await loadQueueFromFile();

  assert.equal(records.length, 2);
  assert.equal(records[0].status, "queue_download");
  assert.equal(records[0].error, false);
  assert.equal(records[0].retryCount, undefined);
  assert.equal(records[0].networkError, undefined);
  assert.equal(records[1].status, "finished");
  assert.equal(writes.at(-1)[1][0].id, "1");
  assert.equal(writes.at(-1)[1][1].id, "2");
});

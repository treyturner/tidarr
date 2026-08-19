const assert = require("node:assert/strict");
const fsPromises = require("fs/promises");
const test = require("node:test");

const { setAppInstance } = require("../dist/src/helpers/app-instance.js");
const {
  handleAddUrlRequest,
  handleHistoryRequest,
  handleQueueRequest,
} = require("../dist/src/lidarr/downloader.js");
const {
  createNzoId,
  extractItemIdFromNzoId,
  formatBytes,
  mapItemToHistorySlot,
  mapItemToQueueSlot,
} = require("../dist/src/lidarr/utils/nzb.js");
const { historyDb } = require("../dist/src/services/db-json.js");
const { addItemToHistory } = require("../dist/src/services/history.js");
const {
  normalizeProcessingItemId,
} = require("../dist/src/helpers/processing-item-id.js");
const tidalSearchAlbums = require("../dist/src/lidarr/utils/tidal-search-albums.js");

function processingItem(overrides = {}) {
  return {
    id: "34277251",
    artist: "Daft Punk",
    title: "Random Access Memories",
    type: "album",
    status: "finished",
    quality: "high",
    url: "https://www.tidal.com/album/34277251",
    loading: false,
    error: false,
    source: "tidarr",
    outputPaths: ["Daft Punk/2013 - Random Access Memories"],
    ...overrides,
  };
}

function responseRecorder() {
  return {
    body: undefined,
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function installApp(items, overrides = {}) {
  const processingStack = {
    data: items,
    actions: {
      getItem(id) {
        return items.find((item) => item.id === id);
      },
      async removeItem(id) {
        const index = items.findIndex((item) => item.id === id);
        if (index !== -1) items.splice(index, 1);
      },
      getQueueStatus() {
        return { isPaused: false };
      },
      ...overrides.actions,
    },
  };

  const app = {
    locals: {
      processingStack,
      history: overrides.history || [],
      historySet: new Set(overrides.history || []),
    },
  };

  setAppInstance(app);
  return app;
}

test("source-specific nzo_ids are opaque and reversible", () => {
  assert.equal(createNzoId("123", "lidarr"), "lidarr_nzo_123");
  assert.equal(createNzoId("123", "tidarr"), "tidarr_nzo_123");
  assert.deepEqual(extractItemIdFromNzoId("lidarr_nzo_123"), {
    itemId: "123",
    source: "lidarr",
  });
  assert.deepEqual(extractItemIdFromNzoId("tidarr_nzo_123"), {
    itemId: "123",
    source: "tidarr",
  });
  assert.equal(extractItemIdFromNzoId("unknown_nzo_123"), null);
});

test("numeric processing IDs are normalized to strings", () => {
  const item = processingItem({ id: 515863434 });

  normalizeProcessingItemId(item);

  assert.equal(item.id, "515863434");
  assert.equal(typeof item.id, "string");
});

test("addfile returns the same Lidarr ID used by queue and history", async (t) => {
  const queued = [];
  t.mock.method(
    tidalSearchAlbums,
    "addAlbumToQueue",
    async (albumId, quality) => {
      queued.push([albumId, quality]);
    },
  );

  const boundary = "tidarr-test-boundary";
  const nzb = '<meta type="title">Tidarr Album 34277251|high</meta>';
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"; filename="album.nzb"',
      "Content-Type: application/x-nzb",
      "",
      nzb,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  const res = responseRecorder();

  await handleAddUrlRequest(
    {
      query: { mode: "addfile" },
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    },
    res,
  );

  assert.deepEqual(queued, [["34277251", "high"]]);
  assert.deepEqual(res.body, {
    status: true,
    nzo_ids: ["lidarr_nzo_34277251"],
  });
});

test("queue and history slots keep Lidarr IDs consistent", async () => {
  const item = processingItem({
    source: "lidarr",
    outputPaths: undefined,
    completedAt: 1787050000,
  });

  assert.equal(mapItemToQueueSlot(item, false).nzo_id, "lidarr_nzo_34277251");

  const historySlot = await mapItemToHistorySlot(item);
  assert.equal(historySlot.nzo_id, "lidarr_nzo_34277251");
  assert.equal(historySlot.storage, "/downloads/34277251");
  assert.equal(historySlot.completed, 1787050000);
  assert.equal(historySlot.tidarr_source, "lidarr");
  assert.deepEqual(historySlot.tidarr_relative_paths, ["34277251"]);
});

test("native history slots expose every safe relative output path", async () => {
  const slot = await mapItemToHistorySlot(
    processingItem({
      outputPaths: [
        "Daft Punk/2013 - Random Access Memories",
        "./Daft Punk/2013 - Random Access Memories/CD02",
        "../outside",
        "/absolute",
      ],
    }),
  );

  assert.equal(slot.nzo_id, "tidarr_nzo_34277251");
  assert.equal(
    slot.storage,
    "/downloads/Daft Punk/2013 - Random Access Memories",
  );
  assert.equal(slot.tidarr_source, "tidarr");
  assert.deepEqual(slot.tidarr_relative_paths, [
    "Daft Punk/2013 - Random Access Memories",
    "Daft Punk/2013 - Random Access Memories/CD02",
  ]);
});

test("history returns terminal jobs from both Tidarr sources", async () => {
  installApp([
    processingItem({ id: "1", source: "lidarr", outputPaths: undefined }),
    processingItem({ id: "2", source: "tidarr" }),
    processingItem({ id: "3", source: "tidarr", status: "download" }),
  ]);

  const res = responseRecorder();
  await handleHistoryRequest({ query: { mode: "history", limit: "50" } }, res);

  assert.equal(res.body.history.noofslots, 2);
  assert.deepEqual(
    res.body.history.slots.map((slot) => slot.nzo_id),
    ["tidarr_nzo_2", "lidarr_nzo_1"],
  );
});

test("history pagination reports total terminal jobs", async () => {
  installApp([
    processingItem({ id: "1", source: "lidarr", outputPaths: undefined }),
    processingItem({ id: "2", source: "tidarr" }),
    processingItem({ id: "3", source: "tidarr" }),
    processingItem({ id: "4", source: "tidarr", status: "download" }),
  ]);

  const res = responseRecorder();
  await handleHistoryRequest(
    { query: { mode: "history", start: "1", limit: "1" } },
    res,
  );

  assert.equal(res.body.history.noofslots, 3);
  assert.deepEqual(
    res.body.history.slots.map((slot) => slot.nzo_id),
    ["tidarr_nzo_2"],
  );
});

test("formatBytes emits SABnzbd-style byte sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 5.5), "5.5 MB");
});

test("completed Lidarr history slots include folder size", async (t) => {
  t.mock.method(fsPromises, "readdir", async (folderPath) => {
    const normalizedPath = String(folderPath);
    if (normalizedPath.endsWith("/34277251")) {
      return [
        {
          name: "disc",
          isDirectory: () => true,
          isFile: () => false,
        },
        {
          name: "cover.jpg",
          isDirectory: () => false,
          isFile: () => true,
        },
      ];
    }

    if (normalizedPath.endsWith("/34277251/disc")) {
      return [
        {
          name: "track.flac",
          isDirectory: () => false,
          isFile: () => true,
        },
      ];
    }

    return [];
  });
  t.mock.method(fsPromises, "stat", async (filePath) => ({
    size: String(filePath).endsWith("track.flac") ? 1536 : 512,
  }));

  const slot = await mapItemToHistorySlot(
    processingItem({
      source: "lidarr",
      outputPaths: undefined,
      completedAt: 1787050123,
    }),
  );

  assert.equal(slot.bytes, "2048");
  assert.equal(slot.size, "2.0 KB");
  assert.equal(slot.completed, 1787050123);
});

test("history deletion clears persistent history before processing state", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  const calls = [];
  t.mock.method(historyDb, "push", async (_path, history) => {
    calls.push(["history", history]);
  });

  const items = [processingItem({ id: "22" })];
  const app = installApp(items, {
    history: ["11", "22"],
    actions: {
      async removeItem(id) {
        calls.push(["processing", id]);
        items.splice(0, items.length);
      },
    },
  });

  const res = responseRecorder();
  await handleHistoryRequest(
    { query: { mode: "history", name: "delete", value: "tidarr_nzo_22" } },
    res,
  );

  assert.deepEqual(calls, [
    ["history", ["11"]],
    ["processing", "22"],
  ]);
  assert.deepEqual(app.locals.history, ["11"]);
  assert.equal(app.locals.historySet.has("22"), false);
  assert.deepEqual(res.body, { status: true, nzo_ids: ["tidarr_nzo_22"] });
});

test("history deletion removes legacy numeric-keyed processing items", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  t.mock.method(historyDb, "push", async () => undefined);

  const items = [processingItem({ id: 515863434 })];
  const app = installApp(items, { history: ["515863434"] });
  const res = responseRecorder();

  await handleHistoryRequest(
    {
      query: {
        mode: "history",
        name: "delete",
        value: "tidarr_nzo_515863434",
      },
    },
    res,
  );

  assert.deepEqual(items, []);
  assert.deepEqual(app.locals.history, []);
  assert.deepEqual(res.body, {
    status: true,
    nzo_ids: ["tidarr_nzo_515863434"],
  });
});

test("history deletion fails when processing state remains", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  t.mock.method(historyDb, "push", async () => undefined);

  const items = [processingItem({ id: "77" })];
  installApp(items, {
    history: ["77"],
    actions: {
      async removeItem() {},
    },
  });
  const res = responseRecorder();

  await handleHistoryRequest(
    { query: { mode: "history", name: "delete", value: "tidarr_nzo_77" } },
    res,
  );

  assert.equal(items.length, 1);
  assert.deepEqual(res.body, {
    status: false,
    error: "Error: Failed to remove processing item 77",
  });
});

test("history acknowledgement waits for an in-flight persistent add", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  t.after(() => releaseFirstWrite());

  const writes = [];
  t.mock.method(historyDb, "push", async (path, value) => {
    writes.push([path, value]);
    if (writes.length === 1) await firstWrite;
  });

  let processingRemovals = 0;
  const items = [processingItem({ id: "33" })];
  installApp(items, {
    actions: {
      async removeItem() {
        processingRemovals += 1;
        items.splice(0, items.length);
      },
    },
  });

  const addPromise = addItemToHistory("33");
  await Promise.resolve();

  const res = responseRecorder();
  const deletePromise = handleHistoryRequest(
    { query: { mode: "history", name: "delete", value: "tidarr_nzo_33" } },
    res,
  );
  await Promise.resolve();

  assert.equal(processingRemovals, 0);
  assert.deepEqual(writes, [["/0", "33"]]);

  releaseFirstWrite();
  await Promise.all([addPromise, deletePromise]);

  assert.deepEqual(writes, [
    ["/0", "33"],
    ["/", []],
  ]);
  assert.equal(processingRemovals, 1);
  assert.deepEqual(res.body, { status: true, nzo_ids: ["tidarr_nzo_33"] });
});

test("queue deletion does not clear persistent downloaded history", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  let historyWrites = 0;
  t.mock.method(historyDb, "push", async () => {
    historyWrites += 1;
  });

  const items = [processingItem({ id: "44", source: "lidarr" })];
  const app = installApp(items, { history: ["44"] });
  const res = responseRecorder();

  await handleQueueRequest(
    { query: { mode: "queue", name: "delete", value: "lidarr_nzo_44" } },
    res,
  );

  assert.equal(historyWrites, 0);
  assert.deepEqual(app.locals.history, ["44"]);
  assert.deepEqual(res.body, { status: true, nzo_ids: ["lidarr_nzo_44"] });
});

test("a persistent history write failure retains the processing row", async (t) => {
  const previousEnableHistory = process.env.ENABLE_HISTORY;
  process.env.ENABLE_HISTORY = "true";
  t.after(() => {
    if (previousEnableHistory === undefined) {
      delete process.env.ENABLE_HISTORY;
    } else {
      process.env.ENABLE_HISTORY = previousEnableHistory;
    }
  });

  t.mock.method(historyDb, "push", async () => {
    throw new Error("history disk unavailable");
  });

  let processingRemovals = 0;
  const items = [processingItem({ id: "66" })];
  const app = installApp(items, {
    history: ["66"],
    actions: {
      async removeItem() {
        processingRemovals += 1;
      },
    },
  });
  const res = responseRecorder();

  await handleHistoryRequest(
    { query: { mode: "history", name: "delete", value: "tidarr_nzo_66" } },
    res,
  );

  assert.equal(processingRemovals, 0);
  assert.deepEqual(app.locals.history, ["66"]);
  assert.equal(app.locals.historySet.has("66"), true);
  assert.equal(items.length, 1);
  assert.deepEqual(res.body, {
    status: false,
    error: "Error: history disk unavailable",
  });
});

test("history deletion is idempotent when both records are already absent", async () => {
  installApp([]);
  const res = responseRecorder();

  await handleHistoryRequest(
    { query: { mode: "history", name: "delete", value: "tidarr_nzo_55" } },
    res,
  );

  assert.deepEqual(res.body, { status: true, nzo_ids: ["tidarr_nzo_55"] });
});

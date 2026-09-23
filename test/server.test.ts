import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../host.ts";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const threadId = "thread-test";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  let queue: any[] = [];
  let sendGate: ReturnType<typeof gate> | undefined;
  let updateGate: ReturnType<typeof gate> | undefined;
  let outputGate: ReturnType<typeof gate> | undefined;
  let targetGate: ReturnType<typeof gate> | undefined;
  let failDelete = false;
  let archivedAt: number | null = null;
  let outputDir: string | undefined;
  const manager = new TaskManager();
  let failSend = false;
  let failClear = false;
  let offline = false;
  let loseStartResponse = false;
  let conflict = false;
  let sends = 0;
  const records = new Map<string, any>();
  const host = createFakePluginHost({
    pluginId: "shell-tasks",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: threadId, environmentId: "env-test", archivedAt }),
        storageLocation: async () => ({ hostId: "host-test", storageRootPath: "/tmp/test" }),
        send: async ({ input }: any) => {
          sends++;
          if (failSend) throw new Error("send offline");
          if (sendGate) await sendGate.promise;
          const row = { id: `q${sends}`, updatedAt: sends, content: input };
          queue.push(row);
          return { delivery: "queued", queuedMessage: row };
        },
        queuedMessages: {
          list: async () => structuredClone(queue),
          update: async ({ queuedMessageId, expectedUpdatedAt, input }: any) => {
            if (updateGate) await updateGate.promise;
            const row = queue.find((item) => item.id === queuedMessageId);
            if (conflict || !row || row.updatedAt !== expectedUpdatedAt) throw new Error("queue conflict");
            row.content = input;
            row.updatedAt++;
            return row;
          },
          delete: async ({ queuedMessageId }: any) => {
            if (failDelete) throw new Error("delete offline");
            queue = queue.filter((item) => item.id !== queuedMessageId);
            return { deleted: true };
          },
        },
      },
      environments: { get: async () => {
        if (targetGate) await targetGate.promise;
        return { id: "env-test", hostId: "host-test", status: "ready", path: "/tmp" };
      } },
    } as any, // SDK transport fixture; the harness validates the plugin's wire contracts.
    experimental_callHostRpc: async ({ method, input }) => {
      const value = input as any;
      if (offline) throw new Error("host offline");
      if (method === "start") {
        records.set(value.key, { pid: 123, logPath: "/tmp/task.log", startedAt: Date.now(), status: "running" });
        if (loseStartResponse) throw new Error("response lost");
        return records.get(value.key);
      }
      if (method === "adopt") return records.get(value.key);
      if (method === "tail" || method === "read") {
        if (outputDir) return method === "read"
          ? manager.read(value.key, value.id, outputDir, value.cursor, value.snapToLine)
          : manager.tail(value.key, outputDir, value.lines);
        const output = records.get(value.key)?.status === "running" ? "partial\n" : "done\n";
        if (outputGate) await outputGate.promise;
        return { output, ...(method === "tail" ? { earlier: false } : { more: false }), total_bytes: output.length, next_cursor: output.length };
      }
      if (method === "clear") {
        if (failClear) throw new Error("clear offline");
        records.delete(value.key); return { cleared: true };
      }
      if (method === "stop") {
        const result = { status: "stopped", endedAt: Date.now(), exitCode: null, signal: "SIGTERM", reason: value.reason };
        Object.assign(records.get(value.key), result);
        return result;
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  let current = host;
  await plugin(current.bb);
  current.harness.behavior.runService("reconcile");
  await flush();
  const row = (id: number): any => current.bb.storage.database().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  const complete = async (id: number, signal = true) => {
    const task = row(id);
    const payload = { key: task.task_key, status: "success", endedAt: Date.now(), exitCode: 0,
      signal: null, output: "done\n", earlier: false, totalOutputBytes: 5, logPath: "/tmp/task.log", notify: true };
    Object.assign(records.get(task.task_key), { status: "success", completion: payload });
    if (signal) await current.harness.behavior.experimental_emitHostSignal("host-test", "complete", payload);
  };
  return {
    row, complete,
    tool: (input: unknown, signal?: AbortSignal) => current.harness.behavior.callAgentTool("task", input, { signal }),
    setTargetGate: (value?: ReturnType<typeof gate>) => { targetGate = value; },
    setArchived: () => { archivedAt = Date.now(); },
    setFailDelete: (value: boolean) => { failDelete = value; },
    cancelQueue: (id: string) => { queue = queue.filter((item) => item.id !== id); },
    setOutput: (id: number, output: string) => {
      outputDir ??= mkdtempSync(join(tmpdir(), "shell-cursor-test-"));
      mkdirSync(join(outputDir, "logs"), { recursive: true });
      const key = createHash("sha256").update(row(id).task_key).digest("hex");
      writeFileSync(join(outputDir, "logs", `${key}.log`), output);
    },
    get: () => current,
    queueIds: () => queue.flatMap((row) => { const payload = JSON.parse(row.content[0].text); return (payload.tasks ?? [payload]).map((item: any) => item.task_id); }),
    queueCount: () => queue.length,
    sends: () => sends,
    setSendGate: (value?: ReturnType<typeof gate>) => { sendGate = value; },
    setUpdateGate: (value?: ReturnType<typeof gate>) => { updateGate = value; },
    setOutputGate: (value?: ReturnType<typeof gate>) => { outputGate = value; },
    setOffline: (value: boolean) => { offline = value; },
    setFailSend: (value: boolean) => { failSend = value; },
    setFailClear: (value: boolean) => { failClear = value; },
    setConflict: (value: boolean) => { conflict = value; },
    loseStart: () => { loseStartResponse = true; },
    reload: async () => {
      current = await current.harness.lifecycle.reload(plugin);
      current.harness.behavior.runService("reconcile");
      await flush();
    },
    dispose: async () => {
      await current.harness.lifecycle.dispose();
      await manager.shutdown();
      if (outputDir) rmSync(outputDir, { recursive: true, force: true });
    },
  };
}

test("in-flight target lookup cannot escape archive, deletion or cancellation", async () => {
  for (const event of ["thread.archived", "thread.deleted", "cancel"] as const) {
    const h = await setup();
    try {
      const lookup = gate(); h.setTargetGate(lookup);
      const controller = new AbortController();
      const starting = h.tool({ action: "start", command: "sleep 30" }, controller.signal);
      await flush();
      if (event === "cancel") controller.abort();
      else await h.get().harness.behavior.emitThreadEvent(event, { thread: makeThreadResponse({ id: threadId }) });
      const rejected = assert.rejects(starting, /archived|deleted|abort/i);
      lookup.resolve(); await rejected;
      await h.reload();
      assert.equal(h.row(1), undefined);
      assert.equal(h.get().harness.inspection.experimental_hostRpcCalls.length, 0);
    } finally { await h.dispose(); }
  }
});

test("already archived threads cannot start tasks", async () => {
  const h = await setup();
  try {
    h.setArchived();
    await assert.rejects(h.tool({ action: "start", command: "true" }), /archived/);
    assert.equal(h.row(1), undefined);
  } finally { await h.dispose(); }
});

test("stale queue lookup retains unrelated acknowledged prune retries across reload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    await h.tool({ action: "start", command: "true" }); await h.complete(1);
    t.mock.timers.tick(3_000); await flush();
    h.setFailDelete(true);
    await h.tool({ action: "tail", id: 1 });
    const pruneId = h.row(1).completion_queue_id;
    assert.ok(pruneId);
    await h.tool({ action: "start", command: "true" }); await h.complete(2);
    t.mock.timers.tick(3_000); await flush();
    h.setFailDelete(false);
    h.cancelQueue(h.row(2).completion_queue_id);
    await h.tool({ action: "start", command: "true" }); await h.complete(3);
    t.mock.timers.tick(3_000); await flush();
    assert.equal(h.row(1).completion_queue_id, pruneId);
    await h.reload();
    assert.deepEqual(h.queueIds(), [3]);
    assert.equal(h.row(1).completion_queue_id, null);
  } finally { await h.dispose(); }
});

test("progress tail preserves a long-line read continuation across reload", async () => {
  const h = await setup();
  try {
    await h.tool({ action: "start", command: "true" }); await h.complete(1);
    h.setOutput(1, "a".repeat(51200) + "UNREAD-MARKER" + "b".repeat(51200));
    const first = JSON.parse(await h.tool({ action: "read", id: 1 }) as string);
    assert.equal(first.next_cursor, 51200);
    const tail = JSON.parse(await h.tool({ action: "tail", id: 1 }) as string);
    assert.equal(tail.output.includes("UNREAD-MARKER"), false);
    await h.reload();
    const next = JSON.parse(await h.tool({ action: "read", id: 1, cursor: first.next_cursor }) as string);
    assert.ok(next.output.startsWith("UNREAD-MARKER"));
    assert.equal(next.more, true);
    assert.equal(h.row(1).completion_acknowledged, 0);
    // Both issued cursors remain valid; an unrelated offset still snaps to the next line.
    h.setOutput(1, "a".repeat(51200) + "UNREAD-MARKER" + "b".repeat(51200) + "\nnew partial\n");
    const fromTail = JSON.parse(await h.tool({ action: "read", id: 1, cursor: tail.next_cursor }) as string);
    assert.equal(fromTail.output, "\nnew partial\n");
    const arbitrary = JSON.parse(await h.tool({ action: "read", id: 1, cursor: 12 }) as string);
    assert.equal(arbitrary.output, "new partial\n");
  } finally { await h.dispose(); }
});

test("retained starts and recovered metadata invalidate task lists without notifications", async () => {
  const h = await setup();
  try {
    h.loseStart();
    await assert.rejects(h.tool({ action: "start", command: "sleep 30" }), /retained for recovery/);
    const signals = h.get().harness.inspection.realtimeSignals;
    assert.equal(signals.length, 1);
    assert.equal((signals[0].payload as any).notify, false);
    assert.equal((signals[0].payload as any).status, "running");
    await h.get().harness.behavior.experimental_emitHostWorkerExit("host-test");
    assert.equal(h.row(1).pid, 123);
    assert.equal(h.row(1).error, null);
    assert.equal(signals.length, 2);
    assert.equal((signals[1].payload as any).notify, false);
    await h.get().harness.behavior.experimental_emitHostWorkerExit("host-test");
    assert.equal(signals.length, 2, "unchanged adoption must not cause a refresh loop");
  } finally { await h.dispose(); }
});

test("durable batches recover after reload and failed delivery, without replaying accepted sends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    await h.tool({ action: "start", command: "true" });
    await h.complete(1);
    await h.reload();
    h.setFailSend(true);
    t.mock.timers.tick(3_000); await flush();
    assert.ok(h.row(1).completion_pending);
    h.setFailSend(false);
    t.mock.timers.tick(10_000); await flush();
    t.mock.timers.tick(3_000); await flush();
    assert.deepEqual(h.queueIds(), [1]);
    assert.equal(h.row(1).completion_pending, null);
    const sends = h.sends();
    await h.reload();
    t.mock.timers.tick(13_000); await flush();
    assert.equal(h.sends(), sends);
  } finally { await h.dispose(); }
});

test("lost start responses and lost completion signals reconcile even with an existing worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    h.loseStart();
    await assert.rejects(h.tool({ action: "start", command: "true" }), /retained for recovery/);
    assert.equal(h.row(1).status, "running");
    await h.complete(1, false);
    t.mock.timers.tick(10_000); await flush();
    assert.equal(h.row(1).status, "success");
    assert.equal(h.row(1).pid, 123);
    t.mock.timers.tick(3_000); await flush();
    assert.deepEqual(h.queueIds(), [1]);
  } finally { await h.dispose(); }
});

test("acknowledgement during send and merge preserves only unacknowledged completions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    for (let id = 1; id <= 2; id++) { await h.tool({ action: "start", command: "true" }); await h.complete(id); }
    const sending = gate(); h.setSendGate(sending);
    t.mock.timers.tick(3_000); await flush();
    const ack = h.tool({ action: "tail", id: 1 });
    await flush(); sending.resolve(); await ack; await flush();
    assert.deepEqual(h.queueIds(), [2]);
    h.setSendGate();
    await h.tool({ action: "start", command: "true" }); await h.complete(3);
    const merging = gate(); h.setUpdateGate(merging);
    t.mock.timers.tick(3_000); await flush();
    const ack2 = h.tool({ action: "tail", id: 2 });
    await flush(); merging.resolve(); await ack2; await flush();
    assert.deepEqual(h.queueIds(), [3]);
    assert.equal(h.queueCount(), 1);
    h.setUpdateGate();
    await h.tool({ action: "start", command: "true" }); await h.complete(4);
    h.setConflict(true);
    t.mock.timers.tick(3_000); await flush();
    assert.ok(h.row(4).completion_pending);
    assert.equal(h.queueCount(), 1);
    h.setConflict(false);
    t.mock.timers.tick(10_000); await flush(); t.mock.timers.tick(3_000); await flush();
    assert.deepEqual(h.queueIds(), [3, 4]);
  } finally { await h.dispose(); }
});

test("concurrent acknowledgements during a queue update each prune their own completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    for (let id = 1; id <= 3; id++) { await h.tool({ action: "start", command: "true" }); await h.complete(id); }
    t.mock.timers.tick(3_000); await flush();
    const updating = gate(); h.setUpdateGate(updating);
    const first = h.tool({ action: "tail", id: 1 });
    await flush();
    const second = h.tool({ action: "tail", id: 2 });
    await flush();
    updating.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.queueIds(), [3]);
    assert.equal(h.row(1).completion_queue_id, null);
    assert.equal(h.row(2).completion_queue_id, null);
  } finally { await h.dispose(); }
});

test("read and tail do not acknowledge a pre-completion snapshot as final output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    for (const [index, action] of ["read", "tail"].entries()) {
      const id = index + 1;
      await h.tool({ action: "start", command: "printf partial; sleep 1; printf done" });
      const output = gate(); h.setOutputGate(output);
      const reading = h.tool({ action, id });
      await flush();
      await h.complete(id);
      output.resolve();
      const result = JSON.parse(await reading as string);
      assert.equal(result.status, "success");
      assert.equal(result.output, "done\n", `${action} must read the final snapshot before acknowledging`);
      assert.equal(h.row(id).completion_acknowledged, 1);
      h.setOutputGate();
    }
  } finally { await h.dispose(); }
});

test("task tool is available to Pi without a setting", async () => {
  const host = createFakePluginHost({ pluginId: "shell-tasks" });
  try {
    await plugin(host.bb);
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ provider: { id: "pi" } }),
    );
    assert.deepEqual(config.tools.map((tool) => tool.name), ["task"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("preference setting nudges agents away from provider background tasks", async () => {
  const host = createFakePluginHost({
    pluginId: "shell-tasks",
    settings: { preferOverNativeBackgroundTasks: true },
  });
  try {
    await plugin(host.bb);
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ provider: { id: "claude-code" } }),
    );
    assert.match(config.instructions ?? "", /Prefer the BB task tool over the provider's native background-task runner/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("offline archive and deletion retain ownership and retry stops and log cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await setup();
  try {
    await h.tool({ action: "start", command: "sleep 30" });
    h.setOffline(true);
    await h.get().harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: threadId }) });
    assert.equal(h.row(1).status, "running");
    assert.equal(h.row(1).pending_stop, "thread_archived");
    await h.get().harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: threadId }) });
    assert.equal(h.row(1).pending_delete, 1);
    assert.ok(h.get().harness.inspection.logEntries.some((entry) => entry.message.includes("host=host-test")));
    h.setOffline(false);
    h.setFailClear(true);
    await h.reload();
    assert.equal(h.row(1).status, "stopped");
    assert.equal(h.row(1).pending_delete, 1);
    h.setFailClear(false);
    t.mock.timers.tick(10_000); await flush();
    assert.equal(h.row(1), undefined);
    assert.equal(h.queueCount(), 0);
  } finally { await h.dispose(); }
});

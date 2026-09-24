import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const { act, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const app = await loadPluginApp(() => import("../app.tsx"));
const task = (id: number, status = "running") => ({ task_id: id, status, pid: 123, command: "true", started_at: new Date().toISOString(), ended_at: null, exit_code: null, signal: null, log_path: "/tmp/log" });
const detail = (id: number, output: string, status = "running") => ({ task: task(id, status), tail: { output, earlier: false, total_bytes: output.length, next_cursor: output.length } });

test("panel uses the Apple Reminder icon", () => {
  assert.equal(app.threadPanelActions[0].icon, "shell-tasks/apple-reminder");
});

test("task duration ticks while running and stays fixed when completed", async () => {
  const endedAt = Date.now();
  let current: any = {
    ...task(1),
    title: "Timed task",
    started_at: new Date(endedAt - 487_000).toISOString(),
  };
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test" } as any, {
    rpc: { tasks_list: () => ({ tasks: [current] }) },
  });
  try {
    await slot.findByText("8m 7s");
    await slot.findByText("8m 8s", {}, { timeout: 2_000 });
    current = { ...current, status: "success", ended_at: new Date(endedAt).toISOString() };
    await slot.behavior.emitRealtime("tasks-changed", { threadId: "thread-test", taskId: 1, status: "success", notify: false });
    await slot.findByText("8m 7s");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    assert.ok(slot.getByText("8m 7s"));
  } finally { slot.lifecycle.unmount(); }
});

test("sub-second task durations use milliseconds without showing zero", async () => {
  const instant = new Date().toISOString();
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test" } as any, {
    rpc: { tasks_list: () => ({ tasks: [{ ...task(1, "success"), started_at: instant, ended_at: instant }] }) },
  });
  try {
    await slot.findByText("1ms");
    assert.equal(slot.queryByText("0ms"), null);
    assert.equal(slot.queryByText("0s"), null);
  } finally { slot.lifecycle.unmount(); }
});

test("expanded output opens at the latest line", async () => {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 480 });
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test", params: { selectedId: 1 } } as any, {
    rpc: {
      tasks_list: async () => ({ tasks: [task(1, "success")] }),
      task_get: async () => detail(1, "first line\nlatest line", "success"),
    },
  });
  try {
    const output = await slot.findByText(/latest line/, { selector: "pre" });
    assert.equal(output.scrollTop, 480);
  } finally {
    slot.lifecycle.unmount();
    if (previous) Object.defineProperty(HTMLElement.prototype, "scrollHeight", previous);
    else delete (HTMLElement.prototype as any).scrollHeight;
  }
});

test("cards refresh running output without events and reconcile missed completion and clear on reconnect", async () => {
  let next: any = detail(1, "first");
  let calls = 0;
  const slot = renderSlot(app.messageDirectives[0], { attributes: { id: "1" }, message: { threadId: "thread-test" } } as any, {
    rpc: { task_get: async () => { calls++; return next; } }, realtimeConnectionState: "connected",
  });
  try {
    await slot.findByText("first");
    next = detail(1, "appended");
    await slot.findByText("appended", {}, { timeout: 3_000 });
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    next = detail(1, "completed output", "success");
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Completed");
    const stoppedAt = calls;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    assert.equal(calls, stoppedAt, "finished cards stop polling");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    next = { ...detail(1, ""), task: { task_id: 1, status: "cleared" } };
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Cleared");
    assert.equal(slot.queryByText("completed output"), null);
  } finally { slot.lifecycle.unmount(); }
});

test("message cards show the task duration", async () => {
  const endedAt = Date.now();
  const value: any = detail(1, "done", "success");
  value.task.title = "Timed card";
  value.task.started_at = new Date(endedAt - 487_000).toISOString();
  value.task.ended_at = new Date(endedAt).toISOString();
  const slot = renderSlot(app.messageDirectives[0], { attributes: { id: "1" }, message: { threadId: "thread-test" } } as any, {
    rpc: { task_get: async () => value },
  });
  try {
    await slot.findByText("8m 7s");
    assert.ok(slot.getByText("Completed"));
  } finally { slot.lifecycle.unmount(); }
});

test("late detail responses cannot overwrite the currently selected task", async () => {
  const pending: Array<(value: any) => void> = [];
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test", params: { selectedId: 1 } } as any, {
    rpc: {
      tasks_list: async () => ({ tasks: [task(1, "success"), task(2, "success")] }),
      task_get: ({ id }: any) => id === 1 ? new Promise((resolve) => pending.push(resolve)) : detail(2, "B output", "success"),
    },
  });
  try {
    fireEvent.click(await slot.findByRole("button", { name: /^Task #2/ }));
    await slot.findByText("B output");
    await act(async () => { for (const resolve of pending) resolve(detail(1, "A stale output", "success")); });
    assert.ok(slot.getByText("B output"));
    assert.equal(slot.queryByText("A stale output"), null);
    assert.equal(slot.queryByText("Loading output…"), null);
  } finally { slot.lifecycle.unmount(); }
});

for (const initial of [true, false]) {
  test(`${initial ? "initial" : "completion"} list failure offers a working retry`, async () => {
    let fail = initial;
    let completed = false;
    const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test" } as any, {
      rpc: { tasks_list: () => {
        if (fail) throw new Error("List unavailable");
        return { tasks: [task(1, completed ? "success" : "running")] };
      } },
    });
    try {
      if (!initial) {
        await slot.findByText("Running");
        fail = true;
        await slot.behavior.emitRealtime("tasks-changed", { threadId: "thread-test", taskId: 1, status: "success", notify: false });
      }
      await slot.findByRole("alert");
      assert.ok(!slot.queryByText("Loading tasks…"), "a failed initial list must not remain loading");
      fail = false; completed = true;
      const retry = slot.queryByRole("button", { name: "Retry" });
      assert.ok(retry, "a failed list must offer Retry");
      fireEvent.click(retry);
      await slot.findByText("Completed");
      assert.equal(slot.queryByRole("alert"), null);
      assert.equal(slot.queryByText("Running"), null);
    } finally { slot.lifecycle.unmount(); }
  });
}

test("delayed clear keeps the task selected while the request was pending", async () => {
  let resolve!: () => void;
  let cleared = false;
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test", params: { selectedId: 1 } } as any, {
    rpc: {
      tasks_list: () => ({ tasks: cleared ? [task(2)] : [task(1, "success"), task(2)] }),
      task_get: ({ id }: any) => detail(id, `${id} output`, id === 1 ? "success" : "running"),
      task_clear: () => new Promise((done) => {
        resolve = () => { cleared = true; done({ task_id: 1, status: "cleared", previous_status: "success" }); };
      }),
    },
  });
  try {
    await slot.findByText("1 output");
    fireEvent.click(slot.getByRole("button", { name: "Clear Task #1" }));
    fireEvent.click(slot.getByRole("button", { name: /^Task #2/ }));
    await slot.findByText("2 output");
    await act(async () => { resolve(); });
    assert.equal(slot.getByRole("button", { name: /^Task #2/ }).getAttribute("aria-expanded"), "true");
    assert.ok(slot.getByText("2 output"));
    assert.ok(!slot.queryByRole("alert"));
  } finally { slot.lifecycle.unmount(); }
});

test("late list responses cannot restore a running task after completion", async () => {
  const pending: Array<(value: any) => void> = [];
  let completed = false;
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "thread-test" } as any, {
    rpc: { tasks_list: () => completed ? { tasks: [task(1, "success")] } : new Promise((resolve) => pending.push(resolve)) },
  });
  try {
    completed = true;
    await slot.behavior.emitRealtime("tasks-changed", { threadId: "thread-test", taskId: 1, status: "success", notify: false });
    await slot.findByText("Completed");
    await act(async () => { for (const resolve of pending) resolve({ tasks: [task(1)] }); });
    assert.ok(slot.queryByText("Completed"), "older running lists must not overwrite the final list");
    assert.equal(slot.queryByRole("button", { name: "Stop" }), null);
  } finally { slot.lifecycle.unmount(); }
});

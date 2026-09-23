import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import {
  READ_MAX_BYTES,
  READ_MAX_LINES,
  TAIL_DEFAULT_LINES,
  clearedTaskSummarySchema,
  hostSignals,
  sanitizeOutput,
  taskToolInputSchema,
} from "../contract.ts";
import {
  TaskManager,
  completeUtf8Prefix,
  dropUtf8ContinuationPrefix,
  processGroupAlive,
} from "../host.ts";

const TASK_ENV = {
  BB_THREAD_ID: "thr_test",
  BB_PROJECT_ID: "proj_test",
  BB_ENVIRONMENT_ID: "env_test",
  BB_THREAD_STORAGE: "/tmp/thread-storage-test",
} as const;

function harness(dataDir: string) {
  const completions: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    lifecycle: { signal: controller.signal },
    experimental_paths: { dataDir, tempDir: dataDir },
    experimental_emitSignal: async (_name: string, payload: Record<string, unknown>) => {
      completions.push(payload);
    },
    experimental_retainWorker: () => ({ dispose: async () => {} }),
  } as unknown as ExperimentalHostRpcContext<typeof hostSignals>;
  return { completions, context };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met");
}

test("task input validates Unicode titles and tail lines", () => {
  assert.deepEqual(
    clearedTaskSummarySchema.parse({ task_id: 1, title: "done", status: "cleared" }),
    { task_id: 1, title: "done", status: "cleared" },
  );
  assert.equal(
    taskToolInputSchema.parse({ action: "start", title: "💩".repeat(120) }).title,
    "💩".repeat(120),
  );
  assert.throws(
    () => taskToolInputSchema.parse({ action: "start", title: "💩".repeat(121) }),
    /title must not exceed 120 characters/,
  );
  assert.equal(taskToolInputSchema.parse({ action: "tail", lines: 200 }).lines, 200);
  assert.throws(() => taskToolInputSchema.parse({ action: "tail", lines: 201 }));
});


test("ANSI control sequences are removed", () => {
  assert.equal(sanitizeOutput("\u001b[31mred\u001b[0m\n"), "red\n");
});

test("UTF-8 boundaries are not split", () => {
  const split = Buffer.concat([
    Buffer.alloc(READ_MAX_BYTES - 1, 0x61),
    Buffer.from([0xf0, 0x9f, 0x92, 0xa9]),
  ]);
  assert.equal(
    completeUtf8Prefix(split.subarray(0, READ_MAX_BYTES)).length,
    READ_MAX_BYTES - 1,
  );
  assert.equal(
    dropUtf8ContinuationPrefix(Buffer.from([0x9f, 0x92, 0xa9, 0x61])).toString(),
    "a",
  );
});

test("tail defaults to 50 lines and accepts a lower limit", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-tasks-tail-test-"));
  const manager = new TaskManager();
  const { context } = harness(dataDir);

  try {
    const envTask = await manager.start(
      "thread-env",
      `printf '%s\\n' "$BB_THREAD_ID|$BB_PROJECT_ID|$BB_ENVIRONMENT_ID|$BB_THREAD_STORAGE"`,
      process.cwd(),
      TASK_ENV,
      context,
    );
    await envTask.done;
    assert.equal(
      manager.tail("thread-env", dataDir).output,
      "thr_test|proj_test|env_test|/tmp/thread-storage-test\n",
    );

    const task = await manager.start(
      "tail-lines",
      `i=1; while [ "$i" -le 80 ]; do printf '\\033[31mwarning-%03d\\033[0m\\n' "$i"; i=$((i+1)); done`,
      process.cwd(),
      TASK_ENV,
      context,
    );
    await task.done;

    const defaultTail = manager.tail("tail-lines", dataDir);
    assert.equal(defaultTail.output.trimEnd().split("\n").length, TAIL_DEFAULT_LINES);
    assert.match(defaultTail.output, /^warning-031\n/);
    assert.equal(defaultTail.earlier, true);
    assert.equal("more" in defaultTail, false);
    assert.equal("truncated" in defaultTail, false);
    assert.equal(defaultTail.output.includes("\u001b"), false);

    const shortTail = manager.tail("tail-lines", dataDir, 5);
    assert.equal(shortTail.output, "warning-076\nwarning-077\nwarning-078\nwarning-079\nwarning-080\n");
    assert.equal(shortTail.earlier, true);

    const fullTail = manager.tail("tail-lines", dataDir, 200);
    assert.equal(fullTail.earlier, false);

    const readTask = await manager.start(
      "read-lines",
      `i=1; while [ "$i" -le 250 ]; do printf 'line-%03d\\n' "$i"; i=$((i+1)); done`,
      process.cwd(),
      TASK_ENV,
      context,
    );
    await readTask.done;
    const firstRead = manager.read("read-lines", 1, dataDir, 0);
    assert.equal(firstRead.output.trimEnd().split("\n").length, READ_MAX_LINES);
    assert.equal(firstRead.more, true);
  } finally {
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});


test("running reads hold incomplete lines without losing continuations", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-tasks-lines-test-"));
  const manager = new TaskManager();
  const { context } = harness(dataDir);

  try {
    const task = await manager.start(
      "partial-lines",
      "printf 'first line\\npartial-no-newline'; sleep 0.2; printf '...finished\\nlast\\n'",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await eventually(() =>
      manager.tail("partial-lines", dataDir).output.includes("partial-no-newline"),
    );
    assert.equal(
      manager.tail("partial-lines", dataDir).output,
      "first line\npartial-no-newline",
    );
    const first = manager.read("partial-lines", 1, dataDir, 0);
    assert.equal(first.output, "first line\n");
    assert.equal(first.next_cursor, Buffer.byteLength("first line\n"));

    await task.done;
    const second = manager.read(
      "partial-lines",
      1,
      dataDir,
      first.next_cursor,
      false,
    );
    assert.equal(second.output, "partial-no-newline...finished\nlast\n");
    assert.equal(second.more, false);

    const unterminated = await manager.start(
      "unterminated",
      "printf 'a\\nb'",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await unterminated.done;
    const finalRead = manager.read("unterminated", 2, dataDir, 0);
    assert.equal(finalRead.output, "a\nb");
    assert.equal(finalRead.more, false);
  } finally {
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("oversized UTF-8 lines advance and starts recover by key without rerunning", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-tasks-recovery-"));
  const manager = new TaskManager();
  const replacement = new TaskManager();
  const { context } = harness(dataDir);
  try {
    const task = await manager.start("large", `node -e 'process.stdout.write("a".repeat(51199) + "\\u{1f4a9}" + "b".repeat(9000) + "\\n")'`, process.cwd(), TASK_ENV, context);
    await task.done;
    const first = manager.read("large", 1, dataDir, 0);
    assert.equal(first.next_cursor, 51199);
    assert.equal(first.more, true);
    const second = manager.read("large", 1, dataDir, first.next_cursor, false);
    assert.equal(first.output + second.output, "a".repeat(51199) + "\u{1f4a9}" + "b".repeat(9000) + "\n");
    assert.equal(second.more, false);
    await manager.shutdown();
    const adopted = await replacement.adopt("large", null, "", 0, context);
    assert.equal(adopted.pid, task.pid);
    assert.equal(replacement.completion(adopted).status, "success");
    const retried = await replacement.start("large", "echo MUST-NOT-RUN", process.cwd(), TASK_ENV, context);
    assert.equal(retried.pid, task.pid);
    assert.equal(replacement.tail("large", dataDir).output.includes("MUST-NOT-RUN"), false);
  } finally {
    await manager.shutdown();
    await replacement.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("tasks start, stream, fail, stop and clear", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-tasks-test-"));
  const manager = new TaskManager();
  const { completions, context } = harness(dataDir);

  try {
    const completed = await manager.start(
      "completed",
      "printf 'first\\nsecond\\n'; sleep 0.1; printf 'third\\n'",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await completed.done;
    await eventually(() => completions.length === 1);
    assert.equal(completed.status, "success");
    assert.equal(completions[0].status, "success");
    assert.equal(completions[0].earlier, false);
    assert.equal(completions[0].logPath, completed.logPath);
    assert.match(manager.tail("completed", dataDir).output, /first\nsecond\nthird/);
    const firstRead = manager.read("completed", 1, dataDir, 0);
    assert.equal(firstRead.more, false);
    assert.equal(manager.read("completed", 1, dataDir, 8).output, "third\n");
    assert.equal(
      manager.read("completed", 1, dataDir, firstRead.next_cursor).output,
      "",
    );
    assert.throws(
      () => manager.read("completed", 1, dataDir, firstRead.next_cursor + 1),
      /cursor .* is beyond task 1 output/,
    );

    const failed = await manager.start(
      "failed",
      "printf 'failed\\n' >&2; exit 7",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await failed.done;
    await eventually(() => completions.length === 2);
    assert.equal(failed.status, "error");
    assert.equal(failed.exitCode, 7);
    assert.match(String(completions[1].output), /failed/);
    manager.clear("failed", dataDir);
    assert.throws(() => manager.tail("failed", dataDir), /ENOENT/);

    const stopped = await manager.start(
      "stopped",
      "sleep 30 & echo $!",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(manager.tail("stopped", dataDir).output, /^\d+\n$/);
    const stoppedResult = await manager.stop("stopped", stopped.pid, "requested");
    assert.equal(stoppedResult.status, "stopped");
    assert.equal(processGroupAlive(stopped.pid), false);
    await eventually(() => completions.length === 3);
    assert.equal(completions[2].notify, false);

    const stubborn = await manager.start(
      "stubborn",
      `node -e "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"`,
      process.cwd(),
      TASK_ENV,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopStartedAt = Date.now();
    await manager.stop("stubborn", stubborn.pid, "requested");
    assert.ok(Date.now() - stopStartedAt >= 4_900);
    assert.equal(processGroupAlive(stubborn.pid), false);
    await eventually(() => completions.length === 4);
    assert.equal(completions[3].notify, false);

    const reloading = await manager.start(
      "reloading",
      "sleep 0.3; printf 'survived reload\\n'",
      process.cwd(),
      TASK_ENV,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.shutdown();
    assert.equal(reloading.status, "running");
    assert.equal(processGroupAlive(reloading.pid), true);

    const replacement = new TaskManager();
    const replacementHarness = harness(dataDir);
    try {
      const adopted = await replacement.adopt(
        "reloading",
        reloading.pid,
        reloading.logPath,
        reloading.startedAt,
        replacementHarness.context,
      );
      assert.equal(adopted.pid, reloading.pid);
      await adopted.done;
      await eventually(() => replacementHarness.completions.length === 1);
      assert.equal(adopted.status, "success");
      assert.equal(
        replacement.tail("reloading", dataDir).output,
        "survived reload\n",
      );
      assert.equal(replacementHarness.completions[0].notify, true);
    } finally {
      await replacement.shutdown();
    }
  } finally {
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  READ_MAX_BYTES,
  READ_MAX_LINES,
  TAIL_DEFAULT_LINES,
  TAIL_MAX_LINES,
  TASK_PARAMETERS,
  TITLE_MAX_LENGTH,
  errorMessage,
  hostContract,
  hostSignals,
  rpcContract,
  taskToolInputSchema,
  type ReadOutputChunk,
  type TailOutputChunk,
  type TaskStatus,
  type TaskSummary,
  type TaskToolInput,
} from "./contract.ts";

export { rpcContract } from "./contract.ts";
export type {
  ReadOutputChunk,
  TailOutputChunk,
  TaskStatus,
  TaskSummary,
  TaskDetailSummary,
} from "./contract";

const TASKS_CHANGED = "tasks-changed";
const COMPLETION_BATCH_MIN_DELAY_MS = 3_000;
const COMPLETION_BATCH_QUIET_MS = 1_000;

type TaskRow = {
  thread_id: string;
  id: number;
  task_key: string;
  host_id: string;
  cwd: string;
  command: string;
  title: string | null;
  pid: number | null;
  log_path: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  signal: string | null;
  status: TaskStatus;
  error: string | null;
  stop_reason: string | null;
  last_read_cursor: number | null;
  last_tail_cursor: number | null;
  completion_queue_id: string | null;
  completion_acknowledged: number;
  cleared_at: number | null;
  completion_pending: string | null;
  pending_stop: string | null;
  pending_delete: number;
};

type CompletionPayload = {
  threadId: string;
  taskId: number;
  title?: string;
  status: TaskStatus | "cleared";
  exitCode?: number | null;
  notify: boolean;
};

type HostCompletion = {
  status: "success" | "error" | "stopped";
  endedAt: number;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  reason?: string;
  output: string;
  earlier: boolean;
  totalOutputBytes: number;
  logPath: string;
};

type PendingCompletion = {
  task: TaskRow;
  payload: HostCompletion;
};

function rowToSummary(row: TaskRow): TaskSummary {
  return {
    task_id: row.id,
    status: row.status,
    pid: row.pid,
    command: row.command,
    ...(row.title === null ? {} : { title: row.title }),
    started_at: new Date(row.started_at).toISOString(),
    ended_at: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
    exit_code: row.exit_code,
    signal: row.signal,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.stop_reason === null ? {} : { reason: row.stop_reason }),
    log_path: row.log_path,
  };
}

function requiredId(input: TaskToolInput): number {
  if (input.id === undefined) throw new Error(`${input.action} requires id`);
  return input.id;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    preferOverNativeBackgroundTasks: {
      type: "boolean",
      label: "Prefer Shell tasks over provider background tasks",
      description:
        "Nudge agents to use Shell tasks instead of the provider's built-in background-task runner.",
      default: false,
    },
  });
  const { preferOverNativeBackgroundTasks } = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE tasks (
      thread_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      task_key TEXT NOT NULL UNIQUE,
      host_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      title TEXT,
      pid INTEGER,
      log_path TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'stopped')),
      error TEXT,
      PRIMARY KEY (thread_id, id)
    )`,
    `CREATE TABLE task_counters (
      thread_id TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL
    )`,
    "CREATE INDEX tasks_host_status ON tasks(host_id, status)",
    "ALTER TABLE tasks ADD COLUMN last_read_cursor INTEGER",
    "ALTER TABLE tasks ADD COLUMN completion_queue_id TEXT",
    "ALTER TABLE tasks ADD COLUMN completion_acknowledged INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN stop_reason TEXT",
    "ALTER TABLE tasks ADD COLUMN cleared_at INTEGER",
    "ALTER TABLE tasks ADD COLUMN completion_pending TEXT",
    "ALTER TABLE tasks ADD COLUMN pending_stop TEXT",
    "ALTER TABLE tasks ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN last_tail_cursor INTEGER",
  ]);

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const findTask = (threadId: string, id: number): TaskRow | undefined =>
    db
      .prepare("SELECT * FROM tasks WHERE thread_id = ? AND id = ?")
      .get(threadId, id) as TaskRow | undefined;

  const requireTask = (threadId: string, id: number): TaskRow => {
    const task = findTask(threadId, id);
    if (!task || task.cleared_at !== null) throw new Error(`task ${id} not found`);
    return task;
  };

  const listTasks = (threadId: string): TaskRow[] =>
    db
      .prepare(
        "SELECT * FROM tasks WHERE thread_id = ? AND cleared_at IS NULL ORDER BY id",
      )
      .all(threadId) as TaskRow[];

  // Queue delete has no CAS in SDK 0.5.9. Serialize our mutations per thread.
  const queueOperations = new Map<string, Promise<unknown>>();
  function withQueue<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const previous = queueOperations.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    queueOperations.set(threadId, next);
    void next.finally(() => {
      if (queueOperations.get(threadId) === next) queueOperations.delete(threadId);
    }).catch(() => {});
    return next;
  }

  const publish = (payload: CompletionPayload) => {
    bb.realtime.publish(TASKS_CHANGED, payload);
  };

  async function logHandlerError<T>(
    name: string,
    run: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      bb.log.error(`${name} failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  const allocateTask = db.transaction(
    (threadId: string, hostId: string, cwd: string, command: string, title?: string) => {
      const counter = db
        .prepare(
          `INSERT INTO task_counters(thread_id, last_id) VALUES (?, 1)
           ON CONFLICT(thread_id) DO UPDATE SET last_id = last_id + 1
           RETURNING last_id`,
        )
        .get(threadId) as { last_id: number };
      const key = randomUUID();
      db.prepare(
        `INSERT INTO tasks(
          thread_id, id, task_key, host_id, cwd, command, title,
          started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      ).run(
        threadId,
        counter.last_id,
        key,
        hostId,
        cwd,
        command,
        title ?? null,
        Date.now(),
      );
      return requireTask(threadId, counter.last_id);
    },
  );

  const pendingTargets = new Map<AbortController, string>();

  async function taskTarget(threadId: string, signal?: AbortSignal) {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.archivedAt !== null) throw new Error("cannot start a task in an archived thread");
    if (thread.environmentId === null) {
      throw new Error("task requires a thread environment");
    }
    const [environment, storage] = await Promise.all([
      bb.sdk.environments.get({ environmentId: thread.environmentId, signal }),
      bb.sdk.threads.storageLocation({ threadId, signal }),
    ]);
    if (environment.status !== "ready" || environment.path === null) {
      throw new Error("task requires a ready environment with a working directory");
    }
    if (storage.hostId !== environment.hostId) {
      throw new Error("task requires thread storage on the environment host");
    }
    return {
      hostId: environment.hostId,
      cwd: environment.path,
      env: {
        BB_THREAD_ID: threadId,
        BB_PROJECT_ID: thread.projectId,
        BB_ENVIRONMENT_ID: environment.id,
        BB_THREAD_STORAGE: storage.storageRootPath,
      },
    };
  }

  async function startTask(
    threadId: string,
    commandInput: string,
    titleInput?: string,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    const command = commandInput.trim();
    const title = titleInput?.trim() || undefined;
    if (!command) throw new Error("start requires a non-empty command");
    if (title && Array.from(title).length > TITLE_MAX_LENGTH) {
      throw new Error(`title must not exceed ${TITLE_MAX_LENGTH} characters`);
    }
    const lookup = new AbortController();
    const lookupSignal = signal ? AbortSignal.any([signal, lookup.signal]) : lookup.signal;
    pendingTargets.set(lookup, threadId);
    let target: Awaited<ReturnType<typeof taskTarget>>;
    let pending: TaskRow;
    try {
      target = await taskTarget(threadId, lookupSignal);
      // No await between this check and allocation: endThread owns every allocated row.
      lookupSignal.throwIfAborted();
      pending = allocateTask(threadId, target.hostId, target.cwd, command, title);
    } finally {
      pendingTargets.delete(lookup);
    }
    try {
      const started = await host.call(
        "start",
        {
          key: pending.task_key,
          command,
          ...(title === undefined ? {} : { title }),
          cwd: target.cwd,
          env: target.env,
        },
        { hostId: target.hostId },
      );
      db.prepare(
        `UPDATE tasks
         SET pid = ?, log_path = ?, started_at = ?
         WHERE thread_id = ? AND id = ?`,
      ).run(
        started.pid,
        started.logPath,
        started.startedAt,
        threadId,
        pending.id,
      );
      const summary: TaskSummary = {
        task_id: pending.id,
        status: "running",
        pid: started.pid,
        command,
        ...(title === undefined ? {} : { title }),
        started_at: new Date(started.startedAt).toISOString(),
        ended_at: null,
        exit_code: null,
        signal: null,
        log_path: started.logPath,
      };
      publish({
        threadId,
        taskId: pending.id,
        ...(title === undefined ? {} : { title }),
        status: "running",
        notify: false,
      });
      return summary;
    } catch (error) {
      db.prepare("UPDATE tasks SET error = ? WHERE task_key = ?").run(
        `Start response failed; reconciling: ${errorMessage(error)}`, pending.task_key,
      );
      publish({ threadId, taskId: pending.id, status: "running", notify: false });
      throw new Error(`task ${pending.id} start is unconfirmed; retained for recovery: ${errorMessage(error)}`);
    }
  }

  async function ensureTaskWorker(task: TaskRow): Promise<void> {
    if (task.status !== "running") return;
    const adopted = await host.call(
      "adopt",
      {
        key: task.task_key,
        pid: task.pid,
        logPath: task.log_path,
        startedAt: task.started_at,
      },
      { hostId: task.host_id },
    );
    db.prepare("UPDATE tasks SET pid = ?, log_path = ?, started_at = ?, error = CASE WHEN status = 'running' THEN NULL ELSE error END WHERE task_key = ?")
      .run(adopted.pid, adopted.logPath, adopted.startedAt, task.task_key);
    if (adopted.completion) applyCompletion(adopted.completion);
    else if (task.pid !== adopted.pid || task.log_path !== adopted.logPath ||
      task.started_at !== adopted.startedAt || task.error !== null) {
      publish({ threadId: task.thread_id, taskId: task.id, status: "running", notify: false });
    }
  }

  async function acknowledgeCompletion(task: TaskRow): Promise<void> {
    db.prepare(
      `UPDATE tasks
       SET completion_acknowledged = 1, completion_pending = NULL
       WHERE thread_id = ? AND id = ?`,
    ).run(task.thread_id, task.id);
    await withQueue(task.thread_id, async () => {
      const queueId = findTask(task.thread_id, task.id)?.completion_queue_id;
      if (!queueId) return;
      try {
        await removeTaskFromQueuedCompletion(task.thread_id, queueId, task.id);
      } catch (error) {
        bb.log.error(`task acknowledgement thread=${task.thread_id} task=${task.id}: ${errorMessage(error)}`);
        // Keep the queue ID so reconciliation retries a failed prune.
      }
    });
  }

  async function readTask(
    threadId: string,
    id: number,
    cursor = 0,
  ): Promise<{ task_id: number; status: TaskStatus } & ReadOutputChunk> {
    const task = requireTask(threadId, id);
    await ensureTaskWorker(task);
    const input = {
      key: task.task_key,
      id,
      cursor,
      snapToLine: cursor !== 0 && cursor !== task.last_read_cursor && cursor !== task.last_tail_cursor,
    };
    let chunk = await host.call("read", input, { hostId: task.host_id });
    const current = requireTask(threadId, id);
    if (task.status === "running" && current.status !== "running") {
      // Completion can arrive after the host took its snapshot. Read final bytes before acknowledging.
      chunk = await host.call("read", input, { hostId: task.host_id });
    }
    db.prepare(
      "UPDATE tasks SET last_read_cursor = ? WHERE thread_id = ? AND id = ?",
    ).run(chunk.next_cursor, threadId, id);
    if (current.status !== "running" && !chunk.more) {
      await acknowledgeCompletion(current);
    }
    return { task_id: id, status: current.status, ...chunk };
  }

  async function tailTask(
    threadId: string,
    id: number,
    lines?: number,
  ): Promise<{ task_id: number; status: TaskStatus } & TailOutputChunk> {
    const task = requireTask(threadId, id);
    await ensureTaskWorker(task);
    const input = { key: task.task_key, ...(lines === undefined ? {} : { lines }) };
    let chunk = await host.call("tail", input, { hostId: task.host_id });
    const current = requireTask(threadId, id);
    if (task.status === "running" && current.status !== "running") {
      chunk = await host.call("tail", input, { hostId: task.host_id });
    }
    db.prepare(
      "UPDATE tasks SET last_tail_cursor = ? WHERE thread_id = ? AND id = ?",
    ).run(chunk.next_cursor, threadId, id);
    if (
      current.status !== "running" &&
      !chunk.earlier &&
      chunk.next_cursor === chunk.total_bytes
    ) {
      await acknowledgeCompletion(current);
    }
    return { task_id: id, status: current.status, ...chunk };
  }

  async function stopTask(
    threadId: string,
    id: number,
    reason = "requested",
  ): Promise<TaskSummary> {
    let task = requireTask(threadId, id);
    if (task.status !== "running") return rowToSummary(task);
    db.prepare("UPDATE tasks SET pending_stop = ? WHERE task_key = ?").run(reason, task.task_key);
    await ensureTaskWorker(task);
    task = requireTask(threadId, id);
    if (task.status !== "running") return rowToSummary(task);
    const stopped = await host.call(
      "stop",
      { key: task.task_key, pid: task.pid, reason },
      { hostId: task.host_id, timeoutMs: 15_000 },
    );
    db.prepare(
      `UPDATE tasks
       SET status = ?, ended_at = ?, exit_code = ?, signal = ?, error = ?, stop_reason = ?, pending_stop = NULL
       WHERE thread_id = ? AND id = ?`,
    ).run(
      stopped.status,
      stopped.endedAt,
      stopped.exitCode,
      stopped.signal,
      stopped.error ?? null,
      stopped.reason ?? reason,
      threadId,
      id,
    );
    const result = requireTask(threadId, id);
    bb.log.info(
      `task stopped id=${id} signal=${result.signal ?? "none"} reason=${result.stop_reason ?? reason}`,
    );
    publish({
      threadId,
      taskId: id,
      ...(result.title === null ? {} : { title: result.title }),
      status: result.status,
      exitCode: result.exit_code,
      notify: false,
    });
    return rowToSummary(result);
  }

  async function clearTask(threadId: string, id: number) {
    const task = requireTask(threadId, id);
    if (task.status === "running") {
      throw new Error(`task ${id} is running; stop it before clearing`);
    }
    await host.call(
      "clear",
      { key: task.task_key },
      { hostId: task.host_id },
    );
    await acknowledgeCompletion(task);
    db.prepare(
      `UPDATE tasks
       SET cleared_at = ?
       WHERE thread_id = ? AND id = ?`,
    ).run(Date.now(), threadId, id);
    publish({
      threadId,
      taskId: id,
      ...(task.title === null ? {} : { title: task.title }),
      status: "cleared",
      notify: false,
    });
    return {
      task_id: id,
      ...(task.title === null ? {} : { title: task.title }),
      status: "cleared" as const,
      previous_status: task.status,
    };
  }

  const completionBatches = new Map<
    string,
    {
      firstAt: number;
      timer: ReturnType<typeof setTimeout>;
      pending: Map<number, PendingCompletion>;
    }
  >();

  const completionData = ({ task, payload }: PendingCompletion) => ({
    type: "task_complete" as const,
    task_id: task.id,
    ...(task.title === null ? {} : { title: task.title }),
    status: payload.status,
    exit_code: payload.exitCode,
    signal: payload.signal,
    ...(payload.error === undefined ? {} : { error: payload.error }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    output: payload.output,
    earlier: payload.earlier,
    total_output_bytes: payload.totalOutputBytes,
    log_path: payload.logPath,
  });

  type CompletionData = ReturnType<typeof completionData>;

  const completionMessage = (completions: CompletionData[]) =>
    completions.length === 1
      ? completions[0]
      : { type: "task_complete_batch" as const, tasks: completions };

  const completionInput = (completions: CompletionData[]) => [
    {
      type: "text" as const,
      text: JSON.stringify(completionMessage(completions)),
      mentions: [],
      visibility: "agent-only" as const,
    },
  ];

  function parseQueuedCompletions(content: unknown): CompletionData[] | null {
    if (!Array.isArray(content)) return null;
    const text = content.find(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    );
    if (!text) return null;
    try {
      const value = JSON.parse(text.text) as {
        type?: string;
        task_id?: number;
        tasks?: CompletionData[];
      };
      if (value.type === "task_complete" && Number.isInteger(value.task_id)) {
        return [value as CompletionData];
      }
      if (value.type === "task_complete_batch" && Array.isArray(value.tasks)) {
        return value.tasks;
      }
    } catch {
      // This row was not created by shell-tasks.
    }
    return null;
  }

  async function queuedCompletionRow(threadId: string) {
    const queueIds = db
      .prepare(
        `SELECT DISTINCT completion_queue_id AS id
         FROM tasks
         WHERE thread_id = ?
           AND completion_queue_id IS NOT NULL
           AND completion_acknowledged = 0`,
      )
      .all(threadId) as Array<{ id: string }>;
    if (queueIds.length === 0) return undefined;
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    const row = queued.find((message) =>
      queueIds.some(({ id }) => id === message.id),
    );
    if (!row) {
      db.prepare(
        `UPDATE tasks
         SET completion_queue_id = NULL
         WHERE thread_id = ? AND completion_queue_id IS NOT NULL
           AND completion_acknowledged = 0`,
      ).run(threadId);
    }
    return row;
  }

  async function mergeIntoQueuedCompletion(
    threadId: string,
    additions: Array<{ task: TaskRow; completion: CompletionData }>,
  ): Promise<boolean> {
    const row = await queuedCompletionRow(threadId);
    if (!row) return false;
    const existing = parseQueuedCompletions(row.content);
    if (!existing) return false;

    const merged = new Map<number, CompletionData>();
    for (const completion of existing) {
      const task = findTask(threadId, completion.task_id);
      if (task && !task.completion_acknowledged) {
        merged.set(completion.task_id, completion);
      }
    }
    for (const { completion } of additions) {
      const task = findTask(threadId, completion.task_id);
      if (task && !task.completion_acknowledged) merged.set(completion.task_id, completion);
    }
    if (merged.size === 0) return false;
    await bb.sdk.threads.queuedMessages.update({
      threadId,
      queuedMessageId: row.id,
      expectedUpdatedAt: row.updatedAt,
      input: completionInput([...merged.values()]),
    });
    const updateQueueId = db.prepare(
      `UPDATE tasks
       SET completion_queue_id = ?
       WHERE thread_id = ? AND id = ?`,
    );
    for (const { task } of additions) {
      updateQueueId.run(row.id, threadId, task.id);
    }
    return true;
  }

  async function removeTaskFromQueuedCompletion(
    threadId: string,
    queueId: string,
    taskId: number,
  ): Promise<void> {
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    const row = queued.find((message) => message.id === queueId);
    if (!row) {
      db.prepare("UPDATE tasks SET completion_queue_id = NULL WHERE thread_id = ? AND completion_queue_id = ?")
        .run(threadId, queueId);
      return;
    }
    const existing = parseQueuedCompletions(row.content);
    if (!existing) return;
    const remaining = existing.filter((completion) => {
      if (completion.task_id === taskId) return false;
      const task = findTask(threadId, completion.task_id);
      return task !== undefined && !task.completion_acknowledged;
    });
    if (remaining.length === 0) {
      await bb.sdk.threads.queuedMessages.delete({
        threadId,
        queuedMessageId: queueId,
      });
    } else {
      await bb.sdk.threads.queuedMessages.update({
        threadId,
        queuedMessageId: queueId,
        expectedUpdatedAt: row.updatedAt,
        input: completionInput(remaining),
      });
    }
    // Other acknowledgements may arrive while the update is in flight; keep their prune work owned.
    db.prepare("UPDATE tasks SET completion_queue_id = NULL WHERE thread_id = ? AND completion_queue_id = ? AND id = ?")
      .run(threadId, queueId, taskId);
  }

  async function sendCompletionFollowUp(
    pending: PendingCompletion[],
  ): Promise<void> {
    const active = pending.filter(({ task }) => {
      const current = findTask(task.thread_id, task.id);
      return current !== undefined && !current.completion_acknowledged && current.completion_pending !== null;
    });
    if (active.length === 0) return;

    const threadId = active[0].task.thread_id;
    const additions = active.map((item) => ({
      task: item.task,
      completion: completionData(item),
    }));
    const delivered = () => {
      for (const { task } of active) {
        db.prepare("UPDATE tasks SET completion_pending = NULL WHERE task_key = ?").run(task.task_key);
      }
    };
    const pruneAcknowledged = async () => {
      for (const { task } of active) {
        const row = findTask(threadId, task.id);
        if (row?.completion_acknowledged && row.completion_queue_id) {
          await removeTaskFromQueuedCompletion(threadId, row.completion_queue_id, row.id);
        }
      }
    };
    try {
      if (await mergeIntoQueuedCompletion(threadId, additions)) {
        delivered();
        await pruneAcknowledged();
        return;
      }
      const completions = additions.map(({ completion }) => completion);
      const send = () =>
        bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: completionInput(completions),
        });
      let result;
      try {
        result = await send();
      } catch (error) {
        if (!errorMessage(error).includes("changed twice under one dispatch attempt")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = await send();
      }
      if (result.delivery === "queued") {
        const updateQueueId = db.prepare(
          "UPDATE tasks SET completion_queue_id = ? WHERE thread_id = ? AND id = ?",
        );
        for (const { task } of active) updateQueueId.run(result.queuedMessage.id, threadId, task.id);
      }
      delivered();
      await pruneAcknowledged();
    } catch (error) {
      bb.log.error(
        `task completion follow-up failed for ${active.map(({ task }) => task.id).join(", ")}: ${errorMessage(error)}`,
      );
    }
  }

  function discardCompletionBatch(threadId: string): void {
    const batch = completionBatches.get(threadId);
    if (batch) clearTimeout(batch.timer);
    completionBatches.delete(threadId);
  }

  function scheduleCompletionFollowUp(
    task: TaskRow,
    payload: HostCompletion,
  ): void {
    const existing = completionBatches.get(task.thread_id);
    if (existing?.pending.has(task.id)) return;
    if (existing) clearTimeout(existing.timer);
    const now = Date.now();
    const firstAt = existing?.firstAt ?? now;
    const pending = existing?.pending ?? new Map<number, PendingCompletion>();
    pending.set(task.id, { task, payload });
    const delay = Math.max(
      COMPLETION_BATCH_QUIET_MS,
      COMPLETION_BATCH_MIN_DELAY_MS - (now - firstAt),
    );
    const timer = setTimeout(() => {
      const batch = completionBatches.get(task.thread_id);
      if (!batch) return;
      completionBatches.delete(task.thread_id);
      void withQueue(task.thread_id, () => sendCompletionFollowUp([...batch.pending.values()]))
        .catch((error) => bb.log.error(`task batch thread=${task.thread_id}: ${errorMessage(error)}`));
    }, delay);
    completionBatches.set(task.thread_id, { firstAt, timer, pending });
  }

  function applyCompletion(payload: HostCompletion & { key: string; notify: boolean }) {
    const task = db
      .prepare("SELECT * FROM tasks WHERE task_key = ?")
      .get(payload.key) as TaskRow | undefined;
    if (!task || task.status !== "running") return;
    const notify = payload.notify && !task.completion_acknowledged && !task.pending_stop && !task.pending_delete;
    db.prepare(
      `UPDATE tasks
       SET completion_pending = ?, pending_stop = NULL, status = ?, ended_at = ?, exit_code = ?, signal = ?, error = ?, stop_reason = ?, log_path = ?
       WHERE task_key = ?`,
    ).run(
      notify ? JSON.stringify(payload) : null,
      payload.status,
      payload.endedAt,
      payload.exitCode,
      payload.signal,
      payload.error ?? null,
      payload.reason ?? null,
      payload.logPath,
      payload.key,
    );
    publish({
      threadId: task.thread_id,
      taskId: task.id,
      ...(task.title === null ? {} : { title: task.title }),
      status: payload.status,
      exitCode: payload.exitCode,
      notify: Boolean(notify),
    });
    if (notify && payload.status !== "stopped") scheduleCompletionFollowUp(task, payload);
  }

  host.experimental_onSignal("complete", ({ payload }) =>
    logHandlerError("host signal complete", () => applyCompletion(payload)),
  );

  host.experimental_onWorkerExit(({ hostId }) =>
    logHandlerError("host worker exit", async () => {
      const tasks = db
        .prepare("SELECT * FROM tasks WHERE host_id = ? AND status = 'running'")
        .all(hostId) as TaskRow[];
      await Promise.all(tasks.map(reconcileTask));
    }),
  );

  bb.rpc.register(rpcContract, {
    tasks_list: ({ threadId }) =>
      logHandlerError("rpc tasks_list", () => ({
        tasks: listTasks(threadId).map(rowToSummary),
      })),
    task_get: ({ threadId, id }) =>
      logHandlerError("rpc task_get", async () => {
        const task = findTask(threadId, id);
        if (!task) throw new Error(`task ${id} not found`);
        if (task.cleared_at !== null) {
          return {
            task: {
              task_id: id,
              ...(task.title === null ? {} : { title: task.title }),
              status: "cleared" as const,
            },
            tail: {
              output: "",
              next_cursor: 0,
              earlier: false,
              total_bytes: 0,
            },
          };
        }
        await ensureTaskWorker(task);
        const current = requireTask(threadId, id);
        const tail = await host.call(
          "tail",
          { key: current.task_key },
          { hostId: current.host_id },
        );
        return { task: rowToSummary(current), tail };
      }),
    task_stop: ({ threadId, id }) =>
      logHandlerError("rpc task_stop", () => stopTask(threadId, id)),
    task_clear: ({ threadId, id }) =>
      logHandlerError("rpc task_clear", () => clearTask(threadId, id)),
  });

  async function executeTool(input: TaskToolInput, threadId: string, signal?: AbortSignal) {
    switch (input.action) {
      case "start":
        if (input.command === undefined) throw new Error("start requires command");
        return startTask(threadId, input.command, input.title, signal);
      case "list":
        return { tasks: listTasks(threadId).map(rowToSummary) };
      case "read": {
        const id = requiredId(input);
        return readTask(threadId, id, input.cursor);
      }
      case "tail":
        return tailTask(threadId, requiredId(input), input.lines);
      case "stop":
        return stopTask(threadId, requiredId(input));
      case "clear":
        return clearTask(threadId, requiredId(input));
    }
  }

  bb.agents.registerTool({
    name: "task",
    description:
      "Start and manage non-interactive asynchronous shell tasks on Unix systems. Actions: start(command, title?), list, " +
      "read(id, cursor?), tail(id, lines?), stop(id), and clear(id). Task IDs are numbered per thread. List returns every task with its full command. pid is the supervisor and process-group leader; use stop rather than signalling it. " +
      "Status is running, success (exit 0), error (non-zero exit) or stopped. Stopped tasks include signal and reason, such as requested or plugin_reload. Stop sends SIGTERM to the task's process group. Clear removes the task and deletes its log file; stop a running task before clearing. " +
      "Running reads return complete lines, except lines reaching the 50KB cap return UTF-8-safe partial chunks; live tail snapshots intentionally include the unfinished current line. Pass next_cursor from read or tail back unchanged. Any other offset that falls inside a line moves to the start of the next line. Commands run through /bin/sh, not the user's login shell, and inherit machine variables plus safe BB thread context variables. Standard output and standard error are merged into one ordered log. " +
      "Start returns immediately with status running, even when the command finishes at once. Read returns at most " +
      `${READ_MAX_LINES} lines or ${READ_MAX_BYTES / 1024}KB with a next_cursor. Use tail for progress checks and read with next_cursor only when consuming output in chunks. Tail defaults to the latest ` +
      `${TAIL_DEFAULT_LINES} lines, accepts up to ${TAIL_MAX_LINES}, and is capped at ${READ_MAX_BYTES / 1024}KB. ` +
      "Output has ANSI control sequences removed. On read, `more` means later output remains; on tail, `earlier` means earlier output was omitted. Running tasks survive plugin reloads. Unacknowledged task completions are combined into one durable follow-up, including later completions while it waits. A full final read, complete tail or clear acknowledges completion and suppresses its follow-up; list and task cards do not. Do not wait for a follow-up after acknowledging completion. Successful and failed unacknowledged tasks wake the agent; manual stops do not.",
    instructions: [
      "Prefer task over synchronous shell tools for commands that can run asynchronously, especially tests, builds, servers, and watchers.",
      "Give task start a short title when it helps the user identify the command.",
      "After starting a task, do not wait or poll for completion. Continue other work or return control to the user; successful and failed tasks send a follow-up that wakes the agent.",
      'Include ::shell-task{id="<task_id>"} in your response when a live task card would help.',
      `Use task tail with lines for progress checks (default ${TAIL_DEFAULT_LINES}, maximum ${TAIL_MAX_LINES}). Do not use read without a cursor just to check progress; use read with next_cursor when consuming output in chunks.`,
      "A full final read, complete tail or clear acknowledges completion and suppresses its follow-up; list and task cards do not. Do not wait for a follow-up after acknowledging completion.",
      "Completed task logs remain available until task clear or the thread is deleted.",
      "Clear completed or stopped tasks once their result is no longer useful.",
    ].join("\n"),
    parameters: TASK_PARAMETERS as unknown as Record<string, unknown>,
    presentation: {
      label: { pending: "Running task command", completed: "Ran task command" },
      icon: { glyph: "ComputerTerminal01" },
    },
    execute(params, context) {
      return logHandlerError("agent tool task", async () => {
        const input = taskToolInputSchema.parse(params);
        return JSON.stringify(await executeTool(input, context.threadId, context.signal));
      });
    },
  });

  bb.agents.configure(() => ({
    tools: ["task"],
    skills: [],
    instructions: preferOverNativeBackgroundTasks
      ? "Prefer the BB task tool over the provider's native background-task runner for non-interactive long-running commands. Use the provider runner only when task is unavailable or the command requires an interactive terminal."
      : undefined,
  }));

  async function reconcileTask(task: TaskRow): Promise<void> {
    try {
      if (task.pending_stop) await stopTask(task.thread_id, task.id, task.pending_stop);
      else await ensureTaskWorker(task);
      const current = findTask(task.thread_id, task.id);
      if (!current) return;
      if (current.pending_delete) {
        if (current.status === "running") return;
        await withQueue(task.thread_id, async () => {
          await host.call("clear", { key: current.task_key }, { hostId: current.host_id });
          db.prepare("DELETE FROM tasks WHERE task_key = ?").run(current.task_key);
          db.prepare("DELETE FROM task_counters WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE thread_id = ?)")
            .run(task.thread_id, task.thread_id);
        });
      } else if (current.completion_pending && !current.completion_acknowledged) {
        scheduleCompletionFollowUp(current, JSON.parse(current.completion_pending));
      } else if (current.completion_acknowledged && current.completion_queue_id) {
        await acknowledgeCompletion(current);
      }
    } catch (error) {
      bb.log.error(`task reconciliation thread=${task.thread_id} task=${task.id} host=${task.host_id}: ${errorMessage(error)}`);
    }
  }

  async function endThread(threadId: string, deleted: boolean) {
    for (const [lookup, id] of pendingTargets) {
      if (id === threadId) lookup.abort(new Error(`thread ${deleted ? "deleted" : "archived"} during task start`));
    }
    discardCompletionBatch(threadId);
    db.prepare(`UPDATE tasks SET completion_acknowledged = 1, completion_pending = NULL,
      pending_stop = CASE WHEN status = 'running' THEN ? ELSE pending_stop END,
      pending_delete = ? WHERE thread_id = ?`)
      .run(deleted ? "thread_deleted" : "thread_archived", deleted ? 1 : 0, threadId);
    await withQueue(threadId, async () => {
      const tasks = db.prepare("SELECT * FROM tasks WHERE thread_id = ?").all(threadId) as TaskRow[];
      for (const task of tasks) {
        if (task.completion_queue_id && !deleted) {
          await removeTaskFromQueuedCompletion(threadId, task.completion_queue_id, task.id);
        }
      }
    });
    const tasks = db.prepare("SELECT * FROM tasks WHERE thread_id = ?").all(threadId) as TaskRow[];
    await Promise.all(tasks.map(reconcileTask));
  }

  bb.events.on("thread.archived", ({ thread }) =>
    logHandlerError("event thread.archived", () => endThread(thread.id, false)),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    logHandlerError("event thread.deleted", () => endThread(thread.id, true)),
  );

  bb.background.service("reconcile", {
    async start(signal) {
      try {
        while (!signal.aborted) {
          const tasks = db.prepare(`SELECT * FROM tasks WHERE status = 'running'
            OR pending_delete = 1 OR completion_pending IS NOT NULL
            OR (completion_acknowledged = 1 AND completion_queue_id IS NOT NULL)`).all() as TaskRow[];
          await Promise.all(tasks.map(reconcileTask));
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 10_000);
            signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch (error) {
        bb.log.error(`service reconcile failed: ${errorMessage(error)}`);
        throw error;
      } finally {
        for (const batch of completionBatches.values()) clearTimeout(batch.timer);
        completionBatches.clear();
        await Promise.allSettled(queueOperations.values());
      }
    },
  });

  bb.log.info("loaded; task tool enabled");
}

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk";
import {
  COMPLETION_MAX_BYTES,
  COMPLETION_MAX_LINES,
  READ_MAX_BYTES,
  READ_MAX_LINES,
  STOP_GRACE_MS,
  TAIL_DEFAULT_LINES,
  errorMessage,
  hostContract,
  hostSignals,
  sanitizeOutput,
  type ReadOutputChunk,
  type TailOutputChunk,
  type TaskStatus,
} from "./contract.ts";

type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;
type FinalStatus = Exclude<TaskStatus, "running">;

type TaskRecord = {
  key: string;
  pid: number | null;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: TaskStatus;
  error?: string;
  stopReason?: string;
  stopSignal?: NodeJS.Signals;
  stopRequested: boolean;
  notifyOnExit: boolean;
  resultPath: string;
  monitor?: ReturnType<typeof setInterval>;
  done: Promise<void>;
  resolveDone: () => void;
  emit: HostContext["experimental_emitSignal"];
  lease: ExperimentalHostWorkerLease;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processGroupAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(pid: number | null, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The detached process group has already exited.
  }
}

function logPathFor(dataDir: string, key: string): string {
  const logs = join(dataDir, "logs");
  mkdirSync(logs, { recursive: true });
  return join(logs, `${createHash("sha256").update(key).digest("hex")}.log`);
}

const SUPERVISOR_FLAG = "--shell-task-supervisor";

type DurableTaskResult = {
  endedAt: number;
  exitCode: number | null;
  signal: string | null;
  error?: string;
};

function resultPathFor(logPath: string): string {
  return `${logPath}.result.json`;
}

function writeDurableResult(path: string, result: DurableTaskResult): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result));
  renameSync(temporary, path);
}

function readDurableResult(path: string): DurableTaskResult | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as DurableTaskResult;
    if (
      typeof value.endedAt !== "number" ||
      (value.exitCode !== null && typeof value.exitCode !== "number") ||
      (value.signal !== null && typeof value.signal !== "string")
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function processGroupHasOtherMembers(groupId: number): boolean {
  if (process.platform === "linux") {
    try {
      return readdirSync("/proc").some((entry) => {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid === process.pid) return false;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return Number(fields[2]) === groupId;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  const result = spawnSync("ps", ["-axo", "pid=,pgid=,comm="], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return (
      match !== null &&
      Number(match[1]) !== process.pid &&
      Number(match[2]) === groupId &&
      match[3] !== "ps"
    );
  });
}

async function runSupervisor(encoded: string): Promise<void> {
  const spec = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    command: string;
    resultPath: string;
    startedAt: number;
  };
  // Record ownership before executing even if the worker loses its start response.
  writeFileSync(`${spec.resultPath}.started`, JSON.stringify({
    pid: process.pid, startedAt: spec.startedAt,
  }));
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  const result = await new Promise<DurableTaskResult>((resolve) => {
    const child = spawn(spec.command, {
      shell: "/bin/sh",
      detached: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) =>
      resolve({
        endedAt: Date.now(),
        exitCode: null,
        signal: null,
        error: errorMessage(error),
      }),
    );
    child.once("close", (exitCode, signal) =>
      resolve({
        endedAt: Date.now(),
        exitCode,
        signal,
      }),
    );
  });
  while (processGroupHasOtherMembers(process.pid)) await delay(100);
  result.endedAt = Date.now();
  writeDurableResult(spec.resultPath, result);
}

if (process.argv[2] === SUPERVISOR_FLAG) {
  void runSupervisor(process.argv[3] ?? "");
}

function readBytes(path: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function limitLinesFromStart(buffer: Buffer, maxLines: number): Buffer {
  let lines = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue;
    lines += 1;
    if (lines === maxLines) return buffer.subarray(0, index + 1);
  }
  return buffer;
}

export function completeUtf8Prefix(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  let start = buffer.length - 1;
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start -= 1;
  const first = buffer[start];
  const expected =
    (first & 0x80) === 0
      ? 1
      : (first & 0xe0) === 0xc0
        ? 2
        : (first & 0xf0) === 0xe0
          ? 3
          : (first & 0xf8) === 0xf0
            ? 4
            : 1;
  return buffer.length - start < expected ? buffer.subarray(0, start) : buffer;
}

export function dropUtf8ContinuationPrefix(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

export function limitLinesFromEnd(
  text: string,
  maxLines: number,
): { output: string; omitted: boolean } {
  const endedWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endedWithNewline) lines.pop();
  if (lines.length <= maxLines) return { output: text, omitted: false };
  return {
    output: `${lines.slice(-maxLines).join("\n")}${endedWithNewline ? "\n" : ""}`,
    omitted: true,
  };
}

function snapToLineStart(logPath: string, cursor: number, size: number): number {
  if (cursor === 0 || cursor >= size) return cursor;
  if (readBytes(logPath, cursor - 1, 1)[0] === 0x0a) return cursor;

  const fd = openSync(logPath, "r");
  const chunk = Buffer.allocUnsafe(8 * 1024);
  try {
    let position = cursor;
    while (position < size) {
      const bytesRead = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) return position + newline + 1;
      position += bytesRead;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

function readOutput(
  logPath: string,
  running: boolean,
  cursor = 0,
  snapToLine = true,
): ReadOutputChunk {
  const size = statSync(logPath).size;
  if (cursor > size) {
    throw new Error(`cursor ${cursor} is beyond task output (${size} bytes)`);
  }
  const start = snapToLine ? snapToLineStart(logPath, cursor, size) : cursor;
  const available = Math.min(READ_MAX_BYTES, size - start);
  let limited = limitLinesFromStart(
    readBytes(logPath, start, available),
    READ_MAX_LINES,
  );
  if (
    limited.length > 0 &&
    limited.at(-1) !== 0x0a &&
    (running || start + limited.length < size)
  ) {
    const newline = limited.lastIndexOf(0x0a);
    if (newline >= 0) limited = limited.subarray(0, newline + 1);
    else if (limited.length < READ_MAX_BYTES) limited = Buffer.alloc(0);
    // A byte-capped line must advance; returned cursors preserve its continuation.
  }
  const buffer =
    start + limited.length < size || running
      ? completeUtf8Prefix(limited)
      : limited;
  const nextCursor = start + buffer.length;
  return {
    output: sanitizeOutput(buffer.toString("utf8")),
    next_cursor: nextCursor,
    more: nextCursor < size,
    total_bytes: size,
  };
}

function tailOutput(
  logPath: string,
  running: boolean,
  maxBytes = READ_MAX_BYTES,
  maxLines = TAIL_DEFAULT_LINES,
): TailOutputChunk {
  const size = statSync(logPath).size;
  const start = Math.max(0, size - maxBytes);
  const aligned = dropUtf8ContinuationPrefix(
    readBytes(logPath, start, size - start),
  );
  const buffer = running ? completeUtf8Prefix(aligned) : aligned;
  const trailingBytes = aligned.length - buffer.length;
  const limited = limitLinesFromEnd(
    sanitizeOutput(buffer.toString("utf8")),
    maxLines,
  );
  return {
    output: limited.output,
    next_cursor: size - trailingBytes,
    earlier: start > 0 || limited.omitted,
    total_bytes: size,
  };
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private shuttingDown = false;

  async start(
    key: string,
    commandInput: string,
    cwd: string,
    env: Record<
      "BB_THREAD_ID" | "BB_PROJECT_ID" | "BB_ENVIRONMENT_ID" | "BB_THREAD_STORAGE",
      string
    >,
    context: HostContext,
  ): Promise<TaskRecord> {
    const command = commandInput.trim();
    if (!command) throw new Error("start requires a non-empty command");
    if (process.platform === "win32") {
      throw new Error("task is only supported on Unix systems");
    }
    if (this.shuttingDown) {
      throw new Error("cannot start a task while the worker is shutting down");
    }
    const existing = this.tasks.get(key);
    if (existing) return existing;

    const logPath = logPathFor(context.experimental_paths.dataDir, key);
    const resultPath = resultPathFor(logPath);
    const startedAt = Date.now();
    // Exclusive claim prevents a retried start from executing the command twice.
    try {
      closeSync(openSync(`${resultPath}.claim`, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.adopt(key, null, logPath, startedAt, context);
    }
    const encoded = Buffer.from(
      JSON.stringify({ command, resultPath, startedAt }),
      "utf8",
    ).toString("base64url");
    const logFd = openSync(logPath, "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), SUPERVISOR_FLAG, encoded],
        {
          cwd,
          env: { ...process.env, ...env },
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        },
      );
    } finally {
      closeSync(logFd);
    }

    const task = this.track(
      key,
      child.pid ?? null,
      logPath,
      startedAt,
      context,
    );
    child.once("error", (error) => {
      writeDurableResult(resultPath, {
        endedAt: Date.now(), exitCode: null, signal: null, error: errorMessage(error),
      });
      void this.finish(task, null, null, errorMessage(error));
    });
    child.once("close", () => void this.checkTask(task));
    return task;
  }

  async adopt(
    key: string,
    pid: number | null,
    logPath: string,
    startedAt: number,
    context: HostContext,
  ): Promise<TaskRecord> {
    const existing = this.tasks.get(key);
    if (existing) {
      await this.checkTask(existing);
      return existing;
    }
    if (this.shuttingDown) {
      throw new Error("cannot adopt a task while the worker is shutting down");
    }
    logPath ||= logPathFor(context.experimental_paths.dataDir, key);
    if (pid === null) {
      const metadata = `${resultPathFor(logPath)}.started`;
      if (existsSync(metadata)) {
        const value = JSON.parse(readFileSync(metadata, "utf8"));
        if (!Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.startedAt)) {
          throw new Error("invalid task start metadata");
        }
        pid = value.pid;
        startedAt = value.startedAt;
      } else if (!readDurableResult(resultPathFor(logPath))) {
        throw new Error("task start is unconfirmed; retaining ownership for retry");
      }
    }
    const task = this.track(key, pid, logPath, startedAt, context);
    const stopPath = `${task.resultPath}.stop`;
    if (existsSync(stopPath)) {
      task.stopRequested = true;
      task.stopReason = readFileSync(stopPath, "utf8");
      task.notifyOnExit = false;
    }
    await this.checkTask(task);
    return task;
  }

  private track(
    key: string,
    pid: number | null,
    logPath: string,
    startedAt: number,
    context: HostContext,
  ): TaskRecord {
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const task: TaskRecord = {
      key,
      pid,
      logPath,
      resultPath: resultPathFor(logPath),
      startedAt,
      exitCode: null,
      signal: null,
      status: "running",
      stopRequested: false,
      notifyOnExit: true,
      done,
      resolveDone,
      emit: context.experimental_emitSignal.bind(context),
      lease: context.experimental_retainWorker(),
    };
    task.monitor = setInterval(() => void this.checkTask(task), 100);
    this.tasks.set(key, task);
    return task;
  }

  read(
    key: string,
    id: number,
    dataDir: string,
    cursor: number,
    snapToLine = true,
  ): ReadOutputChunk {
    const task = this.tasks.get(key);
    const running =
      task?.status === "running" &&
      readDurableResult(task.resultPath) === undefined &&
      processGroupAlive(task.pid);
    try {
      return readOutput(
        task?.logPath ?? logPathFor(dataDir, key),
        running,
        cursor,
        snapToLine,
      );
    } catch (error) {
      if (errorMessage(error).startsWith(`cursor ${cursor} is beyond task output`)) {
        const size = statSync(task?.logPath ?? logPathFor(dataDir, key)).size;
        throw new Error(`cursor ${cursor} is beyond task ${id} output (${size} bytes)`);
      }
      throw error;
    }
  }

  tail(key: string, dataDir: string, lines = TAIL_DEFAULT_LINES): TailOutputChunk {
    const task = this.tasks.get(key);
    return tailOutput(
      task?.logPath ?? logPathFor(dataDir, key),
      task?.status === "running",
      READ_MAX_BYTES,
      lines,
    );
  }

  async stop(
    key: string,
    pid: number | null,
    reason: string,
  ): Promise<{
    status: FinalStatus;
    endedAt: number;
    exitCode: number | null;
    signal: string | null;
    error?: string;
    reason?: string;
  }> {
    const task = this.tasks.get(key);
    if (task && task.status !== "running") return this.stoppedResult(task);

    if (task) {
      writeFileSync(`${task.resultPath}.stop`, reason);
      task.stopRequested = true;
      task.stopReason = reason;
      task.stopSignal = "SIGTERM";
      task.notifyOnExit = false;
      signalProcessTree(task.pid, "SIGTERM");
      await Promise.race([task.done, delay(STOP_GRACE_MS)]);
      if (task.status === "running") {
        task.stopSignal = "SIGKILL";
        signalProcessTree(task.pid, "SIGKILL");
        await Promise.race([task.done, delay(STOP_GRACE_MS)]);
      }
      if (task.status === "running") {
        if (processGroupAlive(task.pid)) throw new Error("task process group is still alive");
        await this.finish(task, null, "SIGKILL");
      }
      return this.stoppedResult(task);
    }

    const wasAlive = processGroupAlive(pid);
    let signal: NodeJS.Signals | null = wasAlive ? "SIGTERM" : null;
    signalProcessTree(pid, "SIGTERM");
    await delay(STOP_GRACE_MS);
    if (processGroupAlive(pid)) {
      signal = "SIGKILL";
      signalProcessTree(pid, "SIGKILL");
      await delay(STOP_GRACE_MS);
    }
    if (processGroupAlive(pid)) throw new Error("task process group is still alive");
    return {
      status: "stopped",
      endedAt: Date.now(),
      exitCode: null,
      signal,
      reason,
    };
  }

  clear(key: string, dataDir: string): void {
    const task = this.tasks.get(key);
    if (task?.status === "running") {
      throw new Error("task is running; stop it before clearing");
    }
    this.tasks.delete(key);
    const logPath = task?.logPath ?? logPathFor(dataDir, key);
    rmSync(logPath, { force: true });
    for (const suffix of ["", ".started", ".claim", ".stop"]) {
      rmSync(`${resultPathFor(logPath)}${suffix}`, { force: true });
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const task of this.tasks.values()) {
      if (task.monitor) clearInterval(task.monitor);
      task.monitor = undefined;
      await task.lease.dispose();
    }
    this.tasks.clear();
  }

  completion(task: TaskRecord) {
    const tail = existsSync(task.logPath)
      ? tailOutput(task.logPath, false, COMPLETION_MAX_BYTES, COMPLETION_MAX_LINES)
      : { output: "", earlier: false, total_bytes: 0 };
    return {
      key: task.key,
      ...this.stoppedResult(task),
      output: tail.output,
      earlier: tail.earlier,
      totalOutputBytes: tail.total_bytes,
      logPath: task.logPath,
      notify: task.notifyOnExit && task.status !== "stopped",
    };
  }

  private stoppedResult(task: TaskRecord) {
    return {
      status: task.status as FinalStatus,
      endedAt: task.endedAt ?? Date.now(),
      exitCode: task.exitCode,
      signal: task.signal,
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.stopReason === undefined ? {} : { reason: task.stopReason }),
    };
  }

  private async checkTask(task: TaskRecord): Promise<void> {
    if (task.status !== "running") return;
    const result = readDurableResult(task.resultPath);
    if (result) {
      await this.finish(
        task,
        result.exitCode,
        result.signal as NodeJS.Signals | null,
        result.error,
        result.endedAt,
      );
    } else if (!processGroupAlive(task.pid)) {
      await this.finish(
        task,
        null,
        task.stopSignal ?? null,
        task.stopRequested
          ? undefined
          : "task process exited without a durable result",
      );
    }
  }

  private async finish(
    task: TaskRecord,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
    endedAt = Date.now(),
  ): Promise<void> {
    if (task.status !== "running") return;
    if (task.monitor) clearInterval(task.monitor);
    task.monitor = undefined;
    task.endedAt = endedAt;
    task.exitCode = exitCode;
    task.signal = signal;
    task.error = error;
    task.status = task.stopRequested
      ? "stopped"
      : !error && exitCode === 0
        ? "success"
        : "error";
    task.resolveDone();

    try {
      await task.emit("complete", this.completion(task));
    } catch (error) {
      console.error(`task completion signal failed key=${task.key}: ${errorMessage(error)}`);
      // The durable server reconciliation handles a lost completion signal.
    } finally {
      await task.lease.dispose();
    }
  }
}

const manager = new TaskManager();

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    start: async ({ key, command, cwd, env }, context) => {
      const task = await manager.start(key, command, cwd, env, context);
      return {
        pid: task.pid,
        logPath: task.logPath,
        startedAt: task.startedAt,
      };
    },
    adopt: async ({ key, pid, logPath, startedAt }, context) => {
      const task = await manager.adopt(key, pid, logPath, startedAt, context);
      return {
        status: task.status, pid: task.pid, logPath: task.logPath, startedAt: task.startedAt,
        ...(task.status === "running" ? {} : { completion: manager.completion(task) }),
      };
    },
    read: ({ key, id, cursor, snapToLine }, context) =>
      manager.read(
        key,
        id,
        context.experimental_paths.dataDir,
        cursor,
        snapToLine,
      ),
    tail: ({ key, lines }, context) =>
      manager.tail(key, context.experimental_paths.dataDir, lines),
    stop: ({ key, pid, reason }) => manager.stop(key, pid, reason),
    clear: ({ key }, context) => {
      manager.clear(key, context.experimental_paths.dataDir);
      return { cleared: true as const };
    },
  },
  dispose: () => manager.shutdown(),
});

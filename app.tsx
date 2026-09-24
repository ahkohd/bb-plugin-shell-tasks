import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginMessageDirectiveProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  TailOutputChunk,
  TaskDetailSummary,
  TaskStatus,
  TaskSummary,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type TaskChanged = {
  threadId: string;
  taskId: number;
  title?: string;
  status: TaskStatus | "cleared";
  exitCode?: number | null;
  notify: boolean;
};

function taskChanged(payload: unknown): payload is TaskChanged {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.threadId === "string" &&
    Number.isInteger(value.taskId) &&
    typeof value.status === "string" &&
    typeof value.notify === "boolean"
  );
}

function useTasks(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connection = useRealtimeConnectionState();
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const [revision, setRevision] = useState(0);
  const refetch = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    rpc.call("tasks_list", { threadId }).then(
      ({ tasks: next }) => {
        if (cancelled) return;
        setTasks(next);
        setError(null);
      },
      (cause) => { if (!cancelled) report(cause); },
    );
    return () => { cancelled = true; };
  }, [report, rpc, threadId, connection, revision]);
  useRealtime("tasks-changed", (payload) => {
    if (taskChanged(payload) && payload.threadId === threadId) refetch();
  });
  return { rpc, tasks, error, report, refetch };
}

function useTaskDetail(threadId: string, id: number | null, refreshKey?: unknown) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ task: TaskDetailSummary; tail: TailOutputChunk } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useRealtime("tasks-changed", (payload) => {
    if (taskChanged(payload) && payload.threadId === threadId && payload.taskId === id) {
      setRevision((value) => value + 1);
    }
  });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    if (id === null) return;
    const load = async () => {
      try {
        const next = await rpc.call("task_get", { threadId, id });
        if (cancelled) return;
        setData(next);
        setError(null);
        if (next.task.status === "running") timer = setTimeout(load, 2_000);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        timer = setTimeout(load, 2_000);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rpc, threadId, id, connection, refreshKey, revision]);
  return { data, error };
}

function statusIcon(status: TaskStatus) {
  switch (status) {
    case "running":
      return (
        <Icon
          name="Loading"
          className="size-4 animate-spin text-subtle-foreground"
        />
      );
    case "success":
      return <Icon name="CircleCheck" className="size-4 text-success" />;
    case "error":
      return <Icon name="CircleX" className="size-4 text-destructive-text" />;
    case "stopped":
      return <Icon name="Unavailable" className="size-4 text-destructive-text" />;
  }
}

function statusClass(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "text-subtle-foreground";
    case "success":
      return "text-subtle-foreground";
    case "error":
      return "text-subtle-foreground";
    case "stopped":
      return "text-destructive-text";
  }
}

function taskName(task: Pick<TaskDetailSummary, "task_id" | "title">): string {
  return task.title || `Task #${task.task_id}`;
}

function taskDuration(task: TaskSummary, now: number): string | null {
  const started = Date.parse(task.started_at);
  const ended = task.ended_at === null ? now : Date.parse(task.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  const elapsed = ended - started;
  if (elapsed < 1_000) return `${Math.max(1, elapsed)}ms`;
  const total = Math.floor(elapsed / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function statusText(task: TaskSummary): string {
  if (task.status === "error" && task.exit_code !== null) {
    return `Failed (exit ${task.exit_code})`;
  }
  switch (task.status) {
    case "running":
      return "Running";
    case "success":
      return "Completed";
    case "error":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

function TaskOutput({ tail }: { tail: TailOutputChunk }) {
  const outputRef = useRef<HTMLPreElement>(null);
  const positioned = useRef(false);
  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output || positioned.current) return;
    output.scrollTop = output.scrollHeight;
    positioned.current = true;
  }, [tail.output]);
  if (!tail.output) {
    return <p className="text-xs text-muted-foreground">No output.</p>;
  }
  return (
    <>
      <pre ref={outputRef} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5">
        {tail.output}
      </pre>
      {tail.earlier ? (
        <p className="mt-2 text-xs text-muted-foreground">Earlier output omitted.</p>
      ) : null}
    </>
  );
}

function initialSelectedId(params: PluginThreadPanelProps["params"]): number | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).selectedId;
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function TasksPanel({ threadId, params }: PluginThreadPanelProps) {
  const { rpc, tasks, error, report, refetch } = useTasks(threadId);
  const [selectedId, setSelectedId] = useState<number | null>(() =>
    initialSelectedId(params),
  );
  const { data: detail, error: detailError } = useTaskDetail(threadId, selectedId, tasks);
  const [pending, setPending] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const ordered = useMemo(() => [...(tasks ?? [])].reverse(), [tasks]);
  const hasRunningTask = tasks?.some((task) => task.status === "running") ?? false;
  useEffect(() => {
    if (!hasRunningTask) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningTask]);

  const stop = async (id: number) => {
    setPending(id);
    try {
      await rpc.call("task_stop", { threadId, id });
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(null);
    }
  };
  const clear = async (id: number) => {
    setPending(id);
    try {
      await rpc.call("task_clear", { threadId, id });
      setSelectedId((current) => current === id ? null : current);
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error || detailError ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error || detailError}
          </p>
        ) : null}
        {error ? <Button className="mb-3" variant="outline" onClick={refetch}>Retry</Button> : null}
        {tasks === null ? (
          error ? null : <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
            Loading tasks…
          </p>
        ) : ordered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
            No tasks in this thread.
          </p>
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {ordered.map((task) => {
              const selected = selectedId === task.task_id;
              const duration = taskDuration(task, now);
              return (
                <li
                  key={task.task_id}
                  className={cn(
                    "rounded-lg border border-border bg-card",
                    selected && "ring-1 ring-ring",
                  )}
                >
                  <div className="flex items-start gap-2 p-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      onClick={() => setSelectedId(selected ? null : task.task_id)}
                      aria-expanded={selected}
                    >
                      <span className="mt-0.5">{statusIcon(task.status)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate text-sm font-medium">
                            {taskName(task)}
                          </span>
                          {duration ? (
                            <span className="shrink-0 text-xs text-subtle-foreground">
                              {duration}
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate font-mono text-xs text-subtle-foreground">
                          {task.command}
                        </span>
                        <span className="mt-1 block text-xs">
                          <span className="text-subtle-foreground">
                            #{task.task_id} ·{" "}
                          </span>
                          <span className={statusClass(task.status)}>
                            {statusText(task)}
                          </span>
                        </span>
                      </span>
                    </button>
                    {task.status === "running" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending === task.task_id}
                        onClick={() => void stop(task.task_id)}
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        aria-label={`Clear ${taskName(task)}`}
                        disabled={pending === task.task_id}
                        onClick={() => void clear(task.task_id)}
                      >
                        <Icon name="Trash2" className="size-4" />
                      </Button>
                    )}
                  </div>
                  {selected ? (
                    <div className="border-t border-border p-3">
                      {detail?.task.task_id === task.task_id ? (
                        <>
                          <TaskOutput tail={detail.tail} />
                          <p className="mt-2 break-all text-xs text-muted-foreground">
                            {task.log_path}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">Loading output…</p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const id = Number(attributes.id);
  const validId = Number.isInteger(id) && id > 0;
  const { data, error } = useTaskDetail(message.threadId, validId ? id : null);

  if (!validId) {
    return <p className="text-sm text-destructive">Invalid task id.</p>;
  }
  if (error) {
    return <p className="text-sm text-muted-foreground">Task #{id}: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading task #{id}…</p>;
  }

  if (data.task.status === "cleared") {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-subtle-foreground">
        <Icon name="Unavailable" className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {taskName(data.task)}
        </span>
        <span className="text-xs">Cleared</span>
      </div>
    );
  }

  const outputLines = data.tail.output.trimEnd().split("\n");
  const compactOutput = outputLines.slice(-12).join("\n");
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() =>
          navigate.openThreadPanel({
            actionId: "shell-tasks",
            title: taskName(data.task),
            params: { selectedId: id },
          })
        }
      >
        {statusIcon(data.task.status)}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {taskName(data.task)}
        </span>
        <span className={cn("text-xs", statusClass(data.task.status))}>
          {statusText(data.task)}
        </span>
      </button>
      {compactOutput ? (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-muted/30 px-3 py-2 font-mono text-xs leading-5">
          {compactOutput}
        </pre>
      ) : null}
    </div>
  );
}

function CompletionToasts() {
  const { threadId } = useBbContext();
  useRealtime("tasks-changed", (payload) => {
    if (
      !taskChanged(payload) ||
      !payload.notify ||
      payload.threadId !== threadId
    ) {
      return;
    }
    const name = payload.title || `Task #${payload.taskId}`;
    if (payload.status === "success") {
      toast.success(`${name} completed`);
    } else if (payload.status === "error") {
      const exit =
        typeof payload.exitCode === "number" ? ` (exit ${payload.exitCode})` : "";
      toast.error(`${name} failed${exit}`);
    }
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "shell-tasks",
    title: "Shell tasks",
    icon: "shell-tasks/apple-reminder",
    component: TasksPanel,
    layout: "flush",
  });
  app.slots.messageDirective({ id: "shell-task", component: TaskDirective });
  app.slots.experimental_appOverlay({
    id: "task-completions",
    component: CompletionToasts,
  });
});

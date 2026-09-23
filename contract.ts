import { stripVTControlCharacters } from "node:util";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const READ_MAX_BYTES = 50 * 1024;
export const READ_MAX_LINES = 200;
export const TAIL_DEFAULT_LINES = 50;
export const TAIL_MAX_LINES = 200;
export const COMPLETION_MAX_BYTES = 8 * 1024;
export const COMPLETION_MAX_LINES = 50;
export const STOP_GRACE_MS = 5_000;
export const TITLE_MAX_LENGTH = 120;

export const taskStatusSchema = z
  .enum(["running", "success", "error", "stopped"])
  .describe(
    "Status is running, success (exit 0), error (non-zero exit) or stopped. Stopped tasks include signal and reason, such as requested or plugin_reload.",
  );
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSummarySchema = z.object({
  task_id: z.number().int().positive(),
  status: taskStatusSchema,
  pid: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "The supervisor and process-group leader. Use stop rather than signalling it.",
    ),
  command: z.string(),
  title: z.string().optional(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
  reason: z.string().optional(),
  log_path: z.string(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const clearedTaskSummarySchema = z.object({
  task_id: z.number().int().positive(),
  title: z.string().optional(),
  status: z.literal("cleared"),
});
export type ClearedTaskSummary = z.infer<typeof clearedTaskSummarySchema>;
export type TaskDetailSummary = TaskSummary | ClearedTaskSummary;

const outputChunkFields = {
  output: z.string(),
  next_cursor: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
};

export const readOutputChunkSchema = z.object({
  ...outputChunkFields,
  more: z.boolean(),
});
export type ReadOutputChunk = z.infer<typeof readOutputChunkSchema>;

export const tailOutputChunkSchema = z.object({
  ...outputChunkFields,
  earlier: z.boolean(),
});
export type TailOutputChunk = z.infer<typeof tailOutputChunkSchema>;

export const taskToolInputSchema = z
  .object({
    action: z.enum(["start", "list", "read", "tail", "stop", "clear"]),
    command: z.string().optional(),
    title: z
      .string()
      .refine((value) => Array.from(value).length <= TITLE_MAX_LENGTH, {
        message: `title must not exceed ${TITLE_MAX_LENGTH} characters`,
      })
      .optional(),
    id: z.number().int().positive().optional(),
    cursor: z.number().int().nonnegative().optional(),
    lines: z.number().int().min(1).max(TAIL_MAX_LINES).optional(),
  })
  .strict();
export type TaskToolInput = z.infer<typeof taskToolInputSchema>;

export const TASK_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "list", "read", "tail", "stop", "clear"],
      description:
        "Task operation. List returns every task with its full command. Stop sends SIGTERM to the task's process group. Clear removes the task and deletes its log file; stop a running task before clearing.",
    },
    command: {
      type: "string",
      description: "Non-interactive command executed by /bin/sh. Required for start.",
    },
    title: {
      type: "string",
      maxLength: TITLE_MAX_LENGTH,
      description: "Optional short title shown in the tool row and task panel for start.",
    },
    id: {
      type: "integer",
      minimum: 1,
      description:
        "Task ID, numbered per thread. Required for read, tail, stop, and clear.",
    },
    cursor: {
      type: "integer",
      minimum: 0,
      description:
        "Pass next_cursor from read or tail back unchanged. Any other offset that falls inside a line moves to the start of the next line.",
    },
    lines: {
      type: "integer",
      minimum: 1,
      maximum: TAIL_MAX_LINES,
      description: `Maximum lines returned by tail. Defaults to ${TAIL_DEFAULT_LINES}.`,
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const hostResultSchema = z.object({
  pid: z.number().int().positive().nullable(),
  logPath: z.string(),
  startedAt: z.number().int().nonnegative(),
});

const stoppedResultSchema = z.object({
  status: z.enum(["success", "error", "stopped"]),
  endedAt: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

const completionSchema = stoppedResultSchema.extend({
  key: z.string(),
  output: z.string(),
  earlier: z.boolean(),
  totalOutputBytes: z.number().int().nonnegative(),
  logPath: z.string(),
  notify: z.boolean(),
});

export const hostContract = defineRpcContract({
  start: {
    input: z.object({
      key: z.string().min(1),
      command: z.string(),
      title: z.string().optional(),
      cwd: z.string().min(1),
      env: z.object({
        BB_THREAD_ID: z.string().min(1),
        BB_PROJECT_ID: z.string().min(1),
        BB_ENVIRONMENT_ID: z.string().min(1),
        BB_THREAD_STORAGE: z.string().min(1),
      }),
    }),
    output: hostResultSchema,
  },
  adopt: {
    input: z.object({
      key: z.string().min(1),
      pid: z.number().int().positive().nullable(),
      logPath: z.string(),
      startedAt: z.number().int().nonnegative(),
    }),
    output: hostResultSchema.extend({
      status: taskStatusSchema,
      completion: completionSchema.optional(),
    }),
  },
  read: {
    input: z.object({
      key: z.string().min(1),
      id: z.number().int().positive(),
      cursor: z.number().int().nonnegative(),
      snapToLine: z.boolean(),
    }),
    output: readOutputChunkSchema,
  },
  tail: {
    input: z.object({
      key: z.string().min(1),
      lines: z.number().int().min(1).max(TAIL_MAX_LINES).optional(),
    }),
    output: tailOutputChunkSchema,
  },
  stop: {
    input: z.object({
      key: z.string().min(1),
      pid: z.number().int().positive().nullable(),
      reason: z.string().min(1),
    }),
    output: stoppedResultSchema,
  },
  clear: {
    input: z.object({ key: z.string().min(1) }),
    output: z.object({ cleared: z.literal(true) }),
  },
});

export const hostSignals = {
  complete: {
    payload: completionSchema,
  },
} as const;

export const rpcContract = defineRpcContract({
  tasks_list: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ tasks: z.array(taskSummarySchema) }),
  },
  task_get: {
    input: z.object({ threadId: z.string().min(1), id: z.number().int().positive() }),
    output: z.object({
      task: z.union([taskSummarySchema, clearedTaskSummarySchema]),
      tail: tailOutputChunkSchema,
    }),
  },
  task_stop: {
    input: z.object({ threadId: z.string().min(1), id: z.number().int().positive() }),
    output: taskSummarySchema,
  },
  task_clear: {
    input: z.object({ threadId: z.string().min(1), id: z.number().int().positive() }),
    output: z.object({
      task_id: z.number().int().positive(),
      title: z.string().optional(),
      status: z.literal("cleared"),
      previous_status: taskStatusSchema,
    }),
  },
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeOutput(text: string): string {
  return Array.from(stripVTControlCharacters(text))
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
      return !(code >= 0xfff9 && code <= 0xfffb);
    })
    .join("");
}


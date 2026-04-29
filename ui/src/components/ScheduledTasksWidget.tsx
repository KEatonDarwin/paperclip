import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { scheduledTasksApi, type ScheduledTask, type ScheduledTaskThread } from "../api/scheduled-tasks";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Loader2, CheckCircle2, AlertTriangle, X, Send, ChevronDown, CalendarDays, Clock } from "lucide-react";

function kindLabel(kind: ScheduledTask["kind"]): string {
  switch (kind) {
    case "task_personal": return "Personal";
    case "task_work": return "Work";
    case "task_home": return "Home";
    case "event": return "Event";
    case "reminder": return "Reminder";
    default: return "";
  }
}

function ScheduledTaskCard({
  task,
  onExpand,
  onCancel,
}: {
  task: ScheduledTask;
  onExpand: () => void;
  onCancel: () => void;
}) {
  // pending with clarification needed (has threads but no scheduledAt yet)
  if (task.status === "pending" && task.slackThreadTs) {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 shadow-md text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950/60 dark:text-amber-100 animate-pulse hover:animate-none hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="flex-1 text-left truncate">Need more info — click here</span>
        <span className="text-[10px] font-mono text-amber-700/60 dark:text-amber-300/60 shrink-0">{task.identifier}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      </button>
    );
  }

  if (task.status === "pending") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-md text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span className="truncate flex-1 max-w-[180px]">{task.requestText.slice(0, 60)}</span>
        <span className="text-[10px] text-muted-foreground shrink-0 font-mono">{task.identifier}</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (task.status === "scheduled") {
    const scheduledStr = task.scheduledAt
      ? new Date(task.scheduledAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    const kindStr = kindLabel(task.kind);
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 shadow-md text-sm text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/60 dark:text-emerald-100">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          <span className="flex-1 font-medium truncate">{task.title ?? task.requestText.slice(0, 50)}</span>
          {kindStr && (
            <span className="shrink-0 rounded-full bg-emerald-200/60 px-1.5 py-0.5 text-[10px] font-medium dark:bg-emerald-800/60">
              {kindStr}
            </span>
          )}
          <span className="text-[10px] font-mono text-emerald-600/60 dark:text-emerald-400/60 shrink-0">{task.identifier}</span>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded p-0.5 hover:bg-emerald-200/50 dark:hover:bg-emerald-800/50"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {(scheduledStr || task.durationMinutes) && (
          <div className="mt-1 flex items-center gap-3 text-xs text-emerald-700 dark:text-emerald-300">
            {scheduledStr && (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {scheduledStr}
              </span>
            )}
            {task.durationMinutes && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {task.durationMinutes} min
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function ScheduledTaskConversation({
  task,
  onCancel,
  onClose,
}: {
  task: ScheduledTask;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.scheduledTasks.threads(task.id),
    queryFn: () => scheduledTasksApi.listThreads(task.id),
    refetchInterval: 3000,
  });

  const addThread = useMutation({
    mutationFn: (body: string) => scheduledTasksApi.addThread(task.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.threads(task.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(task.companyId) });
      setReply("");
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [threads]);

  function handleSubmit() {
    const body = reply.trim();
    if (!body || addThread.isPending) return;
    addThread.mutate(body);
  }

  return (
    <div className="rounded-lg border border-amber-400 bg-background shadow-lg overflow-hidden dark:border-amber-500/50 w-80">
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-400/50">
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm font-medium text-amber-900 dark:text-amber-100 flex-1">Need a bit more info</span>
        <span className="text-xs font-mono text-amber-700/60 dark:text-amber-300/60">{task.identifier}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-amber-700 hover:bg-amber-200/50 dark:text-amber-300 dark:hover:bg-amber-800/50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-2">
        <div className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="font-medium">You: </span>{task.requestText}
        </div>
        {threads.map((t: ScheduledTaskThread) => (
          <div
            key={t.id}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs",
              t.authorType === "agent"
                ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                : "bg-muted text-muted-foreground",
            )}
          >
            <span className="font-medium">{t.authorType === "agent" ? "Scheduler: " : "You: "}</span>
            {t.body}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="px-3 pb-3 pt-1 border-t border-border">
        <div className="flex gap-2">
          <input
            type="text"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="Reply..."
            className="flex-1 min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!reply.trim() || addThread.isPending}
            className="shrink-0 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-destructive"
        >
          Cancel this task
        </button>
      </div>
    </div>
  );
}

export function ScheduledTasksWidget() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: tasks = [] } = useQuery({
    queryKey: queryKeys.scheduledTasks.list(selectedCompanyId ?? ""),
    queryFn: () => scheduledTasksApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 5000,
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) => scheduledTasksApi.remove(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      setExpandedId(null);
    },
  });

  // Show tasks that are active: pending or just-scheduled (not completed/cancelled)
  // Hide "scheduled" tasks once they have a calendar event (the job is done, no need to stay visible)
  const visibleTasks = tasks.filter((t) =>
    t.status === "pending" ||
    (t.status === "scheduled" && !t.calendarEventId),
  );

  if (visibleTasks.length === 0) return null;

  // Offset to not overlap HopperWidget (which is at bottom-4 right-4)
  return (
    <div className="fixed bottom-4 right-72 z-[130] flex flex-col gap-2 items-end" aria-live="polite">
      {visibleTasks.map((task) => (
        <div key={task.id}>
          {expandedId === task.id ? (
            <ScheduledTaskConversation
              task={task}
              onCancel={() => cancel.mutate(task.id)}
              onClose={() => setExpandedId(null)}
            />
          ) : (
            <ScheduledTaskCard
              task={task}
              onExpand={() => setExpandedId(task.id)}
              onCancel={() => cancel.mutate(task.id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Calendar, dateFnsLocalizer, type View } from "react-big-calendar";
import "react-big-calendar/lib/css/react-big-calendar.css";
import {
  format,
  parse,
  startOfWeek,
  endOfWeek,
  getDay,
  addWeeks,
  addMonths,
  startOfMonth,
  endOfMonth,
} from "date-fns";
import { enUS } from "date-fns/locale";
import {
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Send,
  Loader2,
  CheckCircle2,
  Clock,
  Bot,
  MessageSquare,
} from "lucide-react";
import { calendarApi, type CalendarEvent } from "../api/calendar";
import { scheduledTasksApi, type ScheduledTask, type ScheduledTaskKind, type ScheduledTaskThread, type ScheduledTaskOrigin } from "../api/scheduled-tasks";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const calendarStyles = `
.rbc-calendar {
  font-family: inherit;
  color: var(--foreground);
  background: transparent;
}
.rbc-toolbar {
  display: none;
}
.rbc-header {
  padding: 6px 3px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted-foreground);
  border-color: var(--border);
  background: transparent;
}
.rbc-month-view,
.rbc-agenda-view,
.rbc-time-view {
  border-color: var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}
.rbc-day-bg,
.rbc-time-slot {
  background: transparent;
}
.rbc-off-range-bg {
  background: color-mix(in srgb, var(--muted) 30%, transparent);
}
.rbc-today {
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.rbc-event {
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 1px 4px;
  border: none;
  cursor: pointer;
}
.rbc-event.rbc-selected {
  outline: 2px solid var(--primary);
}
.rbc-show-more {
  font-size: 0.7rem;
  color: var(--muted-foreground);
  background: transparent;
}
.rbc-date-cell {
  font-size: 0.8rem;
  padding: 2px 4px;
  color: var(--foreground);
}
.rbc-date-cell.rbc-off-range {
  color: var(--muted-foreground);
}
.rbc-agenda-table {
  width: 100%;
}
.rbc-agenda-table td,
.rbc-agenda-table th {
  padding: 6px 12px;
  border-color: var(--border);
  font-size: 0.875rem;
  color: var(--foreground);
  background: transparent;
}
.rbc-agenda-date-cell {
  font-weight: 500;
}
.rbc-agenda-empty {
  padding: 24px;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.rbc-time-content {
  border-color: var(--border);
}
.rbc-time-header {
  border-color: var(--border);
}
.rbc-time-header-content {
  border-color: var(--border);
}
.rbc-timeslot-group {
  border-color: var(--border);
  min-height: 40px;
}
.rbc-time-slot {
  border-color: color-mix(in srgb, var(--border) 40%, transparent);
}
.rbc-label {
  font-size: 0.7rem;
  color: var(--muted-foreground);
  padding: 0 6px;
}
.rbc-current-time-indicator {
  background-color: var(--primary);
  height: 2px;
  opacity: 0.8;
}
`;

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { locale: enUS }),
  getDay,
  locales: { "en-US": enUS },
});

type BigCalEvent =
  | { eventType: "system"; id: string; title: string; start: Date; end: Date; resource: CalendarEvent }
  | { eventType: "scheduled_task"; id: string; title: string; start: Date; end: Date; resource: ScheduledTask };

function eventStyleGetter(event: BigCalEvent) {
  if (event.eventType === "scheduled_task") {
    const synced = Boolean(event.resource.calendarEventId);
    return {
      style: {
        backgroundColor: synced ? "#22c55e" : "#f59e0b",
        color: "#fff",
        opacity: synced ? 1 : 0.9,
      },
    };
  }
  const { kind, status } = event.resource as CalendarEvent;
  if (status === "paused") {
    return { style: { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", opacity: 0.7 } };
  }
  if (kind === "routine") {
    return { style: { backgroundColor: "#3b82f6", color: "#fff" } };
  }
  return { style: { backgroundColor: "#a855f7", color: "#fff" } };
}

// ─── System event detail (read-only) ──────────────────────────────────────────

function SystemEventDetail({
  event,
  agentName,
  onClose,
}: {
  event: CalendarEvent;
  agentName?: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
      <div
        className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    event.status === "paused"
                      ? "var(--muted-foreground)"
                      : event.kind === "routine"
                        ? "#3b82f6"
                        : "#a855f7",
                }}
              />
              <p className="text-sm font-semibold text-foreground">{event.title}</p>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground capitalize">
              {event.kind === "routine" ? "Routine" : "Plugin job"}
              {event.status === "paused" && <span className="ml-2 text-amber-600 dark:text-amber-400">paused</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
            ✕
          </button>
        </div>
        <dl className="space-y-1.5 text-sm">
          {event.nextRunAt && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Time</dt>
              <dd className="text-foreground">{new Date(event.nextRunAt).toLocaleString()}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-20 shrink-0">Schedule</dt>
            <dd className="text-foreground font-mono text-xs">{event.cronExpression}</dd>
          </div>
          {event.timezone && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Timezone</dt>
              <dd className="text-foreground">{event.timezone}</dd>
            </div>
          )}
          {agentName && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Agent</dt>
              <dd className="text-foreground">{agentName}</dd>
            </div>
          )}
        </dl>
        {event.routineId && (
          <div className="mt-4">
            <a href={`/routines/${event.routineId}`} className="text-xs text-primary hover:underline" onClick={onClose}>
              Open routine →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Scheduled task chat modal ───────────────────────────────────────────────

function originLabel(origin: ScheduledTaskOrigin): string {
  switch (origin) {
    case "jarvis_bar": return "Jarvis Bar";
    case "keyboard_shortcut": return "Keyboard Shortcut";
    case "apple_watch": return "Apple Watch";
    case "api": return "API";
    case "slack": return "Slack";
    default: return "";
  }
}

function kindLabel(kind: ScheduledTaskKind): string {
  switch (kind) {
    case "task_personal": return "Personal";
    case "task_work": return "Work";
    case "task_home": return "Home";
    case "event": return "Event";
    case "reminder": return "Reminder";
    default: return "";
  }
}

function ScheduledTaskChatModal({
  task,
  onClose,
}: {
  task: ScheduledTask;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const bottomRef = useRef<HTMLDivElement>(null);
  const synced = Boolean(task.calendarEventId);

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.scheduledTasks.threads(task.id),
    queryFn: () => scheduledTasksApi.listThreads(task.id),
    refetchInterval: 3000,
  });

  const addThread = useMutation({
    mutationFn: (body: string) => scheduledTasksApi.addThread(task.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.threads(task.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      setReply("");
    },
  });

  const cancel = useMutation({
    mutationFn: () => scheduledTasksApi.remove(task.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      onClose();
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

  const scheduledStr = task.scheduledAt
    ? new Date(task.scheduledAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const kindStr = kindLabel(task.kind);
  const originStr = originLabel(task.origin);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
      <div
        className="relative flex w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-lg overflow-hidden"
        style={{ maxHeight: "min(600px, 85vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
                <p className="text-sm font-semibold text-foreground truncate">{task.title ?? task.requestText.slice(0, 50)}</p>
              </div>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono text-muted-foreground">{task.identifier}</span>
                {synced ? (
                  <span className="flex items-center gap-0.5 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300">
                    <CheckCircle2 className="h-2.5 w-2.5" /> Synced
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    <Clock className="h-2.5 w-2.5" /> Pending
                  </span>
                )}
                {kindStr && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{kindStr}</span>
                )}
                {originStr && (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">via {originStr}</span>
                )}
              </div>
              {scheduledStr && (
                <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarIcon className="h-3 w-3" />
                  {scheduledStr}
                  {task.durationMinutes && <span className="ml-1">({task.durationMinutes} min)</span>}
                </div>
              )}
            </div>
            <button onClick={onClose} className="shrink-0 text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        {/* Thread */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {/* Original request */}
          <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
            <span className="font-medium text-muted-foreground">Original request:</span>
            <p className="mt-0.5 text-foreground">{task.requestText}</p>
          </div>

          {threads.map((t: ScheduledTaskThread) => (
            <div
              key={t.id}
              className={
                t.authorType === "agent"
                  ? "rounded-lg bg-primary/5 border border-primary/10 px-3 py-2 text-xs"
                  : "rounded-lg bg-muted px-3 py-2 text-xs"
              }
            >
              <span className="font-medium text-muted-foreground">
                {t.authorType === "agent" ? "Jarvis: " : "You: "}
              </span>
              <span className="text-foreground whitespace-pre-wrap">{t.body}</span>
              <div className="mt-1 text-[10px] text-muted-foreground/60">
                {new Date(t.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            </div>
          ))}

          {threads.length === 0 && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No messages yet. Send a message to discuss this task with Jarvis.
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-border px-5 py-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              placeholder="Tell Jarvis about this task..."
              className="flex-1 min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!reply.trim() || addThread.isPending}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {addThread.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
          >
            Cancel this task
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Ask Jarvis bar ────────────────────────────────────────────────────────────

function AskJarvisBar({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const submit = useMutation({
    mutationFn: (requestText: string) => scheduledTasksApi.create(companyId, requestText, undefined, "jarvis_bar"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(companyId) });
      setText("");
    },
  });

  function handleSubmit() {
    const body = text.trim();
    if (!body || submit.isPending) return;
    submit.mutate(body);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5">
      <div className="flex items-center gap-1.5 shrink-0">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-primary">Ask Jarvis</span>
      </div>
      <div className="h-4 w-px bg-border shrink-0" />
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
        placeholder='Schedule something… e.g. "take out the trash Wednesday at 9am"'
        className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        disabled={submit.isPending}
      />
      {submit.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
      ) : (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="shrink-0 rounded p-1 text-primary hover:text-primary/80 disabled:opacity-30 transition-colors"
          aria-label="Send to Jarvis"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
      {submit.isSuccess && (
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">Sent!</span>
      )}
    </div>
  );
}

// ─── CalendarPage ──────────────────────────────────────────────────────────────

export function CalendarPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [view, setView] = useState<View>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedSystemEvent, setSelectedSystemEvent] = useState<CalendarEvent | null>(null);
  const [selectedScheduledTask, setSelectedScheduledTask] = useState<ScheduledTask | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  const windowStart = useMemo(() => startOfMonth(currentDate), [currentDate]);
  const windowEnd = useMemo(() => endOfMonth(addMonths(currentDate, 1)), [currentDate]);

  const { data: systemData, isLoading: systemLoading, error } = useQuery({
    queryKey: queryKeys.calendar.events(selectedCompanyId!, windowStart.toISOString(), windowEnd.toISOString()),
    queryFn: () => calendarApi.getEvents(selectedCompanyId!, windowStart, windowEnd),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: scheduledTasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!),
    queryFn: () => scheduledTasksApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30 * 1000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);

  const bigCalEvents = useMemo<BigCalEvent[]>(() => {
    const systemEvents: BigCalEvent[] = (systemData?.events ?? [])
      .filter((e) => e.nextRunAt)
      .map((e) => {
        const start = new Date(e.nextRunAt!);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        return { eventType: "system" as const, id: e.id, title: e.title, start, end, resource: e };
      });

    const taskEvents: BigCalEvent[] = scheduledTasks
      .filter((t) => t.status === "scheduled" && t.scheduledAt)
      .map((t) => {
        const start = new Date(t.scheduledAt!);
        const duration = (t.durationMinutes ?? 30) * 60 * 1000;
        const end = new Date(start.getTime() + duration);
        const label = t.title ?? t.requestText.slice(0, 50);
        const syncDot = t.calendarEventId ? "🟢" : "🟡";
        return {
          eventType: "scheduled_task" as const,
          id: t.id,
          title: `${syncDot} ${t.identifier} ${label}`,
          start,
          end,
          resource: t,
        };
      });

    return [...systemEvents, ...taskEvents];
  }, [systemData, scheduledTasks]);

  function handleSelectEvent(event: BigCalEvent) {
    if (event.eventType === "scheduled_task") {
      setSelectedScheduledTask(event.resource);
    } else {
      setSelectedSystemEvent(event.resource);
    }
  }

  function navigate_(direction: "prev" | "next" | "today") {
    setCurrentDate((d) => {
      if (direction === "today") return new Date();
      const delta = direction === "next" ? 1 : -1;
      return view === "week" ? addWeeks(d, delta) : addMonths(d, delta);
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarIcon} message="Select a company to view the calendar." />;
  }

  if (systemLoading || tasksLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load calendar events"}
      </div>
    );
  }

  const dateLabel =
    view === "week"
      ? `${format(startOfWeek(currentDate), "MMM d")} – ${format(endOfWeek(currentDate), "MMM d, yyyy")}`
      : format(currentDate, "MMMM yyyy");

  return (
    <>
      <style>{calendarStyles}</style>

      <div className="flex flex-col gap-4 h-full">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <CalendarIcon className="h-6 w-6 text-muted-foreground" />
              Calendar
            </h1>
            <p className="text-sm text-muted-foreground">
              Scheduled routines, plugin jobs, and your personal tasks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => navigate_("prev")} aria-label="Previous">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate_("today")}>
                Today
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate_("next")} aria-label="Next">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-sm font-medium text-foreground min-w-[140px] text-center">{dateLabel}</span>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {(["week", "month", "agenda"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    view === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Ask Jarvis bar */}
        <AskJarvisBar companyId={selectedCompanyId} />

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            Routines
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-purple-500" />
            Plugin jobs
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
            Tasks (synced)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            Tasks (pending sync)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground opacity-50" />
            Paused
          </span>
        </div>

        {/* Calendar */}
        <div className="flex-1 min-h-0" style={{ minHeight: "500px" }}>
          <Calendar
            localizer={localizer}
            events={bigCalEvents}
            view={view}
            views={["week", "month", "agenda"]}
            date={currentDate}
            onView={setView}
            onNavigate={setCurrentDate}
            eventPropGetter={eventStyleGetter}
            onSelectEvent={handleSelectEvent}
            startAccessor="start"
            endAccessor="end"
            titleAccessor="title"
            min={new Date(0, 0, 0, 6, 0, 0)}
            max={new Date(0, 0, 0, 22, 0, 0)}
            popup
            style={{ height: "100%", minHeight: 500 }}
          />
        </div>
      </div>

      {selectedSystemEvent && (
        <SystemEventDetail
          event={selectedSystemEvent}
          agentName={
            selectedSystemEvent.assigneeAgentId
              ? (agentById.get(selectedSystemEvent.assigneeAgentId)?.name ?? undefined)
              : undefined
          }
          onClose={() => setSelectedSystemEvent(null)}
        />
      )}

      {selectedScheduledTask && (
        <ScheduledTaskChatModal
          task={selectedScheduledTask}
          onClose={() => setSelectedScheduledTask(null)}
        />
      )}
    </>
  );
}

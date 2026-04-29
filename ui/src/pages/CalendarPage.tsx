import { useEffect, useMemo, useState } from "react";
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
  RefreshCw,
} from "lucide-react";
import { calendarApi, type CalendarEvent } from "../api/calendar";
import { scheduledTasksApi, type ScheduledTask, type ScheduledTaskKind } from "../api/scheduled-tasks";
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

// ─── Scheduled task edit modal ─────────────────────────────────────────────────

const KIND_OPTIONS: { value: ScheduledTaskKind; label: string }[] = [
  { value: "task_personal", label: "Personal" },
  { value: "task_work", label: "Work" },
  { value: "task_home", label: "Home" },
  { value: "event", label: "Event" },
  { value: "reminder", label: "Reminder" },
];

function toLocalDatetimeValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ScheduledTaskEditModal({
  task,
  onClose,
}: {
  task: ScheduledTask;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [title, setTitle] = useState(task.title ?? "");
  const [kind, setKind] = useState<ScheduledTaskKind>(task.kind);
  const [scheduledAt, setScheduledAt] = useState(toLocalDatetimeValue(task.scheduledAt));
  const [durationMinutes, setDurationMinutes] = useState(String(task.durationMinutes ?? ""));
  const synced = Boolean(task.calendarEventId);

  const update = useMutation({
    mutationFn: () =>
      scheduledTasksApi.update(task.id, {
        title: title.trim() || null,
        kind,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        durationMinutes: durationMinutes ? Number(durationMinutes) : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      onClose();
    },
  });

  const cancel = useMutation({
    mutationFn: () => scheduledTasksApi.remove(task.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: synced ? "#22c55e" : "#f59e0b" }} />
              <p className="text-sm font-semibold text-foreground">{task.identifier}</p>
              {synced ? (
                <span className="flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300">
                  <CheckCircle2 className="h-2.5 w-2.5" /> Synced
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  <Clock className="h-2.5 w-2.5" /> Pending sync
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{task.requestText}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Fields */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={task.requestText.slice(0, 60)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Kind</label>
              <select
                value={kind ?? ""}
                onChange={(e) => setKind((e.target.value as ScheduledTaskKind) || null)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              >
                <option value="">Unclassified</option>
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value ?? ""}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Duration (min)</label>
              <input
                type="number"
                min={1}
                max={480}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                placeholder="30"
                className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Scheduled time</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
          >
            Cancel task
          </button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => update.mutate()}
              disabled={update.isPending}
            >
              {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
            </Button>
          </div>
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
    mutationFn: (requestText: string) => scheduledTasksApi.create(companyId, requestText),
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
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <RefreshCw className="h-4 w-4 text-muted-foreground shrink-0" />
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
        placeholder='Ask Jarvis to schedule something… e.g. "take out the trash Wednesday"'
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
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
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
        <ScheduledTaskEditModal
          task={selectedScheduledTask}
          onClose={() => setSelectedScheduledTask(null)}
        />
      )}
    </>
  );
}

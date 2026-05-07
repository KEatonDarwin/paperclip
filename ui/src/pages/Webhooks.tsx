import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { webhooksApi, type Webhook, type WebhookDelivery, type CreateWebhookData, type UpdateWebhookData } from "../api/webhooks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Webhook as WebhookIcon,
  Plus,
  Pencil,
  Trash2,
  MoreHorizontal,
  Send,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCw,
  Power,
  PowerOff,
} from "lucide-react";

const ALL_EVENTS = [
  "company.created",
  "company.updated",
  "project.created",
  "project.updated",
  "project.workspace_created",
  "project.workspace_updated",
  "project.workspace_deleted",
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "agent.created",
  "agent.updated",
  "agent.status_changed",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "goal.created",
  "goal.updated",
  "approval.created",
  "approval.decided",
  "cost_event.created",
  "activity.logged",
] as const;

const EVENT_GROUPS: Record<string, string[]> = {
  Issues: ALL_EVENTS.filter((e) => e.startsWith("issue.")),
  Agents: ALL_EVENTS.filter((e) => e.startsWith("agent.")),
  Projects: ALL_EVENTS.filter((e) => e.startsWith("project.")),
  Company: ALL_EVENTS.filter((e) => e.startsWith("company.")),
  Other: ALL_EVENTS.filter(
    (e) => !e.startsWith("issue.") && !e.startsWith("agent.") && !e.startsWith("project.") && !e.startsWith("company."),
  ),
};

function timeAgo(date: Date | string) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function DeliveryStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "succeeded":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-400">
          <CheckCircle2 className="h-3 w-3" /> OK
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
          <XCircle className="h-3 w-3" /> Failed
        </span>
      );
    case "retrying":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
          <RotateCw className="h-3 w-3" /> Retrying
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" /> Pending
        </span>
      );
  }
}

function EventCheckboxes({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (events: Set<string>) => void;
}) {
  const toggle = (event: string) => {
    const next = new Set(selected);
    if (next.has(event)) next.delete(event);
    else next.add(event);
    onChange(next);
  };

  const toggleGroup = (events: string[]) => {
    const allSelected = events.every((e) => selected.has(e));
    const next = new Set(selected);
    for (const e of events) {
      if (allSelected) next.delete(e);
      else next.add(e);
    }
    onChange(next);
  };

  return (
    <div className="space-y-3 max-h-56 overflow-y-auto rounded-md border border-border p-3">
      {Object.entries(EVENT_GROUPS).map(([group, events]) => (
        <div key={group}>
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer">
            <input
              type="checkbox"
              checked={events.every((e) => selected.has(e))}
              ref={(el) => {
                if (el) el.indeterminate = events.some((e) => selected.has(e)) && !events.every((e) => selected.has(e));
              }}
              onChange={() => toggleGroup(events)}
              className="rounded"
            />
            {group}
          </label>
          <div className="ml-5 mt-1 space-y-0.5">
            {events.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm cursor-pointer hover:text-foreground text-muted-foreground">
                <input
                  type="checkbox"
                  checked={selected.has(event)}
                  onChange={() => toggle(event)}
                  className="rounded"
                />
                {event}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function WebhookFormDialog({
  open,
  onOpenChange,
  webhook,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhook: Webhook | null;
  onSubmit: (data: CreateWebhookData | UpdateWebhookData) => void;
  isPending: boolean;
}) {
  const isEdit = !!webhook;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("POST");
  const [secret, setSecret] = useState("");
  const [scope, setScope] = useState("company");
  const [scopeId, setScopeId] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (open) {
      if (webhook) {
        setName(webhook.name);
        setUrl(webhook.url);
        setMethod(webhook.method);
        setSecret("");
        setScope(webhook.scope);
        setScopeId(webhook.scopeId ?? "");
        setEvents(new Set(webhook.events));
        setEnabled(webhook.enabled);
      } else {
        setName("");
        setUrl("");
        setMethod("POST");
        setSecret("");
        setScope("company");
        setScopeId("");
        setEvents(new Set());
        setEnabled(true);
      }
    }
  }, [open, webhook]);

  const handleSubmit = () => {
    const data: Record<string, unknown> = {
      name: name.trim(),
      url: url.trim(),
      method,
      events: Array.from(events),
      scope,
      scopeId: scopeId.trim() || null,
      enabled,
    };
    if (secret) data.secret = secret;
    else if (isEdit && secret === "") {
      // don't send secret field if empty in edit mode
    }
    onSubmit(data as CreateWebhookData | UpdateWebhookData);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Webhook" : "Create Webhook"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update this webhook's configuration." : "Set up a new outbound webhook to receive event notifications."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Slack Notifications" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">URL</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              >
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="GET">GET</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              >
                <option value="company">Company</option>
                <option value="project">Project</option>
                <option value="issue">Issue</option>
              </select>
            </div>
          </div>
          {scope !== "company" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{scope === "project" ? "Project" : "Issue"} ID</label>
              <Input value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="UUID" />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Secret {isEdit && webhook?.hasSecret && <span className="text-xs text-muted-foreground">(leave blank to keep current)</span>}
            </label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={isEdit && webhook?.hasSecret ? "********" : "Optional HMAC signing secret"}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Events</label>
            <EventCheckboxes selected={events} onChange={setEvents} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded" />
            Enabled
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending || !name.trim() || !url.trim() || events.size === 0}>
            {isPending ? (isEdit ? "Saving..." : "Creating...") : isEdit ? "Save Changes" : "Create Webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebhookRow({
  webhook,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  onViewDeliveries,
}: {
  webhook: Webhook;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onToggle: () => void;
  onViewDeliveries: () => void;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <button onClick={onViewDeliveries} className="font-medium text-sm truncate hover:underline text-left">
            {webhook.name}
          </button>
          {!webhook.enabled && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Disabled</span>
          )}
          {webhook.hasSecret && (
            <span className="shrink-0 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] text-green-400">Signed</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground truncate">{webhook.method} {webhook.url}</p>
      </div>
      <div className="hidden sm:block shrink-0 text-xs text-muted-foreground w-20 text-right">
        {webhook.events.length} event{webhook.events.length !== 1 ? "s" : ""}
      </div>
      <div className="hidden md:block shrink-0 text-xs text-muted-foreground w-20 text-right">
        {webhook.scope}
      </div>
      <div className="hidden md:block shrink-0 text-xs text-muted-foreground w-24 text-right">
        {timeAgo(webhook.updatedAt)}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onTest}>
            <Send className="h-3.5 w-3.5 mr-2" /> Send Test
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onViewDeliveries}>
            <Clock className="h-3.5 w-3.5 mr-2" /> View Deliveries
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onToggle}>
            {webhook.enabled ? <PowerOff className="h-3.5 w-3.5 mr-2" /> : <Power className="h-3.5 w-3.5 mr-2" />}
            {webhook.enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DeliveriesView({
  webhook,
  onBack,
}: {
  webhook: Webhook;
  onBack: () => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const deliveriesQuery = useQuery({
    queryKey: queryKeys.webhooks.deliveries(webhook.id),
    queryFn: () => webhooksApi.deliveries(webhook.id),
    refetchInterval: 10_000,
  });

  const testMutation = useMutation({
    mutationFn: () => webhooksApi.test(webhook.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(webhook.id) });
      pushToast({ tone: "success", title: "Test sent", body: "Check deliveries for the result." });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Test failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const deliveries = deliveriesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{webhook.name}</h2>
          <p className="text-xs text-muted-foreground truncate">{webhook.method} {webhook.url}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
          <Send className="h-3.5 w-3.5 mr-1.5" />
          {testMutation.isPending ? "Sending..." : "Send Test"}
        </Button>
      </div>

      <div className="text-xs text-muted-foreground">
        Events: {webhook.events.join(", ")}
      </div>

      {deliveries.length === 0 ? (
        <EmptyState icon={Clock} message="No deliveries yet. Send a test to verify your webhook." action="Send Test" onAction={() => testMutation.mutate()} />
      ) : (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-4 border-b border-border bg-muted/30 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <div className="w-20">Status</div>
            <div className="flex-1">Event</div>
            <div className="hidden sm:block w-16 text-right">Code</div>
            <div className="hidden sm:block w-16 text-right">Duration</div>
            <div className="hidden md:block w-16 text-right">Attempt</div>
            <div className="w-24 text-right">Time</div>
          </div>
          {deliveries.map((d) => (
            <DeliveryRow key={d.id} delivery={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-4 px-4 py-2.5 text-sm hover:bg-accent/30 transition-colors text-left"
      >
        <div className="w-20">
          <DeliveryStatusBadge status={delivery.status} />
        </div>
        <div className="flex-1 truncate font-mono text-xs">{delivery.eventType}</div>
        <div className="hidden sm:block w-16 text-right text-xs text-muted-foreground">
          {delivery.responseStatus ?? "—"}
        </div>
        <div className="hidden sm:block w-16 text-right text-xs text-muted-foreground">
          {delivery.durationMs != null ? `${delivery.durationMs}ms` : "—"}
        </div>
        <div className="hidden md:block w-16 text-right text-xs text-muted-foreground">
          {delivery.attempt}/{delivery.maxAttempts}
        </div>
        <div className="w-24 text-right text-xs text-muted-foreground">
          {timeAgo(delivery.createdAt)}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-2">
          {delivery.error && (
            <div className="text-xs text-red-400">
              <span className="font-medium">Error:</span> {delivery.error}
            </div>
          )}
          {delivery.responseBody && (
            <div className="text-xs">
              <span className="font-medium text-muted-foreground">Response:</span>
              <pre className="mt-1 rounded bg-background p-2 text-xs overflow-x-auto max-h-32">{delivery.responseBody}</pre>
            </div>
          )}
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">Payload:</span>
            <pre className="mt-1 rounded bg-background p-2 text-xs overflow-x-auto max-h-48">
              {JSON.stringify(delivery.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function Webhooks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editWebhook, setEditWebhook] = useState<Webhook | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Webhook | null>(null);
  const [viewDeliveries, setViewDeliveries] = useState<Webhook | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Webhooks" }]);
  }, [setBreadcrumbs]);

  const webhooksQuery = useQuery({
    queryKey: queryKeys.webhooks.list(selectedCompanyId ?? ""),
    queryFn: () => webhooksApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateWebhookData) => webhooksApi.create(selectedCompanyId!, data),
    onSuccess: (wh) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(selectedCompanyId!) });
      setCreateOpen(false);
      pushToast({ tone: "success", title: "Webhook created", body: wh.name });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to create webhook", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWebhookData }) => webhooksApi.update(id, data),
    onSuccess: (wh) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(selectedCompanyId!) });
      setEditWebhook(null);
      pushToast({ tone: "success", title: "Webhook updated", body: wh.name });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to update webhook", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => webhooksApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(selectedCompanyId!) });
      setDeleteConfirm(null);
      pushToast({ tone: "success", title: "Webhook deleted" });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to delete webhook", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (wh: Webhook) => webhooksApi.update(wh.id, { enabled: !wh.enabled }),
    onSuccess: (wh) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(selectedCompanyId!) });
      pushToast({ tone: "success", title: wh.enabled ? "Webhook enabled" : "Webhook disabled", body: wh.name });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to toggle webhook", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => webhooksApi.test(id),
    onSuccess: (_res, id) => {
      const wh = webhooksQuery.data?.find((w) => w.id === id);
      pushToast({ tone: "success", title: "Test sent", body: wh ? `Test delivery queued for ${wh.name}` : "Test delivery queued" });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Test failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={WebhookIcon} message="Select a company to manage webhooks." />;
  }

  if (webhooksQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const webhooksList = webhooksQuery.data ?? [];

  if (viewDeliveries) {
    return (
      <div className="max-w-4xl space-y-6">
        <DeliveriesView webhook={viewDeliveries} onBack={() => setViewDeliveries(null)} />
      </div>
    );
  }

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WebhookIcon className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Webhooks</h1>
            <span className="text-sm text-muted-foreground">
              {webhooksList.length} webhook{webhooksList.length !== 1 ? "s" : ""}
            </span>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add Webhook
          </Button>
        </div>

        {webhooksList.length === 0 ? (
          <EmptyState
            icon={WebhookIcon}
            message="No webhooks yet. Create one to start receiving event notifications."
            action="Add Webhook"
            onAction={() => setCreateOpen(true)}
          />
        ) : (
          <div className="rounded-md border border-border">
            <div className="flex items-center gap-4 border-b border-border bg-muted/30 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <div className="flex-1">Name</div>
              <div className="hidden sm:block w-20 text-right">Events</div>
              <div className="hidden md:block w-20 text-right">Scope</div>
              <div className="hidden md:block w-24 text-right">Updated</div>
              <div className="w-8" />
            </div>
            {webhooksList.map((wh) => (
              <WebhookRow
                key={wh.id}
                webhook={wh}
                onEdit={() => setEditWebhook(wh)}
                onDelete={() => setDeleteConfirm(wh)}
                onTest={() => testMutation.mutate(wh.id)}
                onToggle={() => toggleMutation.mutate(wh)}
                onViewDeliveries={() => setViewDeliveries(wh)}
              />
            ))}
          </div>
        )}
      </div>

      <WebhookFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        webhook={null}
        onSubmit={(data) => createMutation.mutate(data as CreateWebhookData)}
        isPending={createMutation.isPending}
      />

      <WebhookFormDialog
        open={!!editWebhook}
        onOpenChange={(open) => { if (!open) setEditWebhook(null); }}
        webhook={editWebhook}
        onSubmit={(data) => { if (editWebhook) editMutation.mutate({ id: editWebhook.id, data }); }}
        isPending={editMutation.isPending}
      />

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Webhook</DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-medium text-foreground">{deleteConfirm?.name}</span> and all its delivery history? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteConfirm(null)} disabled={deleteMutation.isPending}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteConfirm) deleteMutation.mutate(deleteConfirm.id); }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Webhook"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

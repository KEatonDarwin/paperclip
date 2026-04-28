import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { hopperApi, type HopperItem, type HopperThread } from "../api/hopper";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Loader2, CheckCircle2, AlertTriangle, X, Send, ChevronDown } from "lucide-react";

// Compact status card for a single hopper item (software only)
function HopperItemCard({
  item,
  onExpand,
  onDismiss,
  onCancel,
}: {
  item: HopperItem;
  onExpand: () => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  if (item.status === "processing") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-md text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span className="truncate flex-1">Processing…</span>
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

  if (item.status === "needs_info") {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 shadow-md text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950/60 dark:text-amber-100 animate-pulse hover:animate-none hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="flex-1 text-left truncate">I need more info — click here</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      </button>
    );
  }

  if (item.status === "created" && item.linkedIssueIdentifier) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 shadow-md text-sm text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/60 dark:text-emerald-100">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        <span className="flex-1 truncate">
          Created{" "}
          <a
            href={`/DAR/issues/${item.linkedIssueIdentifier}`}
            className="font-medium underline underline-offset-2 hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            {item.linkedIssueIdentifier}
          </a>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 hover:bg-emerald-200/50 dark:hover:bg-emerald-800/50"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (item.status === "created") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 shadow-md text-sm text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/60 dark:text-emerald-100">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        <span className="flex-1">Issue created</span>
        <button type="button" onClick={onDismiss} className="shrink-0 rounded p-0.5 hover:bg-emerald-200/50">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return null;
}

// Conversation panel for needs_info items
function HopperConversation({
  item,
  onCancel,
  onClose,
}: {
  item: HopperItem;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.hopper.threads(item.id),
    queryFn: () => hopperApi.listThreads(item.id),
    refetchInterval: 3000,
  });

  const addThread = useMutation({
    mutationFn: (body: string) => hopperApi.addThread(item.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hopper.threads(item.id) });
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
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-400/50">
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm font-medium text-amber-900 dark:text-amber-100 flex-1">Need more info</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-amber-700 hover:bg-amber-200/50 dark:text-amber-300 dark:hover:bg-amber-800/50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Thread */}
      <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-2">
        <div className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="font-medium">You: </span>{item.prompt}
        </div>
        {threads.map((t: HopperThread) => (
          <div
            key={t.id}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs",
              t.authorType === "agent"
                ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                : "bg-muted text-muted-foreground",
            )}
          >
            <span className="font-medium">{t.authorType === "agent" ? "Agent: " : "You: "}</span>
            {t.body}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply */}
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
          Nevermind — cancel this request
        </button>
      </div>
    </div>
  );
}

// Completion watcher for a single item that has a linked issue
function IssueCompletionWatcher({ item, onComplete }: { item: HopperItem; onComplete: () => void }) {
  const completedRef = useRef(false);

  const { data: issueStatus } = useQuery({
    queryKey: ["hopper-issue-watch", item.linkedIssueId],
    queryFn: () => issuesApi.get(item.linkedIssueId!),
    enabled: Boolean(item.linkedIssueId),
    refetchInterval: 10000,
    select: (issue: { status: string }) => issue.status,
  });

  useEffect(() => {
    if (issueStatus === "done" && !completedRef.current) {
      completedRef.current = true;
      onComplete();
    }
  }, [issueStatus, onComplete]);

  return null;
}

export function HopperWidget() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: items = [] } = useQuery({
    queryKey: queryKeys.hopper.list(selectedCompanyId ?? ""),
    queryFn: () => hopperApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 5000,
  });

  const dismiss = useMutation({
    mutationFn: (itemId: string) => hopperApi.update(itemId, { dismissed: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hopper.list(selectedCompanyId!) });
    },
  });

  const cancel = useMutation({
    mutationFn: (itemId: string) => hopperApi.remove(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hopper.list(selectedCompanyId!) });
      setExpandedId(null);
    },
  });

  const activeItems = items.filter((i) => !i.dismissed && i.status !== "cancelled");

  if (activeItems.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[130] flex flex-col gap-2 items-end" aria-live="polite">
      {activeItems.map((item) => (
        <div key={item.id}>
          {item.status === "created" && item.linkedIssueId && (
            <IssueCompletionWatcher
              item={item}
              onComplete={() => {
                const label = item.kind === "bug" ? "Bug fixed" : "Feature shipped";
                const identifier = item.linkedIssueIdentifier ?? "issue";
                pushToast({
                  title: `${label}!`,
                  body: identifier,
                  tone: "success",
                  action: item.linkedIssueIdentifier
                    ? { label: `View ${item.linkedIssueIdentifier}`, href: `/DAR/issues/${item.linkedIssueIdentifier}` }
                    : undefined,
                });
                dismiss.mutate(item.id);
              }}
            />
          )}

          {expandedId === item.id && item.status === "needs_info" ? (
            <HopperConversation
              item={item}
              onCancel={() => cancel.mutate(item.id)}
              onClose={() => setExpandedId(null)}
            />
          ) : (
            <HopperItemCard
              item={item}
              onExpand={() => setExpandedId(item.id)}
              onDismiss={() => dismiss.mutate(item.id)}
              onCancel={() => cancel.mutate(item.id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

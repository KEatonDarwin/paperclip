import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { jarvisApi } from "../api/jarvis";
import { queryKeys } from "../lib/queryKeys";
import { Brain, ExternalLink, RotateCcw } from "lucide-react";

export function JarvisStatusCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [restarting, setRestarting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.jarvis.status(companyId),
    queryFn: () => jarvisApi.status(companyId),
    refetchInterval: restarting ? 3_000 : 30_000,
  });

  const restartMutation = useMutation({
    mutationFn: () => jarvisApi.restart(companyId),
    onSuccess: () => {
      setRestarting(true);
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.jarvis.status(companyId) });
        setRestarting(false);
      }, 8_000);
    },
  });

  if (isLoading || !data) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5 sm:py-5 animate-pulse">
        <div className="h-4 w-24 bg-muted rounded" />
        <div className="h-6 w-16 bg-muted rounded mt-2" />
      </div>
    );
  }

  const showRestarting = restarting || restartMutation.isPending;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${
                showRestarting
                  ? "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.6)] animate-pulse"
                  : data.up
                    ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                    : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]"
              }`}
            />
            <p className="text-sm font-medium">
              JARVIS
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">
            {showRestarting ? "Restarting…" : data.up ? "Online" : "Offline"}
          </p>
          <div className="text-xs text-muted-foreground/70 mt-1.5 space-y-0.5 hidden sm:block">
            {data.pid && <p>PID: {data.pid}</p>}
            {data.uptime && <p>Uptime: {data.uptime}</p>}
            {data.memory && <p>Memory: {data.memory}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1.5">
          <button
            onClick={() => {
              if (confirm("Restart JARVIS? It will be back online in a few seconds.")) {
                restartMutation.mutate();
              }
            }}
            disabled={showRestarting}
            className="text-muted-foreground/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title="Restart JARVIS"
          >
            <RotateCcw className={`h-4 w-4 ${showRestarting ? "animate-spin" : ""}`} />
          </button>
          <a
            href={`http://${window.location.hostname}:${data.uiPort}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground/50 hover:text-foreground transition-colors"
            title="Open JARVIS Dashboard"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <Brain className="h-4 w-4 text-muted-foreground/50" />
        </div>
      </div>
      {restartMutation.isError && (
        <p className="text-xs text-destructive mt-2">
          {(restartMutation.error as Error).message}
        </p>
      )}
    </div>
  );
}

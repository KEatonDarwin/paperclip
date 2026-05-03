import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelRight, SlidersHorizontal, Rows3 } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import type { QuickActionPattern } from "../components/MobileQuickActions";

function readQuickActionPattern(): QuickActionPattern {
  try {
    const stored = localStorage.getItem("paperclip.mobileQuickActionPattern");
    if (stored === "side-drawer" || stored === "bottom-sheet") return stored;
  } catch {}
  return "side-drawer";
}

function setQuickActionPattern(pattern: QuickActionPattern) {
  try { localStorage.setItem("paperclip.mobileQuickActionPattern", pattern); } catch {}
  window.dispatchEvent(new CustomEvent("paperclip:quick-action-pattern-changed", { detail: pattern }));
}

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateGeneral({ censorUsernameInLogs: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const [qaPattern, setQaPattern] = useState<QuickActionPattern>(readQuickActionPattern);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide defaults that affect how operator-visible logs are displayed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label="Toggle username log censoring"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate(!censorUsernameInLogs)}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Mobile quick actions style</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Choose how the quick-action menu appears on mobile devices.
          </p>
        </div>
        <div className="flex gap-3">
          {([
            { value: "side-drawer" as const, label: "Drawer", icon: PanelRight, desc: "Slides from right edge" },
            { value: "bottom-sheet" as const, label: "Sheet", icon: Rows3, desc: "Rises from bottom" },
          ]).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setQaPattern(opt.value);
                setQuickActionPattern(opt.value);
              }}
              className={cn(
                "flex flex-1 flex-col items-center gap-2 rounded-lg border p-4 transition-colors",
                qaPattern === opt.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30",
              )}
            >
              <opt.icon className={cn("h-6 w-6", qaPattern === opt.value ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("text-sm font-medium", qaPattern === opt.value ? "text-primary" : "text-foreground")}>{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.desc}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

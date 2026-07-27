import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LlmProvider, ProviderModel } from "@paperclipai/shared";
import { LLM_PROVIDERS } from "@paperclipai/shared";
import { modelCatalogApi } from "../api/model-catalog";
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
import { Cpu, Plus, RotateCw, Trash2, CheckCircle2, XCircle } from "lucide-react";

function AddModelDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { provider: LlmProvider; modelKey: string; displayName: string }) => void;
  isPending: boolean;
}) {
  const [provider, setProvider] = useState<LlmProvider>("anthropic");
  const [modelKey, setModelKey] = useState("");
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    if (open) {
      setProvider("anthropic");
      setModelKey("");
      setDisplayName("");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Model</DialogTitle>
          <DialogDescription>
            Register a model that isn't in the auto-discovered list yet, so it can be selected when configuring agents.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as LlmProvider)}
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            >
              {LLM_PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Display Name</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Claude Opus 5"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Model Key</label>
            <Input
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              placeholder="e.g. claude-opus-5"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">The underlying model id/string used when running a prompt.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ provider, modelKey: modelKey.trim(), displayName: displayName.trim() })}
            disabled={isPending || !modelKey.trim() || !displayName.trim()}
          >
            {isPending ? "Adding..." : "Add Model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  provider,
  label,
  configured,
  models,
  onRefresh,
  isRefreshing,
  onDelete,
}: {
  provider: LlmProvider;
  label: string;
  configured: boolean;
  models: ProviderModel[];
  onRefresh: () => void;
  isRefreshing: boolean;
  onDelete: (model: ProviderModel) => void;
}) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          {configured ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Configured
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              <XCircle className="h-3 w-3" /> Not configured
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={isRefreshing || !configured}>
          <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      {models.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">No models known for this provider yet.</div>
      ) : (
        models.map((model) => (
          <div
            key={model.id}
            className="flex items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-accent/30 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{model.displayName}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {model.source}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground truncate">{model.modelKey}</p>
            </div>
            {!model.id.startsWith("built-in:") && (
              <Button variant="ghost" size="icon-sm" onClick={() => onDelete(model)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function Providers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [refreshingProvider, setRefreshingProvider] = useState<LlmProvider | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Providers" }]);
  }, [setBreadcrumbs]);

  const modelsQuery = useQuery({
    queryKey: queryKeys.modelCatalog.list(selectedCompanyId ?? ""),
    queryFn: () => modelCatalogApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const providersQuery = useQuery({
    queryKey: queryKeys.modelCatalog.providers(selectedCompanyId ?? ""),
    queryFn: () => modelCatalogApi.providers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: { provider: LlmProvider; modelKey: string; displayName: string }) =>
      modelCatalogApi.create(selectedCompanyId!, data),
    onSuccess: (model) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.providers(selectedCompanyId!) });
      setAddOpen(false);
      pushToast({ tone: "success", title: "Model added", body: model.displayName });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to add model", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (model: ProviderModel) => modelCatalogApi.remove(selectedCompanyId!, model.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.providers(selectedCompanyId!) });
      pushToast({ tone: "success", title: "Model removed" });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to remove model", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const handleRefresh = async (provider: LlmProvider) => {
    if (!selectedCompanyId) return;
    setRefreshingProvider(provider);
    try {
      const result = await modelCatalogApi.refresh(selectedCompanyId, provider);
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog.providers(selectedCompanyId) });
      pushToast({
        tone: result.refreshed ? "success" : "info",
        title: result.refreshed ? "Model list refreshed" : "Nothing to refresh",
        body: result.refreshed ? `Found ${result.count} model(s)` : "Provider isn't configured or has no discovery endpoint yet.",
      });
    } catch (err) {
      pushToast({ tone: "error", title: "Refresh failed", body: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setRefreshingProvider(null);
    }
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Cpu} message="Select a company to manage providers." />;
  }

  if (modelsQuery.isLoading || providersQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const models = modelsQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const modelsByProvider = new Map<LlmProvider, ProviderModel[]>();
  for (const model of models) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(model);
    modelsByProvider.set(model.provider, list);
  }

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Providers</h1>
            <span className="text-sm text-muted-foreground">
              {models.length} model{models.length !== 1 ? "s" : ""} across {providers.length} providers
            </span>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add Model
          </Button>
        </div>

        <div className="space-y-4">
          {providers.map((status) => (
            <ProviderCard
              key={status.provider}
              provider={status.provider}
              label={status.label}
              configured={status.configured}
              models={modelsByProvider.get(status.provider) ?? []}
              onRefresh={() => handleRefresh(status.provider)}
              isRefreshing={refreshingProvider === status.provider}
              onDelete={(model) => deleteMutation.mutate(model)}
            />
          ))}
        </div>
      </div>

      <AddModelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmit={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
      />
    </>
  );
}

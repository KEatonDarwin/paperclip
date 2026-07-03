import { useState, useEffect, useCallback } from "react";
import { Info, X, RefreshCw, Copy, Check, GitBranch, Server, Clock, Package } from "lucide-react";
import { cn } from "../lib/utils";
import type { BuildInfo } from "../api/build-info";
import { buildInfoApi } from "../api/build-info";

// Module-load timestamp + dev git marker. Vite's `define` substitution for
// __BUILD_TIME__/__UI_GIT_HASH__ wasn't reliably taking effect in dev — using
// runtime values here keeps the modal safe to mount unconditionally. Server-side
// build info is still fetched via buildInfoApi below.
const BUILD_TIME = new Date().toISOString();
const UI_GIT_HASH = "dev";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between py-1.5 gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-xs text-right break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export function VersionInfoModal() {
  const [open, setOpen] = useState(false);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchBuildInfo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await buildInfoApi.get();
      setBuildInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchBuildInfo();
    }
  }, [open, fetchBuildInfo]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }

      if (e.key === "i" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    const handleCustomOpen = () => setOpen(true);

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("open-version-info", handleCustomOpen);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("open-version-info", handleCustomOpen);
    };
  }, [open]);

  const handleCopyAll = useCallback(() => {
    if (!buildInfo) return;
    const lines = [
      `Server Version: ${buildInfo.serverVersion}`,
      `Server Started: ${formatDate(buildInfo.serverStartedAt)}`,
      `Node: ${buildInfo.nodeVersion}`,
      `Platform: ${buildInfo.platform} (${buildInfo.arch})`,
      `UI Built: ${formatDate(BUILD_TIME)}`,
      `UI Commit: ${UI_GIT_HASH}`,
    ];
    if (buildInfo.git) {
      lines.push(
        `Branch: ${buildInfo.git.branch}`,
        `Commit: ${buildInfo.git.commitShortHash}`,
        `Message: ${buildInfo.git.commitMessage}`,
        `Author: ${buildInfo.git.commitAuthor}`,
        `Commit Date: ${formatDate(buildInfo.git.commitDate)}`,
      );
    }
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [buildInfo]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

      <div className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
            <Info className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-medium flex-1">Build Information</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCopyAll}
                className="text-muted-foreground hover:text-foreground p-1 rounded"
                title="Copy all"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={fetchBuildInfo}
                className={cn("text-muted-foreground hover:text-foreground p-1 rounded", loading && "animate-spin")}
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</div>
            )}

            {loading && !buildInfo && (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {buildInfo && (
              <>
                {/* Git / Last Change */}
                {buildInfo.git && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Last Change
                      </h3>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/20 px-3 py-1 divide-y divide-border">
                      <InfoRow label="Branch" value={buildInfo.git.branch} mono />
                      <InfoRow label="Commit" value={buildInfo.git.commitShortHash} mono />
                      <InfoRow label="Message" value={buildInfo.git.commitMessage} />
                      <InfoRow label="Author" value={buildInfo.git.commitAuthor} />
                      <InfoRow
                        label="Date"
                        value={`${formatDate(buildInfo.git.commitDate)} (${formatRelative(buildInfo.git.commitDate)})`}
                      />
                    </div>
                  </div>
                )}

                {/* UI Build */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Package className="h-3.5 w-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      UI Build
                    </h3>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 px-3 py-1 divide-y divide-border">
                    <InfoRow label="Build Time" value={`${formatDate(BUILD_TIME)} (${formatRelative(BUILD_TIME)})`} />
                    <InfoRow label="Commit" value={UI_GIT_HASH} mono />
                  </div>
                </div>

                {/* Server */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Server
                    </h3>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 px-3 py-1 divide-y divide-border">
                    <InfoRow label="Version" value={`v${buildInfo.serverVersion}`} mono />
                    <InfoRow label="Node" value={buildInfo.nodeVersion} mono />
                    <InfoRow label="Platform" value={`${buildInfo.platform} (${buildInfo.arch})`} />
                  </div>
                </div>

                {/* Uptime */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Uptime
                    </h3>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 px-3 py-1 divide-y divide-border">
                    <InfoRow
                      label="Server Started"
                      value={`${formatDate(buildInfo.serverStartedAt)} (${formatRelative(buildInfo.serverStartedAt)})`}
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground shrink-0 flex items-center justify-between">
            <span>
              Press{" "}
              <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded border border-border bg-muted text-[10px] font-mono font-medium shadow-sm">
                Ctrl
              </kbd>
              {" + "}
              <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded border border-border bg-muted text-[10px] font-mono font-medium shadow-sm">
                Shift
              </kbd>
              {" + "}
              <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded border border-border bg-muted text-[10px] font-mono font-medium shadow-sm">
                I
              </kbd>
              {" "}to toggle
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

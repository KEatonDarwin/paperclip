// Universal Bug/Task Intake widget (DAR-688). Ctrl+Shift+B anywhere in the app opens a modal
// to describe a bug/task; submit routes it into Foreman (DAR-687) as a Job and logs the
// outcome. This is the human-facing caller of the intake API — JARVIS and the DAR-685 UX
// reviewer POST to the same endpoint programmatically. The modal also lists recent submissions
// with their live status + PR link so the loop (submit → Foreman fixes → PR) is visible in one
// place. Mirrors the CommandModal hotkey/modal pattern.
import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { intakeApi, type IntakeJobType, type IntakeOutcome, type IntakeSubmitResponse } from "../api/intake";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { Bug, Loader2, ExternalLink, ArrowUpRight } from "lucide-react";

const REPO_STORAGE_KEY = "paperclip.intake.repo";
const DEFAULT_REPO = "paperclip";
// Foreman Workers project — Ctrl+Shift+B submissions auto-dispatch to this project.
const FOREMAN_PROJECT_ID = "abf02259-3a00-4db7-ac92-cc75435e5d1d";

// Foreman job status → badge styling. Terminal-good is emphasized; failures are destructive.
function statusClasses(status: string): string {
  switch (status) {
    case "merged":
    case "completed":
    case "succeeded":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "failed":
    case "error":
      return "bg-destructive/15 text-destructive";
    case "dispatching":
    case "running":
    case "planning":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function OutcomeRow({ o }: { o: IntakeOutcome }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", statusClasses(o.status))}>
          {o.status}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{o.job_type}</span>
        <span className="text-[10px] text-muted-foreground">· {o.source}</span>
        {o.merge_commit_sha && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            merged → {o.base_branch ?? "base"} @ {o.merge_commit_sha.slice(0, 8)}
          </span>
        )}
        {!o.merge_commit_sha && o.pr_url && (
          <a
            href={o.pr_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            PR <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <p className="line-clamp-2 text-xs text-foreground/90">{o.text}</p>
      {(o.summary || o.error) && (
        <p className={cn("line-clamp-2 text-[11px]", o.error ? "text-destructive" : "text-muted-foreground")}>
          {o.error ?? o.summary}
        </p>
      )}
    </li>
  );
}

export function BugIntakeWidget() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [jobType, setJobType] = useState<IntakeJobType>("bug_fix");
  const [repo, setRepo] = useState<string>(() => {
    try {
      return localStorage.getItem(REPO_STORAGE_KEY) || DEFAULT_REPO;
    } catch {
      return DEFAULT_REPO;
    }
  });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const outcomesQuery = useQuery({
    queryKey: ["intake-outcomes", selectedCompanyId],
    queryFn: () => intakeApi.list(selectedCompanyId!, { limit: 15 }),
    enabled: open && Boolean(selectedCompanyId),
    refetchInterval: open ? 8000 : false, // live-ish while the modal is open
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return intakeApi.submit({ companyId: selectedCompanyId, repo: repo.trim() || DEFAULT_REPO, text: text.trim(), jobType, source: "hotkey", run: true, foremanProjectId: FOREMAN_PROJECT_ID });
    },
    onSuccess: (result: IntakeSubmitResponse) => {
      setText("");
      try {
        localStorage.setItem(REPO_STORAGE_KEY, repo.trim() || DEFAULT_REPO);
      } catch {
        /* ignore */
      }
      pushToast({
        title: result.running ? "Submitted → Foreman dispatching" : "Submitted to Foreman (planning)",
        body: `Job ${result.submission_id.slice(0, 8)} · ${jobType}`,
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["intake-outcomes", selectedCompanyId] });
    },
    onError: (err: Error) => {
      pushToast({ title: "Intake failed", body: err.message, tone: "error" });
    },
  });

  // Ctrl+Shift+B → toggle. Matches the CommandModal (Ctrl+Shift+K) modifier discipline so it
  // never collides with browser shortcuts or the other global hotkeys.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "b" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      submit.reset();
      setTimeout(() => textRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!text.trim() || submit.isPending) return;
      submit.mutate();
    },
    [text, submit],
  );

  if (!open) return null;

  const outcomes = outcomesQuery.data ?? [];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

      <div className="fixed left-1/2 top-1/4 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <Bug className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-sm font-medium">Submit a bug or task</span>
          <span className="ml-auto hidden text-xs text-muted-foreground md:inline">Ctrl+Shift+B</span>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 px-4 py-3">
          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe the bug or task — what's wrong / what to build, and where…"
            rows={4}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(e);
            }}
          />

          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
              {(["bug_fix", "build"] as IntakeJobType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setJobType(t)}
                  className={cn(
                    "px-3 py-1.5 font-medium transition-colors",
                    jobType === t ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t === "bug_fix" ? "Bug fix" : "Build"}
                </button>
              ))}
            </div>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="repo"
              spellCheck={false}
              className="ml-auto w-32 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={!text.trim() || submit.isPending || !selectedCompanyId}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {submit.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
              Submit
            </button>
          </div>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recent submissions
            {outcomesQuery.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
          {outcomes.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {outcomesQuery.isLoading ? "Loading…" : "No submissions yet — send one above."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {outcomes.map((o) => (
                <OutcomeRow key={o.submission_id} o={o} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hopperApi, type HopperTaskMode } from "../api/hopper";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Bug, Zap, X, CalendarDays, Code2 } from "lucide-react";

export function HopperModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<HopperTaskMode>("software");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: ({ prompt, taskMode }: { prompt: string; taskMode: HopperTaskMode }) =>
      hopperApi.create(selectedCompanyId!, prompt, taskMode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hopper.list(selectedCompanyId!) });
      setSubmitted(true);
      setTimeout(() => {
        setOpen(false);
        setText("");
        setSubmitted(false);
      }, 800);
    },
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "b" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
        setText("");
        setSubmitted(false);
      }
    }
    function handleOpenEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("paperclip:open-hopper", handleOpenEvent);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("paperclip:open-hopper", handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  function handleSubmit() {
    const prompt = text.trim();
    if (!prompt || !selectedCompanyId || create.isPending) return;
    create.mutate({ prompt, taskMode: mode });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (!open) return null;

  const isSoftware = mode === "software";

  return (
    <div
      className="fixed inset-0 z-[150] flex items-start justify-center pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setOpen(false);
          setText("");
          setSubmitted(false);
        }
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg mx-4 rounded-lg border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          {/* Mode toggle */}
          <div className="flex items-center rounded-md border border-border bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode("software")}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 transition-colors",
                isSoftware
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Code2 className="h-3 w-3" />
              Software
            </button>
            <button
              type="button"
              onClick={() => setMode("personal")}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 transition-colors",
                !isSoftware
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarDays className="h-3 w-3" />
              Personal task
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-muted-foreground ml-1">
            {isSoftware ? (
              <>
                <Bug className="h-4 w-4" />
                <Zap className="h-3.5 w-3.5" />
              </>
            ) : (
              <CalendarDays className="h-4 w-4" />
            )}
          </div>

          <button
            type="button"
            onClick={() => { setOpen(false); setText(""); setSubmitted(false); }}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Input */}
        <div className="px-4 pb-4">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isSoftware
                ? "Describe what's broken or what you'd like added... (Enter to submit)"
                : "What do you need to do? (e.g. take out the trash, write unit tests, call dentist...)"
            }
            maxLength={4000}
            rows={3}
            className={cn(
              "w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring",
              submitted && "opacity-50",
            )}
            disabled={create.isPending || submitted}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {submitted
                ? "Submitted! Processing..."
                : "Enter to submit · Shift+Enter for new line · Esc to close"}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!text.trim() || create.isPending || submitted}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

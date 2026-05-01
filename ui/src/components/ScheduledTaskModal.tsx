import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { scheduledTasksApi } from "../api/scheduled-tasks";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { CalendarDays, X } from "lucide-react";

export function ScheduledTaskModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const createScheduled = useMutation({
    mutationFn: (requestText: string) =>
      scheduledTasksApi.create(selectedCompanyId!, requestText, undefined, "keyboard_shortcut"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
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
      if (e.key.toLowerCase() === "f" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
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
    window.addEventListener("paperclip:open-scheduled-task", handleOpenEvent);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("paperclip:open-scheduled-task", handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  function handleSubmit() {
    const prompt = text.trim();
    if (!prompt || !selectedCompanyId || createScheduled.isPending) return;
    createScheduled.mutate(prompt);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (!open) return null;

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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      <div className="relative z-10 w-full max-w-lg mx-4 rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
          </div>
          <span className="text-sm font-medium text-foreground">Schedule task</span>
          <button
            type="button"
            onClick={() => { setOpen(false); setText(""); setSubmitted(false); }}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 pb-4">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What do you need to schedule? (e.g. take out the trash Wed, write unit tests before Thursday, call dentist...)"
            maxLength={4000}
            rows={3}
            className={cn(
              "w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring",
              submitted && "opacity-50",
            )}
            disabled={createScheduled.isPending || submitted}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {submitted
                ? "Received! Scheduling..."
                : "Enter to submit · Shift+Enter for new line · Esc to close"}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!text.trim() || createScheduled.isPending || submitted}
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

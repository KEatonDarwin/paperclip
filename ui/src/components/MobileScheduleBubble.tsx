import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Send, X } from "lucide-react";
import { cn } from "../lib/utils";
import { scheduledTasksApi } from "../api/scheduled-tasks";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export function MobileScheduleBubble() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const createTask = useMutation({
    mutationFn: (requestText: string) =>
      scheduledTasksApi.create(selectedCompanyId!, requestText, undefined, "mobile_shortcut"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      setSubmitted(true);
      setTimeout(() => {
        setIsOpen(false);
        setText("");
        setSubmitted(false);
      }, 800);
    },
  });

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  function handleSubmit() {
    const val = text.trim();
    if (!val || !selectedCompanyId || createTask.isPending || submitted) return;
    createTask.mutate(val);
  }

  if (!isOpen) {
    return (
      <button
        title="Quick schedule"
        onClick={() => setIsOpen(true)}
        className="fixed bottom-24 left-4 z-40 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105 transition-transform flex items-center justify-center md:hidden"
      >
        <CalendarPlus className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end md:hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setIsOpen(false);
          setText("");
          setSubmitted(false);
        }
      }}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div className="relative z-10 w-full rounded-t-2xl border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarPlus className="h-4 w-4 text-primary" />
            Quick Schedule
          </div>
          <button
            type="button"
            onClick={() => { setIsOpen(false); setText(""); setSubmitted(false); }}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 pb-4">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Take out the trash Wednesday at 9am..."
            maxLength={4000}
            rows={2}
            className={cn(
              "w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring",
              submitted && "opacity-50",
            )}
            disabled={createTask.isPending || submitted}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {submitted ? "Scheduling..." : "Type or use voice dictation"}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!text.trim() || createTask.isPending || submitted}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

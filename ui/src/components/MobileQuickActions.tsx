import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  X,
  MessageCircle,
  CalendarPlus,
  FilePlus,
  Bug,
  Send,
  ChevronRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import { scheduledTasksApi } from "../api/scheduled-tasks";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";

export type QuickActionPattern = "side-drawer" | "bottom-sheet";

interface MobileQuickActionsProps {
  pattern: QuickActionPattern;
  onOpenChat: () => void;
}

interface ActionItem {
  id: string;
  label: string;
  icon: typeof Plus;
  color: string;
  action: () => void;
}

export function MobileQuickActions({ pattern, onOpenChat }: MobileQuickActionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleText, setScheduleText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (requestText: string) =>
      scheduledTasksApi.create(selectedCompanyId!, requestText, undefined, "mobile_shortcut"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(selectedCompanyId!) });
      setSubmitted(true);
      setTimeout(() => {
        setScheduleMode(false);
        setScheduleText("");
        setSubmitted(false);
        setIsOpen(false);
      }, 800);
    },
  });

  useEffect(() => {
    if (scheduleMode) setTimeout(() => inputRef.current?.focus(), 100);
  }, [scheduleMode]);

  const handleScheduleSubmit = useCallback(() => {
    const val = scheduleText.trim();
    if (!val || !selectedCompanyId || createTask.isPending || submitted) return;
    createTask.mutate(val);
  }, [scheduleText, selectedCompanyId, createTask, submitted]);

  const actions: ActionItem[] = [
    {
      id: "chat",
      label: "Chat",
      icon: MessageCircle,
      color: "bg-blue-500",
      action: () => {
        setIsOpen(false);
        onOpenChat();
      },
    },
    {
      id: "schedule",
      label: "Schedule",
      icon: CalendarPlus,
      color: "bg-emerald-500",
      action: () => setScheduleMode(true),
    },
    {
      id: "create",
      label: "Create",
      icon: FilePlus,
      color: "bg-amber-500",
      action: () => {
        setIsOpen(false);
        openNewIssue();
      },
    },
    {
      id: "bug",
      label: "Bug",
      icon: Bug,
      color: "bg-red-500",
      action: () => {
        setIsOpen(false);
        window.dispatchEvent(new CustomEvent("paperclip:open-hopper"));
      },
    },
  ];

  if (scheduleMode) {
    return <ScheduleSheet
      text={scheduleText}
      setText={setScheduleText}
      onSubmit={handleScheduleSubmit}
      onClose={() => { setScheduleMode(false); setScheduleText(""); setSubmitted(false); }}
      isPending={createTask.isPending}
      submitted={submitted}
      inputRef={inputRef}
    />;
  }

  switch (pattern) {
    case "side-drawer":
      return <SideDrawer isOpen={isOpen} setIsOpen={setIsOpen} actions={actions} />;
    case "bottom-sheet":
      return <BottomSheet isOpen={isOpen} setIsOpen={setIsOpen} actions={actions} />;
  }
}

// --- Pattern 1: Side drawer (slides from right edge) ---

function SideDrawer({
  isOpen,
  setIsOpen,
  actions,
}: {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  actions: ActionItem[];
}) {
  return (
    <div className="md:hidden">
      {/* Pull tab */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed right-0 bottom-32 z-40 flex items-center gap-1 rounded-l-xl bg-primary/90 text-primary-foreground pl-2 pr-1 py-3 shadow-lg backdrop-blur"
        >
          <Plus className="h-4 w-4" />
          <ChevronRight className="h-3 w-3 rotate-180" />
        </button>
      )}

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Drawer */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-20 bg-background/95 backdrop-blur border-l border-border shadow-2xl transition-transform duration-300 ease-out flex flex-col items-center justify-center gap-6 py-8",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Close */}
        <button
          onClick={() => setIsOpen(false)}
          className="absolute top-4 left-1/2 -translate-x-1/2 h-8 w-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        {actions.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={item.action}
              className="flex flex-col items-center gap-1.5 group"
            >
              <div
                className={cn(
                  "h-12 w-12 rounded-full flex items-center justify-center text-white shadow-md group-hover:scale-110 transition-transform",
                  item.color,
                )}
              >
                <Icon className="h-5 w-5" />
              </div>
              <span className="text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Pattern 2: Bottom sheet speed dial ---

function BottomSheet({
  isOpen,
  setIsOpen,
  actions,
}: {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  actions: ActionItem[];
}) {
  return (
    <div className="md:hidden">
      {/* Trigger FAB */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-24 right-4 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-xl flex items-center justify-center"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[140] bg-black/40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sheet */}
      <div
        className={cn(
          "fixed left-0 right-0 bottom-0 z-[150] transition-transform duration-300 ease-out",
          isOpen ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="bg-background rounded-t-2xl border-t border-border pb-[env(safe-area-inset-bottom)] shadow-2xl">
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-2">
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>

          {/* Actions grid */}
          <div className="grid grid-cols-4 gap-4 px-6 pb-6 pt-2">
            {actions.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={item.action}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div
                    className={cn(
                      "h-14 w-14 rounded-full flex items-center justify-center text-white shadow-md group-active:scale-95 transition-transform",
                      item.color,
                    )}
                  >
                    <Icon className="h-6 w-6" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Cancel */}
          <div className="px-6 pb-4">
            <button
              onClick={() => setIsOpen(false)}
              className="w-full py-3 rounded-xl bg-muted text-sm font-medium text-muted-foreground hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Schedule bottom sheet (shared by all patterns) ---

function ScheduleSheet({
  text,
  setText,
  onSubmit,
  onClose,
  isPending,
  submitted,
  inputRef,
}: {
  text: string;
  setText: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  isPending: boolean;
  submitted: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div
      className="fixed inset-0 z-[150] flex items-end md:hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
            onClick={onClose}
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
                onSubmit();
              }
            }}
            placeholder="Take out the trash Wednesday at 9am..."
            maxLength={4000}
            rows={2}
            className={cn(
              "w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring",
              submitted && "opacity-50",
            )}
            disabled={isPending || submitted}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {submitted ? "Scheduling..." : "Type or use voice dictation"}
            </span>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!text.trim() || isPending || submitted}
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

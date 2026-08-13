import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Archive, Edit2, Check, X, Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";
import { chatsApi, type AgentChat } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";

interface AgentChatSessionSidebarProps {
  agentId: string;
  chats: AgentChat[];
  selectedChatId: string | null;
  onSelect: (chatId: string) => void;
  onNew: () => void;
  onToggleLock?: (chat: AgentChat) => void;
}

function relativeDate(isoStr: string) {
  const date = new Date(isoStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function AgentChatSessionSidebar({
  agentId,
  chats,
  selectedChatId,
  onSelect,
  onNew,
  onToggleLock,
}: AgentChatSessionSidebarProps) {
  const queryClient = useQueryClient();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const updateChat = useMutation({
    mutationFn: (input: { chatId: string; data: { title?: string; status?: "archived" } }) =>
      chatsApi.update(agentId, input.chatId, input.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(agentId) });
    },
  });

  const handleRenameStart = (chat: AgentChat) => {
    setEditingId(chat.id);
    setEditTitle(chat.title ?? "");
  };

  const handleRenameCommit = (chatId: string) => {
    if (editTitle.trim()) {
      updateChat.mutate({ chatId, data: { title: editTitle.trim() } });
    }
    setEditingId(null);
  };

  const handleArchive = (chatId: string) => {
    updateChat.mutate({ chatId, data: { status: "archived" } });
    if (selectedChatId === chatId) onNew();
  };

  const activeChats = chats.filter((c) => c.status === "active");

  return (
    <div className="flex flex-col h-full border-r border-border min-w-0">
      <div className="flex-1 overflow-y-auto">
        {activeChats.length === 0 && (
          <p className="text-xs text-muted-foreground px-3 py-4">No sessions yet. Start a new chat.</p>
        )}
        {activeChats.map((chat) => (
          <div
            key={chat.id}
            className={cn(
              "group relative flex flex-col px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-muted/50 transition-colors",
              selectedChatId === chat.id && "bg-muted",
            )}
            onClick={() => editingId !== chat.id && onSelect(chat.id)}
            onMouseEnter={() => setHoveredId(chat.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {editingId === chat.id ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Input
                  className="h-6 text-xs px-1 py-0"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameCommit(chat.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => handleRenameCommit(chat.id)}
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setEditingId(null)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <>
                <span className="text-sm truncate pr-12 flex items-center gap-1">
                  {chat.locked && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  {chat.title ?? "Untitled"}
                </span>
                <span className="text-xs text-muted-foreground">{relativeDate(chat.updatedAt)}</span>
                {hoveredId === chat.id && (
                  <div
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      title="Rename"
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                      onClick={() => handleRenameStart(chat)}
                    >
                      <Edit2 className="h-3 w-3" />
                    </button>
                    {onToggleLock && (
                      <button
                        title={chat.locked ? "Unlock" : "Lock"}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                        onClick={() => onToggleLock(chat)}
                      >
                        {chat.locked ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                      </button>
                    )}
                    <button
                      title="Archive"
                      className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"
                      onClick={() => handleArchive(chat.id)}
                    >
                      <Archive className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="p-2 border-t border-border">
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={onNew}>
          <Plus className="h-4 w-4" />
          New Chat
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { chatsApi, type AgentChat } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";
import { AgentChatSessionSidebar } from "./AgentChatSessionSidebar";
import { AgentChatThread } from "./AgentChatThread";
import { SetPasswordDialog, PasswordGate } from "./ChatPasswordDialog";

interface AgentChatTabProps {
  agent: Agent;
}

export function AgentChatTab({ agent }: AgentChatTabProps) {
  const agentId = agent.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("chatId");
  const queryClient = useQueryClient();
  const [unlockedChats, setUnlockedChats] = useState<Set<string>>(new Set());
  const [lockDialogChat, setLockDialogChat] = useState<AgentChat | null>(null);

  const { data: chats = [] } = useQuery({
    queryKey: queryKeys.chats.list(agentId),
    queryFn: () => chatsApi.list(agentId),
    staleTime: 10000,
  });

  const createChat = useMutation({
    mutationFn: () => chatsApi.create(agentId),
    onSuccess: (newChat) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(agentId) });
      setSearchParams({ chatId: newChat.id });
    },
  });

  useEffect(() => {
    if (chats.length === 0 || selectedChatId) return;
    const activeChats = chats.filter((c) => c.status === "active");
    if (activeChats.length > 0) {
      setSearchParams({ chatId: activeChats[0]!.id });
    }
  }, [chats, selectedChatId, setSearchParams]);

  const handleSelect = (chatId: string) => {
    setUnlockedChats((prev) => {
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
    setSearchParams({ chatId });
  };

  const handleNew = () => {
    createChat.mutate();
  };

  const handleToggleLock = useCallback((chat: AgentChat) => {
    setLockDialogChat(chat);
  }, []);

  const handleUnlocked = useCallback((chatId: string) => {
    setUnlockedChats((prev) => new Set(prev).add(chatId));
  }, []);

  const selectedChat = chats.find((c) => c.id === selectedChatId);
  const needsPassword = selectedChat?.locked && !unlockedChats.has(selectedChatId!);

  return (
    <>
      <div className="flex h-[calc(100vh-200px)] min-h-[400px] border border-border rounded-lg overflow-hidden">
        <div className="w-48 shrink-0">
          <AgentChatSessionSidebar
            agentId={agentId}
            chats={chats}
            selectedChatId={selectedChatId}
            onSelect={handleSelect}
            onNew={handleNew}
            onToggleLock={handleToggleLock}
          />
        </div>

        <div className="flex-1 min-w-0">
          {selectedChatId ? (
            needsPassword ? (
              <PasswordGate
                agentId={agentId}
                chatId={selectedChatId}
                onUnlocked={() => handleUnlocked(selectedChatId)}
              />
            ) : (
              <AgentChatThread
                agentId={agentId}
                chatId={selectedChatId}
                agent={agent}
              />
            )
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {createChat.isPending ? "Creating chat..." : "Select or start a new chat"}
            </div>
          )}
        </div>
      </div>

      {lockDialogChat && (
        <SetPasswordDialog
          open={!!lockDialogChat}
          onOpenChange={(open) => { if (!open) setLockDialogChat(null); }}
          agentId={agentId}
          chatId={lockDialogChat.id}
          isLocked={lockDialogChat.locked}
        />
      )}
    </>
  );
}

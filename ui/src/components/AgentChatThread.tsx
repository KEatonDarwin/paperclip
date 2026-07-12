import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Wrench } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { cn, stripMarkdown } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { AgentIcon } from "./AgentIconPicker";
import { AgentChatInput } from "./AgentChatInput";
import { chatsApi, type AgentChatMessage } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";

interface AgentChatThreadProps {
  agentId: string;
  chatId: string;
  agent: Agent;
}

function CopyButton({ text, title, plain }: { text: string; title: string; plain?: boolean }) {
  const [copied, setCopied] = useState(false);
  const content = plain ? stripMarkdown(text) : text;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
      title={title}
      onClick={() => {
        navigator.clipboard.writeText(content).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// Brief tool-use annotation lines start with "Tool used:"
const TOOL_LINE_RE = /^Tool used:/i;

function isToolAnnotation(line: string) {
  return TOOL_LINE_RE.test(line.trim());
}

function ChatBubble({
  message,
  agentIcon,
}: {
  message: AgentChatMessage;
  agentIcon?: string | null;
}) {
  const isUser = message.role === "user";

  if (!isUser) {
    // Split tool annotation lines from regular content
    const lines = message.body.split("\n");
    const toolLines: string[] = [];
    const contentLines: string[] = [];
    for (const line of lines) {
      if (isToolAnnotation(line)) {
        toolLines.push(line.trim());
      } else {
        contentLines.push(line);
      }
    }
    const content = contentLines.join("\n").trim();

    return (
      <div className="group flex gap-3 items-start">
        <div className="shrink-0 mt-0.5">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
            <AgentIcon icon={agentIcon ?? null} className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          {toolLines.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {toolLines.map((tl, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  {tl.replace(/^Tool used:\s*/i, "")}
                </span>
              ))}
            </div>
          )}
          {content && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownBody>{content}</MarkdownBody>
            </div>
          )}
          {content && (
            <div className="flex items-center gap-1.5 pt-0.5">
              <CopyButton text={content} title="Copy" plain />
              <CopyButton text={content} title="Copy as markdown" />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex justify-end items-end gap-1.5">
      <div className="flex items-center gap-1.5 pb-1">
        <CopyButton text={message.body} title="Copy" plain />
        <CopyButton text={message.body} title="Copy as markdown" />
      </div>
      <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {message.body}
      </div>
    </div>
  );
}

function ThinkingBubble({ agentIcon }: { agentIcon?: string | null }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="shrink-0 mt-0.5">
        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
          <AgentIcon icon={agentIcon ?? null} className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-1">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Thinking…</span>
      </div>
    </div>
  );
}

export function AgentChatThread({ agentId, chatId, agent }: AgentChatThreadProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const { data: messages = [], isFetching } = useQuery({
    queryKey: queryKeys.chats.messages(agentId, chatId),
    queryFn: () => chatsApi.getMessages(agentId, chatId),
    staleTime: 5000,
  });

  // Detect when a new agent message arrives and clear thinking state
  useEffect(() => {
    const prev = prevMessageCountRef.current;
    const curr = messages.length;
    if (curr > prev) {
      const latestMsg = messages[curr - 1];
      if (latestMsg?.role === "agent") {
        setIsAgentThinking(false);
        setPendingRunId(null);
      }
    }
    prevMessageCountRef.current = curr;
  }, [messages]);

  // Auto-scroll when messages grow or thinking state changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isAgentThinking]);

  const sendMessage = useMutation({
    mutationFn: (body: string) => chatsApi.sendMessage(agentId, chatId, body),
    onMutate: () => {
      setIsAgentThinking(true);
    },
    onSuccess: (result) => {
      setPendingRunId(result.runId);
      // Invalidate messages to show the user message immediately
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(agentId, chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(agentId) });
    },
    onError: () => {
      setIsAgentThinking(false);
      setPendingRunId(null);
    },
  });

  const handleSend = (body: string) => {
    sendMessage.mutate(body);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isFetching && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground text-sm gap-2 py-12">
            <AgentIcon icon={agent.icon ?? null} className="h-8 w-8 opacity-30" />
            <p>Send a message to start a conversation with {agent.name}.</p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} agentIcon={agent.icon} />
        ))}
        {isAgentThinking && <ThinkingBubble agentIcon={agent.icon} />}
      </div>

      {/* Input */}
      <AgentChatInput
        disabled={false}
        isLoading={sendMessage.isPending}
        onSend={handleSend}
      />
    </div>
  );
}

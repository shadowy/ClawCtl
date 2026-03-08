import { useState, useEffect, useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, Send, Wrench, X, RefreshCw, MessageSquare } from "lucide-react";
import { post } from "../lib/api";
import { useInstances } from "../hooks/useInstances";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  actions?: Array<{ tool: string; args: any; result: string }>;
}

function useAssistantContext() {
  const location = useLocation();
  const params = useParams<{ id?: string }>();
  const { instances } = useInstances();

  const path = location.pathname;

  // Instance detail page — most context-rich
  if (path.startsWith("/instance/") && params.id) {
    const inst = instances.find((i) => i.id === params.id);
    return {
      instanceId: params.id,
      page: "instance" as const,
      hint: inst ? `Viewing instance "${inst.connection.label || inst.id}" (${inst.connection.status})` : `Viewing instance ${params.id}`,
    };
  }

  // Other pages — provide page context, pick first connected instance for API calls
  const firstConnected = instances.find((i) => i.connection.status === "connected");
  const pageMap: Record<string, string> = {
    "/": "Dashboard — overview of all instances",
    "/sessions": "Sessions — browsing chat sessions",
    "/usage": "Usage — token usage and metrics",
    "/security": "Security — tool permissions and audit",
    "/config": "Config — comparing instance configurations",
    "/tools": "Tools — tool matrix and diagnostics",
    "/monitoring": "Monitoring — host metrics (CPU/memory)",
    "/operations": "Operations — operation logs",
    "/settings": "Settings — LLM config, user management",
  };

  return {
    instanceId: firstConnected?.id || null,
    page: path as string,
    hint: pageMap[path] || `Page: ${path}`,
  };
}

export function GlobalAssistant() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 w-12 h-12 bg-brand text-white rounded-full shadow-lg hover:bg-brand/90 flex items-center justify-center transition-transform hover:scale-105 z-50"
          title={t("assistant.title")}
        >
          <MessageSquare size={20} />
        </button>
      )}
    </>
  );
}

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const ctx = useAssistantContext();

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userMsg: ChatMsg = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setLoading(true);
    try {
      const apiMessages = updated.map((m) => ({ role: m.role, content: m.content }));
      const res = await post<{ reply: string; actions?: ChatMsg["actions"]; tokensUsed?: number }>(
        "/assistant/chat",
        {
          messages: apiMessages,
          instanceId: ctx.instanceId,
          pageContext: ctx.hint,
        },
      );
      setMessages((prev) => [...prev, { role: "assistant", content: res.reply, actions: res.actions }]);
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message || "Failed to get response"}` }]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  return (
    <div className="fixed right-0 top-0 h-screen w-[400px] z-40 flex flex-col border-l border-edge bg-s1 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Bot size={16} className="text-brand" /> {t("assistant.title")}
        </div>
        <div className="flex items-center gap-1">
          {ctx.instanceId && (
            <span className="text-[10px] px-1.5 py-0.5 bg-s2 rounded text-ink-3 font-mono truncate max-w-[150px]" title={ctx.instanceId}>
              {ctx.instanceId}
            </span>
          )}
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1"><X size={16} /></button>
        </div>
      </div>

      {/* Messages */}
      <div ref={chatRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center py-8 text-ink-3">
            <Bot size={32} className="mb-2 opacity-40" />
            <p className="text-xs text-center px-4">
              {ctx.instanceId
                ? t("assistant.emptyStateInstance")
                : t("assistant.emptyStateGeneral")}
            </p>
            <div className="flex flex-col gap-1.5 mt-3 w-full">
              {(ctx.instanceId ? [
                t("assistant.quickQuestions.showAgentConfig"),
                t("assistant.quickQuestions.whatModel"),
                t("assistant.quickQuestions.changeModel"),
                t("assistant.quickQuestions.isRunning"),
              ] : [
                t("assistant.quickQuestions.configNewAgent"),
                t("assistant.quickQuestions.securityBestPractices"),
                t("assistant.quickQuestions.explainBindings"),
              ]).map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="px-3 py-1.5 text-xs text-left bg-s2 border border-edge rounded text-ink-2 hover:text-ink hover:bg-s3 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
              msg.role === "user"
                ? "bg-brand/20 text-ink"
                : "bg-s2 border border-edge text-ink"
            }`}>
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{msg.content}</pre>
              {msg.actions && msg.actions.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-edge space-y-0.5">
                  {msg.actions.map((a, j) => (
                    <div key={j} className="flex items-center gap-1 text-xs text-ok">
                      <Wrench size={10} />
                      <span>{a.tool}: {a.result}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-s2 border border-edge rounded-lg px-3 py-2 text-xs text-ink-3">
              <RefreshCw size={12} className="animate-spin inline mr-1.5" />
              {t("assistant.thinking")}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-edge p-3 shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder={t("assistant.inputPlaceholder")}
            className="flex-1 px-3 py-2 bg-s2 border border-edge rounded text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-brand"
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            className="px-3 py-2 bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-40 transition-colors"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

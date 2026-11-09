import { useState } from "react";
import { Badge, Card, EmptyState, LoadingState, PageHeader, ConversationPanel } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  status?: "sending" | "sent" | "delivered" | "read";
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: "1",
    role: "system",
    content: "Medveris Intelligence is decision support only, not a diagnosis. Confirm any clinical action with the patient chart and your clinical judgment.",
    timestamp: new Date(),
  },
];

export function AIChatPage() {
  const aiConfig = useQuery<{ configured: boolean; provider: string | null; model: string | null }>("/ai/config");
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [busy, setBusy] = useState(false);

  function handleSend(text: string) {
    if (busy) return;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
      status: "sending",
    };
    setMessages((prev) => [...prev, userMessage]);
    setBusy(true);

    // Simulate assistant response (replace with real API call in production)
    setTimeout(() => {
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `I've noted your question about "${text}". In a production environment, I would consult the patient's chart, relevant guidelines, and the configured AI provider. For now, this is a demonstration of the mobile-first conversation interface.`,
        timestamp: new Date(),
        status: "delivered",
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === userMessage.id ? { ...m, status: "delivered" as const } : m))
      );
      setMessages((prev) => [...prev, assistantMessage]);
      setBusy(false);
    }, 1200);
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Medveris Intelligence"
        title="AI chat"
        description="Assistive conversation with Medveris Intelligence. Output is decision support only and never a diagnosis."
        actions={
          aiConfig.data?.configured ? (
            <Badge tone="success">{aiConfig.data.provider} · {aiConfig.data.model}</Badge>
          ) : (
            <Badge tone="warning">No provider configured</Badge>
          )
        }
      />
      <Card title="Conversation" description="Your messages and the assistant's responses appear here. The composer stays reachable on mobile.">
        {aiConfig.loading ? (
          <LoadingState />
        ) : aiConfig.error ? (
          <EmptyState title="Cannot connect to AI service" description={aiConfig.error} />
        ) : !aiConfig.data?.configured ? (
          <EmptyState
            title="No AI provider configured"
            description="An administrator must configure a reviewed AI provider before conversations can be submitted. The conversation interface is ready."
          />
        ) : (
          <ConversationPanel
            messages={messages}
            onSend={handleSend}
            title="Medveris Intelligence"
            placeholder="Ask a clinical question…"
            busy={busy}
          />
        )}
      </Card>
    </div>
  );
}

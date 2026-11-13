import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Badge, Card, EmptyState, LoadingState, Notice, PageHeader, ConversationPanel, type ConversationMessage } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";
import { useAuth } from "../lib/auth";
import { api, errorMessage } from "../lib/api";
import { detectRedFlag } from "@medveris/domain";

interface PublicAiStatus {
  mode: string;
  requested: boolean;
  configured: boolean;
  providerBaseUrl: string | null;
  model: string | null;
  connection: { url: string; version: string | null; lastVerifiedAt: string | null } | null;
}

interface ChatResponse {
  message: string;
  redFlag: boolean;
  redFlagCategory: string | null;
  disclaimer: string;
  provider: string | null;
  model: string | null;
}

const PATIENT_CHIPS = ["I feel unwell", "I have a question about my medicine", "I need to see a doctor", "Help me understand my results"];
const PROVIDER_CHIPS = ["Summarize the patient before my visit", "What are red flags for chest pain?", "Draft a referral note", "What does this result mean?"];

const GREETING: Record<"patient" | "provider", string> = {
  patient: "Hello. I can help with general health questions. I cannot diagnose you or change your medicine — only a clinician can. What would you like to know?",
  provider: "Clinical decision support. I assist; you decide. Verify against the patient record and facility protocols before acting. What do you need?",
};

/** Dual-role accounts (patient + clinical role) can switch audiences; switching into provider mode re-confirms. */
function AudienceSwitch({ target }: { target: "patient" | "provider" }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  if (target === "patient") {
    return (
      <button type="button" className="mv-audience-switch" onClick={() => navigate("/portal/assistant")}>
        Switch to patient mode
      </button>
    );
  }
  return confirming ? (
    <span className="mv-audience-switch mv-audience-switch--confirm" role="group" aria-label="Confirm switch to provider mode">
      <span>Open provider mode?</span>
      <button type="button" onClick={() => navigate("/ai/chat")}>Confirm</button>
      <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  ) : (
    <button type="button" className="mv-audience-switch" onClick={() => setConfirming(true)}>
      Switch to provider mode
    </button>
  );
}

export function AIChatPage() {
  const { me } = useAuth();
  const { pathname } = useLocation();
  // The portal route serves patients; everything else is the clinical (provider) surface.
  const mode: "patient" | "provider" = pathname.startsWith("/portal") ? "patient" : "provider";
  const aiStatus = useQuery<PublicAiStatus>("/public/ai/status");
  const [messages, setMessages] = useState<ConversationMessage[]>(() => [
    { id: "greeting", role: "system", content: GREETING[mode], timestamp: new Date() },
  ]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const usable = useMemo(() => {
    const status = aiStatus.data;
    if (!status) return false;
    return status.configured || status.mode === "sandbox";
  }, [aiStatus.data]);

  const isDualRole = useMemo(() => {
    if (!me) return false;
    const clinical = ["nurse", "midwife", "clinician", "specialist_clinician", "pharmacist"];
    return Boolean(me.patientId && me.activeTenant?.roles.some((role) => clinical.includes(role)));
  }, [me]);

  const sendToServer = useCallback(async (history: ConversationMessage[]): Promise<ChatResponse> => {
    return api<ChatResponse>("/ai/chat", {
      method: "POST",
      body: {
        mode,
        messages: history
          .filter((message) => message.role === "user" || message.role === "assistant")
          .filter((message) => message.kind !== "emergency")
          .map((message) => ({ role: message.role, content: message.content })),
      },
    });
  }, [mode]);

  const handleSend = useCallback((text: string) => {
    if (busy) return;
    setNotice(null);
    const userMessage: ConversationMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
      status: "sending",
    };
    const next = [...messages, userMessage];
    setMessages(next);
    setBusy(true);

    // Offline: queue locally and tell the user; never pretend the message was delivered.
    if (!navigator.onLine) {
      const emergency = detectRedFlag(text);
      setMessages((current) =>
        current
          .map((message) => (message.id === userMessage.id ? { ...message, status: "failed" as const } : message))
          .concat(emergency ? [{
            id: crypto.randomUUID(),
            role: "assistant",
            kind: "emergency",
            content: "This could be serious. Call emergency services now (112 or 999) or go to the nearest facility. Do not wait.",
            timestamp: new Date(),
          }] : []),
      );
      setNotice("You are offline. This message was not sent. It stays on this device — tap Retry when you are back online.");
      setBusy(false);
      return;
    }

    void (async () => {
      try {
        const response = await sendToServer(next);
        setMessages((current) => [
          ...current.map((message) => (message.id === userMessage.id ? { ...message, status: "delivered" as const } : message)),
          {
            id: crypto.randomUUID(),
            role: "assistant",
            kind: response.redFlag ? "emergency" : "text",
            content: response.redFlag
              ? "This could be serious. Call emergency services now (112 or 999) or go to the nearest facility. Do not wait for a reply."
              : response.message,
            timestamp: new Date(),
            status: "delivered",
          },
        ]);
      } catch (cause) {
        setMessages((current) => current.map((message) => (message.id === userMessage.id ? { ...message, status: "failed" as const } : message)));
        setNotice(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, messages, sendToServer]);

  const handleRetry = useCallback((id: string) => {
    const target = messages.find((message) => message.id === id);
    if (!target || busy) return;
    // Drop the failed placeholder and resend with the full history.
    const resent = messages.filter((message) => message.id !== id);
    setMessages(resent);
    handleSend(target.content);
  }, [busy, handleSend, messages]);

  const statusBadge = aiStatus.data?.configured
    ? <Badge tone="success">{aiStatus.data.mode === "sandbox" ? "Sandbox (synthetic)" : `${aiStatus.data.model ? "AI configured" : "AI configured"}${aiStatus.data.model ? ` · ${aiStatus.data.model}` : ""}`}</Badge>
    : aiStatus.data?.mode === "sandbox"
      ? <Badge tone="info">Sandbox (synthetic)</Badge>
      : <Badge tone="warning">No provider configured</Badge>;

  const isProvider = mode === "provider";

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Medveris Intelligence"
        title="AI assistant"
        description={isProvider
          ? "Clinical decision support for licensed staff. The assistant assists; it never decides — confirm against the record."
          : "General health information in plain language. Not medical advice — only a clinician can diagnose, prescribe, or change treatment."}
        actions={statusBadge}
      />
      {isDualRole && <AudienceSwitch target={isProvider ? "patient" : "provider"} />}
      {!online && <Notice tone="warning" title="You appear to be offline">Messages are not sent while offline; they stay on this device. Tap Retry when you reconnect. For emergencies, call 112 or 999 now.</Notice>}
      {notice && <Notice tone="warning" title="Message not sent">{notice}</Notice>}
      <Card
        title={isProvider ? "Assistant" : "Ask a health question"}
        description={isProvider
          ? "AI-generated. Verify against the patient record and clinical guidelines."
          : "AI-generated. For anything urgent, call 112 or 999 or go to the nearest facility."}
      >
        {aiStatus.loading ? (
          <LoadingState label="Checking the AI provider" />
        ) : aiStatus.error ? (
          <EmptyState title="Cannot connect to the AI service" description={aiStatus.error} />
        ) : !usable ? (
          <EmptyState
            title="No AI provider configured"
            description="An administrator must configure and verify a reviewed AI provider before conversations can be submitted. The interface is ready."
          />
        ) : (
          <ConversationPanel
            messages={messages}
            onSend={handleSend}
            audience={mode}
            title={isProvider ? "Medveris Intelligence — Provider" : "Medveris Intelligence"}
            placeholder={isProvider ? "Ask for decision support…" : "Ask a health question…"}
            busy={busy}
            chips={isProvider ? PROVIDER_CHIPS : PATIENT_CHIPS}
            onChipSelect={(chip) => handleSend(chip)}
            onRetryMessage={handleRetry}
          />
        )}
      </Card>
      <p className="mv-small mv-muted mv-ai-chat-footer">
        {isProvider
          ? "AI assists; you decide. Confirm diagnosis, medication changes and orders in the patient record before acting. Every session is audited."
          : "This is not medical advice. Talk to your clinician about anything important. Your questions are stored under your account."}
        {" "}
        {!isProvider && <Link to="/portal/consents">How your information is shared</Link>}
      </p>
    </div>
  );
}

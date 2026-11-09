import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "./primitives";
import "./ConversationPanel.css";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  status?: "sending" | "sent" | "delivered" | "read";
}

interface ConversationPanelProps {
  messages: Message[];
  onSend: (text: string) => void;
  onClose?: () => void;
  title?: string;
  placeholder?: string;
  busy?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function ConversationPanel({
  messages,
  onSend,
  onClose,
  title = "Message",
  placeholder = "Type a message…",
  busy = false,
  className = "",
  style,
}: ConversationPanelProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  // Handle Escape key and body scroll lock when used as a modal
  useEffect(() => {
    if (!onClose) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const isModal = Boolean(onClose);

  return (
    <>
      {isModal ? (
        <div
          className="mv-conversation-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose?.();
          }}
          aria-hidden="false"
        >
          <div
            ref={panelRef}
            className={`mv-conversation mv-conversation--modal${className ? ` ${className}` : ""}`}
            style={style}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="mv-conversation__header">
              <h2 className="mv-conversation__title">{title}</h2>
              <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close conversation">
                Close
              </Button>
            </header>
            <div className="mv-conversation__list" aria-live="polite" aria-label="Messages">
              {messages.length === 0 ? (
                <div className="mv-conversation__empty">
                  <p>No messages yet.</p>
                  <p className="mv-small mv-muted">Start the conversation above.</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))
              )}
              <div ref={bottomRef} />
            </div>
            <form className="mv-conversation__composer" onSubmit={handleSend} aria-label="Compose message">
              <label className="mv-conversation__composer-label" htmlFor="mv-conversation-input">
                Message
              </label>
              <div className="mv-conversation__composer-row">
                <Input
                  id="mv-conversation-input"
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(e as unknown as FormEvent);
                    }
                  }}
                  placeholder={placeholder}
                  disabled={busy}
                  autoFocus
                  className="mv-conversation__input"
                  style={{ minHeight: 48 }}
                />
                <Button type="submit" disabled={!draft.trim() || busy} busy={busy} className="mv-conversation__send">
                  Send
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : (
        <div className={`mv-conversation mv-conversation--inline${className ? ` ${className}` : ""}`} style={style}>
          <header className="mv-conversation__header">
            <h2 className="mv-conversation__title">{title}</h2>
          </header>
          <div className="mv-conversation__list" aria-live="polite" aria-label="Messages">
            {messages.length === 0 ? (
              <div className="mv-conversation__empty">
                <p>No messages yet.</p>
                <p className="mv-small mv-muted">Start the conversation above.</p>
              </div>
            ) : (
              messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
            )}
            <div ref={bottomRef} />
          </div>
          <form className="mv-conversation__composer" onSubmit={handleSend} aria-label="Compose message">
            <label className="mv-conversation__composer-label" htmlFor="mv-conversation-input-inline">
              Message
            </label>
            <div className="mv-conversation__composer-row">
              <Input
                id="mv-conversation-input-inline"
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e as unknown as FormEvent);
                  }
                }}
                placeholder={placeholder}
                disabled={busy}
                autoFocus
                className="mv-conversation__input"
                style={{ minHeight: 48 }}
              />
              <Button type="submit" disabled={!draft.trim() || busy} busy={busy} className="mv-conversation__send">
                Send
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  return (
    <div className={`mv-conversation__message mv-conversation__message--${isUser ? "user" : isSystem ? "system" : "assistant"}`}>
      {!isSystem && (
        <span className="mv-conversation__role">
          {isUser ? "You" : "Assistant"}
        </span>
      )}
      <div className="mv-conversation__bubble">
        {isSystem ? (
          <span className="mv-conversation__system">{message.content}</span>
        ) : (
          <>
            <p className="mv-conversation__text">{message.content}</p>
            {message.status && (
              <span className={`mv-conversation__status mv-conversation__status--${message.status}`} aria-label={`Message status: ${message.status}`}>
                {message.status === "sending" ? "Sending…" : message.status === "sent" ? "Sent" : message.status === "delivered" ? "Delivered" : "Read"}
              </span>
            )}
          </>
        )}
      </div>
      <time className="mv-conversation__time mv-small mv-muted" dateTime={message.timestamp.toISOString()}>
        {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </time>
    </div>
  );
}

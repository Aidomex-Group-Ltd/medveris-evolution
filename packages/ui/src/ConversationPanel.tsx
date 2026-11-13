import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "./primitives";
import "./ConversationPanel.css";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Render a message as a fixed, safety-critical card instead of a bubble. */
  kind?: "text" | "emergency";
}

interface ConversationPanelProps {
  messages: ConversationMessage[];
  onSend: (text: string) => void;
  onClose?: () => void;
  title?: string;
  placeholder?: string;
  busy?: boolean;
  /** Audience rendered in the header badge. */
  audience?: "patient" | "provider";
  /** Quick-reply chips shown under the message list. */
  chips?: string[];
  onChipSelect?: (chip: string) => void;
  /** Retry a message whose status is "failed". */
  onRetryMessage?: (id: string) => void;
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
  audience,
  chips,
  onChipSelect,
  onRetryMessage,
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
              <span className="mv-conversation__header-actions">
                {audience && <span className={`mv-conversation__audience mv-conversation__audience--${audience}`}>{audience === "patient" ? "Patient" : "Provider"}</span>}
                <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close conversation">
                  Close
                </Button>
              </span>
            </header>
            <div className="mv-conversation__list" aria-live="polite" aria-label="Messages">
              {messages.length === 0 ? (
                <div className="mv-conversation__empty">
                  <p>No messages yet.</p>
                  <p className="mv-small mv-muted">Start the conversation above.</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} onRetryMessage={onRetryMessage} />
                ))
              )}
              <div ref={bottomRef} />
            </div>
            {chips && chips.length > 0 && onChipSelect && (
              <div className="mv-conversation__chips" role="list" aria-label="Suggested replies">
                {chips.map((chip) => (
                  <button key={chip} type="button" role="listitem" className="mv-conversation__chip" disabled={busy} onClick={() => onChipSelect(chip)}>
                    {chip}
                  </button>
                ))}
              </div>
            )}
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
            {audience && <span className={`mv-conversation__audience mv-conversation__audience--${audience}`}>{audience === "patient" ? "Patient" : "Provider"}</span>}
          </header>
          <div className="mv-conversation__list" aria-live="polite" aria-label="Messages">
            {messages.length === 0 ? (
              <div className="mv-conversation__empty">
                <p>No messages yet.</p>
                <p className="mv-small mv-muted">Start the conversation above.</p>
              </div>
            ) : (
              messages.map((msg) => <MessageBubble key={msg.id} message={msg} onRetryMessage={onRetryMessage} />)
            )}
            <div ref={bottomRef} />
          </div>
          {chips && chips.length > 0 && onChipSelect && (
            <div className="mv-conversation__chips" role="list" aria-label="Suggested replies">
              {chips.map((chip) => (
                <button key={chip} type="button" role="listitem" className="mv-conversation__chip" disabled={busy} onClick={() => onChipSelect(chip)}>
                  {chip}
                </button>
              ))}
            </div>
          )}
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

function MessageBubble({ message, onRetryMessage }: { message: ConversationMessage; onRetryMessage?: (id: string) => void }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (message.kind === "emergency") {
    return (
      <div className="mv-emergency-card" role="alert" data-message-role="assistant" data-message-kind="emergency">
        <p className="mv-emergency-card__title">This could be an emergency</p>
        <p className="mv-emergency-card__body">{message.content}</p>
        <div className="mv-emergency-card__actions">
          <a className="mv-emergency-card__call" href="tel:112">Call 112</a>
          <a className="mv-emergency-card__call" href="tel:999">Call 999</a>
        </div>
        <p className="mv-emergency-card__note">Do not wait for the assistant to reply. Go to the nearest facility now if you can.</p>
      </div>
    );
  }
  return (
    <div className={`mv-conversation__message mv-conversation__message--${isUser ? "user" : isSystem ? "system" : "assistant"}`} data-message-role={message.role}>
      {!isSystem && (
        <span className="mv-conversation__role">
          {isUser ? "You" : "AI assistant"}
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
                {message.status === "sending" ? "Sending…" : message.status === "sent" ? "Sent" : message.status === "delivered" ? "Delivered" : message.status === "read" ? "Read" : "Failed to send"}
              </span>
            )}
            {message.status === "failed" && onRetryMessage && (
              <Button variant="ghost" size="sm" className="mv-conversation__retry" onClick={() => onRetryMessage(message.id)}>
                Retry
              </Button>
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

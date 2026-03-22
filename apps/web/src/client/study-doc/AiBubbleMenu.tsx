import { BubbleMenu, type Editor } from "@tiptap/react";
import { useState, useRef, useCallback } from "react";

type AiBubbleMenuProps = {
  editor: Editor;
  onAiAction: (action: string, selectedText: string, from: number, to: number) => void;
  isLoading?: boolean;
};

const AI_ACTIONS = [
  { id: "explain", label: "Explain", icon: "?" },
  { id: "simplify", label: "Simplify", icon: "\u2193" },
  { id: "latex", label: "LaTeX", icon: "\u2211" },
  { id: "diagram", label: "Diagram", icon: "\u25C7" },
] as const;

export function AiBubbleMenu({ editor, onAiAction, isLoading }: AiBubbleMenuProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const getSelectionInfo = useCallback(() => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, " ");
    return { text, from, to };
  }, [editor]);

  const handleAction = useCallback((actionId: string) => {
    const { text, from, to } = getSelectionInfo();
    if (!text.trim()) return;
    onAiAction(actionId, text, from, to);
  }, [getSelectionInfo, onAiAction]);

  const handleCustomSubmit = useCallback(() => {
    if (!customPrompt.trim()) return;
    const { text, from, to } = getSelectionInfo();
    if (!text.trim()) return;
    onAiAction(`custom:${customPrompt}`, text, from, to);
    setCustomPrompt("");
    setShowCustom(false);
  }, [customPrompt, getSelectionInfo, onAiAction]);

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{
        duration: 150,
        placement: "top",
        maxWidth: "none",
      }}
      className="study-doc-bubble-menu"
    >
      {isLoading ? (
        <div className="bubble-menu-loading">
          <span className="bubble-menu-spinner" />
          Stuart is thinking...
        </div>
      ) : showCustom ? (
        <div className="bubble-menu-custom">
          <input
            ref={inputRef}
            className="bubble-menu-input"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCustomSubmit();
              if (e.key === "Escape") setShowCustom(false);
            }}
            placeholder="Ask Stuart about this..."
            autoFocus
          />
          <button
            className="bubble-menu-send"
            type="button"
            onClick={handleCustomSubmit}
            disabled={!customPrompt.trim()}
          >
            Ask
          </button>
        </div>
      ) : (
        <div className="bubble-menu-actions">
          {AI_ACTIONS.map((action) => (
            <button
              key={action.id}
              className="bubble-menu-btn"
              type="button"
              onClick={() => handleAction(action.id)}
              title={action.label}
            >
              <span className="bubble-menu-icon">{action.icon}</span>
              <span className="bubble-menu-label">{action.label}</span>
            </button>
          ))}
          <div className="bubble-menu-divider" />
          <button
            className="bubble-menu-btn ask-stuart"
            type="button"
            onClick={() => {
              setShowCustom(true);
              setTimeout(() => inputRef.current?.focus(), 50);
            }}
            title="Ask Stuart"
          >
            <span className="bubble-menu-icon">?</span>
            <span className="bubble-menu-label">Ask</span>
          </button>
        </div>
      )}
    </BubbleMenu>
  );
}

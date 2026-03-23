import { type Editor } from "@tiptap/react";
import { useCallback } from "react";

type ToolbarProps = {
  editor: Editor | null;
  title: string;
  onTitleChange?: (newTitle: string) => void;
  onSave?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  isSaving?: boolean;
  isDirty?: boolean;
};

export function StudyDocToolbar({ editor, title, onTitleChange, onSave, onDelete, onClose, onToggleFullscreen, isFullscreen, isSaving, isDirty }: ToolbarProps) {
  if (!editor) return null;

  return (
    <div className="study-doc-toolbar-wrap">
      {/* Row 1: Title + actions (always visible) */}
      <div className="study-doc-toolbar-header">
        <input
          className="toolbar-title-input"
          value={title}
          onChange={(e) => onTitleChange?.(e.target.value)}
          placeholder="Untitled Notes"
          spellCheck={false}
        />
        <div className="toolbar-header-actions">
          {isDirty ? (
            <span className="toolbar-status-text unsaved">Unsaved</span>
          ) : (
            <span className="toolbar-status-text saved">Saved</span>
          )}
          {onSave ? (
            <button className="toolbar-save-btn" type="button" onClick={onSave} disabled={isSaving || !isDirty}>
              {isSaving ? "..." : "Save"}
            </button>
          ) : null}
          {onToggleFullscreen ? (
            <button className="toolbar-btn" type="button" onClick={onToggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
              {isFullscreen ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 1 1 1 1 4" /><polyline points="12 1 15 1 15 4" /><polyline points="4 15 1 15 1 12" /><polyline points="12 15 15 15 15 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 5 1 1 5 1" /><polyline points="11 1 15 1 15 5" /><polyline points="15 11 15 15 11 15" /><polyline points="5 15 1 15 1 11" />
                </svg>
              )}
            </button>
          ) : null}
          {onDelete ? (
            <button className="toolbar-btn destructive" type="button" onClick={onDelete} title="Delete">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 3 14 13 14 13 6" /><line x1="1" y1="4" x2="15" y2="4" /><line x1="6" y1="2" x2="10" y2="2" />
              </svg>
            </button>
          ) : null}
          {onClose ? (
            <button className="toolbar-btn" type="button" onClick={onClose} title="Close">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Row 2: Formatting tools (scrollable) */}
      <div className="study-doc-toolbar">

      <div className="toolbar-group">
        <ToolbarButton
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        >H1</ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        >H2</ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3"
        >H3</ToolbarButton>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="Underline"
        >
          <u>U</u>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline Code"
        >
          {"</>"}
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("highlight")}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          title="Highlight"
        >
          <span style={{ background: "#fef08a", padding: "0 2px" }}>H</span>
        </ToolbarButton>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet List"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="3" cy="4" r="1.5" fill="currentColor" stroke="none" />
            <line x1="7" y1="4" x2="14" y2="4" />
            <circle cx="3" cy="8" r="1.5" fill="currentColor" stroke="none" />
            <line x1="7" y1="8" x2="14" y2="8" />
            <circle cx="3" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <line x1="7" y1="12" x2="14" y2="12" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered List"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <text x="1" y="5.5" fontSize="6" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text>
            <line x1="7" y1="4" x2="14" y2="4" />
            <text x="1" y="9.5" fontSize="6" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text>
            <line x1="7" y1="8" x2="14" y2="8" />
            <text x="1" y="13.5" fontSize="6" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text>
            <line x1="7" y1="12" x2="14" y2="12" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 4v8" />
            <line x1="7" y1="6" x2="14" y2="6" />
            <line x1="7" y1="10" x2="12" y2="10" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code Block"
        >
          {"{ }"}
        </ToolbarButton>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarButton
          onClick={() => (editor.commands as any).insertCallout?.()}
          title="Insert Callout"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="8" y1="5" x2="8" y2="9" />
            <circle cx="8" cy="11" r="0.5" fill="currentColor" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => (editor.commands as any).insertMathBlock?.()}
          title="Insert Math Block"
        >
          <span style={{ fontFamily: "serif", fontStyle: "italic" }}>&#8721;</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => (editor.commands as any).insertMermaidBlock?.()}
          title="Insert Diagram"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="1" width="8" height="4" rx="1" />
            <line x1="8" y1="5" x2="8" y2="8" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="8" x2="3" y2="11" />
            <line x1="13" y1="8" x2="13" y2="11" />
            <rect x="1" y="11" width="5" height="3.5" rx="1" />
            <rect x="10" y="11" width="5" height="3.5" rx="1" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          title="Insert Table"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="1" />
            <line x1="2" y1="6" x2="14" y2="6" />
            <line x1="2" y1="10" x2="14" y2="10" />
            <line x1="6" y1="2" x2="6" y2="14" />
            <line x1="10" y1="2" x2="10" y2="14" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Horizontal Rule"
        >&#8212;</ToolbarButton>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h7a4 4 0 0 1 0 8H8" />
            <polyline points="6 4 3 7 6 10" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 7H6a4 4 0 0 0 0 8h2" />
            <polyline points="10 4 13 7 10 10" />
          </svg>
        </ToolbarButton>
      </div>

      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`toolbar-btn${active ? " active" : ""}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

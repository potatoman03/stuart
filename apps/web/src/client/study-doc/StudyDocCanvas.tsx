import { useEditor, EditorContent } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildStudyDocExtensions } from "./extensions";
import { StudyDocToolbar } from "./Toolbar";
import { AiBubbleMenu } from "./AiBubbleMenu";
import { apiUrl } from "../platform";
import { convertStudyDocBlocks } from "./rendering";
import "./study-doc.css";

type StudyDocCanvasProps = {
  initialDoc: unknown;
  initialMarkdown?: string;
  title: string;
  artifactId?: string;
  taskId?: string;
  onSavePayload?: (newPayload: string) => Promise<void> | void;
  onSaveToWorkspace?: (markdown: string, title: string) => void;
  onDelete?: () => void;
  onClose?: () => void;
};

export function StudyDocCanvas({
  initialDoc,
  initialMarkdown,
  title,
  artifactId,
  taskId,
  onSavePayload,
  onSaveToWorkspace,
  onDelete,
  onClose,
}: StudyDocCanvasProps) {
  const [docTitle, setDocTitle] = useState(title);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSavePayload);
  onSaveRef.current = onSavePayload;
  const isInitializingRef = useRef(true);

  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const handleSave = useCallback(async () => {
    const ed = editorRef.current;
    const saveFn = onSaveRef.current;
    if (!ed || !saveFn) {
      console.warn("[StudyDoc] Save skipped: editor or save function not available");
      return;
    }
    setIsSaving(true);
    try {
      const doc = ed.getJSON();
      const markdown = ed.storage.markdown?.getMarkdown?.() ?? "";
      const payload = JSON.stringify({
        kind: "study_doc",
        title: docTitle,
        doc,
        markdown,
      });
      await saveFn(payload);
      setIsDirty(false);
    } catch (err) {
      console.error("[StudyDoc] Save failed:", err);
    } finally {
      setIsSaving(false);
    }
  }, [title]);

  const editor = useEditor({
    extensions: buildStudyDocExtensions(),
    content: initialDoc || undefined,
    editorProps: {
      attributes: {
        "data-task-id": taskId ?? "",
      },
    },
    onCreate({ editor: e }) {
      // If we have markdown but no doc JSON, parse the markdown
      if (!initialDoc && initialMarkdown) {
        e.commands.setContent(initialMarkdown);
      }
      // Post-process: convert display math and Mermaid-like blocks into nodes
      convertStudyDocBlocks(e);
      // Mark initialization complete after a tick so onUpdate ignores
      // the transactions produced by setContent + post-processing
      queueMicrotask(() => {
        isInitializingRef.current = false;
      });
    },
    onUpdate() {
      // Skip marking dirty during initial content load
      if (isInitializingRef.current) return;
      setIsDirty(true);
      // Debounced auto-save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void handleSave();
      }, 5000);
    },
  });

  editorRef.current = editor;

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleSaveToWorkspace = useCallback(() => {
    if (!editor || !onSaveToWorkspace) return;
    const markdown = editor.storage.markdown?.getMarkdown?.() ?? "";
    onSaveToWorkspace(markdown, title);
  }, [editor, onSaveToWorkspace, title]);

  const handleAiAction = useCallback(async (action: string, selectedText: string, from: number, to: number) => {
    setIsAiLoading(true);

    const promptMap: Record<string, string> = {
      explain: `Explain this concept clearly and concisely, as if to a student:\n\n> ${selectedText}\n\nRespond with ONLY the explanation text. No markdown headers.`,
      simplify: `Rewrite this to be simpler and more concise while preserving accuracy:\n\n> ${selectedText}\n\nRespond with ONLY the rewritten text.`,
      latex: `Convert any mathematical notation in this text to proper LaTeX notation:\n\n> ${selectedText}\n\nRespond with ONLY the raw LaTeX, no $$ delimiters, no explanation.`,
      diagram: `Create a Mermaid diagram illustrating this:\n\n> ${selectedText}\n\nRespond with ONLY the Mermaid code, no fences, no explanation.`,
    };

    let prompt: string;
    if (action.startsWith("custom:")) {
      prompt = `The student selected this text:\n\n> ${selectedText}\n\nQuestion: ${action.slice(7)}\n\nRespond concisely.`;
    } else {
      prompt = promptMap[action] ?? `About this text: ${selectedText}`;
    }

    try {
      const res = await fetch(apiUrl("/api/quick-complete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, fallback: selectedText }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const result = (data.result as string || "").trim();

      if (!editor || !result) return;

      if (action === "diagram") {
        editor.chain().focus().setTextSelection(to).insertContent({
          type: "mermaidBlock",
          attrs: { code: result },
        }).run();
      } else if (action === "latex") {
        editor.chain().focus().setTextSelection(to).insertContent({
          type: "mathBlock",
          attrs: { latex: result, display: true },
        }).run();
      } else {
        // For explain/simplify/custom: parse markdown into HTML, then insert
        // as rich content so bold, code, lists etc. render properly
        const markdownParser = editor.storage.markdown?.parser;
        if (markdownParser) {
          const parsed = markdownParser.parse(result);
          editor.chain().focus().setTextSelection(to).insertContent(parsed).run();
        } else {
          // Fallback: insert as plain text
          editor.chain().focus().setTextSelection(to).insertContent(result).run();
        }
      }
    } catch {
      // AI action failed silently
    } finally {
      setIsAiLoading(false);
    }
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={`study-doc-canvas${isFullscreen ? " fullscreen" : ""}`}>
      <StudyDocToolbar
        editor={editor}
        title={docTitle}
        onTitleChange={(t) => { setDocTitle(t); setIsDirty(true); }}
        onSave={handleSave}
        onToggleFullscreen={() => setIsFullscreen((f) => !f)}
        isFullscreen={isFullscreen}
        isSaving={isSaving}
        isDirty={isDirty}
        onDelete={onDelete}
        onClose={onClose}
      />
      <div className="study-doc-editor-wrapper">
        <EditorContent editor={editor} className="study-doc-editor" />
        <AiBubbleMenu
          editor={editor}
          onAiAction={handleAiAction}
          isLoading={isAiLoading}
        />
      </div>
      {onSaveToWorkspace ? (
        <div className="study-doc-footer">
          <button
            className="study-doc-export-btn"
            type="button"
            onClick={handleSaveToWorkspace}
          >
            Save to study folder
          </button>
          <span className="study-doc-export-hint">
            Saves as Markdown to your project folder. Stuart will use it as study context.
          </span>
        </div>
      ) : null}
    </div>
  );
}

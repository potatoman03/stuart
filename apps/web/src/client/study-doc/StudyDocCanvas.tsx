import { useEditor, EditorContent, type Editor, generateJSON } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildStudyDocExtensions } from "./extensions";
import { StudyDocToolbar } from "./Toolbar";
import { AiBubbleMenu } from "./AiBubbleMenu";
import { apiUrl } from "../platform";
import "./study-doc.css";

/**
 * Walk the editor document and convert raw `$$ ... $$` text into mathBlock nodes.
 * Handles both single-paragraph (`$$ F = ma $$`) and multi-paragraph forms where
 * `$$` appears alone in a paragraph followed by content and a closing `$$` paragraph.
 */
function convertMathBlocks(editor: Editor) {
  const { doc, schema } = editor.state;
  const mathBlockType = schema.nodes.mathBlock;
  if (!mathBlockType) return;

  // Strategy 1: Single text node contains $$ ... $$
  const transforms: Array<{ from: number; to: number; latex: string }> = [];

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const text = node.textContent;
      // Match display math: $$ ... $$ (possibly with whitespace/newlines)
      const regex = /\$\$([\s\S]+?)\$\$/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        // Only convert if the paragraph contains ONLY the math expression
        // (inline math within text would require an inline node, not supported yet)
        const beforeMath = text.slice(0, match.index).trim();
        const afterMath = text.slice(match.index + match[0].length).trim();
        if (!beforeMath && !afterMath) {
          const captured = match[1];
          if (captured) {
            transforms.push({
              from: pos,
              to: pos + node.nodeSize,
              latex: captured.trim(),
            });
          }
        }
      }
    }
  });

  if (transforms.length === 0) {
    // Strategy 2: Multi-paragraph form where $$ appears alone in paragraphs
    // e.g., paragraph("$$"), paragraph("F = ma"), paragraph("$$")
    const nodes: Array<{ pos: number; size: number; text: string }> = [];
    doc.descendants((node, pos) => {
      if (node.isTextblock) {
        nodes.push({ pos, size: node.nodeSize, text: node.textContent.trim() });
      }
    });

    for (let i = 0; i < nodes.length - 2; i++) {
      const nodeI = nodes[i]!;
      if (nodeI.text === "$$") {
        // Find the closing $$
        for (let j = i + 1; j < nodes.length; j++) {
          const nodeJ = nodes[j]!;
          if (nodeJ.text === "$$") {
            // Collect content between opening and closing $$
            const latexParts: string[] = [];
            for (let k = i + 1; k < j; k++) {
              latexParts.push(nodes[k]!.text);
            }
            const latex = latexParts.join("\n").trim();
            if (latex) {
              transforms.push({
                from: nodeI.pos,
                to: nodeJ.pos + nodeJ.size,
                latex,
              });
              i = j; // skip past closing $$
            }
            break;
          }
        }
      }
    }
  }

  if (transforms.length === 0) return;

  // Apply transforms in reverse order to preserve positions
  const tr = editor.state.tr;
  for (let i = transforms.length - 1; i >= 0; i--) {
    const t = transforms[i]!;
    const mathNode = mathBlockType.create({ latex: t.latex, display: true });
    tr.replaceWith(t.from, t.to, mathNode);
  }

  editor.view.dispatch(tr);
}

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
      // Post-process: convert $$ ... $$ text into mathBlock nodes
      convertMathBlocks(e);
      // Mark initialization complete after a tick so onUpdate ignores
      // the transactions produced by setContent + convertMathBlocks
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

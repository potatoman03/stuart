import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState, useEffect, useRef, useCallback } from "react";
import { renderMermaidSvg } from "./rendering";

function MermaidNodeView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const [editing, setEditing] = useState(!node.attrs.code);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`);
  const code = node.attrs.code as string;

  useEffect(() => {
    if (editing) return;
    let cancelled = false;

    (async () => {
      const { svg: rendered, error: renderError } = await renderMermaidSvg(code, idRef.current);
      if (!cancelled) {
        setSvg(rendered);
        setError(renderError);
      }
    })();

    return () => { cancelled = true; };
  }, [code, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <NodeViewWrapper className="mermaid-node editing">
        <div className="mermaid-edit-header">
          <span className="mermaid-edit-label">Mermaid Diagram</span>
          <button
            className="mermaid-render-btn"
            type="button"
            onClick={() => code.trim() && setEditing(false)}
          >
            Render
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="mermaid-node-input"
          value={code}
          onChange={(e) => updateAttributes({ code: e.target.value })}
          placeholder={"graph TD\n  A[Start] --> B[End]"}
          rows={Math.max(4, code.split("\n").length + 1)}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className={`mermaid-node rendered${selected ? " selected" : ""}`}>
      <button
        className="node-delete-btn"
        type="button"
        onClick={deleteNode}
        title="Delete block"
        contentEditable={false}
      >x</button>
      <div className="mermaid-display" onClick={() => setEditing(true)} title="Click to edit diagram">
        {error ? (
          <pre className="mermaid-error">{error}</pre>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const MermaidExtension = Node.create({
  name: "mermaidBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: { default: "graph TD\n  A[Start] --> B[End]" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mermaid-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "mermaid-block" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },

  addCommands() {
    return {
      insertMermaidBlock: (attrs?: { code?: string }) => ({ commands }: any) => {
        return commands.insertContent({
          type: this.name,
          attrs: { code: attrs?.code ?? "graph TD\n  A[Start] --> B[End]" },
        });
      },
    } as any;
  },
});

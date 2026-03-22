import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState, useRef, useEffect, useCallback } from "react";
import katex from "katex";

function MathNodeView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const [editing, setEditing] = useState(!node.attrs.latex);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latex = node.attrs.latex as string;

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  const handleBlur = useCallback(() => {
    if (latex.trim()) {
      setEditing(false);
    }
  }, [latex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      handleBlur();
    }
  }, [handleBlur]);

  if (editing) {
    return (
      <NodeViewWrapper className="math-node editing">
        <textarea
          ref={textareaRef}
          className="math-node-input"
          value={latex}
          onChange={(e) => updateAttributes({ latex: e.target.value })}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder="Enter LaTeX (e.g., E = mc^2)"
          rows={Math.max(2, latex.split("\n").length)}
        />
      </NodeViewWrapper>
    );
  }

  let html = "";
  let error = "";
  try {
    html = katex.renderToString(latex, { displayMode: true, throwOnError: true });
  } catch (e) {
    error = e instanceof Error ? e.message : "Invalid LaTeX";
  }

  return (
    <NodeViewWrapper className={`math-node rendered${selected ? " selected" : ""}`}>
      <button
        className="node-delete-btn"
        type="button"
        onClick={deleteNode}
        title="Delete block"
        contentEditable={false}
      >x</button>
      <div
        className="math-node-display"
        onClick={() => setEditing(true)}
        title="Click to edit LaTeX"
      >
        {error ? (
          <span className="math-node-error">{error}</span>
        ) : (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const MathExtension = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: { default: "" },
      display: { default: true },
    };
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="math-block"]',
      getAttrs(dom) {
        if (typeof dom === "string") return false;
        return {
          latex: dom.getAttribute("data-latex") ?? dom.textContent ?? "",
          display: true,
        };
      },
    }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-type": "math-block",
      "data-latex": HTMLAttributes.latex || "",
    })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const latex = node.attrs.latex || "";
          state.write("$$\n");
          state.text(latex, false);
          state.ensureNewLine();
          state.write("$$");
          state.closeBlock(node);
        },
      },
    };
  },

  addCommands() {
    return {
      insertMathBlock: (attrs?: { latex?: string }) => ({ commands }: any) => {
        return commands.insertContent({
          type: this.name,
          attrs: { latex: attrs?.latex ?? "", display: true },
        });
      },
    } as any;
  },
});

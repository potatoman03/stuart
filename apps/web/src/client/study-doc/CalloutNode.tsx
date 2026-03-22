import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";

const CALLOUT_STYLES = {
  note: { label: "Note", color: "#296767" },
  important: { label: "Important", color: "#b85c2f" },
  tip: { label: "Tip", color: "#2d7d46" },
  warning: { label: "Warning", color: "#c4432b" },
} as const;

type CalloutStyle = keyof typeof CALLOUT_STYLES;

function CalloutNodeView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const style = (node.attrs.style as CalloutStyle) || "note";

  return (
    <NodeViewWrapper className={`callout-node callout-${style}`}>
      <div className="callout-header">
        <select
          className="callout-style-select"
          value={style}
          onChange={(e) => updateAttributes({ style: e.target.value })}
          contentEditable={false}
        >
          {Object.entries(CALLOUT_STYLES).map(([key, val]) => (
            <option key={key} value={key}>{val.label}</option>
          ))}
        </select>
        <button
          className="node-delete-btn"
          type="button"
          onClick={deleteNode}
          title="Delete block"
          contentEditable={false}
        >x</button>
      </div>
      <NodeViewContent className="callout-content" />
    </NodeViewWrapper>
  );
}

export const CalloutExtension = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  draggable: true,
  defining: true,

  addAttributes() {
    return {
      style: { default: "note" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },

  addCommands() {
    return {
      insertCallout: (attrs?: { style?: string }) => ({ commands }: any) => {
        return commands.insertContent({
          type: this.name,
          attrs: { style: attrs?.style ?? "note" },
          content: [{ type: "paragraph" }],
        });
      },
    } as any;
  },
});

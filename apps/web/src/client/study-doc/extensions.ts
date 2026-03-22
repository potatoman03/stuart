import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";
import { MathExtension } from "./MathNode";
import { CalloutExtension } from "./CalloutNode";
import { MermaidExtension } from "./MermaidNode";
import { SlashCommandExtension } from "./SlashCommandExtension";

const lowlight = createLowlight(common);

/**
 * Ensures the document always ends with an empty paragraph so the user
 * can click below the last block (code block, math, mermaid) to continue typing.
 */
/**
 * Adds Backspace handling for code blocks: when the code block is empty and
 * the user presses Backspace, delete the entire block instead of doing nothing.
 */
const CodeBlockBackspace = Extension.create({
  name: "codeBlockBackspace",

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return false;
        // Check if we're at position 0 inside a code block
        if ($from.parent.type.name === "codeBlock" && $from.parentOffset === 0) {
          if ($from.parent.textContent === "") {
            // Empty code block — delete it
            const pos = $from.before();
            const end = $from.after();
            editor.chain().focus().deleteRange({ from: pos, to: end }).run();
            return true;
          }
        }
        return false;
      },
    };
  },
});

const TrailingParagraph = Extension.create({
  name: "trailingParagraph",

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey("trailingParagraph");
    return [
      new Plugin({
        key: pluginKey,
        appendTransaction(_transactions, _oldState, newState) {
          const { doc, schema, tr } = newState;
          const lastNode = doc.lastChild;
          if (!lastNode || lastNode.type.name !== "paragraph" || lastNode.textContent !== "") {
            const paragraphType = schema.nodes.paragraph;
            if (!paragraphType) return null;
            const paragraph = paragraphType.create();
            return tr.insert(doc.content.size, paragraph);
          }
          return null;
        },
      }),
    ];
  },
});

export function buildStudyDocExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({ lowlight }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    Placeholder.configure({
      placeholder: "Start writing... (try /math quadratic formula)",
    }),
    Highlight.configure({ multicolor: true }),
    Typography,
    Underline,
    Markdown,
    MathExtension,
    CalloutExtension,
    MermaidExtension,
    SlashCommandExtension,
    CodeBlockBackspace,
    TrailingParagraph,
  ];
}

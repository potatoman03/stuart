import { Extension } from "@tiptap/core";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import {
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { apiUrl } from "../platform";
import { convertStudyDocBlocks } from "./rendering";

/**
 * Slash command menu for inline AI actions in the study doc editor.
 *
 * Powered by TipTap's Suggestion plugin -- typing `/` triggers a floating
 * dropdown that filters as the user continues to type.
 *
 * Two flavours of command:
 *   - **Immediate**: insert a block/node right away (callout, table, etc.)
 *   - **Query-based**: after selection the prefix stays in the editor and the
 *     user types a query, then presses Enter to execute (math, diagram, etc.)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SlashCommand = {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** If true the user needs to type a query after selecting (two-phase). */
  queryBased: boolean;
  prefix: string;
};

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const SLASH_COMMANDS: SlashCommand[] = [
  // -- Immediate insert -----------------------------------------------------
  { id: "heading1", label: "Heading 1", description: "Large heading", icon: "H1", queryBased: false, prefix: "/heading1" },
  { id: "heading2", label: "Heading 2", description: "Medium heading", icon: "H2", queryBased: false, prefix: "/heading2" },
  { id: "heading3", label: "Heading 3", description: "Small heading", icon: "H3", queryBased: false, prefix: "/heading3" },
  { id: "bulletList", label: "Bullet List", description: "Unordered list", icon: "\u2022", queryBased: false, prefix: "/bulletList" },
  { id: "numberedList", label: "Numbered List", description: "Ordered list", icon: "1.", queryBased: false, prefix: "/numberedList" },
  { id: "codeBlock", label: "Code Block", description: "Fenced code block", icon: "{}", queryBased: false, prefix: "/codeBlock" },
  { id: "table", label: "Table", description: "Insert a table", icon: "\u229E", queryBased: false, prefix: "/table" },
  { id: "callout", label: "Callout", description: "Insert a callout note", icon: "!", queryBased: false, prefix: "/callout" },
  { id: "divider", label: "Divider", description: "Horizontal rule", icon: "\u2014", queryBased: false, prefix: "/divider" },
  // -- Query-based (two-phase) ----------------------------------------------
  { id: "math", label: "Math", description: "Generate LaTeX from text", icon: "\u2211", queryBased: true, prefix: "/math " },
  { id: "diagram", label: "Diagram", description: "Generate a Mermaid diagram", icon: "\u25C7", queryBased: true, prefix: "/diagram " },
  { id: "explain", label: "Explain", description: "Get an AI explanation", icon: "?", queryBased: true, prefix: "/explain " },
  { id: "code", label: "Code", description: "Generate code with AI", icon: "<>", queryBased: true, prefix: "/code " },
];

// ---------------------------------------------------------------------------
// Quick-math lookup table
// ---------------------------------------------------------------------------

// LaTeX generation prompt — adapted from Inkd's proven approach.
// Always routes through Codex quick-complete, no local lookup table.
const LATEX_SYSTEM_PROMPT = `Output ONLY raw LaTeX math code. No thinking, no commentary, no explanation.

ABSOLUTE RULES:
- Your entire response must be valid LaTeX math syntax
- NO English words or sentences
- NO "I will...", NO reasoning, NO thinking out loud
- NO dollar signs, NO backticks, NO markdown
- Just LaTeX code, nothing else

CONCISE BY DEFAULT:
- "quadratic formula" → x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}
- "pythagorean theorem" → a^2 + b^2 = c^2
- "integral of sin x" → \\int \\sin x \\, dx = -\\cos x + C
- "fourier series" → f(x) = \\frac{a_0}{2} + \\sum_{n=1}^{\\infty} \\left( a_n \\cos \\frac{n\\pi x}{L} + b_n \\sin \\frac{n\\pi x}{L} \\right)
- "fourier transform" → \\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x) \\, e^{-2\\pi i \\xi x} \\, dx

Only use \\begin{aligned} if user says "show steps", "derive", or "prove".`;

// ---------------------------------------------------------------------------
// Quick-complete helper
// ---------------------------------------------------------------------------

// Legacy local quick-math lookup was removed. All /math requests now route
// through Codex using the strict LaTeX-only prompt above.

// ---------------------------------------------------------------------------
// processSlashCommand -- executes a completed slash command
// ---------------------------------------------------------------------------

function showLoading(editor: any, label: string): () => void {
  // Insert a visually styled loading indicator
  const loadingId = `loading-${Date.now()}`;
  editor.chain().focus().insertContent({
    type: "callout",
    attrs: { style: "tip" },
    content: [{ type: "paragraph", content: [{ type: "text", text: `Generating${label ? `: ${label.slice(0, 40)}` : ""}...` }] }],
  }).run();

  // Track the position of the last inserted node
  const insertPos = editor.state.selection.from;

  return () => {
    // Remove the loading callout — find the nearest callout before current cursor
    const { doc, tr } = editor.state;
    let found = false;
    doc.descendants((node: any, pos: number) => {
      if (found) return false;
      if (node.type.name === "callout" && node.textContent.startsWith("Generating")) {
        tr.delete(pos, pos + node.nodeSize);
        found = true;
        return false;
      }
    });
    if (tr.docChanged) editor.view.dispatch(tr);
  };
}

export async function processSlashCommand(
  commandId: string,
  query: string,
  editor: any,
): Promise<void> {
  // --- /math: always route through Codex with Inkd-style prompt ---
  if (commandId === "math") {
    // If raw LaTeX (has backslashes or braces), insert directly
    if (/[\\{}]/.test(query)) {
      editor.chain().focus().insertContent({
        type: "mathBlock",
        attrs: { latex: query, display: true },
      }).run();
      return;
    }

    // Route everything through Codex — fast model, strict LaTeX-only prompt
    const removeLoading = showLoading(editor, query);
    const latex = await quickComplete(
      `${LATEX_SYSTEM_PROMPT}\n\n${query}`,
      `\\text{${query}}`,
    );

    // Clean up the response — strip any stray delimiters or markdown
    const cleaned = latex
      .replace(/^\$\$?\s*/, "")
      .replace(/\s*\$\$?$/, "")
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    removeLoading();
    editor.chain().focus().insertContent({
      type: "mathBlock",
      attrs: { latex: cleaned || `\\text{${query}}`, display: true },
    }).run();
    return;
  }

  // --- /diagram: ask Codex inline, insert result as Mermaid ---
  if (commandId === "diagram") {
    const removeLoading = showLoading(editor, query);
    const code = await quickComplete(
      `Create a Mermaid diagram for: ${query}. Return ONLY the raw Mermaid code. No fences, no explanation, no markdown. Just the Mermaid syntax.`,
      `graph TD\n  A["${query}"]`,
    );
    removeLoading();
    editor.chain().focus().insertContent({
      type: "mermaidBlock",
      attrs: { code },
    }).run();
    return;
  }

  // --- /code: ask Codex inline, insert result as code block ---
  if (commandId === "code") {
    const removeLoading = showLoading(editor, query);
    const result = await quickComplete(
      `Write code for: ${query}

Return ONLY the code with clear comments. Include:
- A brief docstring/comment at the top explaining what it does
- Inline comments on non-obvious lines
- A small usage example at the bottom (commented out)

No markdown fences, no explanation outside the code. Just the code.`,
      `# ${query}`,
    );
    removeLoading();
    editor.chain().focus().insertContent({
      type: "codeBlock",
      content: [{ type: "text", text: result }],
    }).run();
    return;
  }

  // --- /explain: ask Codex for a rich inline explanation ---
  if (commandId === "explain") {
    const removeLoading = showLoading(editor, query);
    const explanation = await quickComplete(
      `The student is writing study notes and wants an explanation of: "${query}"

Write a clear, concise explanation suitable for inline insertion in their notes. Use:
- Brief paragraphs (2-3 sentences each)
- Display math in $$...$$ where equations help
- Inline math in $...$ for variables
- Bullet points for key properties or steps
- Bold for key terms

Keep it focused — 3-6 short paragraphs max. No title or top-level header.
Return ONLY the content as markdown.`,
      query,
    );
    removeLoading();

    // Insert as parsed markdown, then convert $$ blocks to math nodes
    const markdownParser = editor.storage.markdown?.parser;
    if (markdownParser) {
      const parsed = markdownParser.parse(explanation);
      editor.chain().focus().insertContent(parsed).run();
    } else {
      editor.chain().focus().insertContent(explanation).run();
    }
    convertStudyDocBlocks(editor);
    return;
  }

  // --- /callout: insert immediately, no Codex needed ---
  if (commandId === "callout") {
    const style = /important|warning|caution/i.test(query) ? "important"
      : /tip|hint/i.test(query) ? "tip"
      : /warning|danger/i.test(query) ? "warning"
      : "note";
    editor.chain().focus().insertContent({
      type: "callout",
      attrs: { style },
      content: [{ type: "paragraph", content: query ? [{ type: "text", text: query }] : [] }],
    }).run();
    return;
  }

  // Fallback
  if (query) {
    editor.chain().focus().insertContent(query).run();
  }
}

/** Call the quick-complete endpoint for inline AI results (no chat roundtrip). */
async function quickComplete(prompt: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(apiUrl("/api/quick-complete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, fallback }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    return (data.result as string) || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// executeImmediateCommand -- inserts a block node immediately
// ---------------------------------------------------------------------------

function executeImmediateCommand(commandId: string, editor: any): void {
  switch (commandId) {
    case "heading1":
      editor.chain().focus().toggleHeading({ level: 1 }).run();
      break;
    case "heading2":
      editor.chain().focus().toggleHeading({ level: 2 }).run();
      break;
    case "heading3":
      editor.chain().focus().toggleHeading({ level: 3 }).run();
      break;
    case "bulletList":
      editor.chain().focus().toggleBulletList().run();
      break;
    case "numberedList":
      editor.chain().focus().toggleOrderedList().run();
      break;
    case "codeBlock":
      editor.chain().focus().toggleCodeBlock().run();
      break;
    case "table":
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "callout":
      editor.chain().focus().insertContent({
        type: "callout",
        attrs: { style: "note" },
        content: [{ type: "paragraph" }],
      }).run();
      break;
    case "divider":
      editor.chain().focus().setHorizontalRule().run();
      break;
  }
}

// ---------------------------------------------------------------------------
// SlashCommandList -- the floating dropdown component
// ---------------------------------------------------------------------------

type SlashCommandListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type SlashCommandListProps = {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
};

const SlashCommandList = forwardRef<SlashCommandListHandle, SlashCommandListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Reset selection when the filtered list changes
    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) command(item);
      },
      [items, command],
    );

    useImperativeHandle(ref, () => ({
      onKeyDown(event: KeyboardEvent) {
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) return null;

    return (
      <div className="slash-menu">
        {items.map((cmd, index) => (
          <button
            key={cmd.id}
            className={`slash-menu-item${index === selectedIndex ? " selected" : ""}`}
            type="button"
            onClick={() => selectItem(index)}
          >
            <span className="slash-menu-icon">{cmd.icon}</span>
            <div className="slash-menu-text">
              <span className="slash-menu-label">{cmd.label}</span>
              <span className="slash-menu-desc">{cmd.description}</span>
            </div>
          </button>
        ))}
      </div>
    );
  },
);
SlashCommandList.displayName = "SlashCommandList";

// ---------------------------------------------------------------------------
// The Suggestion-based TipTap Extension
// ---------------------------------------------------------------------------

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: true,
        items: ({ query }: { query: string }): SlashCommand[] => {
          if (!query) return SLASH_COMMANDS;
          const q = query.toLowerCase();
          return SLASH_COMMANDS.filter(
            (cmd) =>
              cmd.id.toLowerCase().startsWith(q) ||
              cmd.label.toLowerCase().startsWith(q) ||
              cmd.label.toLowerCase().includes(q),
          );
        },
        command: ({
          editor,
          range,
          props: item,
        }: {
          editor: any;
          range: { from: number; to: number };
          props: SlashCommand;
        }) => {
          if (item.queryBased) {
            // Two-phase: replace the suggestion text with the prefix, keep
            // the cursor at the end so the user can type their query.
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent(item.prefix)
              .run();
          } else {
            // Immediate: delete the slash text and run the command.
            editor.chain().focus().deleteRange(range).run();
            executeImmediateCommand(item.id, editor);
          }
        },
        render: () => {
          let component: ReactRenderer<SlashCommandListHandle>;
          let popup: HTMLDivElement | null = null;

          function updatePosition(props: SuggestionProps) {
            const rect = props.clientRect?.();
            if (rect && popup) {
              popup.style.left = `${rect.left}px`;
              popup.style.top = `${rect.bottom + 4}px`;
            }
          }

          return {
            onStart(props: SuggestionProps) {
              component = new ReactRenderer(SlashCommandList, {
                props: {
                  items: props.items as SlashCommand[],
                  command: (item: SlashCommand) => props.command(item as any),
                },
                editor: props.editor,
              });

              popup = document.createElement("div");
              popup.style.position = "fixed";
              popup.style.zIndex = "10001";
              document.body.appendChild(popup);

              popup.appendChild(component.element);
              updatePosition(props);
            },

            onUpdate(props: SuggestionProps) {
              component.updateProps({
                items: props.items as SlashCommand[],
                command: (item: SlashCommand) => props.command(item as any),
              });
              updatePosition(props);
            },

            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === "Escape") {
                popup?.remove();
                popup = null;
                return true;
              }
              return component.ref?.onKeyDown?.(props.event) ?? false;
            },

            onExit() {
              popup?.remove();
              popup = null;
              component?.destroy();
            },
          };
        },
      } satisfies Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },

  // Keep the Enter key handler for query-based slash commands.
  // After the user selects e.g. "Math" from the dropdown, the text
  // `/math quadratic formula` is left in the paragraph. Pressing Enter
  // detects the pattern, removes the text, and processes the command.
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from } = state.selection;
        const textBefore = $from.parent.textContent;

        const match = textBefore.match(
          /^\/(math|diagram|code|explain)\s+(.+)$/i,
        );
        if (!match) return false;

        const commandId = match[1]!.toLowerCase();
        const query = match[2]!.trim();
        if (!query) return false;

        // Delete the typed command text
        const blockStart = $from.start();
        const blockEnd = $from.end();
        editor.chain().focus().deleteRange({ from: blockStart, to: blockEnd }).run();

        // Process the command asynchronously
        void processSlashCommand(commandId, query, editor);

        return true;
      },
    };
  },
});

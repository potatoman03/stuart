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

const QUICK_MATH: Record<string, string> = {
  // Common integrals
  "integral of e^x": "\\int e^x \\, dx = e^x + C",
  "integral of sin x": "\\int \\sin x \\, dx = -\\cos x + C",
  "integral of cos x": "\\int \\cos x \\, dx = \\sin x + C",
  "integral of 1/x": "\\int \\frac{1}{x} \\, dx = \\ln|x| + C",
  "integral of x^n": "\\int x^n \\, dx = \\frac{x^{n+1}}{n+1} + C, \\quad n \\neq -1",
  "integral of ln x": "\\int \\ln x \\, dx = x \\ln x - x + C",
  "integral of e^-x": "\\int e^{-x} \\, dx = -e^{-x} + C",
  "integral of sec^2 x": "\\int \\sec^2 x \\, dx = \\tan x + C",
  "integral of tan x": "\\int \\tan x \\, dx = -\\ln|\\cos x| + C",
  // Common derivatives
  "derivative of e^x": "\\frac{d}{dx} e^x = e^x",
  "derivative of sin x": "\\frac{d}{dx} \\sin x = \\cos x",
  "derivative of cos x": "\\frac{d}{dx} \\cos x = -\\sin x",
  "derivative of ln x": "\\frac{d}{dx} \\ln x = \\frac{1}{x}",
  "derivative of x^n": "\\frac{d}{dx} x^n = n x^{n-1}",
  "derivative of tan x": "\\frac{d}{dx} \\tan x = \\sec^2 x",
  // Famous equations/formulas
  "pythagorean theorem": "a^2 + b^2 = c^2",
  "quadratic formula": "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
  "euler's formula": "e^{i\\pi} + 1 = 0",
  "euler's identity": "e^{i\\theta} = \\cos\\theta + i\\sin\\theta",
  "binomial theorem": "(x + y)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k",
  "taylor series": "f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!}(x-a)^n",
  "bayes theorem": "P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}",
  "normal distribution": "f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}",
  "chain rule": "\\frac{dy}{dx} = \\frac{dy}{du} \\cdot \\frac{du}{dx}",
  "product rule": "\\frac{d}{dx}[f(x)g(x)] = f'(x)g(x) + f(x)g'(x)",
  "quotient rule": "\\frac{d}{dx}\\left[\\frac{f(x)}{g(x)}\\right] = \\frac{f'(x)g(x) - f(x)g'(x)}{[g(x)]^2}",
  "integration by parts": "\\int u \\, dv = uv - \\int v \\, du",
  "sum of geometric series": "\\sum_{k=0}^{n-1} ar^k = a \\cdot \\frac{1 - r^n}{1 - r}, \\quad r \\neq 1",
  "sum of arithmetic series": "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
  // Linear algebra
  "determinant 2x2": "\\det \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc",
  "matrix multiplication": "(AB)_{ij} = \\sum_{k} A_{ik} B_{kj}",
  "eigenvalue equation": "A\\mathbf{v} = \\lambda\\mathbf{v}",
  "dot product": "\\mathbf{a} \\cdot \\mathbf{b} = \\sum_{i} a_i b_i = |\\mathbf{a}||\\mathbf{b}|\\cos\\theta",
  "cross product": "\\mathbf{a} \\times \\mathbf{b} = |\\mathbf{a}||\\mathbf{b}|\\sin\\theta \\, \\hat{\\mathbf{n}}",
  // Physics
  "newton's second law": "F = ma",
  "kinetic energy": "KE = \\frac{1}{2}mv^2",
  "gravitational force": "F = G\\frac{m_1 m_2}{r^2}",
  "schrodinger equation": "i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi",
  "einstein mass energy": "E = mc^2",
  "ohm's law": "V = IR",
  // Statistics
  "standard deviation": "\\sigma = \\sqrt{\\frac{1}{N}\\sum_{i=1}^{N}(x_i - \\mu)^2}",
  "variance": "\\text{Var}(X) = E[(X - \\mu)^2] = E[X^2] - (E[X])^2",
  "expected value": "E[X] = \\sum_{i} x_i \\cdot P(x_i)",
  "correlation": "r = \\frac{\\sum(x_i - \\bar{x})(y_i - \\bar{y})}{\\sqrt{\\sum(x_i-\\bar{x})^2 \\sum(y_i-\\bar{y})^2}}",
  // Fundamental theorem of calculus
  "ftc": "\\frac{d}{dx}\\int_a^x f(t)\\,dt = f(x)",
  "ftc1": "\\frac{d}{dx}\\int_a^x f(t)\\,dt = f(x)",
  "ftc 1": "\\frac{d}{dx}\\int_a^x f(t)\\,dt = f(x)",
  "fundamental theorem of calculus": "\\int_a^b f(x)\\,dx = F(b) - F(a), \\quad F'(x) = f(x)",
  "fundamental theorem of calc": "\\int_a^b f(x)\\,dx = F(b) - F(a), \\quad F'(x) = f(x)",
  "ftc2": "\\int_a^b f(x)\\,dx = F(b) - F(a)",
  "ftc 2": "\\int_a^b f(x)\\,dx = F(b) - F(a)",
  // More common
  "limit definition of derivative": "f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}",
  "mean value theorem": "f'(c) = \\frac{f(b) - f(a)}{b - a}",
  "mvt": "f'(c) = \\frac{f(b) - f(a)}{b - a}",
  "lhopitals rule": "\\lim_{x \\to c} \\frac{f(x)}{g(x)} = \\lim_{x \\to c} \\frac{f'(x)}{g'(x)}",
  "l'hopital's rule": "\\lim_{x \\to c} \\frac{f(x)}{g(x)} = \\lim_{x \\to c} \\frac{f'(x)}{g'(x)}",
  "lhopital": "\\lim_{x \\to c} \\frac{f(x)}{g(x)} = \\lim_{x \\to c} \\frac{f'(x)}{g'(x)}",
  "power rule": "\\frac{d}{dx} x^n = nx^{n-1}",
  "area of circle": "A = \\pi r^2",
  "circumference": "C = 2\\pi r",
  "volume of sphere": "V = \\frac{4}{3}\\pi r^3",
  "surface area of sphere": "A = 4\\pi r^2",
  "law of cosines": "c^2 = a^2 + b^2 - 2ab\\cos C",
  "law of sines": "\\frac{a}{\\sin A} = \\frac{b}{\\sin B} = \\frac{c}{\\sin C}",
  "distance formula": "d = \\sqrt{(x_2-x_1)^2 + (y_2-y_1)^2}",
  "midpoint formula": "M = \\left(\\frac{x_1+x_2}{2}, \\frac{y_1+y_2}{2}\\right)",
  "slope formula": "m = \\frac{y_2 - y_1}{x_2 - x_1}",
  "point slope form": "y - y_1 = m(x - x_1)",
  "slope intercept": "y = mx + b",
  "compound interest": "A = P\\left(1 + \\frac{r}{n}\\right)^{nt}",
  "continuous compound interest": "A = Pe^{rt}",
  "logarithm change of base": "\\log_b a = \\frac{\\ln a}{\\ln b}",
  "log rules": "\\log(ab) = \\log a + \\log b, \\quad \\log\\frac{a}{b} = \\log a - \\log b, \\quad \\log a^n = n\\log a",
  "trig identity": "\\sin^2\\theta + \\cos^2\\theta = 1",
  "double angle": "\\sin 2\\theta = 2\\sin\\theta\\cos\\theta, \\quad \\cos 2\\theta = \\cos^2\\theta - \\sin^2\\theta",
  "half angle": "\\sin\\frac{\\theta}{2} = \\pm\\sqrt{\\frac{1-\\cos\\theta}{2}}, \\quad \\cos\\frac{\\theta}{2} = \\pm\\sqrt{\\frac{1+\\cos\\theta}{2}}",
  // CS / Algorithms
  "big o": "T(n) = O(g(n)) \\iff \\exists\\, c, n_0 > 0 : T(n) \\leq c \\cdot g(n) \\; \\forall\\, n \\geq n_0",
  "master theorem": "T(n) = aT(n/b) + f(n)",
  "entropy": "H(X) = -\\sum_{i} p(x_i) \\log_2 p(x_i)",
  "softmax": "\\sigma(z_i) = \\frac{e^{z_i}}{\\sum_{j} e^{z_j}}",
  "sigmoid": "\\sigma(x) = \\frac{1}{1 + e^{-x}}",
  "relu": "\\text{ReLU}(x) = \\max(0, x)",
  "gradient descent": "\\theta_{t+1} = \\theta_t - \\alpha \\nabla J(\\theta_t)",
  "cross entropy loss": "L = -\\sum_{i} y_i \\log \\hat{y}_i",
  "mse": "\\text{MSE} = \\frac{1}{n}\\sum_{i=1}^{n}(y_i - \\hat{y}_i)^2",
  "linear regression": "\\hat{y} = \\mathbf{X}\\boldsymbol{\\beta}, \\quad \\boldsymbol{\\beta} = (\\mathbf{X}^T\\mathbf{X})^{-1}\\mathbf{X}^T\\mathbf{y}",
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function findQuickMath(query: string): string | null {
  const norm = normalize(query);
  // Exact match (normalized)
  for (const [key, latex] of Object.entries(QUICK_MATH)) {
    if (normalize(key) === norm) return latex;
  }
  // Fuzzy: query contains key or key contains query
  for (const [key, latex] of Object.entries(QUICK_MATH)) {
    const nk = normalize(key);
    if (norm.includes(nk) || nk.includes(norm)) return latex;
  }
  return null;
}

// ---------------------------------------------------------------------------
// processSlashCommand -- executes a completed slash command
// ---------------------------------------------------------------------------

function showLoading(editor: any, _label: string): () => void {
  // Insert a small styled placeholder and return a cleanup function
  const marker = `\u200B__stuart_loading__\u200B`;
  editor.chain().focus().insertContent({
    type: "paragraph",
    content: [{ type: "text", text: marker }],
  }).run();

  return () => {
    const { doc, tr } = editor.state;
    doc.descendants((node: any, pos: number) => {
      if (node.isTextblock && node.textContent.includes("__stuart_loading__")) {
        tr.delete(pos, pos + node.nodeSize);
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
  // --- /math: try quick local lookup first, then Codex ---
  if (commandId === "math") {
    const quick = findQuickMath(query);
    if (quick) {
      editor.chain().focus().insertContent({
        type: "mathBlock",
        attrs: { latex: quick, display: true },
      }).run();
      return;
    }

    // If the query looks like raw LaTeX already (has backslashes or braces), insert directly
    if (/[\\{}^_]/.test(query)) {
      editor.chain().focus().insertContent({
        type: "mathBlock",
        attrs: { latex: query, display: true },
      }).run();
      return;
    }

    // Send to Codex for natural language → LaTeX conversion (inline, no chat)
    const removeLoading = showLoading(editor, query);
    const latex = await quickComplete(
      `Convert this to LaTeX. Return ONLY the raw LaTeX expression, no $$ delimiters, no explanation, no markdown, no code fences. Just the LaTeX:\n\n${query}`,
      `\\text{${query}}`,
    );
    removeLoading();
    editor.chain().focus().insertContent({
      type: "mathBlock",
      attrs: { latex, display: true },
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
      `Write code for: ${query}. Return ONLY the code with comments. No explanation outside the code, no markdown fences.`,
      `# ${query}`,
    );
    removeLoading();
    editor.chain().focus().insertContent({
      type: "codeBlock",
      content: [{ type: "text", text: result }],
    }).run();
    return;
  }

  // --- /explain: ask Codex inline, insert result as callout ---
  if (commandId === "explain") {
    const removeLoading = showLoading(editor, query);
    const explanation = await quickComplete(
      `Explain briefly and clearly for a university student: ${query}. Be concise (2-4 sentences). No markdown headers.`,
      query,
    );
    removeLoading();
    editor.chain().focus().insertContent({
      type: "callout",
      attrs: { style: "note" },
      content: [{ type: "paragraph", content: [{ type: "text", text: explanation }] }],
    }).run();
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

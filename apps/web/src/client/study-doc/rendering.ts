import katex from "katex";

export type TextMathPart =
  | { type: "text"; content: string }
  | { type: "math"; content: string; display: boolean };

const MERMAID_STARTERS = [
  "graph ",
  "flowchart ",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "sankey-beta",
  "requirementDiagram",
  "quadrantChart",
  "xychart-beta",
  "block-beta",
  "architecture-beta",
];

function appendClassName(attrs: string, className: string): string {
  if (/\bclass\s*=/.test(attrs)) {
    return attrs.replace(
      /\bclass=(["'])(.*?)\1/i,
      (_match, quote: string, existing: string) => `class=${quote}${existing} ${className}${quote}`,
    );
  }
  return `${attrs} class="${className}"`;
}

export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<(?:p|div|li|tr|h[1-6])\b[^>]*>/gi, "")
    .replace(/<ul[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<ol[^>]*>/gi, "")
    .replace(/<\/ol>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/gi, "$1")
    .replace(/\{\{([^}]*)\}\}/g, "$1")
    .replace(/\bTags:\s*[\w:]+(?:::[\w:]+)*/gi, "")
    .replace(/^(Extra|Notes|Hint|Tags|Source|Ref):\s*/gim, "")
    .replace(/\b\w+(?:::\w+){2,}\b/g, "")
    .replace(/(\w)::([\w])/g, "$1, $2")
    .replace(/\.([A-Z])/g, ".\n$1")
    .replace(/([a-z])—\s*([A-Z])/g, "$1\n—$2")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, arr) => line || (index > 0 && arr[index - 1] !== ""))
    .join("\n")
    .trim();
}

export function splitTextWithMath(text: string): TextMathPart[] {
  const cleaned = stripHtml(text)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, inner: string) => `$${inner}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, inner: string) => `$$${inner}$$`);

  const parts: TextMathPart[] = [];
  const regex = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: cleaned.slice(lastIndex, match.index) });
    }
    const isDisplay = match[1] !== undefined;
    parts.push({
      type: "math",
      content: (match[1] ?? match[2] ?? "").trim(),
      display: isDisplay,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    parts.push({ type: "text", content: cleaned.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: "text", content: cleaned }];
}

export function renderLatexMarkup(latex: string, displayMode: boolean): { html: string; error: string | null } {
  try {
    return {
      html: katex.renderToString(latex, {
        displayMode,
        throwOnError: true,
      }),
      error: null,
    };
  } catch (err) {
    return {
      html: "",
      error: err instanceof Error ? err.message : "Invalid LaTeX",
    };
  }
}

export function normalizeSvgMarkup(svg: string): string {
  const trimmed = svg.trim();
  if (!trimmed) return "";

  return trimmed.replace(/<svg\b([^>]*)>/i, (match, attrs) => {
    let nextAttrs = attrs
      .replace(/\s(?:width|height)=["'][^"']*["']/gi, "")
      .trim();
    nextAttrs = appendClassName(nextAttrs, "rendered-svg").trim();
    if (!/\brole=/.test(nextAttrs)) {
      nextAttrs += ' role="img"';
    }
    return `<svg${nextAttrs ? ` ${nextAttrs}` : ""}>`;
  });
}

export function isMermaidDiagramSource(code: string): boolean {
  const firstLine = code.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return MERMAID_STARTERS.some((starter) => firstLine.startsWith(starter));
}

type StudyDocEditorLike = {
  state: {
    doc: {
      descendants(cb: (node: any, pos: number) => boolean | void): void;
    };
    schema: {
      nodes: {
        mathBlock?: {
          create(attrs: { latex: string; display: boolean }): any;
        };
        mermaidBlock?: {
          create(attrs: { code: string }): any;
        };
      };
      tr?: any;
    };
    tr: any;
  };
  view: {
    dispatch(tr: any): void;
  };
};

export function convertStudyDocBlocks(editor: StudyDocEditorLike): boolean {
  const { doc, schema } = editor.state;
  const mathBlockType = schema.nodes.mathBlock;
  const mermaidBlockType = schema.nodes.mermaidBlock;
  if (!mathBlockType && !mermaidBlockType) return false;

  const transforms: Array<
    | { from: number; to: number; kind: "math"; latex: string }
    | { from: number; to: number; kind: "mermaid"; code: string }
  > = [];

  const textblocks: Array<{ pos: number; size: number; text: string }> = [];
  const mathDelimiters = [
    { open: "$$", close: "$$" },
    { open: "\\[", close: "\\]" },
  ];
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  doc.descendants((node: any, pos: number) => {
    if (node.isTextblock) {
      textblocks.push({ pos, size: node.nodeSize, text: node.textContent.trim() });
      if (mathBlockType) {
        const text = node.textContent;
        for (const { open, close } of mathDelimiters) {
          const regex = new RegExp(`^\\s*${escapeRegExp(open)}([\\s\\S]+?)${escapeRegExp(close)}\\s*$`);
          const match = text.match(regex);
          if (match?.[1]) {
            transforms.push({
              from: pos,
              to: pos + node.nodeSize,
              kind: "math",
              latex: match[1].trim(),
            });
            break;
          }
        }
      }
    }
  });

  if (mathBlockType) {
    for (const { open, close } of mathDelimiters) {
      for (let i = 0; i < textblocks.length - 2; i += 1) {
        const start = textblocks[i]!;
        if (start.text !== open) continue;

        for (let j = i + 1; j < textblocks.length; j += 1) {
          const end = textblocks[j]!;
          if (end.text !== close) continue;

          const latex = textblocks
            .slice(i + 1, j)
            .map((block) => block.text)
            .join("\n")
            .trim();

          if (latex) {
            transforms.push({
              from: start.pos,
              to: end.pos + end.size,
              kind: "math",
              latex,
            });
            i = j;
          }
          break;
        }
      }
    }
  }

  if (mermaidBlockType) {
    for (const block of textblocks) {
      if (isMermaidDiagramSource(block.text)) {
        transforms.push({
          from: block.pos,
          to: block.pos + block.size,
          kind: "mermaid",
          code: block.text,
        });
      }
    }
  }

  if (transforms.length === 0) return false;

  const tr = editor.state.tr;
  for (let i = transforms.length - 1; i >= 0; i -= 1) {
    const t = transforms[i]!;
    if (t.kind === "math" && mathBlockType) {
      tr.replaceWith(t.from, t.to, mathBlockType.create({ latex: t.latex, display: true }));
    } else if (t.kind === "mermaid" && mermaidBlockType) {
      tr.replaceWith(t.from, t.to, mermaidBlockType.create({ code: t.code }));
    }
  }

  editor.view.dispatch(tr);
  return true;
}

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

async function loadMermaidModule() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  return mermaidModulePromise;
}

export async function renderMermaidSvg(
  code: string,
  id: string = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ svg: string; error: string | null }> {
  const source = code.trim();
  if (!source) {
    return { svg: "", error: "Empty diagram" };
  }

  try {
    const { default: mermaid } = await loadMermaidModule();
    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      fontFamily: "Inter, system-ui, sans-serif",
      securityLevel: "loose",
    });
    const { svg } = await mermaid.render(id, source);
    return { svg: normalizeSvgMarkup(svg), error: null };
  } catch (err) {
    return {
      svg: "",
      error: err instanceof Error ? err.message : "Diagram error",
    };
  }
}

import katex from "katex";

const SVG_EX_TO_PT = 6.2;

type MathJaxInstance = {
  tex2svg: (latex: string, options?: { display?: boolean }) => unknown;
  startup: {
    adaptor: {
      outerHTML: (node: unknown) => string;
    };
  };
};

let mathJaxPromise: Promise<MathJaxInstance> | null = null;

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "\u2070",
  "1": "\u00B9",
  "2": "\u00B2",
  "3": "\u00B3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
  "+": "\u207A",
  "-": "\u207B",
  "=": "\u207C",
  "(": "\u207D",
  ")": "\u207E",
  i: "\u2071",
  n: "\u207F",
  a: "\u1D43",
  b: "\u1D47",
  c: "\u1D9C",
  d: "\u1D48",
  e: "\u1D49",
  f: "\u1DA0",
  g: "\u1D4D",
  h: "\u02B0",
  j: "\u02B2",
  k: "\u1D4F",
  l: "\u02E1",
  m: "\u1D50",
  o: "\u1D52",
  p: "\u1D56",
  r: "\u02B3",
  s: "\u02E2",
  t: "\u1D57",
  u: "\u1D58",
  v: "\u1D5B",
  w: "\u02B7",
  x: "\u02E3",
  y: "\u02B8",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "\u2080",
  "1": "\u2081",
  "2": "\u2082",
  "3": "\u2083",
  "4": "\u2084",
  "5": "\u2085",
  "6": "\u2086",
  "7": "\u2087",
  "8": "\u2088",
  "9": "\u2089",
  "+": "\u208A",
  "-": "\u208B",
  "=": "\u208C",
  "(": "\u208D",
  ")": "\u208E",
  a: "\u2090",
  e: "\u2091",
  h: "\u2095",
  i: "\u1D62",
  j: "\u2C7C",
  k: "\u2096",
  l: "\u2097",
  m: "\u2098",
  n: "\u2099",
  o: "\u2092",
  p: "\u209A",
  r: "\u1D63",
  s: "\u209B",
  t: "\u209C",
  u: "\u1D64",
  v: "\u1D65",
  x: "\u2093",
};

function convertAsciiScriptSequence(value: string, scriptMap: Record<string, string>): string {
  return Array.from(value)
    .map((character) => scriptMap[character] ?? character)
    .join("");
}

function looksLikeBareMathText(text: string): boolean {
  return (
    /\\[A-Za-z]+/.test(text) ||
    /<=|>=|!=|[=^]/.test(text) ||
    /\b(?:min|max|argmin|argmax|subject to)\b/i.test(text) ||
    /\bO\([^)]+\)/.test(text) ||
    /(?<![A-Za-z])[A-Za-z]\d+\b/.test(text)
  );
}

function normalizeBareMathLikeText(text: string): string {
  if (!looksLikeBareMathText(text)) {
    return text;
  }

  return replaceLatexWithUnicode(text)
    .replace(/<=/g, "\u2264")
    .replace(/>=/g, "\u2265")
    .replace(/!=/g, "\u2260")
    .replace(/(?<![A-Za-z])([A-Za-z])(\d+)\b/g, (_match, variable, digits) => (
      `${variable}${convertAsciiScriptSequence(digits, SUBSCRIPT_MAP)}`
    ));
}

function replaceLatexWithUnicode(raw: string): string {
  return raw
    .replace(/\\(?:d|t)?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\alpha/g, "\u03B1").replace(/\\beta/g, "\u03B2").replace(/\\gamma/g, "\u03B3")
    .replace(/\\delta/g, "\u03B4").replace(/\\epsilon/g, "\u03B5").replace(/\\zeta/g, "\u03B6")
    .replace(/\\eta/g, "\u03B7").replace(/\\theta/g, "\u03B8").replace(/\\iota/g, "\u03B9")
    .replace(/\\kappa/g, "\u03BA").replace(/\\lambda/g, "\u03BB").replace(/\\mu/g, "\u03BC")
    .replace(/\\nu/g, "\u03BD").replace(/\\xi/g, "\u03BE").replace(/\\pi/g, "\u03C0")
    .replace(/\\rho/g, "\u03C1").replace(/\\sigma/g, "\u03C3").replace(/\\tau/g, "\u03C4")
    .replace(/\\phi/g, "\u03C6").replace(/\\chi/g, "\u03C7").replace(/\\psi/g, "\u03C8")
    .replace(/\\omega/g, "\u03C9")
    .replace(/\\Gamma/g, "\u0393").replace(/\\Delta/g, "\u0394").replace(/\\Theta/g, "\u0398")
    .replace(/\\Lambda/g, "\u039B").replace(/\\Pi/g, "\u03A0").replace(/\\Sigma/g, "\u03A3")
    .replace(/\\Phi/g, "\u03A6").replace(/\\Psi/g, "\u03A8").replace(/\\Omega/g, "\u03A9")
    .replace(/\\times/g, "\u00D7").replace(/\\div/g, "\u00F7").replace(/\\cdot/g, "\u00B7")
    .replace(/\\pm/g, "\u00B1").replace(/\\mp/g, "\u2213")
    .replace(/\\leq/g, "\u2264").replace(/\\geq/g, "\u2265").replace(/\\neq/g, "\u2260")
    .replace(/\\approx/g, "\u2248").replace(/\\equiv/g, "\u2261")
    .replace(/\\infty/g, "\u221E").replace(/\\partial/g, "\u2202")
    .replace(/\\nabla/g, "\u2207").replace(/\\sqrt/g, "\u221A")
    .replace(/\\sum/g, "\u2211").replace(/\\prod/g, "\u220F").replace(/\\int/g, "\u222B")
    .replace(/\\forall/g, "\u2200").replace(/\\exists/g, "\u2203")
    .replace(/\\in/g, "\u2208").replace(/\\notin/g, "\u2209")
    .replace(/\\subset/g, "\u2282").replace(/\\supset/g, "\u2283")
    .replace(/\\cup/g, "\u222A").replace(/\\cap/g, "\u2229")
    .replace(/\\emptyset/g, "\u2205")
    .replace(/\\rightarrow/g, "\u2192").replace(/\\leftarrow/g, "\u2190")
    .replace(/\\Rightarrow/g, "\u21D2").replace(/\\Leftarrow/g, "\u21D0")
    .replace(/\\leftrightarrow/g, "\u2194").replace(/\\Leftrightarrow/g, "\u21D4")
    .replace(/\\lfloor/g, "\u230A").replace(/\\rfloor/g, "\u230B")
    .replace(/\\lceil/g, "\u2308").replace(/\\rceil/g, "\u2309")
    .replace(/\\ldots/g, "\u2026").replace(/\\cdots/g, "\u22EF")
    .replace(/\^\{([^{}]+)\}/g, (_match, inner) => convertAsciiScriptSequence(inner, SUPERSCRIPT_MAP))
    .replace(/\^([A-Za-z0-9+\-=()])/g, (_match, inner) => convertAsciiScriptSequence(inner, SUPERSCRIPT_MAP))
    .replace(/_\{([^{}]+)\}/g, (_match, inner) => convertAsciiScriptSequence(inner, SUBSCRIPT_MAP))
    .replace(/_([A-Za-z0-9+\-=()])/g, (_match, inner) => convertAsciiScriptSequence(inner, SUBSCRIPT_MAP))
    .replace(/[{}]/g, "")
    .replace(/\\\\/g, "  ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeLatexDelimiters(text: string): string {
  return String(text ?? "")
    .replace(/\\\((.+?)\\\)/g, (_match, inner) => `$${inner}$`)
    .replace(/\\\[(.+?)\\\]/gs, (_match, inner) => `$$${inner}$$`);
}

export function stripLatexDelimiters(text: string): { latex: string; display: boolean } {
  const normalized = normalizeLatexDelimiters(text).trim();
  if (normalized.startsWith("$$") && normalized.endsWith("$$")) {
    return { latex: normalized.slice(2, -2).trim(), display: true };
  }
  if (normalized.startsWith("$") && normalized.endsWith("$")) {
    return { latex: normalized.slice(1, -1).trim(), display: false };
  }
  return { latex: normalized, display: false };
}

export function renderLatexToStaticHtml(latex: string, display = false): string {
  const normalized = stripLatexDelimiters(latex).latex;
  if (!normalized) {
    return "";
  }
  try {
    return katex.renderToString(normalized, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
  } catch {
    return `<code>${escapeHtml(normalized)}</code>`;
  }
}

export function renderTextWithLatexToStaticHtml(text: string): string {
  const normalized = normalizeLatexDelimiters(text);
  const parts: Array<{ type: "text" | "math"; content: string; display: boolean }> = [];
  const regex = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: normalized.slice(lastIndex, match.index), display: false });
    }
    const display = match[1] !== undefined;
    const content = (match[1] ?? match[2] ?? "").trim();
    parts.push({ type: "math", content, display });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    parts.push({ type: "text", content: normalized.slice(lastIndex), display: false });
  }

  if (parts.length === 0) {
    return escapeHtml(normalized).replace(/\n/g, "<br/>");
  }

  return parts.map((part) => {
    if (part.type === "text") {
      return escapeHtml(part.content).replace(/\n/g, "<br/>");
    }
    return part.display
      ? `<div class="math-block">${renderLatexToStaticHtml(part.content, true)}</div>`
      : renderLatexToStaticHtml(part.content, false);
  }).join("");
}

export function renderLatexToPlainText(latex: string): string {
  return replaceLatexWithUnicode(stripLatexDelimiters(latex).latex);
}

export function renderTextWithLatexToPlainText(text: string): string {
  const normalized = normalizeLatexDelimiters(text);
  const regex = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let result = "";

  while ((match = regex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      result += normalizeBareMathLikeText(normalized.slice(lastIndex, match.index));
    }
    result += renderLatexToPlainText(match[1] ?? match[2] ?? "");
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    result += normalizeBareMathLikeText(normalized.slice(lastIndex));
  }

  return result || normalizeBareMathLikeText(normalized);
}

export async function renderTextWithLatexToSvgHtml(text: string): Promise<string> {
  const normalized = normalizeLatexDelimiters(text);
  const parts: Array<{ type: "text" | "math"; content: string; display: boolean }> = [];
  const regex = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: normalized.slice(lastIndex, match.index), display: false });
    }
    parts.push({
      type: "math",
      content: (match[1] ?? match[2] ?? "").trim(),
      display: match[1] !== undefined,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < normalized.length) {
    parts.push({ type: "text", content: normalized.slice(lastIndex), display: false });
  }
  if (parts.length === 0) {
    return escapeHtml(normalized).replace(/\n/g, "<br/>");
  }

  const htmlParts: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      htmlParts.push(escapeHtml(part.content).replace(/\n/g, "<br/>"));
      continue;
    }
    try {
      const { svg } = await renderLatexToSvg(part.content, part.display);
      htmlParts.push(part.display ? `<div class="math-block">${svg}</div>` : `<span class="math-inline">${svg}</span>`);
    } catch {
      htmlParts.push(`<code>${escapeHtml(part.content)}</code>`);
    }
  }
  return htmlParts.join("");
}

async function getMathJax(): Promise<MathJaxInstance> {
  if (!mathJaxPromise) {
    mathJaxPromise = (async () => {
      const mod = await import("mathjax");
      const mathjax = (mod.default ?? mod) as { init: (config: unknown) => Promise<MathJaxInstance> };
      return mathjax.init({
        loader: { load: ["input/tex", "output/svg"] },
      });
    })();
  }
  return mathJaxPromise;
}

function stripRedundantMathNamespaces(omml: string): string {
  return omml
    .replace(/\s+xmlns:m="[^"]+"/g, "")
    .replace(/\s+xmlns:w="[^"]+"/g, "");
}

export async function renderLatexToOmml(latex: string, display = false): Promise<string> {
  const normalized = stripLatexDelimiters(latex).latex;
  if (!normalized) {
    throw new Error("Cannot render an empty LaTeX expression.");
  }
  const mod = await import("latex-to-omml");
  const latexToOMML = (mod.latexToOMML ??
    (mod.default as { latexToOMML?: typeof mod.latexToOMML } | undefined)?.latexToOMML) as
    | ((input: string, options?: { displayMode?: boolean }) => Promise<string>)
    | undefined;
  if (!latexToOMML) {
    throw new Error("latex-to-omml did not expose a latexToOMML export.");
  }
  const omml = await latexToOMML(normalized, { displayMode: display });
  return stripRedundantMathNamespaces(omml);
}

function extractSvgSize(svg: string): { widthPt: number; heightPt: number } {
  const widthEx = /width="([0-9.]+)ex"/.exec(svg)?.[1];
  const heightEx = /height="([0-9.]+)ex"/.exec(svg)?.[1];
  if (widthEx && heightEx) {
    return {
      widthPt: Number(widthEx) * SVG_EX_TO_PT,
      heightPt: Number(heightEx) * SVG_EX_TO_PT,
    };
  }

  const viewBox = /viewBox="[^"]* ([0-9.]+) ([0-9.]+)"/.exec(svg);
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (width > 0 && height > 0) {
      const widthPt = 64;
      return { widthPt, heightPt: (height / width) * widthPt };
    }
  }

  return { widthPt: 64, heightPt: 28 };
}

export async function renderLatexToSvg(latex: string, display = false): Promise<{ svg: string; widthPt: number; heightPt: number }> {
  const normalized = stripLatexDelimiters(latex).latex;
  if (!normalized) {
    throw new Error("Cannot render an empty LaTeX expression.");
  }

  const MathJax = await getMathJax();
  const node = MathJax.tex2svg(normalized, { display });
  const outer = MathJax.startup.adaptor.outerHTML(node);
  const svgMatch = outer.match(/<svg[\s\S]*<\/svg>/i);
  const svg = svgMatch ? svgMatch[0] : outer;
  return {
    svg,
    ...extractSvgSize(svg),
  };
}

import { describe, expect, it } from "vitest";
import {
  isMermaidDiagramSource,
  normalizeSvgMarkup,
  splitTextWithMath,
} from "./rendering";

describe("splitTextWithMath", () => {
  it("preserves text and both inline and display math", () => {
    const parts = splitTextWithMath("Alpha <strong>$x$</strong> and \\(y+1\\) then \\[z^2\\].");
    expect(parts).toEqual([
      { type: "text", content: "Alpha " },
      { type: "math", content: "x", display: false },
      { type: "text", content: " and " },
      { type: "math", content: "y+1", display: false },
      { type: "text", content: " then " },
      { type: "math", content: "z^2", display: true },
      { type: "text", content: "." },
    ]);
  });

  it("keeps multi-paragraph display math intact", () => {
    const parts = splitTextWithMath("Line 1\n$$\na^2 + b^2 = c^2\n$$\nLine 2");
    expect(parts).toEqual([
      { type: "text", content: "Line 1\n" },
      { type: "math", content: "a^2 + b^2 = c^2", display: true },
      { type: "text", content: "\nLine 2" },
    ]);
  });
});

describe("normalizeSvgMarkup", () => {
  it("strips hard-coded dimensions and marks rendered svg elements", () => {
    const svg = normalizeSvgMarkup('<svg width="120" height="80" viewBox="0 0 10 10"><path d="M0 0" /></svg>');
    expect(svg).toContain('class="rendered-svg"');
    expect(svg).not.toContain('width="120"');
    expect(svg).not.toContain('height="80"');
    expect(svg).toContain('role="img"');
  });
});

describe("isMermaidDiagramSource", () => {
  it("recognizes obvious Mermaid sources", () => {
    expect(isMermaidDiagramSource("graph TD\nA-->B")).toBe(true);
    expect(isMermaidDiagramSource("```mermaid")).toBe(false);
    expect(isMermaidDiagramSource("plain text")).toBe(false);
  });
});

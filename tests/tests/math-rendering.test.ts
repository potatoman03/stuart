import { describe, expect, it } from "vitest";
import { renderTextWithLatexToPlainText } from "../../packages/runtime-supervisor/src/math-rendering";

describe("math rendering fallback text normalization", () => {
  it("normalizes bare simplex-style expressions in plain text", () => {
    expect(renderTextWithLatexToPlainText("x1 + 2x2 <= 6")).toBe("x₁ + 2x₂ ≤ 6");
    expect(renderTextWithLatexToPlainText("min -3x1 - 2x2")).toBe("min -3x₁ - 2x₂");
    expect(renderTextWithLatexToPlainText("x1, x2 >= 0")).toBe("x₁, x₂ ≥ 0");
  });

  it("normalizes asymptotic notation and mixed inline latex", () => {
    expect(renderTextWithLatexToPlainText("Growth O(n^2)")).toBe("Growth O(n²)");
    expect(renderTextWithLatexToPlainText("Runtime grows as $b^d$")).toBe("Runtime grows as bᵈ");
  });

  it("does not rewrite ordinary non-math prose", () => {
    expect(renderTextWithLatexToPlainText("Lecture 1 response is due on Sunday.")).toBe(
      "Lecture 1 response is due on Sunday."
    );
  });
});

declare module "svg-to-pdfkit" {
  const SVGtoPDF: (
    doc: unknown,
    svg: string,
    x: number,
    y: number,
    options?: Record<string, unknown>
  ) => void;
  export default SVGtoPDF;
}

declare module "mathjax" {
  const mathjax: {
    init: (config: unknown) => Promise<{
      tex2svg: (latex: string, options?: { display?: boolean }) => unknown;
      startup: {
        adaptor: {
          outerHTML: (node: unknown) => string;
        };
      };
    }>;
  };
  export default mathjax;
}

declare module "latex-to-omml" {
  export function latexToOMML(
    latex: string,
    options?: { displayMode?: boolean }
  ): Promise<string>;
}

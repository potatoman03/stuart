import { Resvg } from "@resvg/resvg-js";

const PX_PER_INCH = 96;
const PT_PER_INCH = 72;

function parseSvgLength(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)(px|pt|in|cm|mm)?$/i);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  switch (unit) {
    case "px":
      return amount;
    case "pt":
      return amount * (PX_PER_INCH / PT_PER_INCH);
    case "in":
      return amount * PX_PER_INCH;
    case "cm":
      return amount * (PX_PER_INCH / 2.54);
    case "mm":
      return amount * (PX_PER_INCH / 25.4);
    default:
      return amount;
  }
}

export function sanitizeSvgMarkup(rawSvg: string): string {
  const cleaned = String(rawSvg ?? "")
    .trim()
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");
  if (!/<svg\b/i.test(cleaned)) {
    throw new Error("Expected an <svg> root element.");
  }
  return cleaned;
}

export function getSvgDimensions(svg: string): { widthPx: number; heightPx: number } {
  const widthMatch = svg.match(/\bwidth="([^"]+)"/i)?.[1];
  const heightMatch = svg.match(/\bheight="([^"]+)"/i)?.[1];
  const widthPx = parseSvgLength(widthMatch);
  const heightPx = parseSvgLength(heightMatch);
  if (widthPx && heightPx) {
    return { widthPx, heightPx };
  }

  const viewBoxMatch = svg.match(/\bviewBox="([^"]+)"/i)?.[1];
  if (viewBoxMatch) {
    const parts = viewBoxMatch
      .trim()
      .split(/[\s,]+/)
      .map((part) => Number(part));
    const viewWidth = parts[2];
    const viewHeight = parts[3];
    if (
      parts.length === 4 &&
      viewWidth !== undefined &&
      viewHeight !== undefined &&
      Number.isFinite(viewWidth) &&
      Number.isFinite(viewHeight) &&
      viewWidth > 0 &&
      viewHeight > 0
    ) {
      return { widthPx: viewWidth, heightPx: viewHeight };
    }
  }

  return { widthPx: 640, heightPx: 360 };
}

export function pxToPt(px: number): number {
  return px * (PT_PER_INCH / PX_PER_INCH);
}

export function clampSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight, 1);
  return {
    width: Math.max(1, safeWidth * scale),
    height: Math.max(1, safeHeight * scale),
  };
}

export function normalizeSvgForHtml(rawSvg: string): string {
  const svg = sanitizeSvgMarkup(rawSvg);
  const { widthPx, heightPx } = getSvgDimensions(svg);
  const hasWidth = /\bwidth="/i.test(svg);
  const hasHeight = /\bheight="/i.test(svg);
  const hasViewBox = /\bviewBox="/i.test(svg);
  let normalized = svg;
  if (!hasViewBox) {
    normalized = normalized.replace(
      /<svg\b/i,
      `<svg viewBox="0 0 ${Math.max(1, Math.round(widthPx))} ${Math.max(1, Math.round(heightPx))}"`
    );
  }
  if (!hasWidth || !hasHeight) {
    normalized = normalized.replace(
      /<svg\b/i,
      `<svg width="${Math.max(1, Math.round(widthPx))}" height="${Math.max(1, Math.round(heightPx))}"`
    );
  }
  return normalized;
}

export function renderSvgToPng(
  rawSvg: string,
  options: { width?: number; height?: number } = {}
): { svg: string; png: Buffer; widthPx: number; heightPx: number } {
  const svg = normalizeSvgForHtml(rawSvg);
  const { widthPx: intrinsicWidth, heightPx: intrinsicHeight } = getSvgDimensions(svg);
  const width = options.width && options.width > 0 ? Math.round(options.width) : Math.max(1, Math.round(intrinsicWidth));
  const height = options.height && options.height > 0 ? Math.round(options.height) : Math.max(1, Math.round(intrinsicHeight));
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: width,
    },
  });
  const rendered = resvg.render();
  return {
    svg,
    png: rendered.asPng(),
    widthPx: rendered.width || width,
    heightPx: rendered.height || height,
  };
}

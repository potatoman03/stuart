import type { IngestionDocumentRecord, IngestionSearchResult, WorkspaceFileRecord } from "@stuart/shared";

export const FILE_REF_MARKER = "\u00ab"; // «
export const FILE_REF_END = "\u00bb"; // »

const FILE_EXTENSION_PATTERN = /\.(pdf|docx|pptx|xlsx|txt|md|html|csv|json|epub|jsx|tsx|js|ts)$/i;
const STUDY_ORDINAL_PATTERN = /\b(lecture|chapter|week|module|lesson|lab|tutorial|worksheet|assignment|quiz|exam)\s*0*(\d+)\b/gi;

export function cleanSourceName(rawPath: string): string {
  let name = rawPath;
  try {
    name = decodeURIComponent(name);
  } catch {
    // Ignore malformed encodings and keep the original label.
  }
  name = name.replace(/^attachments\/[a-f0-9-]+[-/]/i, "");
  const parts = name.split("/");
  name = parts[parts.length - 1] || name;
  name = name.replace(FILE_EXTENSION_PATTERN, "");
  return name;
}

export function fileExtension(rawPath: string): string {
  const match = rawPath.match(/\.(pdf|docx|pptx|xlsx|txt|md|html|csv|json|epub)$/i);
  return match ? match[1]!.toUpperCase() : "DOC";
}

export function normalizeCitationLookupText(value: string): string {
  return cleanSourceName(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_()[\]{}-]+/g, " ")
    .replace(/\b0+(\d+)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeCitationLookupText(value: string): string[] {
  return normalizeCitationLookupText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 || /^\d+$/.test(token));
}

function extractCitationSignals(value: string): Set<string> {
  const signals = new Set<string>();
  const normalized = normalizeCitationLookupText(value);
  for (const match of normalized.matchAll(STUDY_ORDINAL_PATTERN)) {
    const kind = match[1];
    const number = match[2];
    if (kind && number) {
      signals.add(`${kind}:${number}`);
    }
  }
  return signals;
}

function stripRelativePrefix(value: string): string {
  return value.replace(/^\.?\//, "");
}

function basenameFromPath(value: string): string {
  const normalized = normalizeSourcePathReference(value);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function scoreReferenceCandidate(reference: string, candidatePath: string): number {
  const normalizedReference = normalizeCitationLookupText(reference);
  if (!normalizedReference) return 0;

  const referenceTokens = tokenizeCitationLookupText(reference);
  const referenceSignals = extractCitationSignals(reference);
  const candidateDisplayName = normalizeCitationLookupText(cleanSourceName(candidatePath));
  const candidateRelativePath = normalizeCitationLookupText(candidatePath);
  const candidateTokens = new Set([
    ...tokenizeCitationLookupText(candidatePath),
    ...tokenizeCitationLookupText(cleanSourceName(candidatePath)),
  ]);
  const candidateSignals = extractCitationSignals(candidatePath);

  let score = 0;
  for (const candidate of [candidateDisplayName, candidateRelativePath]) {
    if (!candidate) continue;
    if (candidate === normalizedReference) {
      score = Math.max(score, 160);
    } else if (candidate.includes(normalizedReference)) {
      score = Math.max(score, 120);
    } else if (normalizedReference.includes(candidate)) {
      score = Math.max(score, 96);
    }
  }

  if (referenceTokens.length > 0) {
    const overlap = referenceTokens.filter((token) => candidateTokens.has(token)).length;
    if (overlap > 0) {
      score = Math.max(score, overlap * 12);
    }
    if (referenceTokens.every((token) => candidateTokens.has(token))) {
      score += 24;
    }
  }

  const signalMatches = [...referenceSignals].filter((signal) => candidateSignals.has(signal)).length;
  if (signalMatches > 0) {
    score += signalMatches * 60;
  } else if (referenceSignals.size > 0 && candidateSignals.size > 0) {
    score -= 20;
  }

  return score;
}

export function normalizeSourcePathReference(value: string): string {
  let normalized = value.trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original string if decoding fails.
  }
  return normalized
    .replace(/^file:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

/**
 * True when a marker's path looks like a short human label ("Lecture 2"), not a real workspace
 * relative path. Using those as the `source` filter never matches indexed `relative_path` rows.
 */
export function isWeakCitationSourcePath(value: string): boolean {
  const p = value.trim();
  if (!p) {
    return true;
  }
  if (p.includes("/") || p.includes("\\")) {
    return false;
  }
  if (/\.[a-zA-Z0-9]{2,8}$/.test(p)) {
    return false;
  }
  if (p.length >= 48) {
    return false;
  }
  return true;
}

export function findBestCitationDocument(
  sourceName: string,
  docs: IngestionDocumentRecord[],
): IngestionDocumentRecord | null {
  let bestDoc: IngestionDocumentRecord | null = null;
  let bestScore = 0;

  for (const doc of docs) {
    const score = scoreReferenceCandidate(sourceName, doc.relativePath);
    if (score > bestScore) {
      bestScore = score;
      bestDoc = doc;
    }
  }

  return bestScore >= 20 ? bestDoc : null;
}

/** Ranked docs for citation retrieval when the primary path list misses (lower floor than findBestCitationDocument). */
export function listCitationRankedDocuments(
  sourceName: string,
  docs: IngestionDocumentRecord[],
  limit = 25,
  minScore = 12,
): IngestionDocumentRecord[] {
  const scored = docs
    .map((doc) => ({ doc, score: scoreReferenceCandidate(sourceName, doc.relativePath) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((row) => row.doc);
}

export function findBestSourcePath(reference: string, candidatePaths: string[]): string | null {
  let bestPath: string | null = null;
  let bestScore = 0;

  for (const candidatePath of candidatePaths) {
    const score = scoreReferenceCandidate(reference, candidatePath);
    if (score > bestScore) {
      bestScore = score;
      bestPath = candidatePath;
    }
  }

  return bestScore >= 20 ? bestPath : null;
}

export function findBestWorkspaceFile(
  reference: string,
  files: WorkspaceFileRecord[],
  sourcePath?: string | null,
): WorkspaceFileRecord | null {
  const normalizedSourcePath = sourcePath ? normalizeSourcePathReference(sourcePath) : "";
  if (normalizedSourcePath) {
    const direct =
      files.find((entry) => normalizeSourcePathReference(entry.relativePath) === normalizedSourcePath) ??
      files.find((entry) =>
        stripRelativePrefix(normalizeSourcePathReference(entry.relativePath)) === stripRelativePrefix(normalizedSourcePath),
      ) ??
      files.find((entry) =>
        normalizeSourcePathReference(entry.relativePath).endsWith(`/${stripRelativePrefix(normalizedSourcePath)}`),
      );
    if (direct) return direct;
  }

  const normalizedReference = normalizeSourcePathReference(reference);
  const direct =
    files.find((entry) => normalizeSourcePathReference(entry.relativePath) === normalizedReference) ??
    files.find((entry) =>
      stripRelativePrefix(normalizeSourcePathReference(entry.relativePath)) === stripRelativePrefix(normalizedReference),
    );
  if (direct) {
    return direct;
  }

  const suffixMatch = files.find((entry) =>
    normalizeSourcePathReference(entry.relativePath).endsWith(`/${stripRelativePrefix(normalizedReference)}`),
  );
  if (suffixMatch) {
    return suffixMatch;
  }

  const basenameMatches = files.filter((entry) => basenameFromPath(entry.relativePath) === basenameFromPath(reference));
  if (basenameMatches.length === 1) {
    return basenameMatches[0] ?? null;
  }
  if (basenameMatches.length > 1) {
    return basenameMatches.sort((left, right) => left.relativePath.length - right.relativePath.length)[0] ?? null;
  }

  let bestFile: WorkspaceFileRecord | null = null;
  let bestScore = 0;
  for (const file of files) {
    const score = scoreReferenceCandidate(reference, file.relativePath);
    if (score > bestScore) {
      bestScore = score;
      bestFile = file;
    }
  }
  return bestScore >= 20 ? bestFile : null;
}

export function buildFileReferenceMarker(label: string, ext: string, sourcePath?: string | null): string {
  const parts = [label, ext];
  if (sourcePath) {
    parts.push(encodeURIComponent(sourcePath));
  }
  return `${FILE_REF_MARKER}${parts.join("::")}${FILE_REF_END}`;
}

export function parseFileReferenceMarker(raw: string): { label: string; ext: string; sourcePath: string | null } {
  const firstSeparator = raw.indexOf("::");
  if (firstSeparator === -1) {
    return { label: raw, ext: "DOC", sourcePath: null };
  }

  const secondSeparator = raw.indexOf("::", firstSeparator + 2);
  const label = raw.slice(0, firstSeparator);
  const ext = secondSeparator === -1 ? raw.slice(firstSeparator + 2) : raw.slice(firstSeparator + 2, secondSeparator);
  const encodedPath = secondSeparator === -1 ? "" : raw.slice(secondSeparator + 2);

  let sourcePath: string | null = null;
  if (encodedPath) {
    try {
      sourcePath = decodeURIComponent(encodedPath);
    } catch {
      sourcePath = encodedPath;
    }
  }

  return { label, ext: ext || "DOC", sourcePath };
}

function replaceMarkersWithLabels(value: string): string {
  return value.replace(
    new RegExp(`${FILE_REF_MARKER}([^${FILE_REF_END}]+)${FILE_REF_END}`, "g"),
    (_match, raw: string) => parseFileReferenceMarker(raw).label,
  );
}

function findSentenceBoundary(text: string, startIndex: number, direction: -1 | 1): number {
  const punctuationPattern = /[.!?]\s|\n/g;
  if (direction < 0) {
    let boundary = 0;
    for (const match of text.matchAll(punctuationPattern)) {
      const index = match.index ?? -1;
      if (index >= startIndex) break;
      boundary = index + match[0].length;
    }
    return boundary;
  }

  punctuationPattern.lastIndex = startIndex;
  const match = punctuationPattern.exec(text);
  return match ? (match.index ?? text.length) + 1 : text.length;
}

export type MessageCitationSegment =
  | { kind: "markdown"; text: string }
  | {
      kind: "citation";
      label: string;
      ext: string;
      sourcePath: string | null;
      queryText: string;
      key: number;
      /** Sentence punctuation peeled from the following markdown segment so it stays glued to the pill */
      trailingInline?: string;
    };

/**
 * Split assistant markdown into alternating markdown / citation segments so `extractCitationQueryText`
 * runs on the full message. ReactMarkdown only passes paragraph fragments to the old pill pipeline,
 * which produced useless queries (often just the label) and empty FTS results for PDFs.
 */
export function splitMessageWithCitations(content: string): MessageCitationSegment[] {
  const re = new RegExp(`${FILE_REF_MARKER}([^${FILE_REF_END}]+)${FILE_REF_END}`, "gs");
  const segments: MessageCitationSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > last) {
      segments.push({ kind: "markdown", text: content.slice(last, match.index) });
    }
    const parsed = parseFileReferenceMarker(match[1] ?? "");
    segments.push({
      kind: "citation",
      label: parsed.label,
      ext: parsed.ext,
      sourcePath: parsed.sourcePath,
      queryText: extractCitationQueryText(content, match.index, re.lastIndex),
      key: match.index,
    });
    last = re.lastIndex;
  }
  if (last < content.length) {
    segments.push({ kind: "markdown", text: content.slice(last) });
  }
  if (segments.length === 0) {
    segments.push({ kind: "markdown", text: content });
  }
  return segments;
}

/**
 * Merge trailing `.` / `!` / `?` that ended up in the next markdown segment so the pill is not a
 * separate flex item before the period (layout regression with split segments).
 */
export function mergeCitationTrailingPunctuation(segments: MessageCitationSegment[]): MessageCitationSegment[] {
  const out: MessageCitationSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i]!;
    if (cur.kind !== "citation") {
      out.push(cur);
      continue;
    }
    const next = segments[i + 1];
    if (!next || next.kind !== "markdown") {
      out.push(cur);
      continue;
    }
    const text = next.text;
    if (/^\s*[\.\!\?…]+\s*$/.test(text)) {
      out.push({ ...cur, trailingInline: text });
      i++;
      continue;
    }
    const peel = text.match(/^(\s*)([\.\!\?…]{1,3})(\s+)(?=[A-Za-z\d"''"(\[])/);
    if (peel) {
      const leadLen = peel[0].length;
      const trailing = text.slice(0, leadLen);
      const rest = text.slice(leadLen);
      out.push({ ...cur, trailingInline: trailing });
      if (rest.trim()) {
        out.push({ kind: "markdown", text: rest });
      }
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

export function extractCitationQueryText(
  text: string,
  markerStart: number,
  markerEnd: number,
): string {
  let sentenceStart = findSentenceBoundary(text, markerStart, -1);
  // When the citation sits right after end-of-sentence punctuation, the "sentence" would otherwise
  // be only text after that break (often just the pill + a short tail), which makes FTS useless.
  const gapBeforeMarker = text.slice(sentenceStart, markerStart).trim();
  if (gapBeforeMarker.length === 0 && sentenceStart > 0) {
    let probe = sentenceStart - 1;
    while (probe >= 0 && /\s/.test(text.charAt(probe))) probe -= 1;
    if (probe >= 0 && /[.!?]/.test(text.charAt(probe))) {
      sentenceStart = findSentenceBoundary(text, probe, -1);
    }
  }
  const sentenceEnd = findSentenceBoundary(text, markerEnd, 1);
  const sentence = replaceMarkersWithLabels(text.slice(sentenceStart, sentenceEnd))
    .replace(/\s+/g, " ")
    .replace(/^[\s\-*0-9.)]+/, "")
    .trim();

  if (sentence.length >= 24) {
    return sentence.slice(0, 280);
  }

  const windowStart = Math.max(0, markerStart - 160);
  const windowEnd = Math.min(text.length, markerEnd + 160);
  return replaceMarkersWithLabels(text.slice(windowStart, windowEnd))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export function cleanFileReferences(text: string): string {
  let result = text;

  result = result.replace(/%[0-9A-Fa-f]{2}/g, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      return match;
    }
  });

  result = result.replace(
    /\[([^\]]+)\]\s*\(([\s\S]+?\.\w{2,5}\s*)\)/g,
    (match, label: string, path: string) => {
      const trimmedPath = path.trim();
      if (/^https?:\/\//i.test(trimmedPath)) return match;
      const cleanLabel = cleanSourceName(label) || cleanSourceName(trimmedPath);
      return buildFileReferenceMarker(cleanLabel, fileExtension(trimmedPath), trimmedPath);
    },
  );

  result = result.replace(
    /\[([^\]]+)\]\s*\(\s*([^)]+?)\s*\)/g,
    (match, label: string, path: string) => {
      const trimmedPath = path.trim();
      if (/^https?:\/\//i.test(trimmedPath)) return match;
      if (!trimmedPath.includes("/") && !trimmedPath.includes("\\")) return match;
      const cleanLabel = cleanSourceName(label) || cleanSourceName(trimmedPath);
      return buildFileReferenceMarker(cleanLabel, "DOC", trimmedPath);
    },
  );

  result = result.replace(
    new RegExp(`${FILE_REF_END}\\s*[;,]\\s*${FILE_REF_MARKER}`, "g"),
    `${FILE_REF_END} ${FILE_REF_MARKER}`,
  );

  result = result.replace(/\/Users\/[^\s)"\]]+/gi, (match) => cleanSourceName(match));
  result = result.replace(/attachments\/[a-f0-9-]+[-/][^\s)"\]]+/gi, (match) => cleanSourceName(match));

  result = result.replace(
    /\*{0,2}【([^】]+)】\*{0,2}/g,
    (_match, name: string) => buildFileReferenceMarker(name, "DOC"),
  );

  return result;
}

/** Deduplicate search/chunk rows so the citation popover does not repeat the same excerpt. */
export function dedupeCitationResults(results: IngestionSearchResult[]): IngestionSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.relativePath}::${result.locator ?? result.chunkId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Citation pills: show excerpt popover for PDFs/docs (including staged); only skip for inline previews. */
export function citationPillShouldOpenWorkspaceDirectly(file: WorkspaceFileRecord): boolean {
  return file.previewKind === "image" || file.previewKind === "html" || file.previewKind === "jsx";
}

import type { IngestionDocumentRecord, WorkspaceFileRecord } from "@stuart/shared";

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

export function extractCitationQueryText(
  text: string,
  markerStart: number,
  markerEnd: number,
): string {
  const sentenceStart = findSentenceBoundary(text, markerStart, -1);
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

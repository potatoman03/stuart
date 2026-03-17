import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import mermaid from "mermaid";
import type {
  ArtifactDraft,
  CitationRef,
  CustomSection,
  DiagramScene,
  Flashcard,
  MindMapNode,
  MockExamSection,
  MockExamQuestion,
  QuizQuestion,
  StudyArtifactKind,
} from "@stuart/shared";

/* ---- Source Name Cleaning ---- */

function cleanSourceName(rawPath: string): string {
  let name = rawPath;
  try { name = decodeURIComponent(name); } catch { /* ignore */ }
  name = name.replace(/^attachments\/[a-f0-9-]+[-/]/i, "");
  const parts = name.split("/");
  name = parts[parts.length - 1] || name;
  name = name.replace(/\.(pdf|docx|pptx|xlsx|txt|md|html|csv|json|epub)$/i, "");
  return name;
}

/** Strip HTML tags, Anki cloze notation, and field labels from text.
 *  Converts block-level HTML into line breaks so multi-point answers stay readable. */
function stripHtml(text: string): string {
  return text
    // Convert block-level tags to newlines BEFORE stripping
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<(?:p|div|li|tr|h[1-6])\b[^>]*>/gi, "")
    // Convert bullet-style HTML list markers
    .replace(/<ul[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<ol[^>]*>/gi, "")
    .replace(/<\/ol>/gi, "\n")
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    // {{c1::answer::hint}} → answer
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/gi, "$1")
    // {{text}} → text
    .replace(/\{\{([^}]*)\}\}/g, "$1")
    // Remove "Tags: word::word::word" lines entirely
    .replace(/\bTags:\s*[\w:]+(?:::[\w:]+)*/gi, "")
    // Remove Anki field prefixes like "Extra:", "Notes:", "Hint:"
    .replace(/^(Extra|Notes|Hint|Tags|Source|Ref):\s*/gim, "")
    // Clean remaining :: tag separators (e.g., "anaesthesia::chapter6") → remove
    .replace(/\b\w+(?:::\w+){2,}\b/g, "")
    // Clean double colons between words
    .replace(/(\w)::([\w])/g, "$1, $2")
    // Insert line breaks before common list patterns (e.g., "point1.Point2" → "point1.\nPoint2")
    .replace(/\.([A-Z])/g, ".\n$1")
    // Insert line break before em-dash-separated items that run together
    .replace(/([a-z])—\s*([A-Z])/g, "$1\n—$2")
    // Collapse multiple blank lines into one, but preserve single newlines
    .replace(/\n{3,}/g, "\n\n")
    // Collapse spaces within lines (but NOT newlines)
    .replace(/[^\S\n]+/g, " ")
    // Trim each line
    .split("\n").map(l => l.trim()).filter((l, i, arr) => l || (i > 0 && arr[i - 1] !== "")).join("\n")
    .trim();
}

/* ---- Helpers ---- */

function countMindmapNodes(nodes: MindMapNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) count += countMindmapNodes(node.children);
  }
  return count;
}

const DEPTH_COLORS = [
  "#2962FF",
  "#E65100",
  "#16A34A",
  "#7C3AED",
  "#D97706",
  "#DC2626",
  "#0891B2",
  "#BE185D",
];

/* ---- localStorage helpers ---- */

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored) as T;
  } catch { /* ignore */ }
  return fallback;
}

function saveToStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

/* ---- SM-2 Spaced Repetition Algorithm ---- */

type SM2Rating = "again" | "hard" | "good" | "easy";

function sm2RatingToQuality(rating: SM2Rating): number {
  switch (rating) {
    case "again": return 0;
    case "hard": return 2;
    case "good": return 3;
    case "easy": return 5;
  }
}

function computeSM2(
  quality: number,
  prevEaseFactor: number,
  prevInterval: number,
  prevRepetitions: number,
): { easeFactor: number; interval: number; repetitions: number; nextReviewDate: string } {
  let easeFactor = prevEaseFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easeFactor < 1.3) easeFactor = 1.3;

  let interval: number;
  let repetitions: number;
  if (quality < 3) {
    repetitions = 0;
    interval = 0;
  } else {
    repetitions = prevRepetitions + 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(prevInterval * easeFactor);
  }

  const next = new Date();
  next.setDate(next.getDate() + interval);
  return { easeFactor, interval, repetitions, nextReviewDate: next.toISOString() };
}

/* ---- Cloze Deletion Renderer ---- */

function renderCloze(text: string, showAnswer: boolean): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const answer = match[1]!;
    const hint = match[2];
    if (showAnswer) {
      parts.push(<span key={match.index} className="cloze-answer">{answer}</span>);
    } else {
      parts.push(<span key={match.index} className="cloze-blank">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/* ---- Inline Response Panel ---- */

function InlineResponsePanel({ response, isLoading, onClose }: { response: string | null; isLoading?: boolean; onClose: () => void }) {
  if (!response && !isLoading) return null;
  return (
    <div className="inline-response-panel">
      <div className="inline-response-panel-header">
        <span>Stuart's Response</span>
        <button className="ghost-button compact" type="button" onClick={onClose} style={{ padding: "2px 6px", fontSize: 11 }}>Close</button>
      </div>
      <div className="inline-response-panel-body">
        {isLoading && !response && <span className="inline-response-loading">Thinking...</span>}
        {response && response.split("\n").map((line, i) => <p key={i}>{line || "\u00A0"}</p>)}
        {isLoading && response && <span className="inline-response-loading">...</span>}
      </div>
    </div>
  );
}

/* ---- Component ---- */

type ArtifactCanvasProps = {
  title: string;
  kind: StudyArtifactKind;
  payload: string;
  onClose: () => void;
  onExplain?: (message: string) => void;
  artifactDbId?: string;
  onInlineAsk?: (message: string) => void;
  inlineResponse?: string | null;
  isInlineLoading?: boolean;
};

export default function ArtifactCanvas({ title, kind, payload, onClose, onExplain, artifactDbId, onInlineAsk, inlineResponse, isInlineLoading }: ArtifactCanvasProps) {
  let parsed: ArtifactDraft | null = null;
  try {
    parsed = JSON.parse(payload) as ArtifactDraft;
  } catch {
    // ignore parse failures
  }

  // Generate a stable ID for localStorage persistence
  const artifactId = useMemo(() => {
    let hash = 0;
    const str = title + kind;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return `stuart-artifact-${kind}-${Math.abs(hash).toString(36)}`;
  }, [title, kind]);

  return (
    <div className="artifact-canvas-overlay">
      <div className="artifact-canvas-panel">
        <div className="artifact-canvas-header">
          <div>
            <span className={`kind-badge ${kind}`}>{kind}</span>
            <h2>{title}</h2>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => {
                const blob = new Blob([payload], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${title.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-")}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              title="Download artifact as JSON"
            >
              Download
            </button>
            <button className="secondary-button compact" type="button" onClick={onClose}>
              &larr; Back to chat
            </button>
          </div>
        </div>
        <div className="artifact-canvas-body">
          {!parsed ? (
            <div className="empty-state">
              <strong>Could not display this artifact</strong>
              <span>The data may still be loading. Try again in a moment.</span>
            </div>
          ) : kind === "mindmap" && parsed.kind === "mindmap" ? (
            <MindMapCanvas nodes={parsed.nodes} onExplain={onExplain} artifactDbId={artifactDbId} onInlineAsk={onInlineAsk} inlineResponse={inlineResponse} isInlineLoading={isInlineLoading} />
          ) : kind === "flashcards" && parsed.kind === "flashcards" ? (
            <FlashcardsCanvas cards={parsed.cards} artifactId={artifactId} artifactDbId={artifactDbId} onExplain={onExplain} />
          ) : kind === "quiz" && parsed.kind === "quiz" ? (
            <QuizCanvas questions={parsed.questions} artifactId={artifactId} artifactDbId={artifactDbId} onExplain={onExplain} onInlineAsk={onInlineAsk} inlineResponse={inlineResponse} isInlineLoading={isInlineLoading} />
          ) : kind === "diagram" && parsed.kind === "diagram" ? (
            <DiagramCanvas scene={parsed.scene} />
          ) : kind === "custom" && parsed.kind === "custom" ? (
            <CustomCanvas content={parsed.content} sections={parsed.sections} />
          ) : kind === "mock_exam" && parsed.kind === "mock_exam" ? (
            <MockExamCanvas
              sections={parsed.sections}
              title={parsed.title}
              timeLimitMinutes={parsed.timeLimitMinutes}
              artifactDbId={artifactDbId}
              onExplain={onExplain}
              onInlineAsk={onInlineAsk}
              inlineResponse={inlineResponse}
              isInlineLoading={isInlineLoading}
            />
          ) : kind === "interactive" && parsed.kind === "interactive" ? (
            <InteractiveCanvas html={parsed.html} title={parsed.title} />
          ) : (
            <div className="empty-state">
              <strong>Unknown artifact type</strong>
              <span>This study tool is not supported yet.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==================================================================
   MIND MAP CANVAS — SVG-based horizontal tree layout
   ================================================================== */

type LayoutNode = {
  node: MindMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  children: LayoutNode[];
};

function measureTextWidth(text: string, fontSize: number): number {
  return Math.min(text.length * fontSize * 0.55 + 24, 220);
}

function countDescendants(node: MindMapNode): number {
  if (!node.children || node.children.length === 0) return 0;
  let count = node.children.length;
  for (const child of node.children) {
    count += countDescendants(child);
  }
  return count;
}

function layoutTree(
  nodes: MindMapNode[],
  startX: number,
  startY: number,
  availableHeight: number,
  depth: number,
): LayoutNode[] {
  const hGap = 80;
  const vPadding = 12;
  const nodeHeight = 40;
  const results: LayoutNode[] = [];

  // Calculate total weight for distributing vertical space
  const weights = nodes.map((n) => 1 + countDescendants(n));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let currentY = startY;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const w = weights[i] ?? 1;
    const fontSize = depth === 0 ? 15 : depth === 1 ? 13 : 12;
    const nodeWidth = measureTextWidth(node.label, fontSize);
    const sliceHeight = (w / totalWeight) * availableHeight;

    // Layout children first to determine subtree extent
    const childLayouts =
      node.children && node.children.length > 0
        ? layoutTree(
            node.children,
            startX + nodeWidth + hGap,
            currentY,
            sliceHeight,
            depth + 1,
          )
        : [];

    // Center this node within its slice
    const nodeY = currentY + sliceHeight / 2 - nodeHeight / 2;

    results.push({
      node,
      x: startX,
      y: nodeY,
      width: nodeWidth,
      height: nodeHeight,
      depth,
      children: childLayouts,
    });

    currentY += sliceHeight + vPadding;
  }

  return results;
}

function flattenLayout(layouts: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  for (const l of layouts) {
    result.push(l);
    if (l.children.length > 0) {
      result.push(...flattenLayout(l.children));
    }
  }
  return result;
}

function getLayoutBounds(layouts: LayoutNode[]): { maxX: number; maxY: number; minY: number } {
  const all = flattenLayout(layouts);
  let maxX = 0;
  let maxY = 0;
  let minY = Infinity;
  for (const n of all) {
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
    minY = Math.min(minY, n.y);
  }
  return { maxX, maxY, minY };
}

function MindMapCanvas({ nodes, onExplain, artifactDbId, onInlineAsk, inlineResponse, isInlineLoading }: { nodes: MindMapNode[]; onExplain?: (msg: string) => void; artifactDbId?: string; onInlineAsk?: (msg: string) => void; inlineResponse?: string | null; isInlineLoading?: boolean }) {
  const nodeCount = useMemo(() => countMindmapNodes(nodes), [nodes]);
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [nodeSizes, setNodeSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [nodeEdits, setNodeEdits] = useState<Record<string, { label?: string; detail?: string }>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [resizingNodeId, setResizingNodeId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const [nodeNotes, setNodeNotes] = useState<Record<string, string>>({});
  const [editingNote, setEditingNote] = useState("");
  const [showNoteEditor, setShowNoteEditor] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [inlineAskText, setInlineAskText] = useState("");
  const [showInlineResponse, setShowInlineResponse] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!artifactDbId) return;
    fetch(`/api/study-artifacts/${artifactDbId}/node-notes`)
      .then(r => r.ok ? r.json() : [])
      .then((notes: Array<{ nodeId: string; content: string }>) => {
        const map: Record<string, string> = {};
        for (const n of notes) map[n.nodeId] = n.content;
        setNodeNotes(map);
      })
      .catch(() => {});
  }, [artifactDbId]);

  const estimatedHeight = Math.max(600, nodeCount * 52);
  const layout = useMemo(
    () => layoutTree(nodes, 40, 20, estimatedHeight, 0),
    [nodes, estimatedHeight],
  );
  const bounds = useMemo(() => getLayoutBounds(layout), [layout]);
  const svgWidth = bounds.maxX + 160;
  const svgHeight = bounds.maxY + 60;

  // Get effective position, size, and label for a node (layout + user overrides)
  function getNodePos(l: LayoutNode): { x: number; y: number } {
    return nodePositions[l.node.id] ?? { x: l.x, y: l.y };
  }
  function getNodeSize(l: LayoutNode): { w: number; h: number } {
    return nodeSizes[l.node.id] ?? { w: l.width, h: l.height };
  }
  function getNodeLabel(l: LayoutNode): string {
    return nodeEdits[l.node.id]?.label ?? l.node.label;
  }
  function getNodeDetail(l: LayoutNode): string {
    return nodeEdits[l.node.id]?.detail ?? l.node.detail;
  }

  function renderConnections(layouts: LayoutNode[]): React.ReactNode[] {
    const lines: React.ReactNode[] = [];
    for (const l of layouts) {
      const parentPos = getNodePos(l);
      const parentSize = getNodeSize(l);
      for (const child of l.children) {
        const childPos = getNodePos(child);
        const childSize = getNodeSize(child);
        const parentX = parentPos.x + parentSize.w;
        const parentY = parentPos.y + parentSize.h / 2;
        const childX = childPos.x;
        const childY = childPos.y + childSize.h / 2;
        const midX = (parentX + childX) / 2;
        const color = DEPTH_COLORS[child.depth % DEPTH_COLORS.length];
        lines.push(
          <path
            key={`conn-${l.node.id}-${child.node.id}`}
            d={`M${parentX},${parentY} C${midX},${parentY} ${midX},${childY} ${childX},${childY}`}
            stroke={color}
            strokeWidth="1.5"
            fill="none"
            opacity="0.4"
          />,
        );
      }
      if (l.children.length > 0) {
        lines.push(...renderConnections(l.children));
      }
    }
    return lines;
  }

  // Convert mouse event to SVG coordinates
  function mouseToSvg(e: React.MouseEvent): { x: number; y: number } {
    const container = svgContainerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left + container.scrollLeft) / zoom,
      y: (e.clientY - rect.top + container.scrollTop) / zoom,
    };
  }

  function handleNodeDragStart(e: React.MouseEvent, l: LayoutNode) {
    e.stopPropagation();
    e.preventDefault();
    const svgPos = mouseToSvg(e);
    const pos = getNodePos(l);
    dragOffsetRef.current = { x: svgPos.x - pos.x, y: svgPos.y - pos.y };
    setDraggingNodeId(l.node.id);
  }

  function handleResizeStart(e: React.MouseEvent, l: LayoutNode) {
    e.stopPropagation();
    e.preventDefault();
    const svgPos = mouseToSvg(e);
    const size = getNodeSize(l);
    resizeStartRef.current = { x: svgPos.x, y: svgPos.y, w: size.w, h: size.h };
    setResizingNodeId(l.node.id);
  }

  function renderNodes(layouts: LayoutNode[]): React.ReactNode[] {
    const elements: React.ReactNode[] = [];
    for (const l of layouts) {
      const color = DEPTH_COLORS[l.depth % DEPTH_COLORS.length];
      const fontSize = l.depth === 0 ? 15 : l.depth === 1 ? 13 : 12;
      const fontWeight = l.depth === 0 ? 700 : l.depth === 1 ? 600 : 400;
      const isSelected = selectedNode?.id === l.node.id;
      const matchesSearch = searchQuery && l.node.label.toLowerCase().includes(searchQuery.toLowerCase());
      const isDragTarget = draggingNodeId === l.node.id;
      const pos = getNodePos(l);
      const size = getNodeSize(l);
      const label = getNodeLabel(l);
      const isEditing = editingNodeId === l.node.id;
      const truncatedLabel = label.length > Math.floor(size.w / (fontSize * 0.55) - 2)
        ? label.substring(0, Math.floor(size.w / (fontSize * 0.55) - 4)) + "..."
        : label;

      elements.push(
        <g
          key={l.node.id}
          transform={`translate(${pos.x}, ${pos.y})`}
          onMouseDown={(e) => {
            // Don't start node drag if clicking resize handle or editing
            if (isEditing) return;
            handleNodeDragStart(e, l);
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (!draggingNodeId) setSelectedNode(l.node);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(l.node.id);
          }}
          style={{ cursor: isEditing ? "text" : draggingNodeId === l.node.id ? "grabbing" : "grab" }}
          className={"mindmap-node-rect" + (matchesSearch ? " mindmap-node-highlight" : "") + (isDragTarget ? " dragging" : "")}
        >
          <rect
            rx="8"
            ry="8"
            width={size.w}
            height={size.h}
            fill={color}
            opacity={isSelected ? 0.25 : 0.12}
            stroke={color}
            strokeWidth={isSelected ? 2.5 : 1.5}
          />
          {isEditing ? (
            <foreignObject x={4} y={4} width={size.w - 8} height={size.h - 8}>
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                defaultValue={label}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val && val !== l.node.label) {
                    setNodeEdits(prev => ({ ...prev, [l.node.id]: { ...prev[l.node.id], label: val } }));
                  }
                  setEditingNodeId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") { setEditingNodeId(null); }
                }}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "transparent",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: `${fontSize}px`,
                  fontWeight,
                  color: "#111",
                  outline: "none",
                  padding: "0 4px",
                }}
              />
            </foreignObject>
          ) : (
            <text
              x={10}
              y={size.h / 2 + fontSize / 3}
              fill="#111"
              fontSize={fontSize}
              fontWeight={fontWeight}
              fontFamily="Inter, system-ui, sans-serif"
            >
              {truncatedLabel}
            </text>
          )}
          {/* Resize handle — bottom-right corner */}
          {isSelected && !isEditing && (
            <rect
              x={size.w - 10}
              y={size.h - 10}
              width={10}
              height={10}
              fill={color}
              opacity={0.4}
              rx={2}
              style={{ cursor: "nwse-resize" }}
              onMouseDown={(e) => handleResizeStart(e, l)}
            />
          )}
        </g>,
      );
      if (l.children.length > 0) {
        elements.push(...renderNodes(l.children));
      }
    }
    return elements;
  }

  return (
    <div className={`mindmap-canvas-wrapper${isFullscreen ? " mindmap-fullscreen" : ""}`}>
      <div className="mindmap-toolbar">
        <span className="mindmap-node-count">{nodeCount} nodes</span>
        <div className="mindmap-zoom-controls">
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}
          >
            -
          </button>
          <span className="mindmap-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
          >
            +
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setZoom(1)}
          >
            Reset
          </button>
        </div>
        <input
          type="text"
          className="mindmap-search-input"
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          type="button"
          className="secondary-button compact"
          onClick={() => {
            // Render mindmap directly to canvas for reliable PNG export
            const scale = 2;
            const allNodes = flattenLayout(layout);
            // Compute bounds from actual positions (including user overrides)
            let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
            for (const l of allNodes) {
              const pos = getNodePos(l);
              const size = getNodeSize(l);
              minX = Math.min(minX, pos.x);
              minY = Math.min(minY, pos.y);
              maxX = Math.max(maxX, pos.x + size.w);
              maxY = Math.max(maxY, pos.y + size.h);
            }
            const pad = 40;
            const w = maxX - minX + pad * 2;
            const h = maxY - minY + pad * 2;
            const offX = -minX + pad;
            const offY = -minY + pad;

            const canvas = document.createElement("canvas");
            canvas.width = w * scale;
            canvas.height = h * scale;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.scale(scale, scale);
            ctx.fillStyle = "#f7f7f5";
            ctx.fillRect(0, 0, w, h);

            // Draw connections
            function drawConnections(layouts: LayoutNode[]) {
              for (const l of layouts) {
                const parentPos = getNodePos(l);
                const parentSize = getNodeSize(l);
                for (const child of l.children) {
                  const childPos = getNodePos(child);
                  const childSize = getNodeSize(child);
                  const px = parentPos.x + parentSize.w + offX;
                  const py = parentPos.y + parentSize.h / 2 + offY;
                  const cx = childPos.x + offX;
                  const cy = childPos.y + childSize.h / 2 + offY;
                  const midX = (px + cx) / 2;
                  ctx!.beginPath();
                  ctx!.moveTo(px, py);
                  ctx!.bezierCurveTo(midX, py, midX, cy, cx, cy);
                  ctx!.strokeStyle = DEPTH_COLORS[child.depth % DEPTH_COLORS.length]!;
                  ctx!.globalAlpha = 0.5;
                  ctx!.lineWidth = 1.5;
                  ctx!.stroke();
                  ctx!.globalAlpha = 1;
                }
                if (l.children.length > 0) drawConnections(l.children);
              }
            }
            drawConnections(layout);

            // Draw nodes
            for (const l of allNodes) {
              const pos = getNodePos(l);
              const size = getNodeSize(l);
              const color = DEPTH_COLORS[l.depth % DEPTH_COLORS.length]!;
              const x = pos.x + offX;
              const y = pos.y + offY;
              const fontSize = l.depth === 0 ? 15 : l.depth === 1 ? 13 : 12;
              const fontWeight = l.depth === 0 ? "700" : l.depth === 1 ? "600" : "400";
              const label = getNodeLabel(l);
              const maxChars = Math.floor(size.w / (fontSize * 0.55) - 2);
              const truncated = label.length > maxChars ? label.substring(0, maxChars - 2) + "..." : label;

              // Background
              ctx.fillStyle = color;
              ctx.globalAlpha = 0.15;
              ctx.beginPath();
              ctx.roundRect(x, y, size.w, size.h, 8);
              ctx.fill();
              // Border
              ctx.globalAlpha = 0.6;
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.5;
              ctx.stroke();
              ctx.globalAlpha = 1;
              // Text
              ctx.fillStyle = "#111";
              ctx.font = `${fontWeight} ${fontSize}px Inter, system-ui, sans-serif`;
              ctx.textBaseline = "middle";
              ctx.fillText(truncated, x + 10, y + size.h / 2);
            }

            const a = document.createElement("a");
            a.download = "mindmap.png";
            a.href = canvas.toDataURL("image/png");
            a.click();
          }}
          title="Download as PNG"
        >
          PNG
        </button>
        {(Object.keys(nodePositions).length > 0 || Object.keys(nodeSizes).length > 0 || Object.keys(nodeEdits).length > 0) && (
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => { setNodePositions({}); setNodeSizes({}); setNodeEdits({}); }}
            title="Reset all node changes"
          >
            Reset Layout
          </button>
        )}
        <button
          type="button"
          className="secondary-button compact"
          onClick={() => setIsFullscreen(v => !v)}
        >
          {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
      </div>

      <div
        className="mindmap-svg-container"
        ref={svgContainerRef}
        onMouseDown={(e) => {
          if (!svgContainerRef.current) return;
          // Only pan if not dragging a node
          if (!draggingNodeId) {
            setIsPanning(true);
            setPanStart({
              x: e.clientX,
              y: e.clientY,
              scrollLeft: svgContainerRef.current.scrollLeft,
              scrollTop: svgContainerRef.current.scrollTop,
            });
            svgContainerRef.current.style.cursor = "grabbing";
          }
        }}
        onMouseMove={(e) => {
          // Resizing takes priority
          if (resizingNodeId) {
            e.preventDefault();
            const svgPos = mouseToSvg(e);
            const dx = svgPos.x - resizeStartRef.current.x;
            const dy = svgPos.y - resizeStartRef.current.y;
            setNodeSizes(prev => ({
              ...prev,
              [resizingNodeId]: {
                w: Math.max(60, resizeStartRef.current.w + dx),
                h: Math.max(28, resizeStartRef.current.h + dy),
              }
            }));
            return;
          }
          // Node dragging
          if (draggingNodeId) {
            e.preventDefault();
            const svgPos = mouseToSvg(e);
            setNodePositions(prev => ({
              ...prev,
              [draggingNodeId]: {
                x: svgPos.x - dragOffsetRef.current.x,
                y: svgPos.y - dragOffsetRef.current.y,
              }
            }));
            return;
          }
          // Pan
          if (!isPanning || !svgContainerRef.current) return;
          e.preventDefault();
          svgContainerRef.current.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
          svgContainerRef.current.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
        }}
        onMouseUp={() => {
          if (resizingNodeId) {
            setResizingNodeId(null);
            return;
          }
          if (draggingNodeId) {
            setDraggingNodeId(null);
            return;
          }
          setIsPanning(false);
          if (svgContainerRef.current) svgContainerRef.current.style.cursor = "grab";
        }}
        onMouseLeave={() => {
          setDraggingNodeId(null);
          setResizingNodeId(null);
          setIsPanning(false);
          if (svgContainerRef.current) svgContainerRef.current.style.cursor = "grab";
        }}
      >
        <svg
          width={svgWidth * zoom}
          height={svgHeight * zoom}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ display: "block" }}
        >
          {renderConnections(layout)}
          {renderNodes(layout)}
        </svg>
      </div>

      {selectedNode && (
        <div className="mindmap-detail-card">
          <div className="mindmap-detail-card-header">
            <strong>{nodeEdits[selectedNode.id]?.label ?? selectedNode.label}</strong>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => { setSelectedNode(null); setShowNoteEditor(false); setShowInlineResponse(false); setEditingNodeId(null); }}
            >
              Close
            </button>
          </div>
          {/* Editable detail */}
          <p
            className="mindmap-detail-card-body"
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) => {
              const val = (e.target as HTMLElement).textContent?.trim() ?? "";
              if (val && val !== selectedNode.detail) {
                setNodeEdits(prev => ({ ...prev, [selectedNode.id]: { ...prev[selectedNode.id], detail: val } }));
              }
            }}
            style={{ cursor: "text", minHeight: 20, outline: "none", borderBottom: "1px dashed var(--line)" }}
          >
            {(nodeEdits[selectedNode.id]?.detail ?? selectedNode.detail) || "Click to add detail..."}
          </p>
          {selectedNode.citations.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <CitationPills citations={selectedNode.citations} />
            </div>
          )}

          {/* Single-row action bar */}
          <div className="mindmap-action-bar">
            {onExplain && (
              <>
                <button className="ghost-button compact" type="button" onClick={() => onExplain(`Explain "${selectedNode.label}" in simple terms. ${selectedNode.detail || ""}`)}>Explain</button>
                <button className="ghost-button compact" type="button" onClick={() => onExplain(`Expand on "${selectedNode.label}" — what are the sub-topics and key details I should know?`)}>Expand</button>
                <button className="ghost-button compact" type="button" onClick={() => onExplain(`Create a short quiz about "${selectedNode.label}" to test my understanding.`)}>Quiz me</button>
              </>
            )}
            <button
              className={`ghost-button compact mindmap-note-toggle${showNoteEditor ? " active" : ""}${nodeNotes[selectedNode.id] ? " has-note" : ""}`}
              type="button"
              onClick={() => {
                setShowNoteEditor(v => !v);
                setEditingNote(nodeNotes[selectedNode.id] ?? "");
              }}
              title={nodeNotes[selectedNode.id] ? "Edit note" : "Add note"}
            >
              {nodeNotes[selectedNode.id] ? "\u270E" : "+"}
            </button>
            {onInlineAsk && (
              <div className="mindmap-inline-ask">
                <input
                  type="text"
                  placeholder={`Ask about "${selectedNode.label}"...`}
                  value={inlineAskText}
                  onChange={(e) => setInlineAskText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && inlineAskText.trim()) {
                      onInlineAsk(`Regarding "${selectedNode.label}": ${inlineAskText.trim()}`);
                      setInlineAskText("");
                      setShowInlineResponse(true);
                    }
                  }}
                />
                <button
                  className="accent-button compact"
                  type="button"
                  onClick={() => {
                    if (inlineAskText.trim()) {
                      onInlineAsk(`Regarding "${selectedNode.label}": ${inlineAskText.trim()}`);
                      setInlineAskText("");
                      setShowInlineResponse(true);
                    }
                  }}
                >
                  Ask
                </button>
              </div>
            )}
          </div>

          {/* Collapsible note editor */}
          {showNoteEditor && (
            <textarea
              className="mindmap-note-textarea"
              placeholder="Add a personal note..."
              value={editingNote}
              onChange={(e) => setEditingNote(e.target.value)}
              onBlur={() => {
                if (artifactDbId && selectedNode) {
                  setNodeNotes(prev => ({ ...prev, [selectedNode.id]: editingNote }));
                  fetch(`/api/study-artifacts/${artifactDbId}/node-notes/${selectedNode.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: editingNote }),
                  }).catch(() => {});
                }
              }}
            />
          )}

          {/* Inline response */}
          {showInlineResponse && (
            <InlineResponsePanel response={inlineResponse ?? null} isLoading={isInlineLoading} onClose={() => setShowInlineResponse(false)} />
          )}
        </div>
      )}
    </div>
  );
}

/* ==================================================================
   FLASHCARDS CANVAS — Anki-style spaced repetition
   ================================================================== */

type CardRating = "again" | "hard" | "good" | "easy";

type CardState = {
  rating: CardRating | null;
  reviewCount: number;
  easeFactor?: number;
  intervalDays?: number;
  repetitions?: number;
  correctCount?: number;
};

function FlashcardsCanvas({
  cards,
  artifactId,
  artifactDbId,
  onExplain,
}: {
  cards: Flashcard[];
  artifactId: string;
  artifactDbId?: string;
  onExplain?: (message: string) => void;
}) {
  const storageKey = `${artifactId}-flashcards`;
  const [cardStates, setCardStates] = useState<Record<string, CardState>>(() =>
    loadFromStorage(storageKey, {}),
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);

  // Spacebar flips the card
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        setFlipped((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [sessionReviewed, setSessionReviewed] = useState(0);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionStartTime] = useState(() => Date.now());
  const [weakCards, setWeakCards] = useState<Array<{ cardId: string; easeFactor: number }>>([]);

  useEffect(() => {
    if (!artifactDbId) return;
    fetch(`/api/study-artifacts/${artifactDbId}/weak-cards`)
      .then(r => r.ok ? r.json() : [])
      .then((cards: Array<{ cardId: string; easeFactor: number }>) => setWeakCards(cards))
      .catch(() => {});
  }, [artifactDbId, showCompletion]);

  // Build the review queue based on ratings
  const reviewQueue = useMemo(() => {
    const again: number[] = [];
    const hard: number[] = [];
    const unseen: number[] = [];
    const good: number[] = [];

    cards.forEach((card, i) => {
      const state = cardStates[card.id];
      if (!state || !state.rating) {
        unseen.push(i);
      } else if (state.rating === "again") {
        again.push(i);
      } else if (state.rating === "hard") {
        hard.push(i);
      } else if (state.rating === "good") {
        good.push(i);
      }
      // "easy" cards are mastered and not in queue
    });

    return [...again, ...hard, ...unseen, ...good];
  }, [cards, cardStates]);

  const masteredCount = cards.filter((c) => cardStates[c.id]?.rating === "easy").length;
  const reviewCount = cards.filter(
    (c) => cardStates[c.id]?.rating === "again" || cardStates[c.id]?.rating === "hard",
  ).length;
  const remainingCount = cards.length - masteredCount;
  const masteryPct = cards.length > 0 ? Math.round((masteredCount / cards.length) * 100) : 0;

  if (cards.length === 0) {
    return (
      <div className="empty-state">
        <strong>No flashcards yet</strong>
        <span>Ask Stuart to create flashcards from your materials.</span>
      </div>
    );
  }

  // Completion screen
  if (showCompletion || (reviewQueue.length === 0 && masteredCount > 0)) {
    return (
      <div className="flashcard-completion">
        <div className="flashcard-completion-icon">&#10003;</div>
        <h3>Deck Complete!</h3>
        <div className="flashcard-completion-stats">
          <div className="flashcard-stat">
            <span className="flashcard-stat-value">{masteredCount}</span>
            <span className="flashcard-stat-label">Mastered</span>
          </div>
          <div className="flashcard-stat">
            <span className="flashcard-stat-value">{reviewCount}</span>
            <span className="flashcard-stat-label">To Review</span>
          </div>
          <div className="flashcard-stat">
            <span className="flashcard-stat-value">{masteryPct}%</span>
            <span className="flashcard-stat-label">Mastery</span>
          </div>
        </div>
        <div className="flashcard-completion-actions">
          <button
            className="accent-button"
            type="button"
            onClick={() => {
              setCardStates({});
              saveToStorage(storageKey, {});
              setCurrentIndex(0);
              setFlipped(false);
              setShowCompletion(false);
            }}
          >
            Start Over
          </button>
          {reviewCount > 0 && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setCurrentIndex(0);
                setFlipped(false);
                setShowCompletion(false);
              }}
            >
              Review Remaining
            </button>
          )}
        </div>

        {/* Session stats */}
        <div className="flashcard-session-stats">
          <span>Reviewed: <strong>{sessionReviewed}</strong></span>
          <span>Correct: <strong>{sessionCorrect}</strong></span>
          <span>Time: <strong>{Math.round((Date.now() - sessionStartTime) / 60000)}m</strong></span>
          <span>Accuracy: <strong>{sessionReviewed > 0 ? Math.round((sessionCorrect / sessionReviewed) * 100) : 0}%</strong></span>
        </div>

        {/* Weak topics */}
        {weakCards.length > 0 && (
          <div className="flashcard-weak-topics">
            <h4>Topics to Review</h4>
            <ul>
              {weakCards.slice(0, 5).map(wc => {
                const card = cards.find(c => c.id === wc.cardId);
                return card ? <li key={wc.cardId}>{stripHtml(card.front)}</li> : null;
              })}
            </ul>
          </div>
        )}

        {/* Anki export */}
        {artifactDbId && (
          <button
            className="secondary-button compact flashcard-export-btn"
            type="button"
            onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/study-artifacts/${artifactDbId}/export-anki`;
              a.download = "flashcards.txt";
              a.click();
            }}
          >
            Export to Anki
          </button>
        )}
      </div>
    );
  }

  const queueIndex = Math.min(currentIndex, reviewQueue.length - 1);
  const cardIndex = reviewQueue[queueIndex] ?? 0;
  const currentCard = cards[cardIndex] as Flashcard | undefined;

  if (!currentCard) return null;

  const activeCard: Flashcard = currentCard;

  function rateCard(rating: CardRating) {
    const quality = sm2RatingToQuality(rating);
    const prev = cardStates[activeCard.id];
    const sm2 = computeSM2(
      quality,
      prev?.easeFactor ?? 2.5,
      prev?.intervalDays ?? 0,
      prev?.repetitions ?? 0,
    );

    const newStates = {
      ...cardStates,
      [activeCard.id]: {
        rating,
        reviewCount: (cardStates[activeCard.id]?.reviewCount ?? 0) + 1,
        easeFactor: sm2.easeFactor,
        intervalDays: sm2.interval,
        repetitions: sm2.repetitions,
        correctCount: (prev?.correctCount ?? 0) + (rating === "good" || rating === "easy" ? 1 : 0),
      },
    };
    setCardStates(newStates);
    saveToStorage(storageKey, newStates);

    // Track session stats
    setSessionReviewed(c => c + 1);
    if (rating === "good" || rating === "easy") setSessionCorrect(c => c + 1);

    // Persist to API
    if (artifactDbId) {
      fetch(`/api/study-artifacts/${artifactDbId}/card-performance/${activeCard.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          easeFactor: sm2.easeFactor,
          intervalDays: sm2.interval,
          repetitions: sm2.repetitions,
          nextReviewDate: sm2.nextReviewDate,
          lastRating: rating,
          totalReviews: (prev?.reviewCount ?? 0) + 1,
          correctCount: (prev?.correctCount ?? 0) + (rating === "good" || rating === "easy" ? 1 : 0),
        }),
      }).catch(() => {});
    }

    setFlipped(false);

    // Move to next card
    if (currentIndex + 1 >= reviewQueue.length) {
      setShowCompletion(true);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  }

  return (
    <div className="flashcard-viewer">
      {/* Stats bar */}
      <div className="flashcard-stats-bar">
        <span>{remainingCount} remaining</span>
        <span className="flashcard-stat-mastered">{masteredCount} mastered</span>
        <span className="flashcard-stat-review">{reviewCount} to review</span>
      </div>

      {/* Progress bar */}
      <div className="flashcard-progress-bar">
        <div
          className="flashcard-progress-fill"
          style={{ width: `${masteryPct}%` }}
        />
      </div>

      {/* Card counter */}
      <div className="flashcard-counter">
        Card {queueIndex + 1} of {reviewQueue.length}
      </div>

      {/* Flip card */}
      {(() => {
        // Detect cloze: check front first, then back (models sometimes put cloze in back)
        const hasClozeInFront = /\{\{c\d+::/.test(currentCard.front);
        const hasClozeInBack = !hasClozeInFront && /\{\{c\d+::/.test(currentCard.back);
        // If cloze is in back, check if the surrounding sentence is meaningful enough
        // "The drug is {{c1::X}}" → stripping cloze leaves "The drug is ." — too short, fall back to Q&A
        const backContextText = hasClozeInBack
          ? currentCard.back.replace(/\{\{c\d+::.*?\}\}/g, "").replace(/[^a-zA-Z]/g, "")
          : "";
        const backClozeUseful = hasClozeInBack && backContextText.length > 30;
        const isCloze = hasClozeInFront || backClozeUseful;
        const clozeText = hasClozeInFront ? currentCard.front : currentCard.back;
        return (
      <div
        className="flashcard-flip-container"
        onClick={() => setFlipped((v) => !v)}
      >
        <div className={`flashcard-flip-inner${flipped ? " flipped" : ""}`}>
          {/* Front */}
          <div className="flashcard-flip-face flashcard-flip-front">
            <span className="flashcard-side-label">{isCloze ? "Fill in the blank" : "Question"}</span>
            <p className="front-text">{isCloze ? renderCloze(clozeText, false) : stripHtml(currentCard.front)}</p>
          </div>
          {/* Back */}
          <div className="flashcard-flip-face flashcard-flip-back">
            <span className="flashcard-side-label">Answer</span>
            <div className="back-text">
              {isCloze
                ? <p>{renderCloze(clozeText, true)}</p>
                : stripHtml(currentCard.back).split("\n").map((line, i) => (
                    <p key={i}>{line || "\u00A0"}</p>
                  ))
              }
            </div>
            {currentCard.cue && <p className="cue-text">{stripHtml(currentCard.cue)}</p>}
            {currentCard.citations.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <CitationPills citations={currentCard.citations} />
              </div>
            )}
          </div>
        </div>
      </div>
        );
      })()}

      {/* Rating buttons - only show when flipped */}
      {flipped ? (
        <>
          <div className="flashcard-rating-buttons">
            <button
              type="button"
              className="rating-again"
              onClick={() => rateCard("again")}
            >
              Again
            </button>
            <button
              type="button"
              className="rating-hard"
              onClick={() => rateCard("hard")}
            >
              Hard
            </button>
            <button
              type="button"
              className="rating-good"
              onClick={() => rateCard("good")}
            >
              Good
            </button>
            <button
              type="button"
              className="rating-easy"
              onClick={() => rateCard("easy")}
            >
              Easy
            </button>
          </div>
          {onExplain && (
            <button
              type="button"
              className="secondary-button compact explain-btn"
              onClick={() => onExplain("Explain this concept in simple terms: " + currentCard.front)}
            >
              Explain this
            </button>
          )}
        </>
      ) : (
        <button
          className="accent-button flashcard-reveal-btn"
          type="button"
          onClick={() => setFlipped(true)}
        >
          Show Answer
        </button>
      )}
    </div>
  );
}

/* ==================================================================
   QUIZ CANVAS — Full assessment mode, one question at a time
   ================================================================== */

function QuizCanvas({
  questions,
  artifactId,
  artifactDbId,
  onExplain,
  onInlineAsk,
  inlineResponse,
  isInlineLoading,
}: {
  questions: QuizQuestion[];
  artifactId: string;
  artifactDbId?: string;
  onExplain?: (message: string) => void;
  onInlineAsk?: (msg: string) => void;
  inlineResponse?: string | null;
  isInlineLoading?: boolean;
}) {
  const bestScoreKey = `${artifactId}-quiz-best`;
  const [currentQ, setCurrentQ] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMulti, setSelectedMulti] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [showEnd, setShowEnd] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [bestScore, setBestScore] = useState<number>(() =>
    loadFromStorage(bestScoreKey, -1),
  );
  const [difficultyFlags, setDifficultyFlags] = useState<Record<string, string>>({});
  const [showInlineExplain, setShowInlineExplain] = useState(false);
  const [attemptCount, setAttemptCount] = useState(1);

  // Shuffle options per question with a stable seed so order doesn't change on re-render
  const shuffledOptions = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const q of questions) {
      const opts = [...q.options];
      // Simple seeded shuffle using question id
      let seed = 0;
      for (let i = 0; i < q.id.length; i++) seed = ((seed << 5) - seed + q.id.charCodeAt(i)) | 0;
      for (let i = opts.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [opts[i], opts[j]] = [opts[j]!, opts[i]!];
      }
      map[q.id] = opts;
    }
    return map;
  }, [questions]);

  // When in review mode, only show missed questions
  const activeQuestions = useMemo(() => {
    if (!reviewMode) return questions;
    return questions.filter((q) => results[q.id] !== true);
  }, [questions, reviewMode, results]);

  const question = activeQuestions[currentQ];

  // Auto-detect MRQ: if the answer contains a comma-separated list matching multiple options
  const isMrq = useMemo(() => {
    if (!question) return false;
    const answerParts = question.answer.split(/,\s*/).map(a => a.trim()).filter(Boolean);
    return answerParts.length > 1 && answerParts.every(a => question.options.includes(a));
  }, [question]);
  const correctAnswers = useMemo(() => {
    if (!question) return new Set<string>();
    if (isMrq) return new Set(question.answer.split(/,\s*/).map(a => a.trim()));
    return new Set([question.answer]);
  }, [question, isMrq]);
  const totalAnswered = Object.keys(results).length;
  const correctCount = Object.values(results).filter(Boolean).length;
  const incorrectCount = totalAnswered - correctCount;

  if (questions.length === 0) {
    return (
      <div className="empty-state">
        <strong>No quiz questions yet</strong>
        <span>Ask Stuart to create a quiz from your materials.</span>
      </div>
    );
  }

  // End screen
  if (showEnd) {
    const pct = Math.round((correctCount / questions.length) * 100);
    const isNewBest = bestScore >= 0 ? pct > bestScore : true;
    if (isNewBest || bestScore < 0) {
      setBestScore(pct);
      saveToStorage(bestScoreKey, pct);
    }

    const missedQuestions = questions.filter((q) => results[q.id] === false);

    return (
      <div className="quiz-end-screen">
        <div className="quiz-end-score">{pct}%</div>
        <p className="quiz-end-subtitle">
          {correctCount} of {questions.length} correct
        </p>
        {bestScore >= 0 && (
          <p className="quiz-end-best">Best score: {Math.max(pct, bestScore)}%</p>
        )}
        <p className="quiz-end-message">
          {pct === 100
            ? "Perfect score! You know this material well."
            : pct >= 75
              ? "Great job! A few areas to review."
              : pct >= 50
                ? "Good effort. Consider revisiting the topics you missed."
                : "Keep studying -- you will get there! Review the material and try again."}
        </p>

        {missedQuestions.length > 0 && (
          <div className="quiz-missed-list">
            <h4>Questions you missed:</h4>
            {missedQuestions.map((q, i) => (
              <div key={q.id} className="quiz-missed-item">
                <p className="quiz-missed-prompt">{q.prompt}</p>
                <p className="quiz-missed-answer">
                  Correct answer: <strong>{q.answer}</strong>
                </p>
                {answers[q.id] && (
                  <p className="quiz-missed-yours">
                    Your answer: {answers[q.id]}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="quiz-end-actions">
          {missedQuestions.length > 0 && (
            <button
              className="accent-button"
              type="button"
              onClick={() => {
                // Capture missed question IDs before clearing state
                const missedIds = new Set(missedQuestions.map((q) => q.id));
                setReviewMode(true);
                setCurrentQ(0);
                setSelected(null);
                setSelectedMulti(new Set());
                setChecked(false);
                // Clear answers for missed questions only
                const newAnswers = { ...answers };
                for (const id of missedIds) {
                  delete newAnswers[id];
                }
                setAnswers(newAnswers);
                // Keep correct results, remove incorrect ones
                const newResults = { ...results };
                for (const id of missedIds) {
                  delete newResults[id];
                }
                setResults(newResults);
                setShowEnd(false);
              }}
            >
              Review Mistakes
            </button>
          )}
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setCurrentQ(0);
              setSelected(null);
              setChecked(false);
              setAnswers({});
              setResults({});
              setReviewMode(false);
              setShowEnd(false);
            }}
          >
            Start Over
          </button>
        </div>

        {/* Difficulty flags summary */}
        {Object.values(difficultyFlags).some(f => f) && (
          <div className="quiz-performance-trends" style={{ marginTop: 16 }}>
            <h4>Difficulty Feedback</h4>
            {Object.entries(difficultyFlags).filter(([, v]) => v).map(([qId, flag]) => {
              const q = questions.find(q => q.id === qId);
              return q ? (
                <div key={qId} className="quiz-performance-bar" style={{ fontSize: 12 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {q.prompt.slice(0, 60)}{q.prompt.length > 60 ? "..." : ""}
                  </span>
                  <span style={{ color: flag === "too_easy" ? "var(--success)" : "var(--danger)", fontWeight: 600, fontSize: 11 }}>
                    {flag === "too_easy" ? "Too Easy" : "Too Hard"}
                  </span>
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
    );
  }

  if (!question) return null;

  function handleCheck() {
    if (!question) return;
    const chosen = isMrq
      ? [...selectedMulti].sort().join(", ")
      : selected;
    if (!chosen) return;
    const isCorrect = isMrq
      ? selectedMulti.size === correctAnswers.size && [...selectedMulti].every(s => correctAnswers.has(s))
      : correctAnswers.has(selected ?? "");
    setChecked(true);
    setAnswers((prev) => ({ ...prev, [question.id]: chosen }));
    setResults((prev) => ({ ...prev, [question.id]: isCorrect }));

    // Persist quiz performance
    if (artifactDbId) {
      fetch(`/api/study-artifacts/${artifactDbId}/quiz-performance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          attemptNumber: attemptCount,
          selectedAnswer: chosen,
          isCorrect,
          difficultyFlag: difficultyFlags[question.id] ?? null,
        }),
      }).catch(() => {});
    }
  }

  function handleNext() {
    if (currentQ + 1 >= activeQuestions.length) {
      setShowEnd(true);
    } else {
      setCurrentQ((i) => i + 1);
      setSelected(null);
      setSelectedMulti(new Set());
      setChecked(false);
    }
  }

  const isCorrect = checked && results[question.id] === true;
  const isIncorrect = checked && results[question.id] === false;

  return (
    <div className="quiz-canvas">
      {/* Score bar */}
      <div className="quiz-score-bar">
        <span className="quiz-score-correct">{correctCount} correct</span>
        <span className="quiz-score-separator">|</span>
        <span className="quiz-score-incorrect">{incorrectCount} incorrect</span>
        <span className="quiz-score-separator">|</span>
        <span className="quiz-score-remaining">
          {activeQuestions.length - currentQ - (checked ? 1 : 0)} remaining
        </span>
        {reviewMode && <span className="quiz-review-badge">Review Mode</span>}
        {isMrq && <span className="quiz-review-badge" style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>Select multiple</span>}
      </div>

      {/* Question */}
      <div className="quiz-question-card">
        <span className="quiz-question-number">
          Question {currentQ + 1} of {activeQuestions.length}
        </span>
        <p className="quiz-question-text">{question.prompt}</p>

        {/* Options */}
        <div className="quiz-options-grid">
          {(shuffledOptions[question.id] ?? question.options).map((option, oi) => {
            let cls = "quiz-option-card";
            const isSelected = isMrq ? selectedMulti.has(option) : option === selected;
            if (checked) {
              if (correctAnswers.has(option)) cls += " correct";
              else if (isSelected && !correctAnswers.has(option)) cls += " incorrect";
            } else if (isSelected) {
              cls += " selected";
            }

            return (
              <button
                key={oi}
                type="button"
                className={cls}
                onClick={() => {
                  if (checked) return;
                  if (isMrq) {
                    setSelectedMulti((prev) => {
                      const next = new Set(prev);
                      if (next.has(option)) next.delete(option);
                      else next.add(option);
                      return next;
                    });
                  } else {
                    setSelected(option);
                  }
                }}
                disabled={checked}
              >
                <span className="quiz-option-letter">
                  {String.fromCharCode(65 + oi)}
                </span>
                <span className="quiz-option-text">{option}</span>
              </button>
            );
          })}
        </div>

        {/* Check / Next buttons */}
        <div className="quiz-question-actions">
          {!checked && (isMrq ? selectedMulti.size > 0 : !!selected) && (
            <button className="accent-button" type="button" onClick={handleCheck}>
              Check
            </button>
          )}
          {checked && (
            <>
              <div
                className={`quiz-feedback ${isCorrect ? "correct" : "incorrect"}`}
              >
                <strong>{isCorrect ? "Correct!" : "Not quite."}</strong>{" "}
                {question.explanation}
                {question.citations.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <CitationPills citations={question.citations} />
                  </div>
                )}
                {question.optionExplanations && (
                  <div style={{ marginTop: 8 }}>
                    {question.options.map(opt => (
                      question.optionExplanations?.[opt] ? (
                        <div key={opt} className="quiz-option-explanation">
                          <strong>{opt === question.answer ? "\u2713" : "\u2717"} {opt}:</strong> {question.optionExplanations[opt]}
                        </div>
                      ) : null
                    ))}
                  </div>
                )}
              </div>
              {isIncorrect && onExplain && (
                <button
                  type="button"
                  className="secondary-button compact explain-btn"
                  onClick={() => onExplain("Explain this to me: " + question.prompt + ". The correct answer is: " + question.answer)}
                >
                  Explain this
                </button>
              )}
              {isIncorrect && onInlineAsk && (
                <button
                  type="button"
                  className="secondary-button compact explain-btn"
                  onClick={() => {
                    onInlineAsk("Explain this to me: " + question.prompt + ". The correct answer is: " + question.answer + ". I selected: " + (answers[question.id] ?? ""));
                    setShowInlineExplain(true);
                  }}
                >
                  Explain Inline
                </button>
              )}
              {showInlineExplain && (
                <InlineResponsePanel response={inlineResponse ?? null} isLoading={isInlineLoading} onClose={() => setShowInlineExplain(false)} />
              )}
              <button
                className="accent-button"
                type="button"
                onClick={handleNext}
              >
                {currentQ + 1 >= activeQuestions.length ? "See Results" : "Next"}
              </button>
            </>
          )}
        </div>
        {checked && (
          <div className="quiz-difficulty-buttons">
            <button
              type="button"
              className={`quiz-difficulty-btn${difficultyFlags[question.id] === "too_easy" ? " active" : ""}`}
              onClick={() => {
                setDifficultyFlags(prev => ({ ...prev, [question.id]: prev[question.id] === "too_easy" ? "" : "too_easy" }));
              }}
            >
              Too Easy
            </button>
            <button
              type="button"
              className={`quiz-difficulty-btn${difficultyFlags[question.id] === "too_hard" ? " active" : ""}`}
              onClick={() => {
                setDifficultyFlags(prev => ({ ...prev, [question.id]: prev[question.id] === "too_hard" ? "" : "too_hard" }));
              }}
            >
              Too Hard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ==================================================================
   DIAGRAM CANVAS — Renders mermaid diagrams
   ================================================================== */

function DiagramCanvas({ scene }: { scene: DiagramScene }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !scene.mermaid) return;

    const el = containerRef.current;
    el.innerHTML = "";
    setRenderError(false);

    // Use a unique ID each time to avoid collisions on re-renders
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      fontFamily: "Inter, system-ui, sans-serif",
      securityLevel: "loose",
    });

    // Clean the mermaid source — trim whitespace, ensure no leading/trailing issues
    const cleanedSource = scene.mermaid.trim();

    mermaid.render(id, cleanedSource)
      .then(({ svg }) => {
        el.innerHTML = svg;
        // Make the SVG responsive
        const svgEl = el.querySelector("svg");
        if (svgEl) {
          svgEl.removeAttribute("height");
          svgEl.style.maxWidth = "100%";
          svgEl.style.height = "auto";
        }
      })
      .catch((err) => {
        console.error("Mermaid render error:", err);
        setRenderError(true);
        // Clear the container so the fallback shows cleanly
        el.innerHTML = "";
      });
  }, [scene.mermaid]);

  return (
    <div className="diagram-canvas">
      {scene.title && <h3 className="diagram-title">{scene.title}</h3>}

      <div className="diagram-rendered" ref={containerRef} />

      {renderError && (
        <div className="diagram-fallback">
          <div className="diagram-fallback-label">Diagram source (could not render)</div>
          <pre className="diagram-fallback-code">
            <code>{scene.mermaid}</code>
          </pre>
        </div>
      )}

      {scene.notes.length > 0 && (
        <div className="diagram-notes">
          {scene.notes.map((note) => (
            <div key={note.id} className="diagram-note-card">
              <strong>{note.label}</strong>
              <p>{note.explanation}</p>
              {note.citations.length > 0 && (
                <CitationPills citations={note.citations} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ==================================================================
   CUSTOM CANVAS — Clean markdown-like rendering
   ================================================================== */

function CustomCanvas({
  content,
  sections,
}: {
  content: string;
  sections: CustomSection[];
}) {
  return (
    <div className="custom-canvas">
      {content && (
        <div className="custom-content">
          {content.split("\n").map((line, i) => (
            <p key={i}>{line || "\u00A0"}</p>
          ))}
        </div>
      )}
      {sections.length > 0 && (
        <div className="custom-sections">
          {sections.map((section, i) => (
            <div key={i} className="custom-section">
              <h3 className="custom-section-heading">{section.heading}</h3>
              <div className="custom-section-body">
                {section.body.split("\n").map((line, li) => (
                  <p key={li}>{line || "\u00A0"}</p>
                ))}
              </div>
              {section.citations.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <CitationPills citations={section.citations} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ==================================================================
   MOCK EXAM CANVAS — Timed exam mode with sections
   ================================================================== */

function MockExamCanvas({
  sections,
  title,
  timeLimitMinutes,
  artifactDbId,
  onExplain,
  onInlineAsk,
  inlineResponse,
  isInlineLoading,
}: {
  sections: MockExamSection[];
  title: string;
  timeLimitMinutes: number;
  artifactDbId?: string;
  onExplain?: (msg: string) => void;
  onInlineAsk?: (msg: string) => void;
  inlineResponse?: string | null;
  isInlineLoading?: boolean;
}) {
  const [started, setStarted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [activeSection, setActiveSection] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [timeRemaining, setTimeRemaining] = useState(timeLimitMinutes * 60);
  const [scores, setScores] = useState<Record<string, number>>({});
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const totalMarks = sections.reduce((sum, s) => sum + s.totalMarks, 0);

  // Timer
  useEffect(() => {
    if (!started || submitted) return;
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const remaining = Math.max(0, timeLimitMinutes * 60 - elapsed);
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        handleSubmit();
      }
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [started, submitted]);

  function handleSubmit() {
    if (timerRef.current) clearInterval(timerRef.current);
    // Auto-mark MCQs
    const autoScores: Record<string, number> = {};
    for (const section of sections) {
      for (const q of section.questions) {
        if (q.questionType === "mcq") {
          autoScores[q.id] = answers[q.id] === q.correctAnswer ? q.marks : 0;
        }
      }
    }
    setScores(autoScores);
    setSubmitted(true);

    // Save attempt
    if (artifactDbId) {
      const timeTaken = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const totalScore = Object.values(autoScores).reduce((s, v) => s + v, 0);
      fetch(`/api/study-artifacts/${artifactDbId}/exam-attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: JSON.stringify(answers),
          totalMarks,
        }),
      })
        .then(r => r.json())
        .then((attempt: { id: string }) => {
          fetch(`/api/study-artifacts/${artifactDbId}/exam-attempts/${attempt.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              score: totalScore,
              timeTakenSeconds: timeTaken,
              completedAt: new Date().toISOString(),
            }),
          }).catch(() => {});
        })
        .catch(() => {});
    }

    // Request AI marking for non-MCQ questions
    if (onInlineAsk) {
      const nonMcq = sections.flatMap(s => s.questions.filter(q => q.questionType !== "mcq" && answers[q.id]));
      if (nonMcq.length > 0) {
        const markingPrompt = nonMcq.map(q =>
          `Question (${q.marks} marks): ${q.prompt}\nStudent answer: ${answers[q.id]}\nModel answer: ${q.correctAnswer}${q.markingCriteria ? `\nMarking criteria: ${q.markingCriteria}` : ""}`
        ).join("\n\n");
        onInlineAsk(`Please mark these exam answers and provide a score out of the allocated marks for each:\n\n${markingPrompt}`);
      }
    }
  }

  // Pre-exam screen
  if (!started) {
    return (
      <div className="mock-exam-canvas">
        <div className="mock-exam-pre-screen">
          <h3>{title}</h3>
          <div className="mock-exam-meta">
            <span>Total marks: <strong>{totalMarks}</strong></span>
            <span>Time limit: <strong>{timeLimitMinutes} min</strong></span>
            <span>Sections: <strong>{sections.length}</strong></span>
          </div>
          <div className="mock-exam-sections-preview">
            <h4>Sections</h4>
            <ul>
              {sections.map((s, i) => (
                <li key={s.id}>{i + 1}. {s.title} ({s.totalMarks} marks, {s.questions.length} questions)</li>
              ))}
            </ul>
          </div>
          <button className="accent-button" type="button" onClick={() => setStarted(true)}>
            Start Exam
          </button>
        </div>
      </div>
    );
  }

  // Results screen
  if (submitted) {
    const mcqTotal = Object.values(scores).reduce((s, v) => s + v, 0);
    const mcqMax = sections.flatMap(s => s.questions.filter(q => q.questionType === "mcq")).reduce((s, q) => s + q.marks, 0);
    const pct = mcqMax > 0 ? Math.round((mcqTotal / mcqMax) * 100) : 0;

    return (
      <div className="mock-exam-canvas">
        <div className="mock-exam-results">
          <h3>Exam Results</h3>
          <div className="mock-exam-score-display">{pct}%</div>
          <p className="mock-exam-score-subtitle">
            {mcqTotal} / {mcqMax} marks (auto-marked MCQs)
          </p>

          {/* Section scores */}
          <div className="mock-exam-section-scores">
            {sections.map(section => {
              const sectionMcq = section.questions.filter(q => q.questionType === "mcq");
              const sectionScore = sectionMcq.reduce((s, q) => s + (scores[q.id] ?? 0), 0);
              const sectionMax = sectionMcq.reduce((s, q) => s + q.marks, 0);
              return (
                <div key={section.id} className="mock-exam-section-score">
                  <span>{section.title}</span>
                  <span><strong>{sectionScore}</strong> / {sectionMax}</span>
                </div>
              );
            })}
          </div>

          {/* Review each question */}
          {sections.map(section => (
            <div key={section.id} style={{ marginBottom: 16 }}>
              <h4 style={{ marginBottom: 8 }}>{section.title}</h4>
              {section.questions.map(q => (
                <div key={q.id} className="mock-exam-question-card" style={{ marginBottom: 8 }}>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>{q.prompt}</p>
                  <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                    Your answer: {answers[q.id] || "(no answer)"}
                  </p>
                  <p style={{ fontSize: 12, color: q.questionType === "mcq" && answers[q.id] === q.correctAnswer ? "var(--success)" : "var(--danger)" }}>
                    {q.questionType === "mcq"
                      ? (answers[q.id] === q.correctAnswer ? `Correct (${q.marks} marks)` : `Incorrect — Answer: ${q.correctAnswer}`)
                      : `Model answer: ${q.correctAnswer}`}
                  </p>
                </div>
              ))}
            </div>
          ))}

          {/* AI marking response */}
          {(inlineResponse || isInlineLoading) && (
            <InlineResponsePanel response={inlineResponse ?? null} isLoading={isInlineLoading} onClose={() => {}} />
          )}

          <button className="secondary-button" type="button" onClick={() => {
            setStarted(false);
            setSubmitted(false);
            setAnswers({});
            setFlagged(new Set());
            setScores({});
            setTimeRemaining(timeLimitMinutes * 60);
          }}>
            Retake Exam
          </button>
        </div>
      </div>
    );
  }

  // Active exam
  const currentSection = sections[activeSection]!;
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;

  return (
    <div className="mock-exam-canvas">
      {/* Timer */}
      <div className={`mock-exam-timer${timeRemaining < 300 ? " warning" : ""}`}>
        <span>{title}</span>
        <span>{String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}</span>
        <button className="accent-button compact" type="button" onClick={handleSubmit}>
          Submit Exam
        </button>
      </div>

      {/* Section nav */}
      <div className="mock-exam-section-nav">
        {sections.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`mock-exam-section-tab${i === activeSection ? " active" : ""}`}
            onClick={() => setActiveSection(i)}
          >
            {s.title}
          </button>
        ))}
      </div>

      {/* Section instructions */}
      {currentSection.instructions && (
        <p style={{ fontSize: 13, color: "var(--ink-muted)", marginBottom: 12, fontStyle: "italic" }}>
          {currentSection.instructions}
        </p>
      )}

      {/* Questions */}
      {currentSection.questions.map((q, qi) => (
        <div key={q.id} className={`mock-exam-question-card${flagged.has(q.id) ? " flagged" : ""}`}>
          <div className="mock-exam-question-header">
            <span>Q{qi + 1} ({q.marks} mark{q.marks !== 1 ? "s" : ""})</span>
            <button
              type="button"
              className={`mock-exam-flag-btn${flagged.has(q.id) ? " flagged" : ""}`}
              onClick={() => setFlagged(prev => {
                const next = new Set(prev);
                if (next.has(q.id)) next.delete(q.id);
                else next.add(q.id);
                return next;
              })}
            >
              {flagged.has(q.id) ? "Flagged" : "Flag"}
            </button>
          </div>
          <p style={{ marginBottom: 8 }}>{q.prompt}</p>

          {q.questionType === "mcq" && q.options && (
            <div className="quiz-options-grid">
              {q.options.map((opt, oi) => (
                <button
                  key={oi}
                  type="button"
                  className={`quiz-option-card${answers[q.id] === opt ? " selected" : ""}`}
                  onClick={() => setAnswers(prev => ({ ...prev, [q.id]: opt }))}
                >
                  <span className="quiz-option-letter">{String.fromCharCode(65 + oi)}</span>
                  <span className="quiz-option-text">{opt}</span>
                </button>
              ))}
            </div>
          )}

          {q.questionType === "short_answer" && (
            <input
              type="text"
              className="mock-exam-short-input"
              placeholder="Your answer..."
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
            />
          )}

          {q.questionType === "essay" && (
            <textarea
              className="mock-exam-essay-input"
              placeholder="Write your answer..."
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ==================================================================
   INTERACTIVE CANVAS — Sandboxed HTML/JS interactive
   ================================================================== */

function InteractiveCanvas({ html, title }: { html: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Write HTML to iframe using srcdoc for full sandboxing
  const sanitizedHtml = useMemo(() => {
    // Ensure it's a complete document
    if (!html.includes("<!DOCTYPE") && !html.includes("<html")) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;color:#111;background:#f7f7f5;}</style></head><body>${html}</body></html>`;
    }
    return html;
  }, [html]);

  return (
    <div className={`interactive-canvas${isFullscreen ? " fullscreen" : ""}`}>
      <div className="interactive-toolbar">
        <span className="interactive-label">{title}</span>
        <button
          type="button"
          className="ghost-button compact"
          onClick={() => setIsFullscreen(v => !v)}
        >
          {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
        <button
          type="button"
          className="ghost-button compact"
          onClick={() => {
            if (iframeRef.current) {
              iframeRef.current.srcdoc = sanitizedHtml;
            }
          }}
        >
          Reset
        </button>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={sanitizedHtml}
        sandbox="allow-scripts"
        className="interactive-iframe"
        title={title}
      />
    </div>
  );
}

/* ==================================================================
   CITATION PILLS — Shared component
   ================================================================== */

function CitationPills({ citations }: { citations: CitationRef[] }) {
  if (citations.length === 0) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {citations.map((citation, i) => {
        const displayName = citation.relativePath
          ? cleanSourceName(citation.relativePath)
          : citation.sourceId;
        return (
          <span key={i} className="citation-pill" title={citation.excerpt}>
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8" />
            </svg>
            {displayName}
          </span>
        );
      })}
    </div>
  );
}

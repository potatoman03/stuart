import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { renderMermaidSvg } from "./study-doc/rendering";
import {
  DEFAULT_TASK_RUNTIME_PROFILE,
} from "@stuart/shared";
import type {
  ApprovalRecord,
  ArtifactDraft,
  ArtifactRecord,
  CreateProjectInput,
  CreateTaskInput,
  IngestionDocumentRecord,
  IngestionIndexStats,
  ProjectAttachment,
  ProjectLearningSummary,
  ProjectRecord,
  RuntimeProvider,
  StudyArtifactKind,
  StudyArtifactRecord,
  StudyTimelineEntry,
  TaskMessageRecord,
  TaskRuntimeProfile,
  TaskPerformanceBreakdown,
  TaskRunRecord,
  TaskSpec,
  TaskWorkerRecord,
  TopicPerformanceRecord,
  UpdateTaskInput,
  WorkspaceConfig,
  WorkspaceEvent,
  WorkspaceFileRecord,
  WorkspaceStartMode,
  IngestionSearchResult
} from "@stuart/shared";
import ArtifactCanvas from "./ArtifactCanvas";
import { ALL_DEMOS } from "./DemoArtifacts";
import type { DesktopCodexLoginState } from "./platform";
import { apiUrl, getDesktopBridge, openExternalUrl } from "./platform";
import PdfPreview from "./PdfPreview";
import {
  cleanFileReferences,
  cleanSourceName,
  extractCitationQueryText,
  FILE_REF_END,
  FILE_REF_MARKER,
  fileExtension,
  findBestCitationDocument,
  findBestSourcePath,
  findBestWorkspaceFile,
  normalizeSourcePathReference,
  parseFileReferenceMarker,
} from "./citation-utils";

/* ---- Types ---- */

type DashboardPayload = {
  vmStatus: {
    state: string;
    detail?: string;
  };
  projects: ProjectRecord[];
  tasks: TaskSpec[];
  diagnostics: SystemDiagnostics;
};

type DesktopBridgeState = {
  isDesktop: boolean;
  isPackaged: boolean;
  platform: string;
  appVersion: string;
  apiOrigin: string;
};

type SystemDiagnosticStatus = "ok" | "warn" | "error";

type SystemDiagnosticCheck = {
  id: string;
  label: string;
  status: SystemDiagnosticStatus;
  required: boolean;
  summary: string;
  detail?: string;
  command?: string;
  resolution?: string;
};

type SystemDiagnostics = {
  generatedAt: string;
  overallStatus: SystemDiagnosticStatus;
  requiredReady: boolean;
  checks: SystemDiagnosticCheck[];
};

type ThinkingState = {
  taskId: string;
  label: string;
  recentActions: string[];
};

type StreamingDelta = {
  taskId: string;
  itemId: string;
  text: string;
};

type SendMessageResponse = {
  userMessage: TaskMessageRecord;
  startedTurn: boolean;
};

type IngestionOverview = {
  stats: IngestionIndexStats;
  documents: IngestionDocumentRecord[];
};

type LibraryContextMenuState =
  | {
      kind: "project";
      projectId: string;
      projectName: string;
      x: number;
      y: number;
    }
  | {
      kind: "task";
      taskId: string;
      x: number;
      y: number;
    };

type LibraryContextMenuInput =
  | {
      kind: "project";
      projectId: string;
      projectName: string;
    }
  | {
      kind: "task";
      taskId: string;
    };

type AgentStatus = "running" | "completed" | "failed";

type AgentActivity = {
  id: string;
  label: string;
  status: AgentStatus;
  detail?: string;
  updatedAt: string;
  source: "codex" | "worker";
};

type WorkspaceSetupStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
};

type WorkspaceSetupState = {
  taskId: string | null;
  projectId: string | null;
  title: string;
  detail: string;
  steps: WorkspaceSetupStep[];
};

type WorkspacePreviewState = {
  title: string;
  relativePath: string;
  locator?: string;
  previewHref: string;
  previewKind: WorkspaceFileRecord["previewKind"];
};

/* ---- Constants ---- */

const STUDY_TOOL_PROMPTS: Record<string, string> = {
  flashcards: "Create flashcards for the current topic based on my study materials.",
  mindmap: "Create a mind map for the current topic based on my study materials.",
  quiz: "Create a quiz to test my understanding of the current topic.",
  diagram: "Create a diagram to visualize the key concepts from my study materials.",
  mock_exam: "Create a mock exam based on the past papers in my study folder. Analyze the exam format and generate new questions in the same style.",
  interactive: "Build me an interactive visualisation or simulation to help me understand the current topic.",
  study_doc: "Create a rich study document summarizing the current topic based on my materials.",
  custom: "Create a custom study artifact: "
};

const DEMO_KIND_ICONS: Record<string, string> = {
  flashcards: "Cards",
  quiz: "Quiz",
  mindmap: "Map",
  diagram: "Flow",
  mock_exam: "Exam",
  interactive: "App",
  study_doc: "Doc",
};

const DIAGNOSTICS_DISMISS_KEY = "stuart.dismissedDiagnostics.v1";
const WORKSPACE_SETUP_STEP_ORDER: Array<{ id: string; label: string }> = [
  { id: "folder", label: "Folder selected" },
  { id: "workspace", label: "Creating the workspace" },
  { id: "session", label: "Starting your first study session" },
  { id: "staging", label: "Staging files for Stuart" },
  { id: "reading", label: "Reading your materials" },
];

/* ---- Citation Context ---- */
type CitationSearchFn = (
  sourceName: string,
  sourcePath?: string | null,
  queryText?: string | null,
) => Promise<IngestionSearchResult[]>;
type CitationOpenFn = (relativePath: string, locator?: string) => void;
type WorkspaceFileResolveFn = (
  reference: string,
  sourcePath?: string | null,
) => Promise<WorkspaceFileRecord | null>;
type WorkspaceFileOpenFn = (
  reference: string,
  sourcePath?: string | null,
  locator?: string,
) => Promise<boolean>;
const CitationContext = createContext<CitationSearchFn | null>(null);
const CitationOpenContext = createContext<CitationOpenFn | null>(null);
const WorkspaceFileResolveContext = createContext<WorkspaceFileResolveFn | null>(null);
const WorkspaceFileOpenContext = createContext<WorkspaceFileOpenFn | null>(null);

/* ---- Helpers ---- */

function buildWorkspaceSetupSteps(activeId: string, completedIds: string[] = []): WorkspaceSetupStep[] {
  const completed = new Set(completedIds);
  return WORKSPACE_SETUP_STEP_ORDER.map((step) => ({
    ...step,
    status: completed.has(step.id) ? "done" : step.id === activeId ? "active" : "pending",
  }));
}

function dedupeCitationResults(results: IngestionSearchResult[]): IngestionSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.relativePath}::${result.locator ?? result.chunkId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Citation pills: show excerpt popover for PDFs/docs (including staged); only skip for inline previews. */
function citationPillShouldOpenWorkspaceDirectly(file: WorkspaceFileRecord): boolean {
  return file.previewKind === "image"
    || file.previewKind === "html"
    || file.previewKind === "jsx";
}

function iconForFileExtension(ext: string): string {
  return ext === "PDF"
    ? "picture_as_pdf"
    : ext === "PPTX" || ext === "PPT"
      ? "slideshow"
      : ext === "DOCX" || ext === "DOC"
        ? "description"
        : ext === "XLSX" || ext === "XLS"
          ? "table_chart"
          : ext === "ZIP"
            ? "folder_zip"
            : ext === "PNG" || ext === "JPG" || ext === "JPEG" || ext === "WEBP" || ext === "GIF" || ext === "SVG"
              ? "image"
              : ext === "HTML" || ext === "HTM" || ext === "JSX"
                ? "open_in_browser"
                : "draft";
}

/* ---- API Helper ---- */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const targetUrl = apiUrl(path);
  const method = (init?.method ?? "GET").toUpperCase();
  const maxAttempts = method === "GET" || method === "HEAD" ? 4 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!(init?.body instanceof FormData) && !(init?.body instanceof Blob) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const response = await fetch(targetUrl, {
        ...init,
        headers
      });

      if (!response.ok) {
        const message = await response.text();
        const error = new Error(message || `Request failed for ${targetUrl}`);
        const shouldRetry =
          attempt < maxAttempts &&
          (response.status >= 500 || response.status === 408 || response.status === 429);
        if (!shouldRetry) {
          throw error;
        }
        lastError = error;
      } else {
        if (response.status === 204) {
          return undefined as T;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return undefined as T;
        }

        return response.json() as Promise<T>;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        throw error;
      }
    }

    await new Promise((resolve) => window.setTimeout(resolve, attempt * 350));
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${targetUrl}`);
}

/* ================================================================
   App Component
   ================================================================ */

function App() {
  const desktopBridge = getDesktopBridge();
  const desktopState = useMemo<DesktopBridgeState>(() => ({
    isDesktop: Boolean(desktopBridge?.isDesktop),
    isPackaged: Boolean(desktopBridge?.isPackaged),
    platform: desktopBridge?.platform ?? "web",
    appVersion: desktopBridge?.appVersion ?? "1.0.1",
    apiOrigin:
      window.location.origin !== "null"
        ? window.location.origin
        : (desktopBridge?.apiOrigin ?? "http://127.0.0.1:8787"),
  }), [desktopBridge]);

  /* ---- Core State ---- */
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [taskRuns, setTaskRuns] = useState<Record<string, TaskRunRecord[]>>({});
  const [workersByTask, setWorkersByTask] = useState<Record<string, TaskWorkerRecord[]>>({});
  const [toolLogByTask, setToolLogByTask] = useState<Record<string, string[]>>({});
  const [agentActivityByTask, setAgentActivityByTask] = useState<Record<string, AgentActivity[]>>(
    {}
  );
  const [messagesByTask, setMessagesByTask] = useState<Record<string, TaskMessageRecord[]>>({});
  const [approvalsByRun, setApprovalsByRun] = useState<Record<string, ApprovalRecord[]>>({});
  const [artifactsByRun, setArtifactsByRun] = useState<Record<string, ArtifactRecord[]>>({});
  const [ingestionByScope, setIngestionByScope] = useState<Record<string, IngestionOverview>>({});
  const [workspaceFilesByScope, setWorkspaceFilesByScope] = useState<
    Record<string, WorkspaceFileRecord[]>
  >({});

  /* ---- Selection State ---- */
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [studyToolsCollapsed, setStudyToolsCollapsed] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [artifactFilter, setArtifactFilter] = useState<string | null>(null);

  /* ---- Theme State ---- */
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("stuart-theme") : null;
    return (saved === "dark" ? "dark" : "light");
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("stuart-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === "light" ? "dark" : "light");
  }, []);

  /* ---- UI State ---- */
  const [composerDraft, setComposerDraft] = useState("");
  const [composerImages, setComposerImages] = useState<string[]>([]);
  const [composerFiles, setComposerFiles] = useState<{ name: string; size: number; file: File }[]>([]);
  const [composerDragOver, setComposerDragOver] = useState(false);
  const [serverHealth, setServerHealth] = useState<"ok" | "degraded" | "down">("ok");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [streamingDelta, setStreamingDelta] = useState<StreamingDelta | null>(null);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [dismissedDiagnosticsFingerprint, setDismissedDiagnosticsFingerprint] = useState<string | null>(
    () => readDismissedDiagnosticsFingerprint()
  );
  const [workspaceSetup, setWorkspaceSetup] = useState<WorkspaceSetupState | null>(null);
  const workspaceSetupDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [onboardingState, setOnboardingState] = useState<{ projectId: string; path: string } | null>(null);

  /* ---- Study Artifacts State ---- */
  const [studyArtifacts, setStudyArtifacts] = useState<Record<string, StudyArtifactRecord[]>>({});
  const [openArtifact, setOpenArtifact] = useState<StudyArtifactRecord | null>(null);
  const [pendingDeleteArtifact, setPendingDeleteArtifact] = useState<{ id: string; title: string; taskId: string } | null>(null);
  const [openDemoArtifact, setOpenDemoArtifact] = useState<{ kind: StudyArtifactKind; title: string; payload: string } | null>(null);
  const [openWorkspacePreview, setOpenWorkspacePreview] = useState<WorkspacePreviewState | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [libraryContextMenu, setLibraryContextMenu] = useState<LibraryContextMenuState | null>(null);
  const libraryContextMenuRef = useRef<HTMLDivElement>(null);

  /* ---- Study Session Tracking ---- */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWorkspaceSetup = useCallback((delayMs = 0) => {
    if (workspaceSetupDismissTimerRef.current) {
      clearTimeout(workspaceSetupDismissTimerRef.current);
      workspaceSetupDismissTimerRef.current = null;
    }
    if (delayMs > 0) {
      workspaceSetupDismissTimerRef.current = setTimeout(() => {
        setWorkspaceSetup(null);
        workspaceSetupDismissTimerRef.current = null;
      }, delayMs);
      return;
    }
    setWorkspaceSetup(null);
  }, []);

  const startStudySession = useCallback(async (taskId: string, artifactId?: string) => {
    if (activeSessionId) return; // already in a session
    try {
      const res = await fetch(apiUrl(`/api/tasks/${taskId}/study-sessions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactIds: artifactId ? [artifactId] : [] }),
      });
      if (res.ok) {
        const session = await res.json();
        setActiveSessionId(session.id);
      }
    } catch { /* non-critical */ }
  }, [activeSessionId]);

  const endStudySession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await fetch(apiUrl(`/api/study-sessions/${activeSessionId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endedAt: new Date().toISOString() }),
      });
    } catch { /* non-critical */ }
    setActiveSessionId(null);
    if (sessionInactivityRef.current) {
      clearTimeout(sessionInactivityRef.current);
      sessionInactivityRef.current = null;
    }
  }, [activeSessionId]);

  const resetInactivityTimer = useCallback(() => {
    if (sessionInactivityRef.current) clearTimeout(sessionInactivityRef.current);
    sessionInactivityRef.current = setTimeout(() => {
      void endStudySession();
    }, 30 * 60 * 1000); // 30 min inactivity
  }, [endStudySession]);

  useEffect(() => {
    return () => {
      if (workspaceSetupDismissTimerRef.current) {
        clearTimeout(workspaceSetupDismissTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!libraryContextMenu) return;
    function handleMouseDown(event: MouseEvent) {
      if (libraryContextMenuRef.current && !libraryContextMenuRef.current.contains(event.target as Node)) {
        setLibraryContextMenu(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLibraryContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [libraryContextMenu]);

  // Start session when artifact opens (flashcard/quiz/mock_exam)
  useEffect(() => {
    const artifact = openArtifact;
    if (artifact && selectedTaskId && ["flashcards", "quiz", "mock_exam"].includes(artifact.kind)) {
      void startStudySession(selectedTaskId, artifact.id);
      resetInactivityTimer();
    }
    // End session when artifact closes
    return () => {
      // Handled by the onClose callback instead
    };
  }, [openArtifact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // End session on task switch
  useEffect(() => {
    void endStudySession();
  }, [selectedTaskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openLibraryContextMenu = useCallback((
    event: React.MouseEvent,
    menu: LibraryContextMenuInput
  ) => {
    event.preventDefault();
    const menuWidth = 196;
    const menuHeight = 112;
    const x = Math.max(12, Math.min(event.clientX, window.innerWidth - menuWidth - 12));
    const y = Math.max(12, Math.min(event.clientY, window.innerHeight - menuHeight - 12));
    setLibraryContextMenu({ ...menu, x, y });
  }, []);

  /* ---- Inline AI Response State ---- */
  const [inlineResponse, setInlineResponse] = useState<string | null>(null);
  const [isInlineLoading, setIsInlineLoading] = useState(false);
  const [desktopAuthPending, setDesktopAuthPending] = useState(false);
  const [desktopCodexLogin, setDesktopCodexLogin] = useState<DesktopCodexLoginState | null>(null);

  /* ---- Context Compaction State ---- */
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactionMessage, setCompactionMessage] = useState<string | null>(null);

  /* ---- Canvas Settings State ---- */
  const [showCanvasSettings, setShowCanvasSettings] = useState(false);

  /* ---- Artifact Resize State ---- */
  const [artifactPaneWidth, setArtifactPaneWidth] = useState(600);
  const [isArtifactResizing, setIsArtifactResizing] = useState(false);
  const artifactResizeRef = useRef(false);

  /* ---- Refs ---- */
  const threadRef = useRef<HTMLDivElement | null>(null);

  /* ---- Derived ---- */
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );

  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === (selectedTask?.projectId ?? selectedProjectId)) ??
      null,
    [projects, selectedProjectId, selectedTask]
  );

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects]
  );

  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.archivedAt),
    [tasks]
  );

  const selectedRuns = selectedTask ? taskRuns[selectedTask.id] ?? [] : [];

  const selectedMessages = useMemo(() => {
    if (!selectedTask) return [];
    return messagesByTask[selectedTask.id] ?? [];
  }, [messagesByTask, selectedTask]);

  // Group messages: consecutive system messages between user/assistant turns become a single activity group
  const visibleMessages = useMemo(() => {
    type VisibleItem = TaskMessageRecord | { role: "activity"; messages: TaskMessageRecord[]; id: string };
    return selectedMessages.filter((msg) => {
      if (msg.role === "system") return false;
      // Hide memory extraction responses (raw JSON arrays from ephemeral threads)
      if (msg.role === "assistant") {
        const t = msg.content.trim();
        if (t.startsWith("[") && t.includes("scope_type") && t.includes("memory_key")) return false;
        if (t === "[]") return false;
      }
      return true;
    });
  }, [selectedMessages]);

  const selectedWorkspaceScopeKey = selectedTask
    ? buildWorkspaceScopeKey(selectedTask.id, selectedRunId)
    : null;
  const selectedIngestion = selectedWorkspaceScopeKey
    ? ingestionByScope[selectedWorkspaceScopeKey] ?? null
    : null;
  const selectedWorkspaceFiles = selectedWorkspaceScopeKey
    ? workspaceFilesByScope[selectedWorkspaceScopeKey] ?? []
    : [];

  const turnInFlight = Boolean(selectedTask && thinkingState?.taskId === selectedTask.id);
  const isStreaming = Boolean(
    streamingDelta && selectedTask && streamingDelta.taskId === selectedTask.id
  );
  const selectedStudyArtifacts = selectedTask ? studyArtifacts[selectedTask.id] ?? [] : [];

  // Review data: weak topics + cards due
  const [reviewData, setReviewData] = useState<{
    weakTopics: Array<{ topic: string; totalAttempts: number; correctCount: number }>;
    cardsDue: number;
    loaded: boolean;
  }>({ weakTopics: [], cardsDue: 0, loaded: false });
  const diagnosticsFingerprint = diagnostics ? buildDiagnosticsFingerprint(diagnostics) : null;
  const diagnosticsDismissed = Boolean(
    diagnosticsFingerprint && diagnosticsFingerprint === dismissedDiagnosticsFingerprint
  );

  // Group artifacts by kind
  const groupedArtifacts = useMemo(() => {
    const groups: Record<string, StudyArtifactRecord[]> = {
      study_doc: [],
      flashcards: [],
      quiz: [],
      mindmap: [],
      diagram: [],
      mock_exam: [],
      interactive: [],
      document_docx: [],
      document_xlsx: [],
      document_pptx: [],
      document_pdf: [],
      other: [],
    };
    for (const artifact of selectedStudyArtifacts) {
      const key = groups[artifact.kind] ? artifact.kind : "other";
      groups[key]!.push(artifact);
    }
    return groups;
  }, [selectedStudyArtifacts]);

  const isArtifactOpen = !!(openArtifact || openDemoArtifact || openWorkspacePreview);
  const codexCliCheck = diagnostics?.checks.find((check) => check.id === "codex-cli") ?? null;
  const codexAuthCheck = diagnostics?.checks.find((check) => check.id === "codex-auth") ?? null;

  const dismissDiagnostics = useCallback(() => {
    if (!diagnosticsFingerprint) {
      return;
    }
    setDismissedDiagnosticsFingerprint(diagnosticsFingerprint);
    writeDismissedDiagnosticsFingerprint(diagnosticsFingerprint);
  }, [diagnosticsFingerprint]);

  const restoreDiagnostics = useCallback(() => {
    setDismissedDiagnosticsFingerprint(null);
    writeDismissedDiagnosticsFingerprint(null);
  }, []);

  /* ---- Data Loaders ---- */

  const refreshDashboard = useCallback(async () => {
    try {
      const payload = await request<DashboardPayload>("/api/dashboard");
      const runs = Object.fromEntries(
        await Promise.all(
          payload.tasks.map(async (task) => [
            task.id,
            await request<TaskRunRecord[]>(`/api/tasks/${task.id}/runs`)
          ] as const)
        )
      );

      const nextTask =
        payload.tasks.find((task) => task.id === selectedTaskId) ??
        payload.tasks.find((task) => task.projectId === selectedProjectId) ??
        payload.tasks[0] ??
        null;
      const nextProjectId =
        nextTask?.projectId ?? selectedProjectId ?? payload.projects[0]?.id ?? null;
      const nextRunId =
        nextTask && runs[nextTask.id]
          ? runs[nextTask.id]?.find((run) => run.id === selectedRunId)?.id ??
            runs[nextTask.id]?.[0]?.id ??
            null
          : null;

      setError(null);
      setProjects(payload.projects);
      setTasks(payload.tasks);
      setDiagnostics(payload.diagnostics ?? null);
      setTaskRuns(runs);
      setWorkersByTask((cur) => pruneRecord(cur, payload.tasks.map((t) => t.id)));
      setAgentActivityByTask((cur) => pruneRecord(cur, payload.tasks.map((t) => t.id)));
      setSelectedProjectId(nextProjectId);
      // Don't override task selection while onboarding is active — the user
      // hasn't finished configuring their new workspace yet.
      setOnboardingState((current) => {
        if (!current) {
          setSelectedTaskId(nextTask?.id ?? null);
          setSelectedRunId(nextRunId);
        }
        return current;
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Failed to load workspace dashboard";
      if (message.includes("/api/dashboard") || message === "Failed to fetch") {
        setError(
          desktopState.isDesktop
            ? "Stuart's local study runtime isn't responding."
            : "The local Stuart API is not ready yet. Wait a second and refresh, or restart with `pnpm dev`."
        );
        return;
      }
      setError(message);
    }
  }, [desktopState.isDesktop, selectedTaskId, selectedProjectId, selectedRunId]);

  const refreshDesktopCodexLoginState = useCallback(async () => {
    if (!desktopBridge?.getCodexLoginState) {
      return;
    }

    try {
      const nextState = await desktopBridge.getCodexLoginState();
      setDesktopCodexLogin(nextState);
    } catch {
      // Ignore desktop login polling errors; diagnostics refresh remains the source of truth.
    }
  }, [desktopBridge]);

  const openCodexHelp = useCallback(async () => {
    await openExternalUrl("https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt");
  }, []);

  const startDesktopCodexLogin = useCallback(async () => {
    if (!desktopBridge?.startCodexLogin) {
      await openCodexHelp();
      return;
    }

    try {
      setBusy("codex-login");
      setDesktopAuthPending(true);
      const opened = await desktopBridge.startCodexLogin();
      if (!opened) {
        setDesktopAuthPending(false);
        await openCodexHelp();
      } else {
        await refreshDesktopCodexLoginState();
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not start ChatGPT sign-in");
      setDesktopAuthPending(false);
    } finally {
      setBusy(null);
      void refreshDashboard();
    }
  }, [desktopBridge, openCodexHelp, refreshDashboard, refreshDesktopCodexLoginState]);

  const searchCitation = useCallback(async (
    sourceName: string,
    sourcePath?: string | null,
    queryText?: string | null,
  ): Promise<IngestionSearchResult[]> => {
    if (!selectedTaskId) return [];
    try {
      let docs = selectedIngestion?.documents ?? [];
      let workspaceFiles = selectedWorkspaceFiles;
      const scopeParams = new URLSearchParams();
      if (selectedRunId) {
        scopeParams.set("taskRunId", selectedRunId);
      }

      if (docs.length === 0) {
        const path = scopeParams.size
          ? `/api/tasks/${selectedTaskId}/ingestion?${scopeParams.toString()}`
          : `/api/tasks/${selectedTaskId}/ingestion`;
        const refreshedOverview = await request<IngestionOverview>(path);
        docs = refreshedOverview.documents ?? [];
      }

      if (workspaceFiles.length === 0) {
        const path = scopeParams.size
          ? `/api/tasks/${selectedTaskId}/workspace-files?${scopeParams.toString()}`
          : `/api/tasks/${selectedTaskId}/workspace-files`;
        workspaceFiles = await request<WorkspaceFileRecord[]>(path);
      }

      const normalizedSourcePath = sourcePath ? normalizeSourcePathReference(sourcePath) : "";
      const normalizedQueryText = queryText?.replace(/\s+/g, " ").trim() ?? "";
      const matchedWorkspaceFile = findBestWorkspaceFile(
        sourceName,
        workspaceFiles,
        sourcePath,
      );
      const bestDoc =
        (normalizedSourcePath
          ? docs.find((doc) => {
              const normalizedRelativePath = normalizeSourcePathReference(doc.relativePath);
              return normalizedRelativePath === normalizedSourcePath
                || normalizedRelativePath.endsWith(`/${normalizedSourcePath}`);
            }) ?? null
          : null)
        ?? findBestCitationDocument(sourceName, docs);
      const candidateSourcePaths = [...new Set([
        normalizedSourcePath || null,
        bestDoc?.relativePath ?? null,
        matchedWorkspaceFile?.relativePath ?? null,
        findBestSourcePath(sourceName, docs.map((doc) => doc.relativePath)),
        findBestSourcePath(sourceName, workspaceFiles.map((file) => file.relativePath)),
      ].filter((value): value is string => Boolean(value)))];

      const requestScopedSearch = async (source: string, q: string) => {
        const searchParams = new URLSearchParams(scopeParams);
        searchParams.set("q", q);
        searchParams.set("source", source);
        searchParams.set("limit", "8");
        return dedupeCitationResults(await request<IngestionSearchResult[]>(
          `/api/tasks/${selectedTaskId}/ingestion/search?${searchParams.toString()}`
        ));
      };

      const requestSourceChunks = async (source: string) => {
        const chunkParams = new URLSearchParams(scopeParams);
        chunkParams.set("source", source);
        chunkParams.set("limit", "5");
        return dedupeCitationResults(await request<IngestionSearchResult[]>(
          `/api/tasks/${selectedTaskId}/ingestion/chunks?${chunkParams.toString()}`
        ));
      };

      for (const source of candidateSourcePaths) {
        if (normalizedQueryText) {
          const searchResults = await requestScopedSearch(source, normalizedQueryText);
          if (searchResults.length > 0) {
            return searchResults.slice(0, 3);
          }
        }

        const chunks = await requestSourceChunks(source);
        if (chunks.length > 0) {
          return chunks.slice(0, 3);
        }
      }

      if (normalizedQueryText) {
        const searchParams = new URLSearchParams(scopeParams);
        searchParams.set("q", normalizedQueryText);
        searchParams.set("limit", "8");
        const queryResults = dedupeCitationResults(await request<IngestionSearchResult[]>(
          `/api/tasks/${selectedTaskId}/ingestion/search?${searchParams.toString()}`
        ));
        const bestPath = findBestSourcePath(
          sourceName,
          [...new Set(queryResults.map((result) => result.relativePath))],
        );
        if (bestPath) {
          const matchedResults = queryResults.filter((result) => result.relativePath === bestPath);
          if (matchedResults.length > 0) {
            return matchedResults.slice(0, 3);
          }
          const chunks = await requestSourceChunks(bestPath);
          if (chunks.length > 0) {
            return chunks.slice(0, 3);
          }
        }
        if (queryResults.length > 0) {
          return queryResults.slice(0, 3);
        }
      }

      if (candidateSourcePaths.length > 0) {
        for (const source of candidateSourcePaths) {
          const chunks = await requestSourceChunks(source);
          if (chunks.length > 0) {
            return chunks.slice(0, 3);
          }
        }
        return [];
      }

      const searchParams = new URLSearchParams(scopeParams);
      searchParams.set("q", normalizedQueryText || sourceName);
      searchParams.set("limit", "8");
      const results = dedupeCitationResults(await request<IngestionSearchResult[]>(
        `/api/tasks/${selectedTaskId}/ingestion/search?${searchParams.toString()}`
      ));
      const bestPath = findBestSourcePath(
        sourceName,
        [...new Set(results.map((result) => result.relativePath))],
      );
      return bestPath
        ? results.filter((result) => result.relativePath === bestPath).slice(0, 3)
        : [];
    } catch {
      return [];
    }
  }, [selectedTaskId, selectedIngestion, selectedRunId, selectedWorkspaceFiles]);

  const resolveWorkspaceFileReference = useCallback(async (
    reference: string,
    sourcePath?: string | null,
  ): Promise<WorkspaceFileRecord | null> => {
    if (!selectedTaskId) {
      return null;
    }

    let workspaceFiles = selectedWorkspaceFiles;
    if (workspaceFiles.length === 0) {
      const scopeParams = new URLSearchParams();
      if (selectedRunId) {
        scopeParams.set("taskRunId", selectedRunId);
      }
      const path = scopeParams.size
        ? `/api/tasks/${selectedTaskId}/workspace-files?${scopeParams.toString()}`
        : `/api/tasks/${selectedTaskId}/workspace-files`;
      workspaceFiles = await request<WorkspaceFileRecord[]>(path);
      setWorkspaceFilesByScope((cur) => ({
        ...cur,
        [buildWorkspaceScopeKey(selectedTaskId, selectedRunId ?? null)]: workspaceFiles,
      }));
    }

    return findBestWorkspaceFile(reference, workspaceFiles, sourcePath);
  }, [selectedTaskId, selectedRunId, selectedWorkspaceFiles]);

  const openWorkspaceFileReference = useCallback(async (
    reference: string,
    sourcePath?: string | null,
    locator?: string,
  ): Promise<boolean> => {
    if (!selectedTaskId) return false;
    const matchedFile = await resolveWorkspaceFileReference(reference, sourcePath);
    if (!matchedFile) return false;

    const search = new URLSearchParams();
    if (selectedRunId) search.set("taskRunId", selectedRunId);
    if (locator) search.set("locator", locator);
    const query = search.toString();
    const baseHref = apiUrl(
      `/api/tasks/${selectedTaskId}/workspace-files/${matchedFile.id}/preview${query ? `?${query}` : ""}`
    );
    const pageMatch = locator?.match(/^page\s+(\d+)$/i);
    const slideMatch = locator?.match(/^slide\s+(\d+)$/i);
    const previewHref =
      matchedFile.previewKind === "pdf" && pageMatch
        ? `${baseHref}#page=${pageMatch[1]}`
        : matchedFile.previewKind === "pptx" && slideMatch
          ? `${baseHref}#page=${slideMatch[1]}`
        : baseHref;

    setOpenArtifact(null);
    setOpenDemoArtifact(null);
    setOpenWorkspacePreview({
      title: cleanSourceName(matchedFile.relativePath),
      relativePath: matchedFile.relativePath,
      locator,
      previewHref,
      previewKind: matchedFile.previewKind,
    });
    return true;
  }, [resolveWorkspaceFileReference, selectedTaskId, selectedRunId]);

  const openCitationSource = useCallback((relativePath: string, locator?: string) => {
    void openWorkspaceFileReference(relativePath, relativePath, locator);
  }, [openWorkspaceFileReference]);

  async function loadMessages(taskId: string) {
    try {
      const messages = await request<TaskMessageRecord[]>(`/api/tasks/${taskId}/messages`);
      setMessagesByTask((cur) => ({ ...cur, [taskId]: messages }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to load conversation");
    }
  }

  async function loadTaskWorkers(taskId: string) {
    try {
      const workers = await request<TaskWorkerRecord[]>(`/api/tasks/${taskId}/workers`);
      setWorkersByTask((cur) => ({ ...cur, [taskId]: workers }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    }
  }

  async function loadRunContext(taskRunId: string) {
    try {
      const [approvals, artifacts] = await Promise.all([
        request<ApprovalRecord[]>(`/api/task-runs/${taskRunId}/approvals`),
        request<ArtifactRecord[]>(`/api/task-runs/${taskRunId}/artifacts`)
      ]);
      setApprovalsByRun((cur) => ({ ...cur, [taskRunId]: approvals }));
      setArtifactsByRun((cur) => ({ ...cur, [taskRunId]: artifacts }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    }
  }

  async function loadIngestionOverview(taskId: string, taskRunId?: string) {
    try {
      const search = new URLSearchParams();
      if (taskRunId) search.set("taskRunId", taskRunId);
      const path = search.size
        ? `/api/tasks/${taskId}/ingestion?${search.toString()}`
        : `/api/tasks/${taskId}/ingestion`;
      const overview = await request<IngestionOverview>(path);
      setIngestionByScope((cur) => ({
        ...cur,
        [buildWorkspaceScopeKey(taskId, taskRunId ?? null)]: overview
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    }
  }

  async function loadWorkspaceFiles(taskId: string, taskRunId?: string) {
    try {
      const search = new URLSearchParams();
      if (taskRunId) search.set("taskRunId", taskRunId);
      const path = search.size
        ? `/api/tasks/${taskId}/workspace-files?${search.toString()}`
        : `/api/tasks/${taskId}/workspace-files`;
      const files = await request<WorkspaceFileRecord[]>(path);
      setWorkspaceFilesByScope((cur) => ({
        ...cur,
        [buildWorkspaceScopeKey(taskId, taskRunId ?? null)]: files,
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    }
  }

  async function loadStudyArtifacts(taskId: string) {
    try {
      const artifacts = await request<StudyArtifactRecord[]>(
        `/api/tasks/${taskId}/study-artifacts`
      );
      setStudyArtifacts((cur) => ({ ...cur, [taskId]: artifacts }));
    } catch {
      // study-artifacts endpoint may not exist yet; silently ignore
    }
  }

  async function deleteStudyArtifact(artifactId: string, taskId: string) {
    try {
      await request(`/api/study-artifacts/${artifactId}`, { method: "DELETE" });
      setStudyArtifacts((cur) => ({
        ...cur,
        [taskId]: (cur[taskId] ?? []).filter((a) => a.id !== artifactId),
      }));
      if (openArtifact?.id === artifactId) {
        setOpenArtifact(null);
      }
    } catch (err) {
      console.error("Failed to delete artifact:", err);
    }
  }

  async function pickFolder(prompt: string): Promise<string | null> {
    try {
      setBusy("folder");
      if (desktopBridge?.pickFolder) {
        return await desktopBridge.pickFolder();
      }
      const payload = await request<{ path: string | null }>("/api/dialogs/folder", {
        method: "POST",
        body: JSON.stringify({ prompt })
      });
      return payload.path ?? null;
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not open folder picker");
      return null;
    } finally {
      setBusy(null);
    }
  }

  /* ---- Effects ---- */

  useEffect(() => {
    void refreshDashboard().catch(() => {});
  }, []);

  // Fetch review data when project changes
  useEffect(() => {
    if (!selectedProject?.id) return;
    let alive = true;
    (async () => {
      try {
        const [weakRes, summaryRes] = await Promise.all([
          fetch(apiUrl(`/api/projects/${selectedProject.id}/weak-topics`)).then((r) => r.ok ? r.json() : []),
          fetch(apiUrl(`/api/projects/${selectedProject.id}/learning-summary`)).then((r) => r.ok ? r.json() : null),
        ]);
        if (alive) {
          setReviewData({
            weakTopics: weakRes as any[],
            cardsDue: (summaryRes as any)?.cardsDue ?? 0,
            loaded: true,
          });
        }
      } catch {
        if (alive) setReviewData({ weakTopics: [], cardsDue: 0, loaded: true });
      }
    })();
    return () => { alive = false; };
  }, [selectedProject?.id, openArtifact]); // refresh after closing an artifact (might have studied)

  // Health polling — check server status every 15s
  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(5000) });
        if (alive) setServerHealth(res.ok ? "ok" : "degraded");
      } catch {
        if (alive) setServerHealth("down");
      }
    }
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!desktopState.isDesktop) {
      return;
    }

    void refreshDesktopCodexLoginState();
  }, [desktopState.isDesktop, refreshDesktopCodexLoginState]);

  useEffect(() => {
    if (!desktopAuthPending) {
      return;
    }

    if (codexAuthCheck?.status === "ok") {
      setDesktopAuthPending(false);
      return;
    }

    if (desktopCodexLogin?.status === "error") {
      setDesktopAuthPending(false);
      return;
    }

    const timer = window.setInterval(() => {
      void refreshDashboard();
      void refreshDesktopCodexLoginState();
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    codexAuthCheck?.status,
    desktopAuthPending,
    desktopCodexLogin?.status,
    refreshDashboard,
    refreshDesktopCodexLoginState,
  ]);

  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      es = new EventSource(apiUrl("/api/events"));
      es.onmessage = (event) => {
        const payload = JSON.parse(event.data) as WorkspaceEvent;
        void handleWorkspaceEvent(payload);
      };
      es.onerror = () => {
        es?.close();
        es = null;
        // Auto-reconnect after 2s
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    // Also reconnect when the tab regains focus (covers sleep/idle)
    function onVisibilityChange() {
      if (document.visibilityState === "visible" && !es) {
        connect();
      }
      // Refresh messages on tab focus to catch anything missed
      if (document.visibilityState === "visible" && selectedTaskId) {
        void loadMessages(selectedTaskId);
        void loadStudyArtifacts(selectedTaskId);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      es?.close();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [selectedProjectId, selectedRunId, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) return;
    void loadMessages(selectedTaskId);
    void loadTaskWorkers(selectedTaskId);
    void loadStudyArtifacts(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTask) {
      setSelectedRunId(null);
      return;
    }
    const nextRun =
      selectedRuns.find((run) => run.id === selectedRunId) ?? selectedRuns[0] ?? null;
    if (nextRun?.id !== selectedRunId) {
      setSelectedRunId(nextRun?.id ?? null);
    }
  }, [selectedRunId, selectedRuns, selectedTask]);

  useEffect(() => {
    if (!selectedRunId) return;
    void loadRunContext(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedTask) return;
    void loadIngestionOverview(selectedTask.id, selectedRunId ?? undefined);
    void loadWorkspaceFiles(selectedTask.id, selectedRunId ?? undefined);
  }, [selectedTask, selectedRunId]);

  useEffect(() => {
    setOpenWorkspacePreview(null);
  }, [selectedTaskId, selectedRunId]);

  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distanceFromBottom > 150;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!threadRef.current || userScrolledUpRef.current) return;
    threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [selectedTaskId, selectedRunId, thinkingState, messagesByTask, streamingDelta]);

  // Reset scroll lock when switching tasks
  useEffect(() => {
    userScrolledUpRef.current = false;
  }, [selectedTaskId, selectedRunId]);

  // Polling fallback: when thinking is active, poll for messages every 3s
  // This catches cases where SSE events are missed (stale connection, tab sleep, etc.)
  useEffect(() => {
    if (!thinkingState || !selectedTaskId) return;
    const taskId = selectedTaskId;
    const interval = setInterval(async () => {
      try {
        const msgs = await request<TaskMessageRecord[]>(`/api/tasks/${taskId}/messages`);
        const lastMsg = msgs[msgs.length - 1];
        // If the last message is an assistant response newer than the thinking state start,
        // the turn has completed and we missed the SSE event
        if (lastMsg && lastMsg.role === "assistant") {
          setMessagesByTask((cur) => ({ ...cur, [taskId]: msgs }));
          setThinkingState(null);
          setStreamingDelta(null);
          setBusy(null);
          setIsInlineLoading(false);
          void loadStudyArtifacts(taskId);
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [thinkingState, selectedTaskId]);

  /* ---- Artifact Pane Resize ---- */
  useEffect(() => {
    if (!isArtifactResizing) return;
    function onMove(e: MouseEvent) {
      const nextWidth = window.innerWidth - e.clientX - 12;
      setArtifactPaneWidth(Math.max(360, Math.min(nextWidth, window.innerWidth * 0.6)));
    }
    function onUp() {
      artifactResizeRef.current = false;
      setIsArtifactResizing(false);
      document.body.style.cursor = "";
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isArtifactResizing]);

  /* ---- Event Handler ---- */

  async function handleWorkspaceEvent(event: WorkspaceEvent) {
    switch (event.type) {
      case "connected":
        return;

      case "project.created":
      case "task.created":
      case "task.updated":
        await refreshDashboard();
        return;

      case "task.run":
        setWorkspaceSetup((current) => {
          if (!current || current.taskId !== event.taskId) {
            return current;
          }
          return {
            ...current,
            detail: "Workspace staged. Stuart can answer right away while it warms the local index in the background.",
            steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging"]),
          };
        });
        await refreshDashboard();
        if (event.taskRunId === selectedRunId || event.taskId === selectedTaskId) {
          await loadRunContext(event.taskRunId);
          await loadIngestionOverview(event.taskId, event.taskRunId);
        }
        return;

      case "task.approval":
        if (event.taskRunId === selectedRunId) {
          // Auto-approve all approvals silently for students
          try {
            await request<ApprovalRecord>(
              `/api/task-runs/${event.taskRunId}/approvals/${event.approvalId}`,
              { method: "PATCH", body: JSON.stringify({ status: "approved" }) }
            );
          } catch {
            // If auto-approve fails, just reload context
          }
          await loadRunContext(event.taskRunId);
        }
        return;

      case "task.message":
        if (event.taskId === selectedTaskId) {
          await loadMessages(event.taskId);
          void loadStudyArtifacts(event.taskId);
        }
        return;

      case "task.worker":
        await loadTaskWorkers(event.taskId);
        return;

      case "task.agent":
        setAgentActivityByTask((cur) => ({
          ...cur,
          [event.taskId]: upsertAgentActivity(cur[event.taskId] ?? [], {
            id: event.agentId,
            label: event.label,
            status: event.status,
            detail: event.detail,
            updatedAt: new Date().toISOString(),
            source: "codex"
          })
        }));
        return;

      case "codex.turn.started":
        setWorkspaceSetup((current) => {
          if (!current || current.taskId !== event.taskId) {
            return current;
          }
          return {
            ...current,
            detail: "Stuart has started reading your materials and is drafting the first overview now.",
            steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging"]),
          };
        });
        setThinkingState({ taskId: event.taskId, label: "Stuart is thinking...", recentActions: [] });
        setToolLogByTask((cur) => ({ ...cur, [event.taskId]: [] }));
        setStreamingDelta(null);
        return;

      case "codex.thinking": {
        const newLabel = event.label || "Analyzing your materials...";
        setWorkspaceSetup((current) => {
          if (!current || current.taskId !== event.taskId) {
            return current;
          }
          return {
            ...current,
            detail: newLabel === "Stuart is thinking..."
              ? current.detail
              : newLabel,
            steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging"]),
          };
        });
        setThinkingState((cur) => {
          const prev = cur?.taskId === event.taskId ? cur.recentActions : [];
          const updated = cur && cur.label !== newLabel && cur.label !== "Stuart is thinking..."
            ? [...prev, cur.label].slice(-5)
            : prev;
          return { taskId: event.taskId, label: newLabel, recentActions: updated };
        });
        // Also accumulate into the inline tool log (skip generic labels)
        if (newLabel !== "Stuart is thinking..." && newLabel !== "Analyzing your materials..." && newLabel !== "Working..." && newLabel !== "Processing results...") {
          setToolLogByTask((cur) => {
            const prev = cur[event.taskId] ?? [];
            // Don't add duplicates
            if (prev.length > 0 && prev[prev.length - 1] === newLabel) return cur;
            return { ...cur, [event.taskId]: [...prev, newLabel] };
          });
        }
        return;
      }

      case "codex.message.delta":
        setStreamingDelta((cur) => {
          if (cur && cur.taskId === event.taskId && cur.itemId === event.itemId) {
            return { ...cur, text: cur.text + event.delta };
          }
          return { taskId: event.taskId, itemId: event.itemId, text: event.delta };
        });
        // Accumulate inline response when artifact pane is open
        if (isInlineLoading) {
          setInlineResponse((cur) => (cur ?? "") + event.delta);
        }
        return;

      case "codex.message.completed":
        setWorkspaceSetup((current) => {
          if (!current || current.taskId !== event.taskId) {
            return current;
          }
          return {
            ...current,
            title: "Workspace ready",
            detail: "Your first overview is ready. Background indexing can keep warming while you keep studying.",
            steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging", "reading"]),
          };
        });
        clearWorkspaceSetup(1600);
        setThinkingState((cur) => (cur?.taskId === event.taskId ? null : cur));
        setStreamingDelta((cur) => (cur?.taskId === event.taskId ? null : cur));
        setToolLogByTask((cur) => ({ ...cur, [event.taskId]: [] }));
        setMessagesByTask((cur) => ({
          ...cur,
          [event.taskId]: upsertMessage(cur[event.taskId] ?? [], event.message)
        }));
        return;

      case "codex.turn.completed":
        setWorkspaceSetup((current) => {
          if (!current || current.taskId !== event.taskId) {
            return current;
          }
          return {
            ...current,
            title: event.status === "failed" ? "Workspace still open" : "Workspace ready",
            detail: event.status === "failed"
              ? (event.error ?? "The first pass hit a problem, but your workspace is still open and Stuart can keep working from the local files.")
              : "Stuart finished the first pass over your materials.",
            steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging", "reading"]),
          };
        });
        clearWorkspaceSetup(event.status === "failed" ? 3_000 : 1600);
        setThinkingState((cur) => (cur?.taskId === event.taskId ? null : cur));
        setStreamingDelta((cur) => (cur?.taskId === event.taskId ? null : cur));
        setIsInlineLoading(false);
        // Reload messages and study artifacts after turn completes (artifacts may have been detected)
        if (event.taskId === selectedTaskId) {
          void loadMessages(event.taskId);
          void loadStudyArtifacts(event.taskId);
        }
        if (event.status === "failed") {
          setError(event.error ?? "Stuart ran into a problem. Try again.");
          await loadMessages(event.taskId);
        }
        return;

      case "task.context_compacting":
        if (event.taskId === selectedTaskId) {
          setIsCompacting(event.active);
          setCompactionMessage(event.message);
        }
        return;
    }
  }

  /* ---- Actions ---- */

  async function continueWorkspaceSetup(projectId: string, path: string, config?: WorkspaceConfig) {
    try {
      setBusy("add-materials");
      setOnboardingState(null);
      const runtimeProfile = resolveWorkspaceRuntimeProfile(config);
      const startMode = resolveWorkspaceStartMode(config);

      setWorkspaceSetup({
        taskId: null,
        projectId,
        title: "Preparing your workspace",
        detail: startMode === "guided"
          ? "Workspace created. Stuart is starting a guided first pass now."
          : "Workspace created. Stuart is preparing a direct start so you can jump in faster.",
        steps: buildWorkspaceSetupSteps("session", ["folder", "workspace"]),
      });

      // Build objective and initial message based on config
      const taskTitle = `Study: ${inferProjectName(path)}`;
      let objective = "Help me study and understand the materials in this folder. I may ask you to create flashcards, quizzes, mind maps, and summaries.";
      let initialMessage = startMode === "guided"
        ? "I just added my study materials. Please read through everything and give me a brief overview of what's in there. For this first reply, just give me a concise high-level summary of the workspace and then ask me what I'd like to focus on."
        : "I just added my study materials. Do a quiet first pass of the workspace so you understand the folder structure and core materials. For this first reply, do not summarize everything. Just confirm in one concise sentence that you're ready, mention the subject or folder theme if it's obvious, and ask what I want to work on first.";

      if (config) {
        const objectiveParts: string[] = [];
        const startupParts: string[] = [];
        if (config.subject) {
          objectiveParts.push(`The subject is ${config.subject}.`);
          startupParts.push(`The subject is ${config.subject}.`);
        }
        if (config.goal) {
          objectiveParts.push(`My goal is: ${config.goal}.`);
          startupParts.push(`My goal is: ${config.goal}.`);
        }
        if (config.teachingStyle) {
          objectiveParts.push(`I prefer a ${config.teachingStyle.toLowerCase()} teaching style.`);
        }
        if (config.additionalNotes) {
          objectiveParts.push(config.additionalNotes);
          startupParts.push(config.additionalNotes);
        }
        if (objectiveParts.length > 0 || startupParts.length > 0) {
          const objectiveContext = objectiveParts.length > 0 ? `${objectiveParts.join(" ")} ` : "";
          const startupContext = startupParts.length > 0 ? `${startupParts.join(" ")} ` : "";
          objective = `Help me study and understand the materials in this folder. ${objectiveContext}I may ask you to create flashcards, quizzes, mind maps, and summaries.`;
          initialMessage = `I just added my study materials. ${startupContext}Please read through everything and give me a brief overview of what's in there. For this first reply, just give me a concise high-level summary of the workspace and then ask me what I'd like to focus on.`;
        }
      }

      const created = await request<TaskSpec>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          title: taskTitle,
          objective,
          runtimeProfile,
          attachments: [
            { id: crypto.randomUUID(), hostPath: path, mode: "reference" as const }
          ],
          browserEnabled: false,
          authMode: runtimeProfile.authMode
        } satisfies CreateTaskInput)
      });

      setSelectedTaskId(created.id);
      setSelectedRunId(null);
      setWorkspaceSetup({
        taskId: created.id,
        projectId: created.projectId,
        title: "Preparing your workspace",
        detail: startMode === "guided"
          ? "Stuart is staging your files for a grounded first pass."
          : "Stuart is staging your files so the workspace is ready before you ask the first question.",
        steps: buildWorkspaceSetupSteps("staging", ["folder", "workspace", "session"]),
      });

      // Send the initial ingest message
      setThinkingState({ taskId: created.id, label: "Analyzing your materials...", recentActions: [] });

      const result = await request<SendMessageResponse>(`/api/tasks/${created.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: initialMessage })
      });

      setMessagesByTask((cur) => ({
        ...cur,
        [created.id]: [...(cur[created.id] ?? []), result.userMessage]
      }));

      if (!result.startedTurn) {
        setThinkingState((cur) => (cur?.taskId === created.id ? null : cur));
        setWorkspaceSetup({
          taskId: created.id,
          projectId: created.projectId,
          title: "Workspace ready",
          detail: "Your workspace is ready. Stuart did not need to start a longer first pass for this folder.",
          steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging", "reading"]),
        });
        clearWorkspaceSetup(1600);
      } else {
        setWorkspaceSetup({
          taskId: created.id,
          projectId: created.projectId,
          title: "Preparing your workspace",
          detail: startMode === "guided"
            ? "Stuart has started the guided first reading pass. You can begin asking questions while background indexing warms up."
            : "Stuart has started a quiet readiness pass. You can begin asking questions while background indexing warms up.",
          steps: buildWorkspaceSetupSteps("reading", ["folder", "workspace", "session", "staging"]),
        });
      }

      await refreshDashboard();
      setSelectedProjectId(created.projectId);
      setSelectedTaskId(created.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not add materials");
    } finally {
      setBusy(null);
    }
  }

  async function handleAddStudyMaterials() {
    const path = await pickFolder("Choose a folder with your study materials");
    if (!path) return;

    try {
      setBusy("add-materials");
      clearWorkspaceSetup();
      setWorkspaceSetup({
        taskId: null,
        projectId: null,
        title: "Preparing your workspace",
        detail: "Nothing is being downloaded. Stuart is creating a local study workspace from this folder and will read the files in the background.",
        steps: buildWorkspaceSetupSteps("workspace", ["folder"]),
      });
      // Create or find project for this folder
      const existingProject = projects.find((p) => p.rootPath === path);
      let project: ProjectRecord;

      if (existingProject) {
        project = existingProject;
        const hasSavedSetup = Boolean(
          project.config?.subject
          || project.config?.goal
          || project.config?.teachingStyle
          || project.config?.additionalNotes
          || project.config?.runtimeProfile?.provider
          || project.config?.startupPreferences?.startMode
        );
        if (hasSavedSetup) {
          await continueWorkspaceSetup(project.id, path, project.config);
          return;
        }
      } else {
        project = await request<ProjectRecord>("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            name: inferProjectName(path),
            rootPath: path
          } satisfies CreateProjectInput)
        });
      }

      setSelectedProjectId(project.id);
      // Show onboarding screen for new projects — clear all progress indicators
      setWorkspaceSetup(null);
      setOnboardingState({ projectId: project.id, path });
      setBusy(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not add materials");
      setBusy(null);
    }
  }

  /* ---- Image attachment helpers ---- */
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
  const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024; // 64 MB

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // If the image exceeds the size limit, resize it via canvas
      if (file.size > MAX_IMAGE_BYTES) {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          // Scale down proportionally so the longest side is at most 1600px
          const maxDim = 1600;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            setComposerImages((prev) => [...prev, canvas.toDataURL("image/jpeg", 0.8)]);
          }
        };
        img.src = dataUrl;
      } else {
        setComposerImages((prev) => [...prev, dataUrl]);
      }
    };
    reader.readAsDataURL(file);
  }

  function processDocumentFile(file: File) {
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError(
        `That file is too large to attach in chat. The current limit is ${Math.round(
          MAX_DOCUMENT_BYTES / (1024 * 1024)
        )}MB.`
      );
      return;
    }
    setComposerFiles((prev) => [...prev, { name: file.name, size: file.size, file }]);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = "";
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        processImageFile(file);
      } else {
        processDocumentFile(file);
      }
    }
  }

  function handleComposerPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) processImageFile(file);
        return;
      }
    }
  }

  function handleComposerDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setComposerDragOver(true);
  }

  function handleComposerDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setComposerDragOver(false);
  }

  function handleComposerDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setComposerDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        processImageFile(file);
      } else {
        processDocumentFile(file);
      }
    }
  }

  async function handleComposerSubmit(event: React.FormEvent) {
    event.preventDefault();
    const prompt = composerDraft.trim();
    if (!prompt && composerImages.length === 0 && composerFiles.length === 0) return;

    if (selectedTask) {
      try {
        setBusy("message");

        // Upload all attached document files for Codex to read
        for (const cf of composerFiles) {
          setThinkingState({ taskId: selectedTask.id, label: `Staging ${cf.name}...`, recentActions: [] });
          await request(`/api/tasks/${selectedTask.id}/upload-file`, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Stuart-Filename": cf.name,
            },
            body: cf.file,
          });
        }

        setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking...", recentActions: [] });
        const body: Record<string, string> = {};
        const fileNames = composerFiles.map((f) => f.name);
        if (prompt) {
          body.content = fileNames.length > 0
            ? `${prompt}\n\n(Uploaded files: ${fileNames.join(", ")})`
            : prompt;
        } else if (fileNames.length > 0) {
          body.content = fileNames.length === 1
            ? `I just uploaded ${fileNames[0]}. Please read it and tell me what's in it.`
            : `I just uploaded ${fileNames.length} files: ${fileNames.join(", ")}. Please read them and tell me what's in them.`;
        } else {
          body.content = "(see attached image)";
        }
        if (composerImages.length > 0 && composerImages[0]) body.imageBase64 = composerImages[0];
        const result = await request<SendMessageResponse>(
          `/api/tasks/${selectedTask.id}/messages`,
          { method: "POST", body: JSON.stringify(body) }
        );
        setMessagesByTask((cur) => ({
          ...cur,
          [selectedTask.id]: [...(cur[selectedTask.id] ?? []), result.userMessage]
        }));
        if (!result.startedTurn) {
          setThinkingState((cur) => (cur?.taskId === selectedTask.id ? null : cur));
        }
        setComposerDraft("");
        setComposerImages([]);
        setComposerFiles([]);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to send message");
      } finally {
        setBusy(null);
      }
      return;
    }
  }

  function handleStudyToolClick(tool: string) {
    if (!selectedTask) return;
    const prompt = STUDY_TOOL_PROMPTS[tool];
    if (!prompt) return;
    setComposerDraft(prompt);
    // Auto-submit
    void (async () => {
      try {
        setBusy("message");
        setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking...", recentActions: [] });
        const result = await request<SendMessageResponse>(
          `/api/tasks/${selectedTask.id}/messages`,
          { method: "POST", body: JSON.stringify({ content: prompt }) }
        );
        setMessagesByTask((cur) => ({
          ...cur,
          [selectedTask.id]: [...(cur[selectedTask.id] ?? []), result.userMessage]
        }));
        if (!result.startedTurn) {
          setThinkingState((cur) => (cur?.taskId === selectedTask.id ? null : cur));
        }
        setComposerDraft("");
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to send message");
      } finally {
        setBusy(null);
      }
    })();
  }

  async function sendTaskMessage(taskId: string, content: string) {
    try {
      setBusy("message");
      setThinkingState({ taskId, label: "Stuart is thinking...", recentActions: [] });
      const result = await request<SendMessageResponse>(
        `/api/tasks/${taskId}/messages`,
        { method: "POST", body: JSON.stringify({ content }) }
      );
      setMessagesByTask((cur) => ({
        ...cur,
        [taskId]: [...(cur[taskId] ?? []), result.userMessage]
      }));
      if (!result.startedTurn) {
        setThinkingState((cur) => (cur?.taskId === taskId ? null : cur));
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to send message");
    } finally {
      setBusy(null);
    }
  }

  async function deleteStudySession(taskId: string) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const confirmed = window.confirm(`Remove this study session?`);
    if (!confirmed) return;
    try {
      setBusy(`delete-task-${taskId}`);
      await request<void>(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
        setSelectedRunId(null);
      }
      await refreshDashboard();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject(projectId: string, projectName: string) {
    const confirmed = window.confirm(`Permanently delete workspace "${projectName}" and all its study sessions? This cannot be undone.`);
    if (!confirmed) return;
    try {
      setBusy(`delete-project-${projectId}`);
      await request<void>(`/api/projects/${projectId}`, { method: "DELETE" });
      setSelectedTaskId(null);
      setSelectedRunId(null);
      await refreshDashboard();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function archiveProject(projectId: string) {
    try {
      await request<void>(`/api/projects/${projectId}/archive`, { method: "POST" });
      const archivedAt = new Date().toISOString();
      setProjects((current) => current.map((project) => (
        project.id === projectId ? { ...project, archivedAt } : project
      )));
      setTasks((current) => current.map((task) => (
        task.projectId === projectId ? { ...task, archivedAt } : task
      )));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to archive workspace");
    }
  }

  async function unarchiveProject(projectId: string) {
    try {
      await request<void>(`/api/projects/${projectId}/unarchive`, { method: "POST" });
      await refreshDashboard();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to unarchive workspace");
    }
  }

  async function archiveTask(taskId: string) {
    try {
      await request<void>(`/api/tasks/${taskId}/archive`, { method: "POST" });
      const archivedAt = new Date().toISOString();
      setTasks((current) => current.map((task) => (
        task.id === taskId ? { ...task, archivedAt } : task
      )));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to archive session");
    }
  }

  async function unarchiveTask(taskId: string) {
    try {
      await request<void>(`/api/tasks/${taskId}/unarchive`, { method: "POST" });
      await refreshDashboard();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to unarchive session");
    }
  }

  /* ================================================================
     RENDER
     ================================================================ */

  return (
    <div className="stuart-shell">
      {/* ---- Error Banner ---- */}
      {error ? (
        <div className="error-banner">
          <span>{error}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {desktopState.isDesktop && desktopBridge?.restartServer ? (
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => {
                  setError(null);
                  setBusy("restarting");
                  void desktopBridge!.restartServer().then(() => {
                    setBusy(null);
                    void refreshDashboard();
                  }).catch(() => {
                    setBusy(null);
                    setError("Failed to restart the server. Try quitting and reopening Stuart.");
                  });
                }}
              >
                {busy === "restarting" ? "Restarting..." : "Restart Server"}
              </button>
            ) : null}
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => { setError(null); void refreshDashboard(); }}
            >
              Retry
            </button>
            <button className="ghost-button compact" type="button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- Context Compaction Banner ---- */}
      {(isCompacting || compactionMessage) ? (
        <div className={`compaction-banner${isCompacting ? " active" : ""}`}>
          {isCompacting && <span className="compaction-spinner" />}
          <span>{isCompacting ? "Compacting conversation context..." : compactionMessage}</span>
          {!isCompacting && (
            <button className="ghost-button compact" type="button" onClick={() => setCompactionMessage(null)}>
              Dismiss
            </button>
          )}
        </div>
      ) : null}

      {workspaceSetup ? (
        <WorkspaceSetupIndicator progress={workspaceSetup} />
      ) : null}

      {/* ---- Codex Auth Bar ---- */}
      {desktopState.isDesktop && codexAuthCheck && codexAuthCheck.status !== "ok" ? (
        <div className="codex-auth-bar">
          <div className="codex-auth-bar-content">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="7" />
              <line x1="8" y1="5" x2="8" y2="8" />
              <circle cx="8" cy="11" r="0.5" fill="currentColor" />
            </svg>
            <span>
              {desktopCodexLogin?.status === "waiting"
                ? desktopCodexLogin.message
                : codexAuthCheck.summary ?? "ChatGPT account not connected."}
            </span>
          </div>
          {desktopCodexLogin?.userCode ? (
            <div className="codex-auth-bar-code-block">
              <span className="codex-auth-bar-code-label">Device code</span>
              <span className="codex-auth-bar-code">{desktopCodexLogin.userCode}</span>
            </div>
          ) : null}
          <div className="codex-auth-bar-actions">
            {desktopCodexLogin?.verificationUri ? (
              <a
                className="codex-auth-link"
                href={desktopCodexLogin.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternalUrl(desktopCodexLogin.verificationUri!);
                }}
              >
                Open sign-in page
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 3H3v10h10V9" /><path d="M9 2h5v5" /><path d="M14 2L6 10" />
                </svg>
              </a>
            ) : null}
            <button
              className="accent-button compact"
              type="button"
              onClick={() => codexCliCheck?.status === "ok" ? void startDesktopCodexLogin() : void openCodexHelp()}
              disabled={busy === "codex-login" || desktopAuthPending}
            >
              {busy === "codex-login" || desktopAuthPending
                ? "Signing in..."
                : codexCliCheck?.status === "ok"
                  ? "Connect ChatGPT"
                  : "Repair setup"}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- Three-Column Layout ---- */}
      <div
        className={`workspace${studyToolsCollapsed ? " tools-collapsed" : ""}${libraryCollapsed ? " library-collapsed" : ""}${isArtifactOpen ? " artifact-open" : ""}`}
        style={isArtifactOpen ? { "--artifact-pane-width": `${artifactPaneWidth}px` } as React.CSSProperties : undefined}
      >
        {/* ======== LEFT SIDEBAR: Your Library ======== */}
        <aside className={`library-panel${!selectedTask ? " zen-sidebar" : ""}`}>
          <div className="library-header">
            <div
              className="brand-lockup"
              style={{ cursor: "pointer" }}
              onClick={() => { setSelectedTaskId(null); setSelectedRunId(null); }}
              title="Back to dashboard"
            >
              <svg width="24" height="24" viewBox="0 0 200 200" fill="var(--zen-primary)">
                <path d="m185.2 106.2c-1.38-0.66-1.98-0.93-2.91-1.29 2.31-3.16 3.11-4.01 6.52-4.98 2.22-0.65 1.52-3.85-0.8-3.34-4.19 0.45-5.94 3.18-7.84 7.04-7.14-1.6-16.44-0.84-19.35 7.33-0.54 0.35-0.44 0.27-0.7 0.89-2.35 0.35-6.17 0.86-9.02-0.05-0.77-2.78 1.37-9.79 2.85-11.8 10.06-0.8 18.57-3.43 25.71-10.62 4.37-4.34 8.35-7.22 7.26-12.58-3.85-13.03-10.07-26.79-22.86-34.66-2.04-1.46-4.92-2.48-5.42-2.83-0.87-8.12-4.48-15.3-10.03-18.45-1.64-0.71-2.45-0.25-3.32 0.56-3.36 3.15-5.35 9.31-6.22 14.49-3.31-4.46-5.25-6.94-9.56-11.47-3.26-3.78-7.44-2.71-9.75 1.39-5.19 8.23-4.58 17.04-0.82 24.13-5.71 6.76-6.68 16.05-9.79 20.97-3.36 4.97-6.87 7.74-11.5 10.13 9.45-23.09 5.13-45.64-10.68-60.2-10.05-9.34-22.49-12.91-34.48-12.91-25.97 0-47.92 20.16-47.92 44.97 0 10.19 5.08 18.12 13.54 26.24 2.41 2.11 4.82 1.25 3.75-1.58-2.61-7.08 3.45-17.47 11.96-19.58 6.42-0.66 9.98 3.76 9.98 9.73 0 6.65-4.62 14.62-8.71 21.55-6.94 10.93-12.43 21.33-12.43 39.35 0 25.12 16.26 50.38 45.3 50.23 4.34-0.07 7.5-0.14 10.61 2.58-1.02 5.52 2.78 9.81 7.86 9.81l48.37 0.51c5.08-0.05 5.42-2.8 5.29-5.43l20.9-0.79c5.44-0.46 2.87-7.42-1.24-10.77-3.95-3.24-9.52-4.09-14.43-4.21 6.49-8.28 11.01-16.81 6.9-27.59-1.34-4.01-3.21-6.94-4.3-7.79-0.3-2.26 0.57-2.16 5.47-4.52 1.61-0.67 3.92-1.47 4.22-0.21 0.87 6.03 5.12 9.66 9.12 14.44 0.67 0.75 1.44 0 2.75-0.23 12.13-2.52 17.54-6.46 22.29-19.6 2.88-1.83 4.39-4 3.69-8.42-1.11-5.63-5.81-8.51-10.26-10.44zm-37.25-79.77c4.22 2.73 6.87 7.8 7.34 12.77-4.49-1.07-6.1-1.53-11.34-1.78 0.25-4.36 1.12-7.85 4-10.99zm1.81 120.2c1.51 10.08-7.26 21.7-14 27.11-1.06 1.17-0.4 3.43 1.81 3.02 6.07-1.12 17.86-2.05 22.18 2.92 0.5 0.71 0.6 1.47 0.6 1.47l-20.47 0.31c-3.06-3.92-6.91-5.37-11.86-5.97 11.05-8.44 15.27-21.09 18.89-36.55 1.54 0.91 2.41 4.21 2.85 7.69zm21.4-6.78-1.81 0.35c-3.12-3.93-5.78-5.81-6.92-10 6.52 0 10.13-3.92 9.73-10.45l16.19 5.44c-2.95 7.98-6.28 12.99-17.19 14.66zm19.5-19.34-26.4-11.62c2.47-5.02 12.96-3.49 19.09-0.35 5.27 2.67 8.95 6.07 7.31 11.97zm-6.27-40.5c-1.51-0.51-6.89-1.11-6.23 2.33 0.3 1.51 1.1 3.53 2.61 4.6-3.79 4.41-7.4 5.97-13.59 2.2-1.38-0.76-3.02 0-2.15 1.13 0.77 1.08 2.15 2.19 3.42 3.31-11.48 3.94-25.4 2.64-33.75-4.74-2.75-2.16-4.52-5.19-5.39-4.68-1.31 0.35-0.64 2.52 0.97 4.58 5.48 6.81 12.97 9.23 19.48 10.25-1.81 3.15-2.89 7.07-3.09 10.81-4.82-0.76-7.53-4.69-10.28-7.86-1.54-1.35-2.64-0.23-2.14 2.08 2.51 7.29 10.51 12.17 19 11.92 4.85-0.1 5.62-1.33 9.24-1.08 4.65 0.41 6.56 2.98 6.26 5.96-0.5 4.17-3.49 4.72-8.67 3.22-3.51-0.86-12.97 4.72-22.56 5.43-10.76 0.71-17.28-4.48-22.56-14.86-1.1-2.17-4.99-2.62-4.59 0.82 0.97 6.87 10.5 17.66 24.33 18.12 3.15 0.1 5.32-0.3 8.65-0.91-1.07 14.6-4.55 32.13-19.62 41.66-1.64 0.81-3.28 0.66-4.63 0.35 7.66-8.91 9.87-20.51 6.95-29.09-3.82-11.72-14.97-20.72-26.59-20.37-4.75 0.1-10.13 2.46-10.6 5.34-0.5 1.46 0.81 1.2 1.31 0.9 4.59-2.01 8.34-3.02 13.29-2.57 10.96 1.37 19.26 12.1 20.2 22.48 0.87 10.4-5.66 21.23-15.61 26.81-1.95 1.07-1.75 3.59 0.6 3.19 5.54-1.66 9.8-2.57 18.26-2.47 5.28 0.45 9.03 3.8 9.03 7.29 0 1.41-0.77 1.51-2.05 1.51l-47.04-0.5c-3.55 0-4.02-3.25-3.09-5.51 1.11-2.67 2.01-5.72-0.1-5.62-1.1 0-1.4 1.61-2.61 2.83-11.83-8.82-20.73-22.9-20.73-39.63 0-18.17 10.25-39.3 31.54-51.58 8.71-4.56 17.4-8.91 23.24-18 1.95-4.57 3.39-10.75 6.21-15.97 0.97 0.45 2.71 3.23 4.12 3.78 2.04 0.76 3.04-0.96 2.57-2.77-0.97-3.68-5.95-7.37-6.29-15.76 0-4.87 2.15-10.29 4.5-12 5.71 3.92 12.4 13.11 12.53 19.78 0.1 2.52 2.98 1.92 2.88-0.15 0-1.71-0.1-3.12-0.4-5.59 10.38 0.2 18.83 2.57 25.98 9.14 9.12 7.63 13.3 18.7 17.19 29.89z"/>
                <path d="m127.8 32.7c-1.16-0.91-1.73 0.81-0.73 1.82 5.18 5.67 5.38 10.99 3.67 17.88-0.5 2.26 1.94 2.26 2.54 0.45 2.85-7.94 1.24-14.27-5.48-20.15z"/>
                <path d="m140.8 66.82c-2.65 2.16-2.45 4.13-0.6 3.27 3.91-1.81 9.26-4.12 14.81 0.6 2.41 2.07 3.08 2.62 3.58 1.92 1.34-1.46-1.17-5.39-5.39-7.1-4.26-1.86-9.09-1.11-12.4 1.31z"/>
                <path d="m27.18 138.2c3.11 5.63 8.07 9.06 12.29 11.43-6.66-5.05-12.29-11.82-12.29-22.6 0-13.71 7.14-25.89 13.46-35.93 5.05-7.93 7.07-14.9 6.97-20.81-0.67-8.28-7.2-16.36-16.26-15.9-8.16 0.6-14.64 9.41-15.34 19.13-0.1 0.35-0.1 0.35-0.4 0-4.63-5.63-7.38-10.35-7.38-20.09 0.5-18.77 18.14-42.35 44.59-42.35 26.1 0 46.27 18.95 46.27 45.28 0 9.85-3.31 18.93-7.77 27.06-19.14 11.13-34.75 30.41-34.75 56.35 0 12.54 4.35 25.08 12.81 35.46-19.27-0.45-35.17-13.65-42.2-37.03z"/>
              </svg>
              <span className="brand-mark">Stuart</span>
              <span
                className={`server-health-dot ${serverHealth}`}
                title={
                  serverHealth === "ok" ? "Server running" :
                  serverHealth === "degraded" ? "Server responding slowly" :
                  "Server not responding"
                }
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              <button
                className="theme-toggle-btn"
                type="button"
                onClick={() => setShowCanvasSettings((v) => !v)}
                title="Canvas LMS Settings"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>settings</span>
              </button>
              <button
                className="theme-toggle-btn"
                type="button"
                onClick={toggleTheme}
                title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              >
                {theme === "light" ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" />
                    <line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                )}
              </button>
              <button
                className="ghost-button compact library-collapse-btn"
                type="button"
                onClick={() => setLibraryCollapsed(true)}
                title="Hide sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 3 4 7 9 11" />
                </svg>
              </button>
            </div>
          </div>

          <div className="library-body">
            {!selectedTask ? (
              /* Dashboard mode: simplified sidebar */
              <div className="zen-sidebar-content">
                <button
                  className="zen-sidebar-nav active"
                  type="button"
                  onClick={() => { setSelectedTaskId(null); setSelectedRunId(null); }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <rect x="3" y="3" width="8" height="8" rx="2" />
                    <rect x="13" y="3" width="8" height="8" rx="2" />
                    <rect x="3" y="13" width="8" height="8" rx="2" />
                    <rect x="13" y="13" width="8" height="8" rx="2" />
                  </svg>
                  Workspaces
                </button>

                {projects.length > 0 && (
                  <div className="zen-sidebar-list">
                    {projects.map((project) => {
                      const firstTask = tasks.find((t) => t.projectId === project.id);
                      return (
                        <button
                          key={project.id}
                          className="zen-sidebar-item"
                          type="button"
                          onClick={() => {
                            if (firstTask) {
                              setSelectedProjectId(project.id);
                              setSelectedTaskId(firstTask.id);
                            }
                          }}
                          disabled={!firstTask}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5A1 1 0 0 0 5.8 3H3a1 1 0 0 0-1 1z" />
                          </svg>
                          {project.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div style={{ flex: 1 }} />
                <button
                  className="zen-sidebar-new-btn"
                  type="button"
                  onClick={() => void handleAddStudyMaterials()}
                  disabled={busy === "add-materials" || busy === "folder"}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="7" y1="2" x2="7" y2="12" />
                    <line x1="2" y1="7" x2="12" y2="7" />
                  </svg>
                  New Workspace
                </button>
              </div>
            ) : (
            <>
            <button
              className="add-materials-button"
              type="button"
              onClick={() => void handleAddStudyMaterials()}
              disabled={busy === "add-materials" || busy === "folder"}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              {busy === "add-materials" ? "Setting up..." : "Add study materials"}
            </button>

            {diagnostics ? (
              diagnosticsDismissed ? (
                <DiagnosticsDismissedNotice compact onShow={restoreDiagnostics} />
              ) : (
                <DiagnosticsCard
                  diagnostics={diagnostics}
                  compact
                  surface={desktopState.isDesktop ? "desktop" : "developer"}
                  onDismiss={dismissDiagnostics}
                />
              )
            ) : null}

            {/* Projects as study folders */}
            {activeProjects.length > 0 ? (
              <div className="library-section">
                <span className="library-kicker">Your folders</span>
                <div className="library-folder-list">
                  {activeProjects.map((project) => (
                    <div
                      key={project.id}
                      className={`library-row${project.id === selectedProjectId ? " active" : ""}`}
                      onContextMenu={(event) => openLibraryContextMenu(event, {
                        kind: "project",
                        projectId: project.id,
                        projectName: project.name,
                      })}
                    >
                      <button
                        className={`library-folder${project.id === selectedProjectId ? " active" : ""}`}
                        type="button"
                        onClick={() => {
                          setLibraryContextMenu(null);
                          setSelectedProjectId(project.id);
                          const firstTask = activeTasks.find((t) => t.projectId === project.id);
                          if (firstTask) setSelectedTaskId(firstTask.id);
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5A1 1 0 0 0 5.8 3H3a1 1 0 0 0-1 1z" />
                        </svg>
                        <span>{project.name}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Source files — compact preview */}
            {selectedIngestion && selectedIngestion.documents.length > 0 ? (
              <div className="library-section sources-section">
                <span className="library-kicker">
                  Sources
                  <span className="source-count">{selectedIngestion.documents.length}</span>
                </span>
                <div className="library-source-list">
                  {selectedIngestion.documents.slice(0, 3).map((doc) => (
                    <div key={doc.id} className="library-source-item">
                      <span className="source-badge">
                        {fileExtension(doc.relativePath).slice(0, 3)}
                      </span>
                      <span className="source-name">{cleanSourceName(doc.relativePath)}</span>
                    </div>
                  ))}
                  {selectedIngestion.documents.length > 3 && (
                    <span className="source-more">+{selectedIngestion.documents.length - 3} more files indexed</span>
                  )}
                </div>
              </div>
            ) : null}

            {/* Study sessions (tasks, but we don't call them that) */}
            {activeTasks.length > 0 ? (
              <div className="library-section">
                <span className="library-kicker">Study sessions</span>
                <div className="library-session-list">
                  {activeTasks.map((task) => {
                    const isActive = task.id === selectedTaskId;
                    const isWorking = thinkingState?.taskId === task.id;
                    return (
                      <div
                        key={task.id}
                        className={`library-row${isActive ? " active" : ""}`}
                        onContextMenu={(event) => openLibraryContextMenu(event, {
                          kind: "task",
                          taskId: task.id,
                        })}
                      >
                        <button
                          type="button"
                          className={`library-session${isActive ? " active" : ""}`}
                          onClick={() => {
                            setLibraryContextMenu(null);
                            setSelectedTaskId(task.id);
                            setSelectedProjectId(task.projectId);
                          }}
                        >
                          <div className="library-session-head">
                            <strong>{task.title}</strong>
                            {isWorking ? (
                              <span className="working-badge">
                                <span className="working-dot" />
                              </span>
                            ) : null}
                          </div>
                          <p>{task.objective}</p>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            </>
            )}
          </div>
        </aside>

        {libraryContextMenu ? (
          <div
            ref={libraryContextMenuRef}
            className="library-context-menu"
            style={{ left: libraryContextMenu.x, top: libraryContextMenu.y }}
          >
            <button
              type="button"
              className="library-context-item"
              onClick={() => {
                const menu = libraryContextMenu;
                setLibraryContextMenu(null);
                if (menu.kind === "project") {
                  void archiveProject(menu.projectId);
                  return;
                }
                void archiveTask(menu.taskId);
              }}
            >
              {libraryContextMenu.kind === "project" ? "Archive workspace" : "Archive session"}
            </button>
            <button
              type="button"
              className="library-context-item destructive-text"
              onClick={() => {
                const menu = libraryContextMenu;
                setLibraryContextMenu(null);
                if (menu.kind === "project") {
                  void deleteProject(menu.projectId, menu.projectName);
                  return;
                }
                void deleteStudySession(menu.taskId);
              }}
            >
              {libraryContextMenu.kind === "project" ? "Delete workspace" : "Delete session"}
            </button>
          </div>
        ) : null}

        {/* ======== CENTER: Chat or Canvas Settings ======== */}
        {showCanvasSettings ? (
          <CanvasSettingsPanel
            onClose={() => setShowCanvasSettings(false)}
            pickFolder={pickFolder}
            onTaskCreated={(taskId) => {
              setShowCanvasSettings(false);
              refreshDashboard().then(() => setSelectedTaskId(taskId));
            }}
          />
        ) : (
        <section className="chat-panel">
          {libraryCollapsed && (
            <button
              className="library-expand-btn"
              type="button"
              onClick={() => setLibraryCollapsed(false)}
              title="Show sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="5 3 10 7 5 11" />
              </svg>
            </button>
          )}
          <div className="chat-scroll" ref={threadRef}>
            <CitationContext.Provider value={searchCitation}>
            <CitationOpenContext.Provider value={openCitationSource}>
            <WorkspaceFileResolveContext.Provider value={resolveWorkspaceFileReference}>
            <WorkspaceFileOpenContext.Provider value={openWorkspaceFileReference}>
            <div className="chat-transcript">
              {!selectedTask ? (
                projects.length > 0 ? (
                  /* ---- Dashboard: shown when projects exist but no task selected ---- */
                  <DashboardView
                    projects={projects}
                    tasks={tasks}
                    onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                    onAddWorkspace={() => handleAddStudyMaterials()}
                    onDeleteProject={deleteProject}
                    onArchiveProject={archiveProject}
                    onUnarchiveProject={unarchiveProject}
                    onArchiveTask={archiveTask}
                    onUnarchiveTask={unarchiveTask}
                    onOpenCanvas={() => setShowCanvasSettings(true)}
                  />
                ) : (
                  /* ---- Onboarding: Welcome Screen ---- */
                  <div className="welcome-card">
                    <div className="welcome-icon">
                      <svg width="56" height="56" viewBox="0 0 200 200" fill="var(--accent)">
                        <path d="m185.2 106.2c-1.38-0.66-1.98-0.93-2.91-1.29 2.31-3.16 3.11-4.01 6.52-4.98 2.22-0.65 1.52-3.85-0.8-3.34-4.19 0.45-5.94 3.18-7.84 7.04-7.14-1.6-16.44-0.84-19.35 7.33-0.54 0.35-0.44 0.27-0.7 0.89-2.35 0.35-6.17 0.86-9.02-0.05-0.77-2.78 1.37-9.79 2.85-11.8 10.06-0.8 18.57-3.43 25.71-10.62 4.37-4.34 8.35-7.22 7.26-12.58-3.85-13.03-10.07-26.79-22.86-34.66-2.04-1.46-4.92-2.48-5.42-2.83-0.87-8.12-4.48-15.3-10.03-18.45-1.64-0.71-2.45-0.25-3.32 0.56-3.36 3.15-5.35 9.31-6.22 14.49-3.31-4.46-5.25-6.94-9.56-11.47-3.26-3.78-7.44-2.71-9.75 1.39-5.19 8.23-4.58 17.04-0.82 24.13-5.71 6.76-6.68 16.05-9.79 20.97-3.36 4.97-6.87 7.74-11.5 10.13 9.45-23.09 5.13-45.64-10.68-60.2-10.05-9.34-22.49-12.91-34.48-12.91-25.97 0-47.92 20.16-47.92 44.97 0 10.19 5.08 18.12 13.54 26.24 2.41 2.11 4.82 1.25 3.75-1.58-2.61-7.08 3.45-17.47 11.96-19.58 6.42-0.66 9.98 3.76 9.98 9.73 0 6.65-4.62 14.62-8.71 21.55-6.94 10.93-12.43 21.33-12.43 39.35 0 25.12 16.26 50.38 45.3 50.23 4.34-0.07 7.5-0.14 10.61 2.58-1.02 5.52 2.78 9.81 7.86 9.81l48.37 0.51c5.08-0.05 5.42-2.8 5.29-5.43l20.9-0.79c5.44-0.46 2.87-7.42-1.24-10.77-3.95-3.24-9.52-4.09-14.43-4.21 6.49-8.28 11.01-16.81 6.9-27.59-1.34-4.01-3.21-6.94-4.3-7.79-0.3-2.26 0.57-2.16 5.47-4.52 1.61-0.67 3.92-1.47 4.22-0.21 0.87 6.03 5.12 9.66 9.12 14.44 0.67 0.75 1.44 0 2.75-0.23 12.13-2.52 17.54-6.46 22.29-19.6 2.88-1.83 4.39-4 3.69-8.42-1.11-5.63-5.81-8.51-10.26-10.44zm-37.25-79.77c4.22 2.73 6.87 7.8 7.34 12.77-4.49-1.07-6.1-1.53-11.34-1.78 0.25-4.36 1.12-7.85 4-10.99zm1.81 120.2c1.51 10.08-7.26 21.7-14 27.11-1.06 1.17-0.4 3.43 1.81 3.02 6.07-1.12 17.86-2.05 22.18 2.92 0.5 0.71 0.6 1.47 0.6 1.47l-20.47 0.31c-3.06-3.92-6.91-5.37-11.86-5.97 11.05-8.44 15.27-21.09 18.89-36.55 1.54 0.91 2.41 4.21 2.85 7.69zm21.4-6.78-1.81 0.35c-3.12-3.93-5.78-5.81-6.92-10 6.52 0 10.13-3.92 9.73-10.45l16.19 5.44c-2.95 7.98-6.28 12.99-17.19 14.66zm19.5-19.34-26.4-11.62c2.47-5.02 12.96-3.49 19.09-0.35 5.27 2.67 8.95 6.07 7.31 11.97zm-6.27-40.5c-1.51-0.51-6.89-1.11-6.23 2.33 0.3 1.51 1.1 3.53 2.61 4.6-3.79 4.41-7.4 5.97-13.59 2.2-1.38-0.76-3.02 0-2.15 1.13 0.77 1.08 2.15 2.19 3.42 3.31-11.48 3.94-25.4 2.64-33.75-4.74-2.75-2.16-4.52-5.19-5.39-4.68-1.31 0.35-0.64 2.52 0.97 4.58 5.48 6.81 12.97 9.23 19.48 10.25-1.81 3.15-2.89 7.07-3.09 10.81-4.82-0.76-7.53-4.69-10.28-7.86-1.54-1.35-2.64-0.23-2.14 2.08 2.51 7.29 10.51 12.17 19 11.92 4.85-0.1 5.62-1.33 9.24-1.08 4.65 0.41 6.56 2.98 6.26 5.96-0.5 4.17-3.49 4.72-8.67 3.22-3.51-0.86-12.97 4.72-22.56 5.43-10.76 0.71-17.28-4.48-22.56-14.86-1.1-2.17-4.99-2.62-4.59 0.82 0.97 6.87 10.5 17.66 24.33 18.12 3.15 0.1 5.32-0.3 8.65-0.91-1.07 14.6-4.55 32.13-19.62 41.66-1.64 0.81-3.28 0.66-4.63 0.35 7.66-8.91 9.87-20.51 6.95-29.09-3.82-11.72-14.97-20.72-26.59-20.37-4.75 0.1-10.13 2.46-10.6 5.34-0.5 1.46 0.81 1.2 1.31 0.9 4.59-2.01 8.34-3.02 13.29-2.57 10.96 1.37 19.26 12.1 20.2 22.48 0.87 10.4-5.66 21.23-15.61 26.81-1.95 1.07-1.75 3.59 0.6 3.19 5.54-1.66 9.8-2.57 18.26-2.47 5.28 0.45 9.03 3.8 9.03 7.29 0 1.41-0.77 1.51-2.05 1.51l-47.04-0.5c-3.55 0-4.02-3.25-3.09-5.51 1.11-2.67 2.01-5.72-0.1-5.62-1.1 0-1.4 1.61-2.61 2.83-11.83-8.82-20.73-22.9-20.73-39.63 0-18.17 10.25-39.3 31.54-51.58 8.71-4.56 17.4-8.91 23.24-18 1.95-4.57 3.39-10.75 6.21-15.97 0.97 0.45 2.71 3.23 4.12 3.78 2.04 0.76 3.04-0.96 2.57-2.77-0.97-3.68-5.95-7.37-6.29-15.76 0-4.87 2.15-10.29 4.5-12 5.71 3.92 12.4 13.11 12.53 19.78 0.1 2.52 2.98 1.92 2.88-0.15 0-1.71-0.1-3.12-0.4-5.59 10.38 0.2 18.83 2.57 25.98 9.14 9.12 7.63 13.3 18.7 17.19 29.89z"/>
                        <path d="m127.8 32.7c-1.16-0.91-1.73 0.81-0.73 1.82 5.18 5.67 5.38 10.99 3.67 17.88-0.5 2.26 1.94 2.26 2.54 0.45 2.85-7.94 1.24-14.27-5.48-20.15z"/>
                        <path d="m140.8 66.82c-2.65 2.16-2.45 4.13-0.6 3.27 3.91-1.81 9.26-4.12 14.81 0.6 2.41 2.07 3.08 2.62 3.58 1.92 1.34-1.46-1.17-5.39-5.39-7.1-4.26-1.86-9.09-1.11-12.4 1.31z"/>
                        <path d="m27.18 138.2c3.11 5.63 8.07 9.06 12.29 11.43-6.66-5.05-12.29-11.82-12.29-22.6 0-13.71 7.14-25.89 13.46-35.93 5.05-7.93 7.07-14.9 6.97-20.81-0.67-8.28-7.2-16.36-16.26-15.9-8.16 0.6-14.64 9.41-15.34 19.13-0.1 0.35-0.1 0.35-0.4 0-4.63-5.63-7.38-10.35-7.38-20.09 0.5-18.77 18.14-42.35 44.59-42.35 26.1 0 46.27 18.95 46.27 45.28 0 9.85-3.31 18.93-7.77 27.06-19.14 11.13-34.75 30.41-34.75 56.35 0 12.54 4.35 25.08 12.81 35.46-19.27-0.45-35.17-13.65-42.2-37.03z"/>
                      </svg>
                    </div>
                    <h1>Welcome to Stuart</h1>
                    <p>Your personal study assistant. Drop a folder of study materials to get started.</p>
                    <div className="welcome-actions">
                      <button
                        className="accent-button welcome-cta"
                        type="button"
                        onClick={() => void handleAddStudyMaterials()}
                        disabled={busy === "add-materials" || busy === "folder"}
                      >
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5A1 1 0 0 0 5.8 3H3a1 1 0 0 0-1 1z" />
                        </svg>
                        {busy === "add-materials" ? "Setting up..." : "Choose folder"}
                      </button>
                      <button
                        className="secondary-button welcome-cta"
                        type="button"
                        onClick={() => setShowCanvasSettings(true)}
                      >
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z" />
                          <path d="M2 6h12" /><path d="M6 6v8" />
                        </svg>
                        Import from Canvas
                      </button>
                    </div>
                    {diagnostics ? (
                      diagnosticsDismissed ? (
                        <DiagnosticsDismissedNotice onShow={restoreDiagnostics} />
                      ) : (
                        <DiagnosticsCard
                          diagnostics={diagnostics}
                          surface={desktopState.isDesktop ? "desktop" : "developer"}
                          onDismiss={dismissDiagnostics}
                        />
                      )
                    ) : null}
                    <div className="welcome-features">
                      <div className="welcome-feature">
                        <strong>Flashcards</strong>
                        <span>Auto-generated from your notes</span>
                      </div>
                      <div className="welcome-feature">
                        <strong>Quizzes</strong>
                        <span>Test your understanding</span>
                      </div>
                      <div className="welcome-feature">
                        <strong>Mind Maps</strong>
                        <span>Visualize connections</span>
                      </div>
                      <div className="welcome-feature">
                        <strong>Diagrams</strong>
                        <span>See the big picture</span>
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <>
                  {/* Get Started prompt for new sessions */}
                  {visibleMessages.length === 0 && !isStreaming && selectedTask && (
                    <div className="session-welcome">
                      <div className="session-welcome-icon">
                        <span className="material-symbols-outlined" style={{ fontSize: 36, color: "var(--accent)" }}>auto_stories</span>
                      </div>
                      <h2 className="session-welcome-title">{selectedTask.title?.replace(/^Study:\s*/, "") || "Study Session"}</h2>
                      <p className="session-welcome-sub">Stuart has indexed your materials and is ready to help you study.</p>
                      <div className="session-welcome-actions">
                        <button type="button" className="session-welcome-btn" onClick={() => { setComposerDraft("Give me an overview of all the materials in this workspace. What topics are covered and what should I focus on first?"); }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>explore</span>
                          Overview my materials
                        </button>
                        <button type="button" className="session-welcome-btn" onClick={() => { setComposerDraft("Create flashcards from my study materials, focusing on the most important concepts."); }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>style</span>
                          Generate flashcards
                        </button>
                        <button type="button" className="session-welcome-btn" onClick={() => { setComposerDraft("Create a quiz to test my understanding of the key concepts in these materials."); }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>quiz</span>
                          Quiz me
                        </button>
                        <button type="button" className="session-welcome-btn" onClick={() => { setComposerDraft("Create a mind map showing how the main topics in my materials connect to each other."); }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>hub</span>
                          Mind map
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Messages */}
                  {visibleMessages.map((message) => (
                    <ChatBubble key={message.id} message={message} />
                  ))}

                  {/* Streaming Response */}
                  {isStreaming && streamingDelta ? (() => {
                    const text = streamingDelta.text.trim();
                    // Detect if streaming content is a JSON artifact — show clean placeholder instead of raw code
                    const looksLikeArtifact = (text.startsWith("{") || text.includes("```json")) &&
                      /\b"kind"\s*:\s*"(flashcards|quiz|mindmap|diagram|mock_exam|interactive|custom|document_docx|document_xlsx|document_pptx|document_pdf|study_doc)"/.test(text);
                    return (
                      <article className="chat-bubble assistant streaming">
                        <div className="chat-meta">
                          <span className="chat-label">Stuart</span>
                          <span className="chat-typing">typing...</span>
                        </div>
                        <div className="chat-content">
                          {looksLikeArtifact ? (
                            <p style={{ color: "var(--ink-muted)", fontStyle: "italic" }}>Generating study artifact...</p>
                          ) : (
                            <MarkdownMessage content={streamingDelta.text} />
                          )}
                        </div>
                      </article>
                    );
                  })() : null}

                  {/* Inline tool status — single updating line */}
                  {selectedTask && (toolLogByTask[selectedTask.id]?.length ?? 0) > 0 && (
                    <div className="zen-inline-status">
                      <span className="zen-inline-status-dot" />
                      <span className="zen-inline-status-text">
                        {toolLogByTask[selectedTask.id]![toolLogByTask[selectedTask.id]!.length - 1]}
                      </span>
                    </div>
                  )}

                  {/* Thinking State */}
                  {thinkingState?.taskId === selectedTask.id && !isStreaming ? (
                    <ThinkingBubble label={thinkingState.label} recentActions={thinkingState.recentActions} activities={agentActivityByTask[selectedTask.id]} />
                  ) : null}
                </>
              )}
            </div>
            </WorkspaceFileOpenContext.Provider>
            </WorkspaceFileResolveContext.Provider>
            </CitationOpenContext.Provider>
            </CitationContext.Provider>
          </div>

          {/* Composer */}
          {selectedTask ? (
            <form className={`composer-shell${composerDragOver ? " drag-over" : ""}`} onSubmit={handleComposerSubmit} onDragOver={handleComposerDragOver} onDragLeave={handleComposerDragLeave} onDrop={handleComposerDrop}>
              <div className="composer-frame">
                {/* Drag overlay */}
                {composerDragOver && (
                  <div className="composer-drop-zone">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    <span>Drop file here</span>
                  </div>
                )}
                {/* Image preview strip */}
                {composerImages.length > 0 && !composerDragOver && (
                  <div className="composer-image-preview">
                    {composerImages.map((img, i) => (
                      <div key={i} className="composer-image-preview-item">
                        <img className="composer-image-thumb" src={img} alt={`Attached ${i + 1}`} />
                        <button
                          type="button"
                          className="composer-image-remove"
                          onClick={() => setComposerImages((prev) => prev.filter((_, j) => j !== i))}
                          aria-label={`Remove image ${i + 1}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="2" y1="2" x2="10" y2="10" />
                            <line x1="10" y1="2" x2="2" y2="10" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Document file previews */}
                {composerFiles.length > 0 && !composerDragOver && composerFiles.map((cf, i) => (
                  <div key={i} className="composer-file-preview">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
                      <polyline points="9 1 9 5 13 5" />
                    </svg>
                    <span className="composer-file-name">{cf.name}</span>
                    <span className="composer-file-size">{(cf.size / 1024).toFixed(0)}KB</span>
                    <button type="button" className="composer-image-remove" onClick={() => setComposerFiles((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${cf.name}`}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <line x1="2" y1="2" x2="10" y2="10" />
                        <line x1="10" y1="2" x2="2" y2="10" />
                      </svg>
                    </button>
                  </div>
                ))}
                <textarea
                  value={composerDraft}
                  onChange={(e) => setComposerDraft(e.target.value)}
                  placeholder="Ask Stuart anything about your materials..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleComposerSubmit(e);
                    }
                  }}
                  onPaste={handleComposerPaste}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.md,.txt,.csv"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleFileSelect}
                />
                <div className="composer-bottom">
                  <div className="composer-tools">
                    <button
                      type="button"
                      className="composer-upload-btn"
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach file"
                      title="Attach file, image, or document"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <line x1="8" y1="3" x2="8" y2="13" />
                        <line x1="3" y1="8" x2="13" y2="8" />
                      </svg>
                    </button>
                  </div>
                  <div className="composer-meta">
                    <button
                      className="send-button"
                      type="submit"
                      disabled={busy === "message" || turnInFlight || (!composerDraft.trim() && composerImages.length === 0 && composerFiles.length === 0)}
                      aria-label="Send message"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="7" y1="12" x2="7" y2="2" />
                        <polyline points="3 6 7 2 11 6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </form>
          ) : null}
        </section>
        )}

        {/* ======== RIGHT SIDEBAR: Study Tools ======== */}
        {!studyToolsCollapsed ? (
          <aside className="tools-panel">
            <div className="tools-header">
              <div>
                <span className="tools-kicker">Study Tools</span>
                {selectedProject ? <strong>{selectedProject.name}</strong> : null}
              </div>
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => setStudyToolsCollapsed(true)}
                aria-label="Hide study tools"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 3 9 7 4 11" />
                </svg>
              </button>
            </div>

            <div className="tools-body">
              {/* Quick-create buttons */}
              {selectedTask ? (
                <div className="quick-create-grid">
                  <button
                    className="quick-create-btn flashcards"
                    type="button"
                    onClick={() => handleStudyToolClick("flashcards")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <span className="material-symbols-outlined">style</span>
                    Flashcards
                  </button>
                  <button
                    className="quick-create-btn mindmap"
                    type="button"
                    onClick={() => handleStudyToolClick("mindmap")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <span className="material-symbols-outlined">hub</span>
                    Mind Map
                  </button>
                  <button
                    className="quick-create-btn quiz"
                    type="button"
                    onClick={() => handleStudyToolClick("quiz")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <span className="material-symbols-outlined">quiz</span>
                    Quiz
                  </button>
                  <button
                    className="quick-create-btn diagram"
                    type="button"
                    onClick={() => handleStudyToolClick("diagram")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <span className="material-symbols-outlined">schema</span>
                    Diagram
                  </button>
                  <button
                    className="quick-create-btn study_doc"
                    type="button"
                    onClick={() => {
                      if (!selectedTask) return;
                      void (async () => {
                        try {
                          const payload = JSON.stringify({
                            kind: "study_doc",
                            title: "Untitled Notes",
                            markdown: "",
                          });
                          const artifact = await request<StudyArtifactRecord>(
                            `/api/tasks/${selectedTask.id}/study-artifacts`,
                            { method: "POST", body: JSON.stringify({ kind: "study_doc", title: "Untitled Notes", payload }) }
                          );
                          setStudyArtifacts((cur) => ({
                            ...cur,
                            [selectedTask.id]: [...(cur[selectedTask.id] ?? []), artifact],
                          }));
                          setOpenWorkspacePreview(null);
                          setOpenArtifact(artifact);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Failed to create study doc");
                        }
                      })();
                    }}
                    disabled={busy === "message"}
                  >
                    <span className="material-symbols-outlined">description</span>
                    Study Doc
                  </button>
                  <button
                    className="quick-create-btn mock_exam"
                    type="button"
                    onClick={() => handleStudyToolClick("mock_exam")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <span className="material-symbols-outlined">checklist</span>
                    Mock Exam
                  </button>

                  {/* Custom artifact input */}
                  <div className="custom-create-section">
                    <textarea
                      className="custom-create-input"
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="Describe what you'd like Stuart to create..."
                      rows={2}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && customPrompt.trim()) {
                          e.preventDefault();
                          const prompt = `Create a custom study artifact: ${customPrompt.trim()}`;
                          setCustomPrompt("");
                          void (async () => {
                            try {
                              setBusy("message");
                              setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking...", recentActions: [] });
                              const result = await request<SendMessageResponse>(
                                `/api/tasks/${selectedTask.id}/messages`,
                                { method: "POST", body: JSON.stringify({ content: prompt }) }
                              );
                              setMessagesByTask((cur) => ({
                                ...cur,
                                [selectedTask.id]: [...(cur[selectedTask.id] ?? []), result.userMessage]
                              }));
                              if (!result.startedTurn) {
                                setThinkingState((cur) => (cur?.taskId === selectedTask.id ? null : cur));
                              }
                              setComposerDraft("");
                            } catch (caughtError) {
                              setError(caughtError instanceof Error ? caughtError.message : "Failed to send message");
                            } finally {
                              setBusy(null);
                            }
                          })();
                        }
                      }}
                    />
                    <button
                      className="accent-button compact custom-generate-btn"
                      type="button"
                      disabled={busy === "message" || turnInFlight || !customPrompt.trim()}
                      onClick={() => {
                        if (!customPrompt.trim()) return;
                        const prompt = `Create a custom study artifact: ${customPrompt.trim()}`;
                        setCustomPrompt("");
                        void (async () => {
                          try {
                            setBusy("message");
                            setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking...", recentActions: [] });
                            const result = await request<SendMessageResponse>(
                              `/api/tasks/${selectedTask.id}/messages`,
                              { method: "POST", body: JSON.stringify({ content: prompt }) }
                            );
                            setMessagesByTask((cur) => ({
                              ...cur,
                              [selectedTask.id]: [...(cur[selectedTask.id] ?? []), result.userMessage]
                            }));
                            if (!result.startedTurn) {
                              setThinkingState((cur) => (cur?.taskId === selectedTask.id ? null : cur));
                            }
                            setComposerDraft("");
                          } catch (caughtError) {
                            setError(caughtError instanceof Error ? caughtError.message : "Failed to send message");
                          } finally {
                            setBusy(null);
                          }
                        })();
                      }}
                    >
                      Generate
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tools-empty">
                  <p>Add study materials to unlock study tools.</p>
                </div>
              )}

              {/* Example demos section */}
              {selectedTask && selectedStudyArtifacts.length === 0 ? (
                <div className="tools-section">
                  <span className="tools-section-label">See how it works</span>
                  <div className="demo-card-list">
                    {ALL_DEMOS.map((demo) => (
                      <button
                        key={demo.kind}
                        type="button"
                        className={`demo-card ${demo.kind}`}
                        onClick={() => {
                          setOpenWorkspacePreview(null);
                          setOpenDemoArtifact({
                            kind: demo.draft.kind,
                            title: demo.title,
                            payload: JSON.stringify(demo.draft),
                          });
                        }}
                      >
                        <span className={`kind-badge ${demo.kind}`}>{demo.kind}</span>
                        <span className="demo-card-title">{demo.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Review section */}
              {reviewData.loaded && selectedTask && (reviewData.cardsDue > 0 || reviewData.weakTopics.length > 0 || selectedStudyArtifacts.some((a) => a.kind === "flashcards" || a.kind === "quiz")) ? (
                <ReviewPanel
                  taskId={selectedTask.id}
                  artifacts={selectedStudyArtifacts}
                  cardsDue={reviewData.cardsDue}
                  weakTopics={reviewData.weakTopics}
                  onOpenArtifact={(artifact) => {
                    setOpenWorkspacePreview(null);
                    setOpenArtifact(artifact);
                  }}
                  onError={(msg) => setError(msg)}
                />
              ) : null}

              {/* Generated study artifacts */}
              {selectedStudyArtifacts.length > 0 ? (
                <div className="tools-section">
                  <span className="tools-section-label">Your study artifacts</span>
                  {/* Filter pills */}
                  {(() => {
                    const kindLabels: Record<string, string> = {
                      study_doc: "Docs", flashcards: "Cards", quiz: "Quiz",
                      mindmap: "Maps", diagram: "Diagrams", mock_exam: "Exams",
                      interactive: "Apps", document_docx: "DOCX", document_xlsx: "XLSX",
                      document_pptx: "PPTX", document_pdf: "PDF", custom: "Other", other: "Other",
                    };
                    const activeKinds = Object.entries(groupedArtifacts).filter(([, a]) => a.length > 0);
                    if (activeKinds.length <= 1) return null;
                    return (
                      <div className="artifact-filter-pills">
                        <button
                          className={`artifact-filter-pill${artifactFilter === null ? " active" : ""}`}
                          type="button"
                          onClick={() => setArtifactFilter(null)}
                        >All</button>
                        {activeKinds.map(([kind, artifacts]) => (
                          <button
                            key={kind}
                            className={`artifact-filter-pill ${kind}${artifactFilter === kind ? " active" : ""}`}
                            type="button"
                            onClick={() => setArtifactFilter(artifactFilter === kind ? null : kind)}
                          >{kindLabels[kind] ?? kind} <span className="artifact-filter-count">{artifacts.length}</span></button>
                        ))}
                      </div>
                    );
                  })()}
                  {Object.entries(groupedArtifacts).map(([kind, artifacts]) => {
                    if (artifacts.length === 0) return null;
                    if (artifactFilter !== null && artifactFilter !== kind) return null;
                    return (
                      <div key={kind} className="artifact-folder">
                        {artifactFilter === null && (
                          <div className="artifact-folder-header">
                            <span className={`kind-badge ${kind}`}>{kind.replace(/_/g, " ").replace(/\bdocument /g, "").toUpperCase()}</span>
                            <span className="artifact-folder-count">{artifacts.length}</span>
                          </div>
                        )}
                        <div className="artifact-folder-items">
                          {artifacts.map((artifact) => (
                            <div key={artifact.id} className="artifact-card-row">
                              <button
                                className={`artifact-card-compact${openArtifact?.id === artifact.id ? " active" : ""}`}
                                onClick={() => {
                                  setOpenWorkspacePreview(null);
                                  setOpenArtifact(artifact);
                                }}
                              >
                                <span className="artifact-card-title">{artifact.title || `Untitled ${artifact.kind}`}</span>
                                <span className="artifact-card-date">{formatDate(artifact.createdAt)}</span>
                              </button>
                              <ArtifactMenu
                                onDelete={() => {
                                  if (selectedTask) {
                                    setPendingDeleteArtifact({
                                      id: artifact.id,
                                      title: artifact.title || `Untitled ${artifact.kind}`,
                                      taskId: selectedTask.id,
                                    });
                                  }
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : selectedTask ? (
                <div className="tools-section">
                  <span className="tools-section-label">Your study artifacts</span>
                  <p className="tools-empty-note">
                    Use the buttons above to create flashcards, quizzes, and more from your materials.
                  </p>
                </div>
              ) : null}

              {/* Session management */}
              {selectedTask ? (
                <div className="tools-section tools-session-actions">
                  <button
                    className="ghost-button compact"
                    type="button"
                    onClick={() => void archiveTask(selectedTask.id)}
                  >
                    Archive session
                  </button>
                </div>
              ) : null}
            </div>
            <UsagePanel />
          </aside>
        ) : (
          <button
            className="tools-collapsed-tab"
            type="button"
            onClick={() => setStudyToolsCollapsed(false)}
            aria-label="Show study tools"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 3 4 7 9 11" />
            </svg>
            <span>Study Tools</span>
          </button>
        )}

        {/* ======== Artifact Divider + Preview Pane ======== */}
        {isArtifactOpen && (
          <>
            <div
              className="artifact-divider"
              onPointerDown={() => {
                artifactResizeRef.current = true;
                setIsArtifactResizing(true);
              }}
            />
            {openWorkspacePreview ? (
              <WorkspacePreviewPanel
                preview={openWorkspacePreview}
                onClose={() => setOpenWorkspacePreview(null)}
              />
            ) : (
              <ArtifactCanvas
                title={openArtifact?.title ?? openDemoArtifact?.title ?? ""}
                kind={openArtifact?.kind ?? openDemoArtifact?.kind ?? "flashcards"}
                payload={openArtifact?.payload ?? openDemoArtifact?.payload ?? "{}"}
                onClose={() => { setOpenArtifact(null); setOpenDemoArtifact(null); setInlineResponse(null); setIsInlineLoading(false); void endStudySession(); }}
                onDelete={openArtifact && selectedTask ? () => {
                  setPendingDeleteArtifact({
                    id: openArtifact.id,
                    title: openArtifact.title || `Untitled ${openArtifact.kind}`,
                    taskId: selectedTask.id,
                  });
                } : undefined}
                onExplain={(message) => {
                  if (selectedTaskId) void sendTaskMessage(selectedTaskId, message);
                }}
                artifactDbId={openArtifact?.id}
                taskId={selectedTaskId ?? undefined}
                onSavePayload={openArtifact ? async (newPayload: string) => {
                  try {
                    await request(`/api/study-artifacts/${openArtifact.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ payload: newPayload }),
                    });
                    setStudyArtifacts((cur) => ({
                      ...cur,
                      [selectedTaskId!]: (cur[selectedTaskId!] ?? []).map((a) =>
                        a.id === openArtifact.id ? { ...a, payload: newPayload } : a
                      ),
                    }));
                    setOpenArtifact((cur) => cur ? { ...cur, payload: newPayload } : null);
                  } catch { /* save failed silently */ }
                } : undefined}
                socraticEnabled={selectedProject?.config?.teachingStyle?.trim().toLowerCase() === "socratic"}
                onInlineAsk={(message) => {
                  if (!selectedTaskId) return;
                  setInlineResponse(null);
                  setIsInlineLoading(true);
                  void (async () => {
                    try {
                      await sendTaskMessage(selectedTaskId, message);
                    } catch {
                      setIsInlineLoading(false);
                    }
                  })();
                }}
                inlineResponse={inlineResponse}
                isInlineLoading={isInlineLoading}
              />
            )}
          </>
        )}
      </div>

      {/* ---- Delete Confirmation Modal ---- */}
      {pendingDeleteArtifact && (
        <div className="modal-overlay" onClick={() => setPendingDeleteArtifact(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete artifact?</h3>
            <p className="modal-body">
              Are you sure you want to delete <strong>{pendingDeleteArtifact.title}</strong>? This cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => setPendingDeleteArtifact(null)}
              >
                Cancel
              </button>
              <button
                className="ghost-button compact destructive-text"
                type="button"
                onClick={() => {
                  void deleteStudyArtifact(pendingDeleteArtifact.id, pendingDeleteArtifact.taskId);
                  setPendingDeleteArtifact(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Onboarding Modal Overlay ---- */}
      {onboardingState && (
        <div className="onboarding-overlay">
          <WorkspaceOnboarding
            projectId={onboardingState.projectId}
            path={onboardingState.path}
            diagnostics={diagnostics}
            initialConfig={projects.find((project) => project.id === onboardingState.projectId)?.config}
            onSubmit={(pid, p, cfg) => void continueWorkspaceSetup(pid, p, cfg)}
            onSkip={(pid, p) => void continueWorkspaceSetup(pid, p)}
          />
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Helper Functions
   ================================================================ */

function inferProjectName(folderPath: string): string {
  const trimmed = folderPath.trim().replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").filter(Boolean).pop();
  return lastSegment || "My Materials";
}

function buildWorkspaceScopeKey(taskId: string, runId: string | null) {
  return `${taskId}:${runId ?? "no-run"}`;
}

function upsertMessage(messages: TaskMessageRecord[], nextMessage: TaskMessageRecord) {
  const withoutExisting = messages.filter((m) => m.id !== nextMessage.id);
  return [...withoutExisting, nextMessage].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
}

function upsertAgentActivity(current: AgentActivity[], next: AgentActivity) {
  const withoutExisting = current.filter(
    (item) => item.id !== next.id || item.source !== next.source
  );
  return [...withoutExisting, next].sort(compareAgentActivity);
}

function compareAgentActivity(left: AgentActivity, right: AgentActivity) {
  const statusWeight = (status: AgentStatus) =>
    status === "running" ? 0 : status === "failed" ? 1 : 2;
  return (
    statusWeight(left.status) - statusWeight(right.status) ||
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function pruneRecord<T>(record: Record<string, T>, allowedKeys: string[]) {
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => allowed.has(key))
  ) as Record<string, T>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function summarizeDiagnostics(checks: SystemDiagnosticCheck[]) {
  const requiredErrors = checks.filter((check) => check.required && check.status === "error").length;
  const optionalWarnings = checks.filter((check) => !check.required && check.status === "warn").length;
  return { requiredErrors, optionalWarnings };
}

function buildDiagnosticsFingerprint(diagnostics: SystemDiagnostics): string {
  const checks = [...diagnostics.checks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((check) => ({
      id: check.id,
      status: check.status,
      required: check.required,
      summary: check.summary,
      detail: check.detail ?? "",
      resolution: check.resolution ?? "",
      command: check.command ?? "",
    }));
  return JSON.stringify({
    overallStatus: diagnostics.overallStatus,
    requiredReady: diagnostics.requiredReady,
    checks,
  });
}

function readDismissedDiagnosticsFingerprint() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(DIAGNOSTICS_DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissedDiagnosticsFingerprint(fingerprint: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (fingerprint) {
      window.localStorage.setItem(DIAGNOSTICS_DISMISS_KEY, fingerprint);
    } else {
      window.localStorage.removeItem(DIAGNOSTICS_DISMISS_KEY);
    }
  } catch {
    // Ignore storage failures; dismissal just won't persist.
  }
}

function getProviderOption(provider: RuntimeProvider) {
  return PROVIDER_OPTIONS.find((option) => option.id === provider) ?? PROVIDER_OPTIONS[0]!;
}

function getDefaultRuntimeProfile(provider: RuntimeProvider): TaskRuntimeProfile {
  const option = getProviderOption(provider);
  return {
    provider: option.id,
    authMode: option.authMode,
    model: option.models[0]?.id ?? DEFAULT_TASK_RUNTIME_PROFILE.model,
    native: option.native,
  };
}

function resolveWorkspaceRuntimeProfile(config?: WorkspaceConfig | null): TaskRuntimeProfile {
  if (!config?.runtimeProfile?.provider) {
    return { ...DEFAULT_TASK_RUNTIME_PROFILE };
  }
  const fallback = getDefaultRuntimeProfile(config.runtimeProfile.provider);
  return {
    provider: config.runtimeProfile.provider,
    authMode: config.runtimeProfile.authMode ?? fallback.authMode,
    model: config.runtimeProfile.model ?? fallback.model,
    native: config.runtimeProfile.native ?? fallback.native,
  };
}

function resolveWorkspaceStartMode(config?: WorkspaceConfig | null): WorkspaceStartMode {
  return config?.startupPreferences?.startMode ?? "guided";
}

function getDiagnosticCheck(diagnostics: SystemDiagnostics | null | undefined, id: string) {
  return diagnostics?.checks.find((check) => check.id === id) ?? null;
}

function getProviderSetupState(
  provider: RuntimeProvider,
  diagnostics: SystemDiagnostics | null | undefined
): {
  ready: boolean;
  tone: "ok" | "warn" | "error";
  summary: string;
  detail?: string;
} {
  if (provider === "codex") {
    const cli = getDiagnosticCheck(diagnostics, "codex-cli");
    const auth = getDiagnosticCheck(diagnostics, "codex-auth");
    if (cli?.status === "ok" && auth?.status === "ok") {
      return { ready: true, tone: "ok", summary: "Ready", detail: "Codex runtime and authentication are both available." };
    }
    if (cli?.status === "error") {
      return { ready: false, tone: "error", summary: "Setup needed", detail: cli.resolution ?? cli.detail ?? cli.summary };
    }
    return { ready: false, tone: "warn", summary: "Auth needed", detail: auth?.resolution ?? auth?.detail ?? auth?.summary ?? "Connect ChatGPT before starting with Codex." };
  }

  const checkId = provider === "gemini" ? "gemini-native" : "minimax-native";
  const check = getDiagnosticCheck(diagnostics, checkId);
  return {
    ready: check?.status === "ok",
    tone: check?.status === "ok" ? "ok" : "warn",
    summary: check?.status === "ok" ? "Configured" : "Config missing",
    detail: check?.resolution ?? check?.detail ?? check?.summary,
  };
}

const TEACHING_STYLES = ["Concise", "Detailed", "Socratic", "Exam-focused"];
const GOALS = ["Understand material", "Prepare for exam", "Essay writing", "General"];
const START_MODES: Array<{
  id: WorkspaceStartMode;
  label: string;
  description: string;
}> = [
  {
    id: "guided",
    label: "Guided start",
    description: "Stuart maps the workspace first, gives a concise overview, then asks where to focus.",
  },
  {
    id: "direct",
    label: "Direct start",
    description: "Stuart prepares quietly, confirms the workspace is ready, and waits for your first real question.",
  },
];
const PROVIDER_OPTIONS: Array<{
  id: RuntimeProvider;
  label: string;
  native: boolean;
  authMode: TaskRuntimeProfile["authMode"];
  description: string;
  note: string;
  models: Array<{ id: string; label: string; detail: string }>;
}> = [
  {
    id: "codex",
    label: "Codex",
    native: false,
    authMode: "chatgpt",
    description: "Best integrated path for Stuart today. Strong tooling, web access, and workspace continuity.",
    note: "Uses Stuart's managed Codex runtime.",
    models: [
      { id: "gpt-5.4-mini", label: "Balanced", detail: "Fast default for normal study turns." },
      { id: "gpt-5.4", label: "Deep reasoning", detail: "Use when you want heavier planning and harder artifact turns." },
    ],
  },
  {
    id: "gemini",
    label: "Gemini Native",
    native: true,
    authMode: "api_key",
    description: "Direct Gemini API profile for lower-friction native integration work.",
    note: "Configured via API key. Stuart stores this profile while native transport hardening continues.",
    models: [
      { id: "gemini-2.5-flash", label: "Flash", detail: "Best price-performance for high-volume study flows." },
      { id: "gemini-2.5-pro", label: "Pro", detail: "Stronger for complex reasoning and longer synthesis turns." },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax Native",
    native: true,
    authMode: "api_key",
    description: "Direct MiniMax API profile aimed at lightweight native model routing.",
    note: "Public docs clearly expose API-key auth; the OAuth flow I found is currently documented through OpenClaw setup.",
    models: [
      { id: "MiniMax-M2.7", label: "M2.7", detail: "Current general-purpose flagship listed in MiniMax docs." },
      { id: "MiniMax-M2.5", label: "M2.5", detail: "Conservative fallback profile for existing integrations." },
    ],
  },
];

function WorkspaceOnboarding({
  projectId,
  path,
  diagnostics,
  initialConfig,
  onSubmit,
  onSkip,
}: {
  projectId: string;
  path: string;
  diagnostics: SystemDiagnostics | null;
  initialConfig?: WorkspaceConfig;
  onSubmit: (projectId: string, path: string, config: WorkspaceConfig) => void;
  onSkip: (projectId: string, path: string) => void;
}) {
  const initialRuntimeProfile = resolveWorkspaceRuntimeProfile(initialConfig);
  const initialTeachingStyle = initialConfig?.teachingStyle ?? "";
  const initialGoal = initialConfig?.goal ?? "";
  const [subject, setSubject] = useState(initialConfig?.subject ?? "");
  const [teachingStyle, setTeachingStyle] = useState(
    initialTeachingStyle && !TEACHING_STYLES.includes(initialTeachingStyle) ? "Custom" : initialTeachingStyle
  );
  const [customStyle, setCustomStyle] = useState(
    initialTeachingStyle && !TEACHING_STYLES.includes(initialTeachingStyle) ? initialTeachingStyle : ""
  );
  const [goal, setGoal] = useState(
    initialGoal && !GOALS.includes(initialGoal) ? "Custom" : initialGoal
  );
  const [customGoal, setCustomGoal] = useState(
    initialGoal && !GOALS.includes(initialGoal) ? initialGoal : ""
  );
  const [additionalNotes, setAdditionalNotes] = useState(initialConfig?.additionalNotes ?? "");
  const [provider, setProvider] = useState<RuntimeProvider>(initialRuntimeProfile.provider);
  const [selectedModel, setSelectedModel] = useState(initialRuntimeProfile.model);
  const [startMode, setStartMode] = useState<WorkspaceStartMode>(resolveWorkspaceStartMode(initialConfig));
  const [saving, setSaving] = useState(false);

  const effectiveStyle = teachingStyle === "Custom" ? customStyle : teachingStyle;
  const effectiveGoal = goal === "Custom" ? customGoal : goal;
  const providerOption = getProviderOption(provider);
  const providerSetup = getProviderSetupState(provider, diagnostics);

  useEffect(() => {
    if (!providerOption.models.some((model) => model.id === selectedModel)) {
      setSelectedModel(providerOption.models[0]?.id ?? DEFAULT_TASK_RUNTIME_PROFILE.model);
    }
  }, [providerOption, selectedModel]);

  async function handleSubmit() {
    setSaving(true);
    const config: WorkspaceConfig = {};
    if (subject.trim()) config.subject = subject.trim();
    if (effectiveStyle.trim()) config.teachingStyle = effectiveStyle.trim();
    if (effectiveGoal.trim()) config.goal = effectiveGoal.trim();
    if (additionalNotes.trim()) config.additionalNotes = additionalNotes.trim();
    config.runtimeProfile = {
      provider,
      authMode: providerOption.authMode,
      model: selectedModel,
      native: providerOption.native,
    };
    config.startupPreferences = { startMode };

    try {
      await request<ProjectRecord>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ config } satisfies { config: WorkspaceConfig })
      });
    } catch {
      // Continue even if patch fails — config is non-critical
    }
    onSubmit(projectId, path, config);
  }

  return (
    <div className="onboarding-card">
      <div className="onboarding-header">
        <div>
          <h2>Set up your workspace</h2>
          <p className="onboarding-subtitle">Pick the runtime target, how the first session should begin, and how Stuart should teach. You can change this later.</p>
        </div>
        <div className="onboarding-runtime-pill">Workspace runtime</div>
      </div>

      <div className="onboarding-section">
        <div className="onboarding-section-head">
          <strong>Runtime target</strong>
          <span>{providerOption.note}</span>
        </div>
        <div className="onboarding-provider-grid">
          {PROVIDER_OPTIONS.map((option) => {
            const setup = getProviderSetupState(option.id, diagnostics);
            return (
              <button
                key={option.id}
                type="button"
                className={`onboarding-provider${provider === option.id ? " selected" : ""}`}
                onClick={() => {
                  setProvider(option.id);
                  setSelectedModel(option.models[0]?.id ?? DEFAULT_TASK_RUNTIME_PROFILE.model);
                }}
              >
                <div className="onboarding-provider-topline">
                  <strong>{option.label}</strong>
                  <span className={`onboarding-status-badge ${setup.tone}`}>{setup.summary}</span>
                </div>
                <p>{option.description}</p>
                <span className="onboarding-provider-note">{setup.detail ?? option.note}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="onboarding-section">
        <div className="onboarding-section-head">
          <strong>Model selection</strong>
          <span>Keep this simple: balanced for normal study, deeper model for heavier synthesis.</span>
        </div>
        <div className="onboarding-model-grid">
          {providerOption.models.map((model) => (
            <button
              key={model.id}
              type="button"
              className={`onboarding-model${selectedModel === model.id ? " selected" : ""}`}
              onClick={() => setSelectedModel(model.id)}
            >
              <strong>{model.label}</strong>
              <span>{model.id}</span>
              <p>{model.detail}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="onboarding-section">
        <div className="onboarding-section-head">
          <strong>How Stuart should start</strong>
          <span>This changes the first reply and the amount of onboarding friction.</span>
        </div>
        <div className="onboarding-start-grid">
          {START_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`onboarding-start-option${startMode === mode.id ? " selected" : ""}`}
              onClick={() => setStartMode(mode.id)}
            >
              <strong>{mode.label}</strong>
              <p>{mode.description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="onboarding-field">
        <label>Subject</label>
        <input
          type="text"
          placeholder="e.g., Operating Systems, Constitutional Law"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="onboarding-field">
        <label>Teaching style</label>
        <div className="onboarding-chips">
          {TEACHING_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              className={`onboarding-chip${teachingStyle === s ? " selected" : ""}`}
              onClick={() => setTeachingStyle(teachingStyle === s ? "" : s)}
            >{s}</button>
          ))}
          <button
            type="button"
            className={`onboarding-chip${teachingStyle === "Custom" ? " selected" : ""}`}
            onClick={() => setTeachingStyle(teachingStyle === "Custom" ? "" : "Custom")}
          >Custom</button>
        </div>
        {teachingStyle === "Custom" && (
          <input
            type="text"
            placeholder="Describe your preferred style"
            value={customStyle}
            onChange={(e) => setCustomStyle(e.target.value)}
            style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div className="onboarding-field">
        <label>Goal</label>
        <div className="onboarding-chips">
          {GOALS.map((g) => (
            <button
              key={g}
              type="button"
              className={`onboarding-chip${goal === g ? " selected" : ""}`}
              onClick={() => setGoal(goal === g ? "" : g)}
            >{g}</button>
          ))}
          <button
            type="button"
            className={`onboarding-chip${goal === "Custom" ? " selected" : ""}`}
            onClick={() => setGoal(goal === "Custom" ? "" : "Custom")}
          >Custom</button>
        </div>
        {goal === "Custom" && (
          <input
            type="text"
            placeholder="Describe your goal"
            value={customGoal}
            onChange={(e) => setCustomGoal(e.target.value)}
            style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div className="onboarding-field">
        <label>Additional notes <span style={{ fontWeight: 400, color: "var(--ink-muted)" }}>(optional)</span></label>
        <textarea
          placeholder="Anything else Stuart should know — e.g., exam date, areas of difficulty, preferred examples..."
          value={additionalNotes}
          onChange={(e) => setAdditionalNotes(e.target.value)}
          rows={3}
        />
      </div>

      {!providerSetup.ready ? (
        <div className={`onboarding-inline-note ${providerSetup.tone}`}>
          <strong>{providerOption.label} needs setup.</strong>
          <span>{providerSetup.detail ?? "Finish the runtime setup before starting with this profile."}</span>
        </div>
      ) : null}

      <div className="onboarding-actions">
        <button
          className="accent-button"
          type="button"
          onClick={() => void handleSubmit()}
          disabled={saving || !providerSetup.ready}
        >
          {saving ? "Starting..." : startMode === "guided" ? "Start guided session" : "Start direct session"}
        </button>
        <button
          className="onboarding-skip"
          type="button"
          onClick={() => onSkip(projectId, path)}
          disabled={saving}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function DiagnosticsCard({
  diagnostics,
  surface = "developer",
  compact = false,
  onDismiss,
}: {
  diagnostics: SystemDiagnostics;
  surface?: "developer" | "desktop";
  compact?: boolean;
  onDismiss?: () => void;
}) {
  const { requiredErrors, optionalWarnings } = summarizeDiagnostics(diagnostics.checks);
  const visibleChecks = compact ? diagnostics.checks.filter((check) => check.status !== "ok").slice(0, 4) : diagnostics.checks;

  return (
    <section className={`diagnostics-card diagnostics-${diagnostics.overallStatus}${compact ? " compact" : ""}`}>
      <div className="diagnostics-header">
        <div>
          <span className="diagnostics-kicker">System Check</span>
          <strong>
            {requiredErrors > 0
              ? `${requiredErrors} required issue${requiredErrors === 1 ? "" : "s"}`
              : optionalWarnings > 0
                ? `${optionalWarnings} optional gap${optionalWarnings === 1 ? "" : "s"}`
                : "Ready to study"}
          </strong>
        </div>
        <span className={`diagnostics-pill ${diagnostics.overallStatus}`}>
          {diagnostics.overallStatus === "error" ? "Action needed" : diagnostics.overallStatus === "warn" ? "Partial" : "Ready"}
        </span>
      </div>
      {onDismiss ? (
        <div className="diagnostics-actions">
          <button className="ghost-button compact" type="button" onClick={onDismiss} aria-label="Dismiss system check">
            Dismiss
          </button>
        </div>
      ) : null}
      <p className="diagnostics-summary">
        {requiredErrors > 0
          ? (surface === "desktop"
            ? "Stuart needs the required checks below before it can start your study workspace."
            : "Fix the required checks below before expecting Stuart to boot cleanly.")
          : optionalWarnings > 0
            ? (surface === "desktop"
              ? "Stuart can start now. The optional items below only unlock higher-fidelity extras."
              : "Stuart can start, but some optional capabilities are unavailable.")
            : (surface === "desktop" ? "Stuart is ready. You can connect your account and start studying." : "Core prerequisites look good.")}
      </p>
      <div className="diagnostics-list">
        {visibleChecks.map((check) => (
          <div key={check.id} className={`diagnostic-row status-${check.status}`}>
            <div className="diagnostic-main">
              <div className="diagnostic-title-row">
                <span className="diagnostic-dot" />
                <strong>{check.label}</strong>
                {check.required ? <span className="diagnostic-required">required</span> : null}
              </div>
              <p>{check.summary}</p>
              {check.detail ? <span className="diagnostic-detail">{check.detail}</span> : null}
              {check.resolution ? <span className="diagnostic-resolution">{check.resolution}</span> : null}
              {surface === "developer" && check.command ? <code className="diagnostic-command">{check.command}</code> : null}
            </div>
          </div>
        ))}
      </div>
      {surface === "developer" && (requiredErrors > 0 || optionalWarnings > 0) ? (
        <div className="diagnostics-footer">
          <code>pnpm preflight</code>
          <span>Run this in the repo root for a full terminal report.</span>
        </div>
      ) : null}
    </section>
  );
}

function DiagnosticsDismissedNotice({
  onShow,
  compact = false,
}: {
  onShow: () => void;
  compact?: boolean;
}) {
  return (
    <section className={`diagnostics-dismissed${compact ? " compact" : ""}`}>
      <div>
        <span className="diagnostics-kicker">System Check</span>
        <strong>Hidden</strong>
      </div>
      <button className="ghost-button compact" type="button" onClick={onShow}>
        Show
      </button>
    </section>
  );
}

/* DesktopOnboardingView removed — Codex auth status is now shown inline as codex-auth-bar */

/* ================================================================
   Dashboard View
   ================================================================ */

/* ================================================================
   Usage Panel — compact Codex usage tracking
   ================================================================ */

type UsageSnapshot = {
  primaryUsedPercent: number;
  primaryResetsAt: string;
  primaryWindowMins: number;
  secondaryUsedPercent: number;
  secondaryResetsAt: string;
  secondaryWindowMins: number;
  hasCredits: boolean;
  creditsUnlimited: boolean;
  creditsBalance: string;
  planType: string;
  email: string;
  capturedAt: string;
};

function usageBarColor(pct: number): string {
  if (pct > 95) return "usage-bar-danger";
  if (pct >= 80) return "usage-bar-warning";
  return "usage-bar-ok";
}

function formatResetsIn(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function formatUpdatedAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function UsagePanel() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchUsage() {
      try {
        const res = await fetch(apiUrl("/api/usage/codex"));
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.snapshot) {
          setSnapshot(data.snapshot);
          setLoaded(true);
        }
      } catch {
        // silently ignore — panel just won't show
      }
    }

    void fetchUsage();
    const timer = setInterval(fetchUsage, 120_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!loaded || !snapshot) return null;

  const planLabel = snapshot.planType
    ? snapshot.planType.charAt(0).toUpperCase() + snapshot.planType.slice(1)
    : "Free";

  return (
    <div className="usage-wrapper">
      {/* Compact trigger — always visible */}
      <div className="usage-trigger">
        <span className="usage-plan-badge">{planLabel}</span>
        <div className="usage-trigger-bars">
          <div className="usage-trigger-bar">
            <div className={`usage-trigger-fill ${usageBarColor(snapshot.primaryUsedPercent)}`} style={{ width: `${Math.min(snapshot.primaryUsedPercent, 100)}%` }} />
          </div>
          <div className="usage-trigger-bar">
            <div className={`usage-trigger-fill ${usageBarColor(snapshot.secondaryUsedPercent)}`} style={{ width: `${Math.min(snapshot.secondaryUsedPercent, 100)}%` }} />
          </div>
        </div>
        <span className="usage-trigger-pct">{snapshot.primaryUsedPercent}%</span>
      </div>

      {/* Expanded panel — shown on hover */}
      <div className="usage-panel">
        <div className="usage-header">
          <span className="usage-plan-badge">{planLabel}</span>
          <span className="usage-updated">{formatUpdatedAgo(snapshot.capturedAt)}</span>
        </div>

        <div className="usage-meter">
          <div className="usage-meter-label">
            <span>Rate limit</span>
            <span className="usage-meter-value">{snapshot.primaryUsedPercent}%</span>
          </div>
          <div className="usage-bar-track">
            <div className={`usage-bar-fill ${usageBarColor(snapshot.primaryUsedPercent)}`} style={{ width: `${Math.min(snapshot.primaryUsedPercent, 100)}%` }} />
          </div>
          <span className="usage-resets">resets in {formatResetsIn(snapshot.primaryResetsAt)}</span>
        </div>

        <div className="usage-meter">
          <div className="usage-meter-label">
            <span>Weekly</span>
            <span className="usage-meter-value">{snapshot.secondaryUsedPercent}%</span>
          </div>
          <div className="usage-bar-track">
            <div className={`usage-bar-fill ${usageBarColor(snapshot.secondaryUsedPercent)}`} style={{ width: `${Math.min(snapshot.secondaryUsedPercent, 100)}%` }} />
          </div>
          <span className="usage-resets">resets in {formatResetsIn(snapshot.secondaryResetsAt)}</span>
        </div>

        {snapshot.hasCredits ? (
          <div className="usage-credits">
            {snapshot.creditsUnlimited ? "Unlimited credits" : `$${snapshot.creditsBalance} credits`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ================================================================
   Review Panel — selectable decks for cross-deck flashcard + quiz review
   ================================================================ */

function ReviewPanel({
  taskId,
  artifacts,
  cardsDue,
  weakTopics,
  onOpenArtifact,
  onError,
}: {
  taskId: string;
  artifacts: StudyArtifactRecord[];
  cardsDue: number;
  weakTopics: Array<{ topic: string; totalAttempts: number; correctCount: number }>;
  onOpenArtifact: (artifact: StudyArtifactRecord) => void;
  onError: (msg: string) => void;
}) {
  const flashcardDecks = artifacts.filter((a) => a.kind === "flashcards");
  const quizDecks = artifacts.filter((a) => a.kind === "quiz");
  const [expanded, setExpanded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set([
    ...flashcardDecks.map((a) => a.id),
    ...quizDecks.map((a) => a.id),
  ]));
  const [mode, setMode] = useState<"cards" | "quiz">("cards");
  const [loading, setLoading] = useState(false);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startReview = async () => {
    setLoading(true);
    try {
      if (mode === "cards") {
        const allCards = await request<Array<{
          artifactId: string; artifactTitle: string; cardId: string;
          front: string; back: string; cue?: string;
          easeFactor: number; lastRating: string; reason: string;
        }>>(`/api/tasks/${taskId}/review-cards`);

        const filtered = allCards.filter((c) => selectedIds.has(c.artifactId));
        if (filtered.length === 0) { onError("No weak or due cards in selected decks."); return; }

        onOpenArtifact({
          id: `review-cards-${Date.now()}`, taskId, kind: "flashcards",
          title: `Review: ${filtered.length} weak/due cards`,
          payload: JSON.stringify({
            kind: "flashcards",
            title: `Review: ${filtered.length} weak/due cards`,
            cards: filtered.map((c) => ({ id: `${c.artifactId}__${c.cardId}`, front: c.front, back: c.back, cue: c.cue ?? "", citations: [] })),
          }),
          createdAt: new Date().toISOString(),
        } as any);
      } else {
        const allQ = await request<Array<{
          artifactId: string; artifactTitle: string; questionId: string;
          prompt: string; options: string[]; answer: string; explanation: string; selectedAnswer: string;
        }>>(`/api/tasks/${taskId}/review-questions`);

        const filtered = allQ.filter((q) => selectedIds.has(q.artifactId));
        if (filtered.length === 0) { onError("No wrong answers in selected quizzes."); return; }

        onOpenArtifact({
          id: `review-quiz-${Date.now()}`, taskId, kind: "quiz",
          title: `Retry: ${filtered.length} wrong answers`,
          payload: JSON.stringify({
            kind: "quiz",
            title: `Retry: ${filtered.length} wrong answers`,
            questions: filtered.map((q) => ({ id: `${q.artifactId}__${q.questionId}`, prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, optionExplanations: {}, citations: [] })),
          }),
          createdAt: new Date().toISOString(),
        } as any);
      }
    } catch { onError("Could not load review data."); }
    finally { setLoading(false); }
  };

  if (flashcardDecks.length === 0 && quizDecks.length === 0) return null;
  const currentDecks = mode === "cards" ? flashcardDecks : quizDecks;

  // Collapsed: single compact row
  if (!expanded) {
    return (
      <button className="review-compact-bar" type="button" onClick={() => setExpanded(true)}>
        <span className="review-compact-left">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.5" />
            <polyline points="8 4.5 8 8 10.5 9.5" />
          </svg>
          {cardsDue > 0
            ? <span><strong>{cardsDue}</strong> due</span>
            : <span>Review</span>}
          {weakTopics.length > 0 && (
            <span className="review-compact-weak">{weakTopics.length} weak area{weakTopics.length !== 1 ? "s" : ""}</span>
          )}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <polyline points="3 5 6 8 9 5" />
        </svg>
      </button>
    );
  }

  // Expanded
  return (
    <div className="tools-section review-section">
      <div className="review-header-row">
        <span className="tools-section-label">Review</span>
        <button className="review-collapse-btn" type="button" onClick={() => setExpanded(false)} title="Collapse">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <polyline points="3 8 6 5 9 8" />
          </svg>
        </button>
      </div>

      {weakTopics.length > 0 && (
        <div className="review-weak-topics">
          {weakTopics.slice(0, 3).map((t) => {
            const pct = t.totalAttempts > 0 ? Math.round((t.correctCount / t.totalAttempts) * 100) : 0;
            return (
              <div key={t.topic} className="review-weak-item">
                <span className="review-weak-topic">{t.topic}</span>
                <span className={`review-weak-pct${pct < 50 ? " low" : pct < 70 ? " mid" : ""}`}>{pct}%</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="review-mode-tabs">
        <button className={`review-mode-tab${mode === "cards" ? " active" : ""}`} type="button" onClick={() => setMode("cards")}>
          Cards ({flashcardDecks.length})
        </button>
        <button className={`review-mode-tab${mode === "quiz" ? " active" : ""}`} type="button" onClick={() => setMode("quiz")}>
          Quiz ({quizDecks.length})
        </button>
      </div>

      <div className="review-deck-list">
        {currentDecks.map((deck) => (
          <label key={deck.id} className="review-deck-item">
            <input type="checkbox" checked={selectedIds.has(deck.id)} onChange={() => toggleId(deck.id)} />
            <span className="review-deck-name">{deck.title || `Untitled`}</span>
          </label>
        ))}
      </div>

      <button className="review-practice-btn" type="button" onClick={() => void startReview()}
        disabled={loading || !currentDecks.some((d) => selectedIds.has(d.id))}>
        {loading ? "Loading..." : mode === "cards" ? "Review weak cards" : "Retry wrong answers"}
      </button>
    </div>
  );
}

/* ================================================================
   Canvas LMS Settings Panel
   ================================================================ */

type CanvasConnection = {
  id: string;
  label: string;
  baseUrl: string;
  userDisplayName?: string | null;
  userId?: string | null;
  isActive: boolean;
  lastVerifiedAt?: string | null;
  lastSyncAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type CanvasCourse = {
  id: string;
  name: string;
  courseCode: string;
  termName?: string | null;
  currentScore?: number | null;
};

type CanvasSyncProgress = {
  connectionId: string;
  phase: string;
  detail: string;
  percent: number;
};

type CanvasFileInfo = {
  id: string;
  name: string;
  folderPath: string;
  contentType: string;
  size: number;
  updatedAt: string;
};

function CanvasSettingsPanel({ onClose, pickFolder, onTaskCreated }: { onClose: () => void; pickFolder: (prompt: string) => Promise<string | null>; onTaskCreated: (taskId: string) => void }) {
  const [connections, setConnections] = useState<CanvasConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Connection form
  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formToken, setFormToken] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formBusy, setFormBusy] = useState(false);

  // Course picker
  const [coursePickerConnectionId, setCoursePickerConnectionId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CanvasCourse[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);

  // File browser (step between course selection and download)
  const [fileBrowserCourseId, setFileBrowserCourseId] = useState<string | null>(null);
  const [fileBrowserCourseName, setFileBrowserCourseName] = useState("");
  const [canvasFiles, setCanvasFiles] = useState<CanvasFileInfo[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState("");
  const [downloading, setDownloading] = useState(false);

  // Sync progress
  const [syncProgress, setSyncProgress] = useState<CanvasSyncProgress | null>(null);
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null);

  // Show help
  const [showTokenHelp, setShowTokenHelp] = useState(false);

  // Load connections on mount
  useEffect(() => {
    void loadConnections();
  }, []);

  // Listen for SSE sync events
  useEffect(() => {
    const evtSource = new EventSource(apiUrl("/api/events"));
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "canvas.sync.progress") {
          setSyncProgress({
            connectionId: data.connectionId,
            phase: data.phase ?? "Syncing",
            detail: data.detail ?? "",
            percent: data.percent ?? 0,
          });
        } else if (data.type === "canvas.sync.completed") {
          setSyncProgress(null);
          setSyncingConnectionId(null);
          setSuccess("Sync completed successfully.");
          void loadConnections();
        }
      } catch { /* ignore parse errors */ }
    };
    evtSource.addEventListener("message", handleMessage);
    return () => {
      evtSource.removeEventListener("message", handleMessage);
      evtSource.close();
    };
  }, []);

  async function loadConnections() {
    setLoadingConnections(true);
    setError(null);
    try {
      const data = await request<CanvasConnection[]>("/api/canvas/connections");
      setConnections(Array.isArray(data) ? data : []);
    } catch (err) {
      setConnections([]);
      // Not an error if the endpoint doesn't exist yet
      if (err instanceof Error && !err.message.includes("404")) {
        setError(err.message);
      }
    } finally {
      setLoadingConnections(false);
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await request<CanvasConnection>("/api/canvas/connections", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: formUrl.replace(/\/+$/, ""),
          token: formToken,
          label: formLabel || formUrl.replace(/https?:\/\//, "").replace(/\/.*$/, ""),
        }),
      });
      setSuccess("Canvas account connected successfully!");
      setFormUrl("");
      setFormToken("");
      setFormLabel("");
      setShowForm(false);
      void loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    try {
      await request(`/api/canvas/connections/${id}`, { method: "DELETE" });
      setConnections((prev) => prev.filter((c) => c.id !== id));
      if (coursePickerConnectionId === id) {
        setCoursePickerConnectionId(null);
        setCourses([]);
      }
      setSuccess("Connection removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove connection");
    }
  }

  async function handleSync(id: string) {
    setError(null);
    setSyncingConnectionId(id);
    setSyncProgress({ connectionId: id, phase: "Starting", detail: "Initiating sync...", percent: 0 });
    try {
      await request(`/api/canvas/connections/${id}/sync`, { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
      setSyncProgress(null);
      setSyncingConnectionId(null);
    }
  }

  async function handleLoadCourses(connectionId: string) {
    setCoursePickerConnectionId(connectionId);
    setLoadingCourses(true);
    setFileBrowserCourseId(null);
    setCanvasFiles([]);
    setSelectedFileIds(new Set());
    setError(null);
    try {
      const data = await request<CanvasCourse[]>(
        `/api/canvas/connections/${connectionId}/courses`
      );
      setCourses(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load courses");
      setCourses([]);
    } finally {
      setLoadingCourses(false);
    }
  }

  async function handleBrowseFiles(courseId: string, courseName: string) {
    setFileBrowserCourseId(courseId);
    setFileBrowserCourseName(courseName);
    setLoadingFiles(true);
    setCanvasFiles([]);
    setSelectedFileIds(new Set());
    try {
      const data = await request<{ files: CanvasFileInfo[] }>(
        `/api/canvas/connections/${coursePickerConnectionId}/courses/${courseId}/files`
      );
      setCanvasFiles(data.files ?? []);
      // Auto-select all files
      setSelectedFileIds(new Set((data.files ?? []).map((f) => f.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleDownloadAndImport() {
    if (!fileBrowserCourseId || !coursePickerConnectionId || selectedFileIds.size === 0 || !downloadFolder) return;
    setDownloading(true);
    setError(null);
    try {
      const result = await request<{ project: { id: string }; task: { id: string }; downloadedCount: number }>(
        `/api/canvas/connections/${coursePickerConnectionId}/courses/${fileBrowserCourseId}/download`,
        {
          method: "POST",
          body: JSON.stringify({
            fileIds: Array.from(selectedFileIds),
            destinationFolder: downloadFolder,
            courseName: fileBrowserCourseName,
          }),
        }
      );
      setFileBrowserCourseId(null);
      setCanvasFiles([]);
      setSelectedFileIds(new Set());
      setDownloadFolder("");
      onClose();
      // Navigate to the new task
      if (result.task?.id) {
        onTaskCreated(result.task.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  function groupFilesByFolder(files: CanvasFileInfo[]): Record<string, CanvasFileInfo[]> {
    const groups: Record<string, CanvasFileInfo[]> = {};
    for (const f of files) {
      const key = f.folderPath || "";
      if (!groups[key]) groups[key] = [];
      groups[key].push(f);
    }
    return groups;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getFileIcon(contentType: string): string {
    if (contentType.includes("pdf")) return "picture_as_pdf";
    if (contentType.includes("word") || contentType.includes("docx")) return "description";
    if (contentType.includes("presentation") || contentType.includes("pptx")) return "slideshow";
    if (contentType.includes("spreadsheet") || contentType.includes("xlsx")) return "table_chart";
    if (contentType.startsWith("image/")) return "image";
    return "draft";
  }

  function getFileColor(contentType: string): string {
    if (contentType.includes("pdf")) return "#DC2626";
    if (contentType.includes("word") || contentType.includes("docx")) return "#2563EB";
    if (contentType.includes("presentation") || contentType.includes("pptx")) return "#EA580C";
    if (contentType.includes("spreadsheet") || contentType.includes("xlsx")) return "#16A34A";
    if (contentType.startsWith("image/")) return "#7C3AED";
    return "#6B7280";
  }

  function toggleFile(id: string) {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* ---------- Full-page file browser overlay ---------- */
  if (fileBrowserCourseId) {
    const selectedSize = canvasFiles.filter((f) => selectedFileIds.has(f.id)).reduce((s, f) => s + f.size, 0);
    return (
      <div className="canvas-fb-overlay">
        {/* Top bar */}
        <div className="canvas-fb-topbar">
          <button
            className="canvas-fb-back"
            type="button"
            onClick={() => { setFileBrowserCourseId(null); setCanvasFiles([]); setSelectedFileIds(new Set()); setDownloadFolder(""); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
            Back to courses
          </button>
          <div className="canvas-fb-title">
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--accent)" }}>school</span>
            <h2>{fileBrowserCourseName}</h2>
          </div>
          <button className="ghost-button compact" type="button" onClick={onClose} title="Close">
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Destination folder bar */}
        <div className="canvas-fb-dest">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>folder_open</span>
          <span className="canvas-fb-dest-label">Save to:</span>
          <span className="canvas-fb-dest-path">{downloadFolder || "No folder selected"}</span>
          <button
            className="secondary-button compact"
            type="button"
            onClick={async () => {
              const picked = await pickFolder("Choose where to save course files");
              if (picked) setDownloadFolder(picked);
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>drive_file_move</span>
            Choose Folder
          </button>
        </div>

        {/* Summary / selection bar */}
        <div className="canvas-fb-summary">
          <span className="canvas-fb-summary-count">{selectedFileIds.size} of {canvasFiles.length} files selected</span>
          <span className="canvas-fb-summary-size">{formatFileSize(selectedSize)}</span>
          <div className="canvas-fb-summary-actions">
            <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds(new Set(canvasFiles.map((f) => f.id)))}>Select All</button>
            <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds(new Set())}>Deselect All</button>
          </div>
        </div>

        {/* File list */}
        <div className="canvas-fb-filelist">
          {loadingFiles ? (
            <div className="canvas-fb-loading">
              <span className="material-symbols-outlined" style={{ fontSize: 32, animation: "spin 1s linear infinite" }}>progress_activity</span>
              <p>Loading files...</p>
            </div>
          ) : canvasFiles.length === 0 ? (
            <div className="canvas-fb-loading">
              <span className="material-symbols-outlined" style={{ fontSize: 32, color: "var(--ink-faint)" }}>folder_off</span>
              <p>No files found in this course.</p>
            </div>
          ) : (
            Object.entries(groupFilesByFolder(canvasFiles)).map(([folder, files]) => (
              <div key={folder} className="canvas-fb-folder-group">
                <div className="canvas-fb-folder-header">
                  <input
                    type="checkbox"
                    checked={files.every((f) => selectedFileIds.has(f.id))}
                    ref={(el) => { if (el) el.indeterminate = files.some((f) => selectedFileIds.has(f.id)) && !files.every((f) => selectedFileIds.has(f.id)); }}
                    onChange={() => {
                      const allSelected = files.every((f) => selectedFileIds.has(f.id));
                      setSelectedFileIds((prev) => {
                        const next = new Set(prev);
                        for (const f of files) { allSelected ? next.delete(f.id) : next.add(f.id); }
                        return next;
                      });
                    }}
                  />
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>folder</span>
                  <span>{folder || "Root"}</span>
                  <span className="canvas-fb-folder-count">{files.length} files</span>
                </div>
                {files.map((file) => (
                  <label key={file.id} className={`canvas-fb-file ${selectedFileIds.has(file.id) ? "selected" : ""}`}>
                    <input type="checkbox" checked={selectedFileIds.has(file.id)} onChange={() => toggleFile(file.id)} />
                    <span className="material-symbols-outlined canvas-fb-file-icon" style={{ color: getFileColor(file.contentType) }}>
                      {getFileIcon(file.contentType)}
                    </span>
                    <span className="canvas-fb-file-name">{file.name}</span>
                    <span className="canvas-fb-file-size">{formatFileSize(file.size)}</span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Bottom action bar */}
        <div className="canvas-fb-actionbar">
          {error && <span className="canvas-fb-error">{error}</span>}
          {success && <span className="canvas-fb-success">{success}</span>}
          <button
            className="accent-button"
            type="button"
            disabled={selectedFileIds.size === 0 || !downloadFolder || downloading}
            onClick={() => void handleDownloadAndImport()}
          >
            {downloading ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 16, animation: "spin 1s linear infinite" }}>progress_activity</span>
                Downloading...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                Download & Import {selectedFileIds.size > 0 ? `(${selectedFileIds.size} files)` : ""}
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="chat-panel canvas-settings-panel">
      <div className="canvas-settings-header">
        <div>
          <span className="material-symbols-outlined" style={{ fontSize: 22, verticalAlign: "middle", marginRight: 8, color: "var(--accent)" }}>
            integration_instructions
          </span>
          <strong style={{ fontSize: 16 }}>Canvas Integration</strong>
        </div>
        <button className="ghost-button compact" type="button" onClick={onClose} title="Close settings">
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
        </button>
      </div>

      <div className="canvas-settings-body">
        {/* Status messages */}
        {error && (
          <div className="canvas-alert canvas-alert-error">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
            <span>{error}</span>
            <button className="ghost-button compact" type="button" onClick={() => setError(null)} style={{ marginLeft: "auto", padding: 2 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        )}
        {success && (
          <div className="canvas-alert canvas-alert-success">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check_circle</span>
            <span>{success}</span>
            <button className="ghost-button compact" type="button" onClick={() => setSuccess(null)} style={{ marginLeft: "auto", padding: 2 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        )}

        {/* Sync progress */}
        {syncProgress && (
          <div className="canvas-sync-progress">
            <div className="canvas-sync-progress-header">
              <span className="material-symbols-outlined" style={{ fontSize: 18, animation: "spin 1s linear infinite" }}>sync</span>
              <strong>{syncProgress.phase}</strong>
            </div>
            <div className="canvas-sync-progress-bar">
              <div className="canvas-sync-progress-fill" style={{ width: `${Math.min(100, syncProgress.percent)}%` }} />
            </div>
            <span className="canvas-help-text">{syncProgress.detail}</span>
          </div>
        )}

        {/* Loading state */}
        {loadingConnections ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--ink-muted)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 32, animation: "spin 1s linear infinite" }}>progress_activity</span>
            <p style={{ marginTop: 8 }}>Loading connections...</p>
          </div>
        ) : (
          <>
            {/* Existing connections */}
            {connections.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Connected Accounts
                </h3>
                {connections.map((conn) => (
                  <div key={conn.id} className="canvas-connection-card">
                    <div className="canvas-connection-card-header">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`canvas-status-dot ${conn.isActive ? "active" : "failed"}`} />
                        <strong>{conn.label || "Canvas Account"}</strong>
                      </div>
                      <button
                        className="ghost-button compact destructive-text"
                        type="button"
                        onClick={() => handleRemove(conn.id)}
                        title="Remove connection"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                      </button>
                    </div>
                    <div className="canvas-connection-card-details">
                      <span className="canvas-help-text">{conn.baseUrl}</span>
                      {conn.userDisplayName && <span className="canvas-help-text">User: {conn.userDisplayName}</span>}
                      {conn.lastVerifiedAt && (
                        <span className="canvas-help-text">Verified: {formatDate(conn.lastVerifiedAt)}</span>
                      )}
                      {conn.lastSyncAt && (
                        <span className="canvas-help-text">Last synced: {formatDate(conn.lastSyncAt)}</span>
                      )}
                    </div>
                    <div className="canvas-connection-card-actions">
                      <button
                        className="accent-button compact"
                        type="button"
                        onClick={() => handleSync(conn.id)}
                        disabled={syncingConnectionId === conn.id}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>sync</span>
                        {syncingConnectionId === conn.id ? "Syncing..." : "Sync Now"}
                      </button>
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => handleLoadCourses(conn.id)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>school</span>
                        Import Courses
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Course picker */}
            {coursePickerConnectionId && (
              <div className="canvas-course-picker">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Select a Course
                  </h3>
                  <button
                    className="ghost-button compact"
                    type="button"
                    onClick={() => { setCoursePickerConnectionId(null); setCourses([]); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                  </button>
                </div>
                {loadingCourses ? (
                  <div style={{ textAlign: "center", padding: 24, color: "var(--ink-muted)" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 24, animation: "spin 1s linear infinite" }}>progress_activity</span>
                    <p style={{ marginTop: 8 }}>Loading courses...</p>
                  </div>
                ) : courses.length === 0 ? (
                  <p className="canvas-help-text" style={{ padding: "16px 0" }}>No courses found for this account.</p>
                ) : (
                  <div className="canvas-course-list">
                    {courses.map((course) => (
                      <button key={course.id} className="canvas-course-item" type="button" onClick={() => void handleBrowseFiles(course.id, course.name)}>
                        <div className="canvas-course-item-details">
                          <strong>{course.name}</strong>
                          <span className="canvas-help-text">
                            {course.courseCode}
                            {course.termName ? ` \u00b7 ${course.termName}` : ""}
                            {course.currentScore != null ? ` \u00b7 ${course.currentScore}%` : ""}
                          </span>
                        </div>
                        <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--ink-muted)" }}>chevron_right</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Add connection button or form */}
            {!showForm ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShowForm(true)}
                style={{ alignSelf: "flex-start" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add</span>
                {connections.length > 0 ? "Add Another Account" : "Connect Canvas"}
              </button>
            ) : (
              <form className="canvas-connection-form" onSubmit={(e) => void handleConnect(e)}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Connect Canvas Account</h3>

                <label className="canvas-form-label">
                  Canvas URL
                  <input
                    type="url"
                    className="canvas-form-input"
                    placeholder="https://canvas.university.edu"
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                    required
                    autoFocus
                  />
                </label>

                <label className="canvas-form-label">
                  Access Token
                  <input
                    type="password"
                    className="canvas-form-input"
                    placeholder="paste your personal access token"
                    value={formToken}
                    onChange={(e) => setFormToken(e.target.value)}
                    required
                  />
                </label>

                <label className="canvas-form-label">
                  Label <span className="canvas-help-text">(optional)</span>
                  <input
                    type="text"
                    className="canvas-form-input"
                    placeholder="My University"
                    value={formLabel}
                    onChange={(e) => setFormLabel(e.target.value)}
                  />
                </label>

                <button
                  type="button"
                  className="ghost-button compact"
                  onClick={() => setShowTokenHelp((v) => !v)}
                  style={{ alignSelf: "flex-start", fontSize: 12, gap: 4 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>help</span>
                  How to get your token
                </button>

                {showTokenHelp && (
                  <div className="canvas-token-help">
                    <ol>
                      <li>Log in to your Canvas LMS</li>
                      <li>Go to <strong>Account</strong> &rarr; <strong>Settings</strong></li>
                      <li>Scroll to <strong>Approved Integrations</strong></li>
                      <li>Click <strong>+ New Access Token</strong></li>
                      <li>Enter a purpose (e.g. &quot;Stuart&quot;) and generate</li>
                      <li>Copy the token and paste it above</li>
                    </ol>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button
                    className="accent-button"
                    type="submit"
                    disabled={formBusy || !formUrl || !formToken}
                  >
                    {formBusy ? "Connecting..." : "Connect"}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => { setShowForm(false); setError(null); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function DashboardView({
  projects,
  tasks,
  onSelectTask,
  onAddWorkspace,
  onDeleteProject,
  onArchiveProject,
  onUnarchiveProject,
  onArchiveTask,
  onUnarchiveTask,
  onOpenCanvas,
}: {
  projects: ProjectRecord[];
  tasks: TaskSpec[];
  onSelectTask: (taskId: string) => void;
  onAddWorkspace: () => void;
  onDeleteProject: (projectId: string, projectName: string) => void;
  onArchiveProject: (projectId: string) => void;
  onUnarchiveProject: (projectId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onUnarchiveTask: (taskId: string) => void;
  onOpenCanvas: () => void;
}) {
  const [summaries, setSummaries] = useState<Record<string, ProjectLearningSummary>>({});
  const [timelines, setTimelines] = useState<Record<string, StudyTimelineEntry[]>>({});
  const [curriculumFlags, setCurriculumFlags] = useState<Record<string, boolean>>({});
  const [dashWeakTopics, setDashWeakTopics] = useState<Record<string, Array<{ topic: string; totalAttempts: number; correctCount: number }>>>({});
  const [archivedProjects, setArchivedProjects] = useState<ProjectRecord[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskSpec[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archivedAt), [tasks]);
  const visibleArchivedProjects = useMemo(() => {
    const merged = new Map<string, ProjectRecord>();
    for (const project of archivedProjects) merged.set(project.id, project);
    for (const project of projects) {
      if (project.archivedAt) merged.set(project.id, project);
    }
    return [...merged.values()].sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
  }, [archivedProjects, projects]);
  const visibleArchivedTasks = useMemo(() => {
    const merged = new Map<string, TaskSpec>();
    for (const task of archivedTasks) merged.set(task.id, task);
    for (const task of tasks) {
      if (task.archivedAt) merged.set(task.id, task);
    }
    return [...merged.values()].sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
  }, [archivedTasks, tasks]);

  // Fetch summaries + timelines for all projects
  useEffect(() => {
    for (const project of activeProjects) {
      fetch(apiUrl(`/api/projects/${project.id}/learning-summary`))
        .then((r) => r.json())
        .then((data: ProjectLearningSummary) => {
          setSummaries((prev) => ({ ...prev, [project.id]: data }));
        })
        .catch(() => {});

      fetch(apiUrl(`/api/projects/${project.id}/study-timeline?days=30`))
        .then((r) => r.json())
        .then((data: StudyTimelineEntry[]) => {
          setTimelines((prev) => ({ ...prev, [project.id]: data }));
        })
        .catch(() => {});

      fetch(apiUrl(`/api/projects/${project.id}/weak-topics`))
        .then((r) => r.ok ? r.json() : [])
        .then((data: Array<{ topic: string; totalAttempts: number; correctCount: number }>) => {
          setDashWeakTopics((prev) => ({ ...prev, [project.id]: data }));
        })
        .catch(() => {});
    }
  }, [activeProjects]);

  // Check curriculum existence for each task (first task per project)
  useEffect(() => {
    for (const task of activeTasks) {
      if (curriculumFlags[task.id] !== undefined) continue;
      fetch(apiUrl(`/api/tasks/${task.id}/curriculum`))
        .then((r) => r.json())
        .then((data: { exists: boolean }) => {
          setCurriculumFlags((prev) => ({ ...prev, [task.id]: data.exists }));
        })
        .catch(() => {});
    }
  }, [activeTasks, curriculumFlags]);

  // Fetch archived projects and tasks when section is shown
  useEffect(() => {
    if (!showArchived) return;
    fetch(apiUrl("/api/projects/archived"))
      .then((r) => r.ok ? r.json() : [])
      .then((data: ProjectRecord[]) => setArchivedProjects(data))
      .catch(() => {});
    fetch(apiUrl("/api/tasks/archived"))
      .then((r) => r.ok ? r.json() : [])
      .then((data: TaskSpec[]) => setArchivedTasks(data))
      .catch(() => {});
  }, [showArchived, projects, tasks]);

  // Merge all timelines into a 30-day aggregate
  const aggregatedTimeline = useMemo(() => {
    const dayMap: Record<string, { reviews: number; sessions: number }> = {};
    for (const entries of Object.values(timelines)) {
      for (const entry of entries) {
        if (!dayMap[entry.date]) {
          dayMap[entry.date] = { reviews: 0, sessions: 0 };
        }
        const bucket = dayMap[entry.date]!;
        bucket.reviews += entry.reviews;
        bucket.sessions += entry.sessions;
      }
    }
    const today = new Date();
    const days: { date: string; reviews: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, reviews: dayMap[key]?.reviews ?? 0 });
    }
    return days;
  }, [timelines]);

  // Compute global stats from summaries
  const globalStats = useMemo(() => {
    const vals = Object.values(summaries);
    const totalReviews = vals.reduce((s, v) => s + v.totalReviews, 0);
    const maxStreak = vals.reduce((s, v) => Math.max(s, v.streakDays), 0);
    return { totalReviews, streakDays: maxStreak };
  }, [summaries]);

  // Build workspace card data
  const workspaces = useMemo(() => {
    return activeProjects.map((project) => {
      const summary = summaries[project.id];
      const projectTasks = activeTasks.filter((t) => t.projectId === project.id);
      const firstTask = projectTasks[0] ?? null;
      const hasCurriculum = firstTask ? curriculumFlags[firstTask.id] === true : false;
      return { project, summary, firstTask, hasCurriculum };
    });
  }, [activeProjects, summaries, activeTasks, curriculumFlags]);

  const maxReviews = useMemo(
    () => Math.max(...aggregatedTimeline.map((d) => d.reviews), 1),
    [aggregatedTimeline],
  );

  return (
    <div className="zen-dashboard">
      {/* Activity pulse bar */}
      <section className="zen-activity-section">
        <div className="zen-activity-row">
          <div className="zen-activity-left">
            <span className="zen-section-label">Engagement Pulse</span>
            <span className="zen-activity-title">Daily Activity</span>
          </div>
          <div className="zen-activity-center">
            <div className="zen-heatmap">
              {aggregatedTimeline.map((day) => {
                const opacity = day.reviews === 0
                  ? 0.08
                  : Math.min(0.25 + (day.reviews / maxReviews) * 0.75, 1);
                return (
                  <div
                    key={day.date}
                    className="zen-heatmap-dot"
                    style={{
                      backgroundColor: day.reviews === 0 ? "var(--zen-on-surface)" : "var(--zen-primary)",
                      opacity,
                    }}
                    title={`${day.date}: ${day.reviews} reviews`}
                  />
                );
              })}
            </div>
            {globalStats.streakDays > 0 && (
              <span className="zen-streak-pill">Current Streak: {globalStats.streakDays} Days</span>
            )}
          </div>
          <div className="zen-stat-group">
            <div className="zen-stat">
              <span className="zen-section-label">Workspaces</span>
              <span className="zen-stat-value">{activeProjects.length}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Review panel — aggregate weak areas across all workspaces */}
      {(() => {
        const allWeak = Object.entries(dashWeakTopics).flatMap(([pid, topics]) =>
          topics.map((t) => ({ ...t, projectId: pid, projectName: activeProjects.find((p) => p.id === pid)?.name ?? "" }))
        );
        const totalDue = Object.values(summaries).reduce((s, v) => s + (v.cardsDue ?? 0), 0);
        if (allWeak.length === 0 && totalDue === 0) return null;
        return (
          <section className="dash-review-panel">
            <div className="dash-review-header">
              <span className="zen-section-label">Review</span>
              {totalDue > 0 && (
                <span className="dash-review-due-badge">{totalDue} card{totalDue !== 1 ? "s" : ""} due</span>
              )}
            </div>
            {allWeak.length > 0 && (
              <div className="dash-review-topics">
                {allWeak.slice(0, 6).map((t) => {
                  const pct = t.totalAttempts > 0 ? Math.round((t.correctCount / t.totalAttempts) * 100) : 0;
                  return (
                    <div key={`${t.projectId}-${t.topic}`} className="dash-review-topic-item">
                      <div className="dash-review-topic-info">
                        <span className="dash-review-topic-name">{t.topic}</span>
                        <span className="dash-review-topic-source">{t.projectName}</span>
                      </div>
                      <div className="dash-review-topic-bar">
                        <div className="dash-review-topic-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className={`dash-review-topic-pct${pct < 50 ? " low" : pct < 70 ? " mid" : ""}`}>{pct}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })()}

      {/* Hero headline */}
      <div className="zen-hero">
        <span className="zen-section-label" style={{ color: "var(--zen-primary)" }}>Your Workspaces</span>
        <h2 className="zen-hero-title">
          Your focused study{" "}<em>ecosystems.</em>
        </h2>
      </div>

      {/* Workspace bento grid */}
      <section className="zen-bento-grid">
        {workspaces.map(({ project, summary, firstTask, hasCurriculum }, idx) => {
          const isFeatured = idx === 0 && workspaces.length > 1;
          const accuracy = summary ? Math.round(summary.overallAccuracy * 100) : 0;

          return (
            <div key={project.id} className={`zen-workspace-card${isFeatured ? " featured" : ""}`}>
              <button
                type="button"
                className="zen-card-body"
                onClick={() => firstTask && onSelectTask(firstTask.id)}
                disabled={!firstTask}
              >
                <div className="zen-card-header">
                  <div className="zen-card-badges">
                    <span className={`zen-card-tag ${hasCurriculum ? "curriculum" : "research"}`}>
                      {hasCurriculum ? "Curriculum" : "Research"}
                    </span>
                    {summary?.lastStudiedAt && (
                      <span className="zen-card-meta">Last active {formatTimeAgo(summary.lastStudiedAt)}</span>
                    )}
                  </div>
                  <div className="zen-card-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--zen-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      {hasCurriculum ? (
                        <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /><path d="M8 7h6" /><path d="M8 11h8" /></>
                      ) : (
                        <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>
                      )}
                    </svg>
                  </div>
                </div>

                <h3 className={`zen-card-name${isFeatured ? " featured" : ""}`}>{project.name}</h3>

                {isFeatured && firstTask && (
                  <p className="zen-card-desc">{firstTask.objective?.slice(0, 80) || "Study workspace"}</p>
                )}

                <div className="zen-card-footer">
                  {summary && summary.cardsDue > 0 && (
                    <span className="zen-card-due">{summary.cardsDue} due</span>
                  )}
                  <div className="zen-card-progress-row">
                    <span className="zen-card-accuracy">{accuracy}%</span>
                    <div className="zen-progress-track">
                      <div className="zen-progress-fill" style={{ width: `${accuracy}%` }} />
                    </div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className="zen-card-delete"
                title="Archive workspace"
                onClick={(e) => { e.stopPropagation(); onArchiveProject(project.id); }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>archive</span>
              </button>
            </div>
          );
        })}

        {/* New workspace placeholder */}
        <button type="button" className="zen-add-card" onClick={onAddWorkspace}>
          <div className="zen-add-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--zen-on-surface-variant, #5a6061)" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </div>
          <span className="zen-add-title">New Workspace</span>
          <span className="zen-add-desc">Add a local study folder.</span>
        </button>

        {/* Canvas import card */}
        <button type="button" className="zen-add-card canvas-import" onClick={onOpenCanvas}>
          <div className="zen-add-icon">
            <span className="material-symbols-outlined" style={{ fontSize: 24, color: "var(--accent)" }}>school</span>
          </div>
          <span className="zen-add-title">Import from Canvas</span>
          <span className="zen-add-desc">Pull course files from your LMS.</span>
        </button>
      </section>

      <section className="zen-archive-section">
        <button
          type="button"
          className={`zen-archive-toggle${showArchived ? " open" : ""}`}
          onClick={() => setShowArchived((current) => !current)}
        >
          <span className="zen-archive-toggle-left">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>archive</span>
            Archived
          </span>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            {showArchived ? "expand_less" : "expand_more"}
          </span>
        </button>

        {showArchived ? (
          <div className="zen-archive-panel">
            {visibleArchivedProjects.length === 0 && visibleArchivedTasks.length === 0 ? (
              <p className="zen-archive-empty">Nothing is archived right now.</p>
            ) : null}

            {visibleArchivedProjects.length > 0 ? (
              <div className="zen-archive-group">
                <span className="zen-section-label">Archived workspaces</span>
                <div className="zen-archive-list">
                  {visibleArchivedProjects.map((project) => (
                    <div key={project.id} className="zen-archive-item">
                      <div className="zen-archive-item-copy">
                        <strong>{project.name}</strong>
                        <span>{project.rootPath}</span>
                      </div>
                      <button
                        type="button"
                        className="ghost-button compact"
                        onClick={() => void onUnarchiveProject(project.id)}
                      >
                        Unarchive
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {visibleArchivedTasks.length > 0 ? (
              <div className="zen-archive-group">
                <span className="zen-section-label">Archived sessions</span>
                <div className="zen-archive-list">
                  {visibleArchivedTasks.map((task) => {
                    const projectName = projects.find((project) => project.id === task.projectId)?.name
                      ?? visibleArchivedProjects.find((project) => project.id === task.projectId)?.name
                      ?? "Archived workspace";
                    return (
                      <div key={task.id} className="zen-archive-item">
                        <div className="zen-archive-item-copy">
                          <strong>{task.title}</strong>
                          <span>{projectName}</span>
                        </div>
                        <button
                          type="button"
                          className="ghost-button compact"
                          onClick={() => void onUnarchiveTask(task.id)}
                        >
                          Unarchive
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ================================================================
   Sub-components
   ================================================================ */

function ArtifactMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="artifact-menu" ref={ref}>
      <button
        className="artifact-menu-trigger"
        title="More options"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        &#x22EE;
      </button>
      {open && (
        <div className="artifact-menu-dropdown">
          <button
            className="artifact-menu-item destructive-text"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function toPlainClipboardText(content: string): string {
  return content
    .replace(/\*{0,2}【[^】]+】\*{0,2}/g, "")
    .replace(/«[^»]+»/g, "")
    .replace(/```(?:[\w-]+)?\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/(^|[^\*])\*([^\*]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1$2")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function ChatBubble({ message }: { message: TaskMessageRecord }) {
  const artifactKinds = [
    "flashcards",
    "quiz",
    "mindmap",
    "mind_map",
    "flashcard",
    "diagram",
    "mock_exam",
    "interactive",
    "custom",
    "document_docx",
    "document_xlsx",
    "document_pptx",
    "document_pdf",
    "study_doc",
  ];

  // Detect if assistant message is a JSON artifact — show a clean card instead of raw JSON
  const isJsonArtifact = message.role === "assistant" && (() => {
    const trimmed = message.content.trim();
    if (!trimmed.startsWith("{") && !trimmed.includes("```json")) return false;
    try {
      const jsonStr = trimmed.startsWith("{") ? trimmed : (trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1] ?? "");
      if (!jsonStr) return false;
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      return artifactKinds.includes(String(parsed.kind ?? parsed.artifactType ?? parsed.type ?? "").toLowerCase());
    } catch { return false; }
  })();

  // Detect if assistant message is a scripted document artifact — hide the code
  const isScriptArtifact = !isJsonArtifact && message.role === "assistant" && (() => {
    const content = message.content;
    if (!content.includes("stuart-output:")) return false;
    const match = content.match(/```(?:python|py|javascript|js)\s*\n[\s\S]*?#\s*stuart-output:\s*(.+)/);
    return !!match;
  })();

  // For JSON artifacts, extract the preamble text (before the JSON block) and show a rich summary
  let displayContent = message.content;

  if (isScriptArtifact) {
    // Extract the output filename for a clean message
    const filenameMatch = message.content.match(/stuart-output:\s*(\S+)/);
    const filename = filenameMatch?.[1] ?? "document";
    const ext = filename.split(".").pop()?.toUpperCase() ?? "document";
    displayContent = `**Generating ${ext} document:** ${filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")}\n\nOpen it from the Study Tools panel.`;
  } else if (isJsonArtifact) {
    let beforeJson = message.content.split(/\n\s*\{/)[0]?.trim() ?? "";
    // Strip any unclosed code fences that would cause ReactMarkdown to render summary as code
    beforeJson = beforeJson.replace(/```(?:json)?\s*$/m, "").trim();
    const jsonMatch = message.content.match(/\{[\s\S]*\}/);
    let summary = "Generated a study artifact — check the Study Tools panel to view it.";
    if (jsonMatch) {
      try {
        const p = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const kind = String(p.kind ?? p.artifactType ?? "").toLowerCase().replace(/_/g, " ");
        const title = String(p.title ?? "");
        const lines: string[] = [];

        if (kind === "flashcards" && Array.isArray(p.cards)) {
          const cards = p.cards as Array<{ front?: string; back?: string }>;
          const clozeCount = cards.filter(c => /\{\{c\d+::/.test(c.front ?? "")).length;
          const qaCount = cards.length - clozeCount;
          if (clozeCount > 0 && qaCount > 0) lines.push(`${qaCount} Q&A cards + ${clozeCount} cloze cards`);
          else if (clozeCount > 0) lines.push(`${clozeCount} cloze cards`);
          else lines.push(`${cards.length} cards`);
          // Show first few card topics
          const previews = cards.slice(0, 5).map(c => {
            const text = (c.front ?? "").replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1").slice(0, 60);
            return text.length >= 60 ? text + "..." : text;
          }).filter(Boolean);
          if (previews.length > 0) lines.push("**Covers:** " + previews.join(" · "));

        } else if (kind === "quiz" && Array.isArray(p.questions)) {
          const questions = p.questions as Array<{ prompt?: string }>;
          lines.push(`${questions.length} questions`);
          const previews = questions.slice(0, 4).map(q => {
            const text = (q.prompt ?? "").slice(0, 55);
            return text.length >= 55 ? text + "..." : text;
          }).filter(Boolean);
          if (previews.length > 0) {
            lines.push("**Topics tested:**");
            previews.forEach(pr => lines.push(`- ${pr}`));
            if (questions.length > 4) lines.push(`- ...and ${questions.length - 4} more`);
          }

        } else if (kind === "mindmap" && Array.isArray(p.nodes)) {
          const countNodes = (nodes: unknown[]): number => {
            let c = nodes.length;
            for (const n of nodes) {
              const children = (n as Record<string, unknown>).children;
              if (Array.isArray(children)) c += countNodes(children);
            }
            return c;
          };
          const root = (p.nodes as Array<Record<string, unknown>>)[0];
          const branches = Array.isArray(root?.children) ? (root.children as Array<{ label?: string }>) : [];
          lines.push(`${countNodes(p.nodes as unknown[])} nodes`);
          if (branches.length > 0) {
            lines.push("**Key branches:** " + branches.map(b => b.label ?? "").filter(Boolean).join(", "));
          }

        } else if (kind === "mock exam" && Array.isArray(p.sections)) {
          const sections = p.sections as Array<{ title?: string; questions?: unknown[]; totalMarks?: number }>;
          const totalQ = sections.reduce((s, sec) => s + (sec.questions?.length ?? 0), 0);
          const totalMarks = sections.reduce((s, sec) => s + (Number(sec.totalMarks) || 0), 0);
          lines.push(`${sections.length} sections, ${totalQ} questions${totalMarks ? `, ${totalMarks} marks` : ""}${p.timeLimitMinutes ? `, ${p.timeLimitMinutes} min` : ""}`);
          lines.push("**Sections:**");
          sections.forEach(sec => lines.push(`- ${sec.title ?? "Untitled"} (${sec.questions?.length ?? 0} questions)`));

        } else if (kind === "interactive") {
          lines.push("Interactive visualisation");

        } else if (kind === "diagram") {
          const scene = p.scene as Record<string, unknown> | undefined;
          const notes = Array.isArray(scene?.notes) ? (scene.notes as Array<{ label?: string }>) : [];
          if (notes.length > 0) {
            lines.push("**Key points:** " + notes.map(n => n.label ?? "").filter(Boolean).join(", "));
          }
        } else if (kind === "document xlsx") {
          const workbook = (p.workbook as Record<string, unknown> | undefined) ?? p;
          const sheets = Array.isArray(workbook.sheets)
            ? (workbook.sheets as Array<Record<string, unknown>>)
            : [];
          lines.push(`${sheets.length} worksheet${sheets.length === 1 ? "" : "s"}`);
          const names = sheets.map((sheet) => String(sheet.name ?? "").trim()).filter(Boolean);
          if (names.length > 0) {
            lines.push("**Sheets:** " + names.slice(0, 6).join(", ") + (names.length > 6 ? `, and ${names.length - 6} more` : ""));
          }
        } else if (kind === "document docx" || kind === "document pdf") {
          const document = (p.document as Record<string, unknown> | undefined) ?? p;
          const sections = Array.isArray(document.sections)
            ? (document.sections as Array<Record<string, unknown>>)
            : [];
          lines.push(`${sections.length} section${sections.length === 1 ? "" : "s"}`);
          const headings = sections.map((section) => String(section.heading ?? "").trim()).filter(Boolean);
          if (headings.length > 0) {
            lines.push("**Sections:** " + headings.slice(0, 5).join(", ") + (headings.length > 5 ? `, and ${headings.length - 5} more` : ""));
          }
        } else if (kind === "document pptx") {
          const presentation = (p.presentation as Record<string, unknown> | undefined) ?? p;
          const slides = Array.isArray(presentation.slides)
            ? (presentation.slides as Array<Record<string, unknown>>)
            : [];
          lines.push(`${slides.length} slide${slides.length === 1 ? "" : "s"}`);
          const titles = slides.map((slide) => String(slide.title ?? "").trim()).filter(Boolean);
          if (titles.length > 0) {
            lines.push("**Slides:**");
            titles.slice(0, 5).forEach((slideTitle) => lines.push(`- ${slideTitle}`));
            if (titles.length > 5) lines.push(`- ...and ${titles.length - 5} more`);
          }
        } else if (kind === "study doc") {
          const markdown = String(p.markdown ?? "");
          const headings = Array.from(markdown.matchAll(/^#{1,6}\s+(.+)$/gm))
            .map((match) => match[1]?.trim())
            .filter(Boolean) as string[];
          lines.push("Editable study document");
          if (headings.length > 0) {
            lines.push("**Sections:** " + headings.slice(0, 5).join(", ") + (headings.length > 5 ? `, and ${headings.length - 5} more` : ""));
          }
        }

        const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
        const header = title ? `**${kindLabel}: ${title}**` : `**${kindLabel}**`;
        // Join lines with double newlines for paragraph breaks, but keep list items
        // (lines starting with -) together with single newlines
        let body = "";
        if (lines.length > 0) {
          body = "\n\n";
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            const prevLine = i > 0 ? lines[i - 1]! : "";
            // List items: single newline between consecutive list items,
            // double newline before first list item
            if (line.startsWith("- ")) {
              body += prevLine.startsWith("- ") ? "\n" + line : (i > 0 ? "\n\n" : "") + line;
            } else {
              body += (i > 0 ? "\n\n" : "") + line;
            }
          }
        }
        summary = `${header}${body}\n\nOpen it from the Study Tools panel.`;
      } catch { /* ignore */ }
    }
    displayContent = beforeJson ? `${beforeJson}\n\n${summary}` : summary;
  }

  const [copied, setCopied] = useState(false);

  function copyWithoutCitations() {
    const plain = toPlainClipboardText(displayContent);
    void navigator.clipboard.writeText(plain).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <article
      className={
        message.role === "user"
          ? "chat-bubble user"
          : "chat-bubble assistant"
      }
    >
      <div className="chat-meta">
        <span className="chat-label">
          {message.role === "user" ? "You" : "Stuart"}
        </span>
        <span className="chat-time">{formatDate(message.createdAt)}</span>
      </div>
      {message.role === "assistant" && (
        <button
          className={`chat-copy-btn${copied ? " copied" : ""}`}
          type="button"
          onClick={copyWithoutCitations}
          title="Copy without citations"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <div className="chat-content">
        {message.role === "assistant" ? (
          <MarkdownMessage content={displayContent} />
        ) : (
          <p className="plain-message">{message.content}</p>
        )}
      </div>
    </article>
  );
}

function ThinkingBubble({ label, recentActions, activities }: { label: string; recentActions?: string[]; activities?: AgentActivity[] }) {
  const running = activities?.filter(a => a.status === "running") ?? [];
  return (
    <article className="thinking-bubble">
      <div className="thinking-spinner" />
      <div className="thinking-content">
        <span className="chat-label">Stuart</span>
        <p>{label}</p>
        {(recentActions && recentActions.length > 0) && (
          <div className="thinking-log">
            {recentActions.map((action, i) => (
              <span key={i} className="thinking-log-item">{action}</span>
            ))}
          </div>
        )}
        {running.length > 0 && (
          <div className="thinking-activities">
            {running.map(a => (
              <span key={a.id} className="thinking-activity">{a.detail || a.label}</span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function WorkspaceSetupIndicator({ progress }: { progress: WorkspaceSetupState }) {
  const activeStep = progress.steps.find((step) => step.status === "active") ?? null;
  return (
    <aside className="workspace-setup-indicator" aria-live="polite">
      <div className="workspace-setup-header">
        <span className="workspace-setup-kicker">Workspace Setup</span>
        <span className="workspace-setup-status">{activeStep ? "In progress" : "Ready"}</span>
      </div>
      <h3>{progress.title}</h3>
      <p>{progress.detail}</p>
      <div className="workspace-setup-steps">
        {progress.steps.map((step) => (
          <div key={step.id} className={`workspace-setup-step ${step.status}`}>
            <span className="workspace-setup-step-dot" />
            <span>{step.label}</span>
          </div>
        ))}
      </div>
      <div className="workspace-setup-footer">
        {activeStep
          ? "Stuart can start teaching before every file is fully indexed."
          : "You can start asking questions immediately."}
      </div>
    </aside>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function WorkspacePreviewPanel({
  preview,
  onClose,
}: {
  preview: WorkspacePreviewState;
  onClose: () => void;
}) {
  const [pdfFallbackKey, setPdfFallbackKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initialPage = parsePreviewPage(preview.previewHref, preview.locator);
  const shouldAttemptPdfPreview =
    preview.previewKind === "pdf" || preview.previewKind === "pptx";

  useEffect(() => {
    setPdfFallbackKey(0);
  }, [preview.previewHref, preview.previewKind]);

  const handleIframeLoad = useCallback(() => {
    if (preview.previewKind !== "pptx") {
      return;
    }

    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    if (!iframe || !doc || !win) {
      return;
    }

    stabilizePptxIframePreview(doc, preview.locator);
  }, [preview.locator, preview.previewKind]);

  return (
    <div className="artifact-canvas-overlay">
      <div className="artifact-canvas-panel">
        <div className="artifact-canvas-header">
          <div>
            <span className="kind-badge study_doc">source</span>
            <h2>{preview.title}</h2>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => window.open(preview.previewHref, "_blank", "noopener,noreferrer")}
            >
              Open in Tab
            </button>
            <button className="ghost-button compact" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="artifact-canvas-body workspace-preview-body">
          <div className="workspace-preview-shell">
            <div className="workspace-preview-meta">
              <span>{preview.relativePath}</span>
              {preview.locator ? <span>{preview.locator}</span> : null}
            </div>
            {shouldAttemptPdfPreview && pdfFallbackKey === 0 ? (
              <PdfPreview
                sourceUrl={preview.previewHref}
                initialPage={initialPage}
                onUnavailable={() => setPdfFallbackKey(1)}
              />
            ) : (
              <iframe
                ref={iframeRef}
                className="workspace-preview-iframe"
                src={preview.previewHref}
                title={preview.title}
                onLoad={handleIframeLoad}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function parsePreviewPage(previewHref: string, locator?: string): number {
  const hashMatch = previewHref.match(/#page=(\d+)/i);
  if (hashMatch) {
    return Math.max(1, Number(hashMatch[1]) || 1);
  }
  const locatorMatch = locator?.match(/\b(?:page|slide)\s+(\d+)\b/i);
  return Math.max(1, Number(locatorMatch?.[1] ?? "1") || 1);
}

function stabilizePptxIframePreview(doc: Document, locator?: string) {
  const targetSlideNumber = parseSlideLocator(locator);
  ensurePptxIframePreviewStyles(doc);

  const slides = Array.from(doc.querySelectorAll("div.slide"));
  for (const [index, slideNode] of slides.entries()) {
    if (!(slideNode instanceof HTMLElement)) continue;
    if (slideNode.parentElement?.classList.contains("stuart-ql-slide-frame")) continue;

    const slideNumber = index + 1;
    slideNode.id = slideNode.id || `slide-${slideNumber}`;
    slideNode.style.position = "absolute";
    slideNode.style.top = "44px";
    slideNode.style.left = "16px";
    slideNode.style.transformOrigin = "top left";
    slideNode.style.margin = "0";

    const frame = doc.createElement("section");
    frame.className = "stuart-ql-slide-frame";
    frame.dataset.slideNumber = String(slideNumber);
    if (slideNumber === targetSlideNumber) {
      frame.classList.add("is-target");
    }

    const label = doc.createElement("div");
    label.className = "stuart-ql-slide-label";
    label.textContent = `slide ${slideNumber}`;

    slideNode.parentNode?.insertBefore(frame, slideNode);
    frame.appendChild(label);
    frame.appendChild(slideNode);
  }

  fitPptxIframeSlides(doc);

  const scrollTarget =
    (targetSlideNumber
      ? doc.querySelector(`.stuart-ql-slide-frame[data-slide-number="${targetSlideNumber}"], #slide-${targetSlideNumber}`)
      : null) ?? null;
  if (scrollTarget instanceof HTMLElement) {
    window.setTimeout(() => {
      scrollTarget.scrollIntoView({ block: "start" });
    }, 50);
  }
}

function ensurePptxIframePreviewStyles(doc: Document) {
  if (doc.getElementById("stuart-pptx-preview-style")) {
    return;
  }

  const style = doc.createElement("style");
  style.id = "stuart-pptx-preview-style";
  style.textContent = `
    :root { color-scheme: light; }
    body {
      margin: 0 !important;
      padding: 18px 14px 28px !important;
      background: linear-gradient(180deg, #eef4fb 0%, #e7eef8 100%) !important;
      overflow-x: hidden !important;
    }
    .stuart-ql-slide-frame {
      position: relative;
      width: min(100%, 1180px);
      margin: 0 auto 20px;
      padding: 16px;
      border-radius: 20px;
      border: 1px solid rgba(108,130,168,0.16);
      background: rgba(255,255,255,0.82);
      box-shadow: 0 20px 48px rgba(18,31,56,0.08);
      overflow: hidden;
      box-sizing: border-box;
      scroll-margin-top: 20px;
    }
    .stuart-ql-slide-frame.is-target {
      border-color: rgba(31,93,93,0.42);
      box-shadow: 0 0 0 3px rgba(31,93,93,0.12), 0 20px 48px rgba(18,31,56,0.08);
    }
    .stuart-ql-slide-label {
      position: absolute;
      top: 12px;
      right: 14px;
      z-index: 3;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(31,93,93,0.09);
      color: #1f5d5d;
      font: 700 12px/1 system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .stuart-ql-slide-frame > .slide {
      margin: 0 !important;
      box-shadow: none !important;
    }
  `;

  doc.head.appendChild(style);
}

function fitPptxIframeSlides(doc: Document) {
  const frames = Array.from(doc.querySelectorAll(".stuart-ql-slide-frame"));
  for (const frameNode of frames) {
    if (!(frameNode instanceof HTMLElement)) continue;
    const slideNode = frameNode.querySelector(".slide");
    if (!(slideNode instanceof HTMLElement)) continue;

    const computedStyle = doc.defaultView?.getComputedStyle(slideNode);
    const baseWidth = Number.parseFloat(computedStyle?.width ?? "") || slideNode.scrollWidth || 960;
    const baseHeight = Number.parseFloat(computedStyle?.height ?? "") || slideNode.scrollHeight || 540;
    const availableWidth = Math.max(320, frameNode.clientWidth - 32);
    const scale = Math.min(1, availableWidth / baseWidth);

    slideNode.style.transform = `scale(${scale})`;
    frameNode.style.minHeight = `${Math.ceil(baseHeight * scale + 60)}px`;
  }
}

function parseSlideLocator(locator?: string): number | null {
  const match = locator?.match(/\bslide\s+(\d+)\b/i);
  if (!match) {
    return null;
  }
  const slideNumber = Number(match[1]);
  return Number.isFinite(slideNumber) && slideNumber > 0 ? slideNumber : null;
}

/**
 * Normalize LaTeX delimiters so remark-math can detect them.
 * Codex uses several formats:
 *   \( ... \)  →  $ ... $     (standard LaTeX inline)
 *   \[ ... \]  →  $$ ... $$   (standard LaTeX display)
 *   bare \le, x_2 etc.        (no delimiters — harder, skip for now)
 */
function wrapBareLatex(text: string): string {
  let result = text;
  // Convert \( ... \) to $ ... $
  result = result.replace(/\\\((.+?)\\\)/g, (_, inner) => `$${inner}$`);
  // Convert \[ ... \] to $$ ... $$
  result = result.replace(/\\\[(.+?)\\\]/gs, (_, inner) => `$$${inner}$$`);
  return result;
}

function InlineMermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderMermaidSvg(code).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else setSvg(result.svg);
    });
    return () => { cancelled = true; };
  }, [code]);

  if (error) return <pre className="mermaid-inline-error"><code>{code}</code></pre>;
  if (!svg) return <div className="mermaid-inline-loading"><span className="material-symbols-outlined" style={{ fontSize: 16, animation: "spin 1s linear infinite" }}>progress_activity</span></div>;
  return <div className="mermaid-inline" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CitationPillClickable({
  label,
  icon,
  sourcePath,
  queryText,
}: {
  label: string;
  icon: string;
  sourcePath?: string | null;
  queryText?: string | null;
}) {
  const searchCitation = useContext(CitationContext);
  const openCitationSource = useContext(CitationOpenContext);
  const resolveWorkspaceFile = useContext(WorkspaceFileResolveContext);
  const openWorkspaceFile = useContext(WorkspaceFileOpenContext);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<IngestionSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const pillRef = useRef<HTMLSpanElement>(null);

  const handleClick = useCallback(async () => {
    if (open) { setOpen(false); return; }

    const matchedFile = resolveWorkspaceFile
      ? await resolveWorkspaceFile(sourcePath || label, sourcePath)
      : null;
    if (matchedFile && citationPillShouldOpenWorkspaceDirectly(matchedFile) && openWorkspaceFile) {
      await openWorkspaceFile(sourcePath || label, sourcePath);
      return;
    }

    if (!searchCitation) return;
    setOpen(true);
    setLoading(true);
    try {
      const res = await searchCitation(label, sourcePath, queryText);
      setResults(res);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [label, open, openWorkspaceFile, queryText, resolveWorkspaceFile, searchCitation, sourcePath]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <span ref={pillRef} className={`citation-pill clickable${open ? " active" : ""}`} onClick={handleClick}>
      <span className="material-symbols-outlined" style={{ fontSize: 11, flexShrink: 0 }}>{icon}</span>
      <span className="citation-pill-label">{label}</span>
      {open && (
        <div className="citation-popover" onClick={(e) => e.stopPropagation()}>
          <div className="citation-popover-header">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{icon}</span>
            <strong>{label}</strong>
          </div>
          {loading ? (
            <p className="citation-popover-loading">Searching sources...</p>
          ) : results && results.length > 0 ? (
            <div className="citation-popover-results">
              {results.map((r, i) => (
                <div key={r.chunkId ?? i} className="citation-popover-chunk">
                  <div className="citation-popover-chunk-meta">
                    {r.locator ? <span className="citation-popover-locator">{r.locator}</span> : null}
                    {openCitationSource ? (
                      <button
                        type="button"
                        className="citation-popover-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCitationSource(r.relativePath, r.locator);
                        }}
                      >
                        Open source
                      </button>
                    ) : null}
                  </div>
                  <p>{r.snippet || r.text.slice(0, 300)}{r.text.length > 300 ? "..." : ""}</p>
                  <span className="citation-popover-source">{cleanSourceName(r.relativePath)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="citation-popover-empty">No matching excerpts found.</p>
          )}
        </div>
      )}
    </span>
  );
}

function MarkdownFileLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const openWorkspaceFile = useContext(WorkspaceFileOpenContext);
  const displayName = cleanSourceName(href);
  const ext = fileExtension(href);
  const icon = iconForFileExtension(ext);

  return (
    <button
      type="button"
      className="citation-pill clickable"
      title={href}
      onClick={() => { void openWorkspaceFile?.(displayName, href); }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 12, flexShrink: 0 }}>{icon}</span>
      {children || displayName}
    </button>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  const cleanedContent = cleanFileReferences(wrapBareLatex(content));

  // Process children to replace «label::EXT» markers with styled pills
  function processFileMarkers(node: React.ReactNode): React.ReactNode {
    if (typeof node === "string") {
      const re = new RegExp(`${FILE_REF_MARKER}([^${FILE_REF_END}]+)${FILE_REF_END}`, "g");
      if (!re.test(node)) return node;
      re.lastIndex = 0;
      const parts: React.ReactNode[] = [];
      let lastIdx = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(node)) !== null) {
        if (match.index > lastIdx) parts.push(node.slice(lastIdx, match.index));
        const { label, ext, sourcePath } = parseFileReferenceMarker(match[1] ?? "");
        const queryText = extractCitationQueryText(node, match.index, re.lastIndex);
        const icon = iconForFileExtension(ext);
        parts.push(
          <CitationPillClickable
            key={match.index}
            label={label}
            icon={icon}
            sourcePath={sourcePath}
            queryText={queryText}
          />
        );
        lastIdx = re.lastIndex;
      }
      if (lastIdx < node.length) parts.push(node.slice(lastIdx));
      return parts.length === 1 ? parts[0] : <>{parts}</>;
    }
    if (Array.isArray(node)) return node.map((c, i) => <React.Fragment key={i}>{processFileMarkers(c)}</React.Fragment>);
    if (node && typeof node === "object" && "props" in (node as any)) {
      const el = node as React.ReactElement<{ children?: React.ReactNode }>;
      if (el.props.children) {
        return React.cloneElement(el, {}, processFileMarkers(el.props.children));
      }
    }
    return node;
  }

  // Wrapper that applies file marker processing to any element's children
  function withFileMarkers(Tag: string) {
    return ({ children, ...props }: any) => {
      const processed = processFileMarkers(children);
      return React.createElement(Tag, props, processed);
    };
  }

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ children, href }) => {
            const normalizedHref = href?.trim() ?? "";
            if (!normalizedHref) return <span>{children}</span>;
            if (isExternalLink(normalizedHref)) {
              return (
                <a href={normalizedHref} target="_blank" rel="noreferrer" className="message-link external">
                  {children}
                </a>
              );
            }
            return <MarkdownFileLink href={normalizedHref}>{children}</MarkdownFileLink>;
          },
          p: withFileMarkers("p"),
          td: withFileMarkers("td"),
          th: withFileMarkers("th"),
          li: withFileMarkers("li"),
          strong: withFileMarkers("strong"),
          em: withFileMarkers("em"),
          code: ({ children, className }) => {
            if (className === "language-mermaid") {
              const text = String(children).replace(/\n$/, "");
              return <InlineMermaid code={text} />;
            }
            return className ? <code className={className}>{children}</code> : <code>{children}</code>;
          },
          pre: ({ children }) => {
            // If the child is an InlineMermaid, don't wrap in <pre>
            const child = React.Children.toArray(children)[0];
            if (child && typeof child === "object" && "type" in (child as any) && (child as any).type === InlineMermaid) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
          h1: withFileMarkers("h1"),
          h2: withFileMarkers("h2"),
          h3: withFileMarkers("h3"),
          blockquote: withFileMarkers("blockquote"),
        }}
      >
        {cleanedContent}
      </ReactMarkdown>
    </div>
  );
}

function isExternalLink(href: string) {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href);
}

export default App;

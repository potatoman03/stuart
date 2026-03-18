import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  StudyArtifactKind,
  StudyArtifactRecord,
  StudyTimelineEntry,
  TaskMessageRecord,
  TaskPerformanceBreakdown,
  TaskRunRecord,
  TaskSpec,
  TaskWorkerRecord,
  TopicPerformanceRecord,
  UpdateTaskInput,
  WorkspaceEvent,
  WorkspaceFileRecord
} from "@stuart/shared";
import ArtifactCanvas from "./ArtifactCanvas";
import { ALL_DEMOS } from "./DemoArtifacts";

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

type AgentStatus = "running" | "completed" | "failed";

type AgentActivity = {
  id: string;
  label: string;
  status: AgentStatus;
  detail?: string;
  updatedAt: string;
  source: "codex" | "worker";
};

/* ---- Constants ---- */

const STUDY_TOOL_PROMPTS: Record<string, string> = {
  flashcards: "Create flashcards for the current topic based on my study materials.",
  mindmap: "Create a mind map for the current topic based on my study materials.",
  quiz: "Create a quiz to test my understanding of the current topic.",
  diagram: "Create a diagram to visualize the key concepts from my study materials.",
  mock_exam: "Create a mock exam based on the past papers in my study folder. Analyze the exam format and generate new questions in the same style.",
  interactive: "Build me an interactive visualisation or simulation to help me understand the current topic.",
  custom: "Create a custom study artifact: "
};

const DEMO_KIND_ICONS: Record<string, string> = {
  flashcards: "Cards",
  quiz: "Quiz",
  mindmap: "Map",
  diagram: "Flow",
  mock_exam: "Exam",
  interactive: "App",
};

const DIAGNOSTICS_DISMISS_KEY = "stuart.dismissedDiagnostics.v1";

/* ---- Helpers ---- */

function cleanSourceName(rawPath: string): string {
  // URL-decode first
  let name = rawPath;
  try { name = decodeURIComponent(name); } catch { /* ignore */ }
  // Strip attachments/UUID/ prefix
  name = name.replace(/^attachments\/[a-f0-9-]+[-/]/i, "");
  // Get just the filename
  const parts = name.split("/");
  name = parts[parts.length - 1] || name;
  // Remove extension for display
  name = name.replace(/\.(pdf|docx|pptx|xlsx|txt|md|html|csv|json|epub|jsx|tsx|js|ts)$/i, "");
  return name;
}

function fileExtension(rawPath: string): string {
  const match = rawPath.match(/\.(pdf|docx|pptx|xlsx|txt|md|html|csv|json|epub)$/i);
  return match ? match[1]!.toUpperCase() : "DOC";
}

/* ---- API Helper ---- */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const maxAttempts = method === "GET" || method === "HEAD" ? 4 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {})
        }
      });

      if (!response.ok) {
        const message = await response.text();
        const error = new Error(message || `Request failed for ${path}`);
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

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${path}`);
}

/* ================================================================
   App Component
   ================================================================ */

function App() {
  /* ---- Core State ---- */
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [taskRuns, setTaskRuns] = useState<Record<string, TaskRunRecord[]>>({});
  const [workersByTask, setWorkersByTask] = useState<Record<string, TaskWorkerRecord[]>>({});
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

  /* ---- UI State ---- */
  const [composerDraft, setComposerDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [streamingDelta, setStreamingDelta] = useState<StreamingDelta | null>(null);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [dismissedDiagnosticsFingerprint, setDismissedDiagnosticsFingerprint] = useState<string | null>(
    () => readDismissedDiagnosticsFingerprint()
  );

  /* ---- Study Artifacts State ---- */
  const [studyArtifacts, setStudyArtifacts] = useState<Record<string, StudyArtifactRecord[]>>({});
  const [openArtifact, setOpenArtifact] = useState<StudyArtifactRecord | null>(null);
  const [pendingDeleteArtifact, setPendingDeleteArtifact] = useState<{ id: string; title: string; taskId: string } | null>(null);
  const [openDemoArtifact, setOpenDemoArtifact] = useState<{ kind: StudyArtifactKind; title: string; payload: string } | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");

  /* ---- Study Session Tracking ---- */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startStudySession = useCallback(async (taskId: string, artifactId?: string) => {
    if (activeSessionId) return; // already in a session
    try {
      const res = await fetch(`/api/tasks/${taskId}/study-sessions`, {
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
      await fetch(`/api/study-sessions/${activeSessionId}`, {
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

  const trackReviewEvent = useCallback(async (correct: boolean) => {
    if (!activeSessionId) return;
    resetInactivityTimer();
    try {
      const sessionRes = await fetch(`/api/study-sessions/${activeSessionId}`);
      // We don't have a GET endpoint, so just PATCH with increments
      // Use a simple approach: increment by 1 each time
      await fetch(`/api/study-sessions/${activeSessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardsReviewed: 1, // Will be replaced with accumulated value
          correctCount: correct ? 1 : 0,
        }),
      });
    } catch { /* non-critical */ }
  }, [activeSessionId, resetInactivityTimer]);

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

  /* ---- Inline AI Response State ---- */
  const [inlineResponse, setInlineResponse] = useState<string | null>(null);
  const [isInlineLoading, setIsInlineLoading] = useState(false);

  /* ---- Context Compaction State ---- */
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactionMessage, setCompactionMessage] = useState<string | null>(null);

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

  const selectedRuns = selectedTask ? taskRuns[selectedTask.id] ?? [] : [];

  const selectedMessages = useMemo(() => {
    if (!selectedTask) return [];
    return messagesByTask[selectedTask.id] ?? [];
  }, [messagesByTask, selectedTask]);

  const visibleMessages = useMemo(
    () => selectedMessages.filter((message) => message.role !== "system"),
    [selectedMessages]
  );

  const selectedWorkspaceScopeKey = selectedTask
    ? buildWorkspaceScopeKey(selectedTask.id, selectedRunId)
    : null;
  const selectedIngestion = selectedWorkspaceScopeKey
    ? ingestionByScope[selectedWorkspaceScopeKey] ?? null
    : null;

  const turnInFlight = Boolean(selectedTask && thinkingState?.taskId === selectedTask.id);
  const isStreaming = Boolean(
    streamingDelta && selectedTask && streamingDelta.taskId === selectedTask.id
  );
  const selectedStudyArtifacts = selectedTask ? studyArtifacts[selectedTask.id] ?? [] : [];
  const diagnosticsFingerprint = diagnostics ? buildDiagnosticsFingerprint(diagnostics) : null;
  const diagnosticsDismissed = Boolean(
    diagnosticsFingerprint && diagnosticsFingerprint === dismissedDiagnosticsFingerprint
  );

  // Group artifacts by kind
  const groupedArtifacts = useMemo(() => {
    const groups: Record<string, StudyArtifactRecord[]> = {
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

  const isArtifactOpen = !!(openArtifact || openDemoArtifact);

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
      setSelectedTaskId(nextTask?.id ?? null);
      setSelectedRunId(nextRunId);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Failed to load workspace dashboard";
      if (message.includes("/api/dashboard") || message === "Failed to fetch") {
        setError("The local Stuart API is not ready yet. Wait a second and refresh, or restart with `pnpm dev`.");
        return;
      }
      setError(message);
    }
  }, [selectedTaskId, selectedProjectId, selectedRunId]);

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

  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      es = new EventSource("/api/events");
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
  }, [selectedTask, selectedRunId]);

  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [selectedTaskId, selectedRunId, thinkingState, messagesByTask, streamingDelta]);

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
        setThinkingState({ taskId: event.taskId, label: "Stuart is thinking..." });
        setStreamingDelta(null);
        return;

      case "codex.thinking":
        setThinkingState({ taskId: event.taskId, label: event.label || "Analyzing your materials..." });
        return;

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
        setThinkingState((cur) => (cur?.taskId === event.taskId ? null : cur));
        setStreamingDelta((cur) => (cur?.taskId === event.taskId ? null : cur));
        setMessagesByTask((cur) => ({
          ...cur,
          [event.taskId]: upsertMessage(cur[event.taskId] ?? [], event.message)
        }));
        return;

      case "codex.turn.completed":
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

  async function handleAddStudyMaterials() {
    const path = await pickFolder("Choose a folder with your study materials");
    if (!path) return;

    try {
      setBusy("add-materials");
      // Create or find project for this folder
      const existingProject = projects.find((p) => p.rootPath === path);
      let project: ProjectRecord;

      if (existingProject) {
        project = existingProject;
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

      // Create a study session task automatically
      const taskTitle = `Study: ${inferProjectName(path)}`;
      const objective = "Help me study and understand the materials in this folder. I may ask you to create flashcards, quizzes, mind maps, and summaries.";

      const created = await request<TaskSpec>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          title: taskTitle,
          objective,
          attachments: [
            { id: crypto.randomUUID(), hostPath: path, mode: "reference" as const }
          ],
          browserEnabled: false,
          authMode: "chatgpt"
        } satisfies CreateTaskInput)
      });

      // Send the initial ingest message
      setThinkingState({ taskId: created.id, label: "Analyzing your materials..." });

      const result = await request<SendMessageResponse>(`/api/tasks/${created.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: "I just added my study materials. Please read through everything and give me a brief overview of what's in there, then ask me what I'd like to focus on."
        })
      });

      setMessagesByTask((cur) => ({
        ...cur,
        [created.id]: [...(cur[created.id] ?? []), result.userMessage]
      }));

      if (!result.startedTurn) {
        setThinkingState((cur) => (cur?.taskId === created.id ? null : cur));
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

  async function handleComposerSubmit(event: React.FormEvent) {
    event.preventDefault();
    const prompt = composerDraft.trim();
    if (!prompt) return;

    if (selectedTask) {
      try {
        setBusy("message");
        setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking..." });
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
        setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking..." });
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
      setThinkingState({ taskId, label: "Stuart is thinking..." });
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

  /* ================================================================
     RENDER
     ================================================================ */

  return (
    <div className="stuart-shell">
      {/* ---- Error Banner ---- */}
      {error ? (
        <div className="error-banner">
          <span>{error}</span>
          <button className="ghost-button compact" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
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

      {/* ---- Three-Column Layout ---- */}
      <div
        className={`workspace${studyToolsCollapsed ? " tools-collapsed" : ""}${libraryCollapsed ? " library-collapsed" : ""}${isArtifactOpen ? " artifact-open" : ""}`}
        style={isArtifactOpen ? { "--artifact-pane-width": `${artifactPaneWidth}px` } as React.CSSProperties : undefined}
      >
        {/* ======== LEFT SIDEBAR: Your Library ======== */}
        <aside className="library-panel">
          <div className="library-header">
            <div
              className="brand-lockup"
              style={{ cursor: "pointer" }}
              onClick={() => { setSelectedTaskId(null); setSelectedRunId(null); }}
              title="Back to dashboard"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <span className="brand-mark">Stuart</span>
            </div>
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

          <div className="library-body">
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
                <DiagnosticsCard diagnostics={diagnostics} compact onDismiss={dismissDiagnostics} />
              )
            ) : null}

            {/* Projects as study folders */}
            {projects.length > 0 ? (
              <div className="library-section">
                <span className="library-kicker">Your folders</span>
                <div className="library-folder-list">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className={`library-folder${project.id === selectedProjectId ? " active" : ""}`}
                      type="button"
                      onClick={() => {
                        setSelectedProjectId(project.id);
                        // Select first task in this project
                        const firstTask = tasks.find((t) => t.projectId === project.id);
                        if (firstTask) setSelectedTaskId(firstTask.id);
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5A1 1 0 0 0 5.8 3H3a1 1 0 0 0-1 1z" />
                      </svg>
                      <span>{project.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Source files with clean names */}
            {selectedIngestion && selectedIngestion.documents.length > 0 ? (
              <div className="library-section">
                <span className="library-kicker">
                  Sources ({selectedIngestion.documents.length})
                </span>
                <div className="library-source-list">
                  {selectedIngestion.documents.slice(0, 30).map((doc) => (
                    <div key={doc.id} className="library-source-item">
                      <span className="source-badge">
                        {fileExtension(doc.relativePath).slice(0, 3)}
                      </span>
                      <span className="source-name">{cleanSourceName(doc.relativePath)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Study sessions (tasks, but we don't call them that) */}
            {tasks.length > 0 ? (
              <div className="library-section">
                <span className="library-kicker">Study sessions</span>
                <div className="library-session-list">
                  {tasks.map((task) => {
                    const isActive = task.id === selectedTaskId;
                    const isWorking = thinkingState?.taskId === task.id;
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={`library-session${isActive ? " active" : ""}`}
                        onClick={() => {
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
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        {/* ======== CENTER: Chat ======== */}
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
            <div className="chat-transcript">
              {!selectedTask ? (
                projects.length > 0 ? (
                  /* ---- Dashboard: shown when projects exist but no task selected ---- */
                  <DashboardView
                    projects={projects}
                    tasks={tasks}
                    onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                  />
                ) : (
                  /* ---- Onboarding: Welcome Screen ---- */
                  <div className="welcome-card">
                    <div className="welcome-icon">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                      </svg>
                    </div>
                    <h1>Welcome to Stuart</h1>
                    <p>Your personal study assistant. Drop a folder of study materials to get started.</p>
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
                    {diagnostics ? (
                      diagnosticsDismissed ? (
                        <DiagnosticsDismissedNotice onShow={restoreDiagnostics} />
                      ) : (
                        <DiagnosticsCard diagnostics={diagnostics} onDismiss={dismissDiagnostics} />
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
                  {/* Messages */}
                  {visibleMessages.map((message) => (
                    <ChatBubble key={message.id} message={message} />
                  ))}

                  {/* Streaming Response */}
                  {isStreaming && streamingDelta ? (() => {
                    const text = streamingDelta.text.trim();
                    // Detect if streaming content is a JSON artifact — show clean placeholder instead of raw code
                    const looksLikeArtifact = (text.startsWith("{") || text.includes("```json")) &&
                      /\b"kind"\s*:\s*"(flashcards|quiz|mindmap|diagram|mock_exam|interactive|custom)"/.test(text);
                    return (
                      <article className="chat-bubble assistant streaming">
                        <div className="chat-meta">
                          <span className="chat-label">Stuart</span>
                          <span className="chat-typing">typing...</span>
                        </div>
                        {looksLikeArtifact ? (
                          <p style={{ color: "var(--ink-muted)", fontStyle: "italic" }}>Generating study artifact...</p>
                        ) : (
                          <MarkdownMessage content={streamingDelta.text} />
                        )}
                      </article>
                    );
                  })() : null}

                  {/* Thinking State */}
                  {thinkingState?.taskId === selectedTask.id && !isStreaming ? (
                    <ThinkingBubble label={thinkingState.label} activities={agentActivityByTask[selectedTask.id]} />
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* Composer */}
          {selectedTask ? (
            <form className="composer-shell" onSubmit={handleComposerSubmit}>
              <div className="composer-frame">
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
                />
                <div className="composer-bottom">
                  <div className="composer-tools" />
                  <div className="composer-meta">
                    <button
                      className="send-button"
                      type="submit"
                      disabled={busy === "message" || turnInFlight || !composerDraft.trim()}
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
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <line x1="6" y1="10" x2="18" y2="10" />
                      <line x1="6" y1="14" x2="14" y2="14" />
                    </svg>
                    Flashcards
                  </button>
                  <button
                    className="quick-create-btn mindmap"
                    type="button"
                    onClick={() => handleStudyToolClick("mindmap")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <line x1="12" y1="3" x2="12" y2="9" />
                      <line x1="12" y1="15" x2="12" y2="21" />
                      <line x1="3" y1="12" x2="9" y2="12" />
                      <line x1="15" y1="12" x2="21" y2="12" />
                    </svg>
                    Mind Map
                  </button>
                  <button
                    className="quick-create-btn quiz"
                    type="button"
                    onClick={() => handleStudyToolClick("quiz")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    Quiz
                  </button>
                  <button
                    className="quick-create-btn diagram"
                    type="button"
                    onClick={() => handleStudyToolClick("diagram")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                    Diagram
                  </button>
                  <button
                    className="quick-create-btn mock_exam"
                    type="button"
                    onClick={() => handleStudyToolClick("mock_exam")}
                    disabled={busy === "message" || turnInFlight}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 11l3 3L22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
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
                              setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking..." });
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
                            setThinkingState({ taskId: selectedTask.id, label: "Stuart is thinking..." });
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
                        onClick={() =>
                          setOpenDemoArtifact({
                            kind: demo.draft.kind,
                            title: demo.title,
                            payload: JSON.stringify(demo.draft),
                          })
                        }
                      >
                        <span className={`kind-badge ${demo.kind}`}>{demo.kind}</span>
                        <span className="demo-card-title">{demo.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Generated study artifacts */}
              {selectedStudyArtifacts.length > 0 ? (
                <div className="tools-section">
                  <span className="tools-section-label">Your study artifacts</span>
                  {Object.entries(groupedArtifacts).map(([kind, artifacts]) => {
                    if (artifacts.length === 0) return null;
                    const labels: Record<string, string> = {
                      flashcards: "Flashcards",
                      quiz: "Quizzes",
                      mindmap: "Mind Maps",
                      diagram: "Diagrams",
                      mock_exam: "Mock Exams",
                      interactive: "Interactive",
                      document_docx: "Documents",
                      document_xlsx: "Spreadsheets",
                      document_pptx: "Presentations",
                      document_pdf: "PDFs",
                      custom: "Custom",
                      other: "Other",
                    };
                    return (
                      <div key={kind} className="artifact-folder">
                        <div className="artifact-folder-header">
                          <span className={`kind-badge ${kind}`}>{labels[kind] ?? kind}</span>
                          <span className="artifact-folder-count">{artifacts.length}</span>
                        </div>
                        <div className="artifact-folder-items">
                          {artifacts.map((artifact) => (
                            <div key={artifact.id} className="artifact-card-row">
                              <button
                                className={`artifact-card-compact${openArtifact?.id === artifact.id ? " active" : ""}`}
                                onClick={() => setOpenArtifact(artifact)}
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
                    className="ghost-button compact destructive-text"
                    type="button"
                    disabled={busy === `delete-task-${selectedTask.id}`}
                    onClick={() => void deleteStudySession(selectedTask.id)}
                  >
                    Remove session
                  </button>
                </div>
              ) : null}
            </div>
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

function DiagnosticsCard({
  diagnostics,
  compact = false,
  onDismiss,
}: {
  diagnostics: SystemDiagnostics;
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
          ? "Fix the required checks below before expecting Stuart to boot cleanly."
          : optionalWarnings > 0
            ? "Stuart can start, but some optional capabilities are unavailable."
            : "Core prerequisites look good."}
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
              {check.command ? <code className="diagnostic-command">{check.command}</code> : null}
            </div>
          </div>
        ))}
      </div>
      {(requiredErrors > 0 || optionalWarnings > 0) ? (
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

/* ================================================================
   Dashboard View
   ================================================================ */

function DashboardView({
  projects,
  tasks,
  onSelectTask,
}: {
  projects: ProjectRecord[];
  tasks: TaskSpec[];
  onSelectTask: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, ProjectLearningSummary>>({});
  const [timelines, setTimelines] = useState<Record<string, StudyTimelineEntry[]>>({});
  const [taskBreakdowns, setTaskBreakdowns] = useState<Record<string, TaskPerformanceBreakdown>>({});

  // Fetch summaries for all projects
  useEffect(() => {
    for (const project of projects) {
      fetch(`/api/projects/${project.id}/learning-summary`)
        .then((r) => r.json())
        .then((data: ProjectLearningSummary) => {
          setSummaries((prev) => ({ ...prev, [project.id]: data }));
        })
        .catch(() => {});
    }
  }, [projects]);

  // Fetch timeline + task breakdowns when a project is expanded
  useEffect(() => {
    if (!expanded) return;
    fetch(`/api/projects/${expanded}/study-timeline?days=14`)
      .then((r) => r.json())
      .then((data: StudyTimelineEntry[]) => {
        setTimelines((prev) => ({ ...prev, [expanded]: data }));
      })
      .catch(() => {});

    const projectTasks = tasks.filter((t) => t.projectId === expanded);
    for (const task of projectTasks) {
      fetch(`/api/tasks/${task.id}/performance`)
        .then((r) => r.json())
        .then((data: TaskPerformanceBreakdown) => {
          setTaskBreakdowns((prev) => ({ ...prev, [task.id]: data }));
        })
        .catch(() => {});
    }
  }, [expanded, tasks]);

  return (
    <div className="dashboard-view">
      <h1>Your Study Dashboard</h1>
      <p>Click a project to see details, weak topics, and study options.</p>
      {projects.map((project) => {
        const summary = summaries[project.id];
        const isExpanded = expanded === project.id;
        const projectTasks = tasks.filter((t) => t.projectId === project.id);
        const timeline = timelines[project.id];

        return (
          <div
            key={project.id}
            className={`dashboard-project-card${isExpanded ? " expanded" : ""}`}
            onClick={() => setExpanded(isExpanded ? null : project.id)}
          >
            <div className="dashboard-project-header">
              <h2>{project.name}</h2>
              {summary && summary.cardsDue > 0 && (
                <span className="dashboard-due-badge">{summary.cardsDue} due</span>
              )}
            </div>
            {summary && (
              <div className="dashboard-stats-row">
                <span>{summary.totalArtifacts} artifacts</span>
                <span>{(summary.overallAccuracy * 100).toFixed(0)}% accuracy</span>
                {summary.streakDays > 0 && <span>{summary.streakDays}-day streak</span>}
                {summary.lastStudiedAt && (
                  <span>{formatTimeAgo(summary.lastStudiedAt)}</span>
                )}
              </div>
            )}

            {isExpanded && (
              <div className="dashboard-expanded-body" onClick={(e) => e.stopPropagation()}>
                {/* Timeline sparkline */}
                {timeline && timeline.length > 0 && (
                  <div>
                    <div className="dashboard-timeline">
                      {timeline.map((entry) => {
                        const maxReviews = Math.max(...timeline.map((e) => e.reviews), 1);
                        const height = entry.reviews > 0 ? Math.max(8, (entry.reviews / maxReviews) * 48) : 2;
                        const color =
                          entry.reviews === 0
                            ? "var(--line)"
                            : entry.accuracy >= 0.7
                              ? "var(--success)"
                              : entry.accuracy >= 0.4
                                ? "var(--warning)"
                                : "var(--danger)";
                        return (
                          <div
                            key={entry.date}
                            className="dashboard-timeline-bar"
                            style={{ height: `${height}px`, background: color }}
                            data-tip={`${entry.date}: ${entry.reviews} reviews, ${(entry.accuracy * 100).toFixed(0)}%`}
                          />
                        );
                      })}
                    </div>
                    <div className="dashboard-timeline-label">
                      <span>{timeline[0]?.date.slice(5)}</span>
                      <span>{timeline[timeline.length - 1]?.date.slice(5)}</span>
                    </div>
                  </div>
                )}

                {/* Weak topics */}
                {summary && summary.weakTopics.length > 0 && (
                  <div className="dashboard-weak-topics">
                    <h3>Weak Topics</h3>
                    {summary.weakTopics.map((topic) => {
                      const pct =
                        topic.totalAttempts > 0
                          ? (topic.correctCount / topic.totalAttempts) * 100
                          : 0;
                      const color =
                        pct >= 70
                          ? "var(--success)"
                          : pct >= 40
                            ? "var(--warning)"
                            : "var(--danger)";
                      return (
                        <div key={topic.id} className="dashboard-topic-row">
                          <span className="dashboard-topic-name">{topic.topic}</span>
                          <div className="dashboard-topic-bar-track">
                            <div
                              className="dashboard-topic-bar-fill"
                              style={{ width: `${pct}%`, background: color }}
                            />
                          </div>
                          <span className="dashboard-topic-pct">{pct.toFixed(0)}%</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Per-task breakdown */}
                {projectTasks.length > 0 && (
                  <div>
                    {projectTasks.map((task) => {
                      const bd = taskBreakdowns[task.id];
                      return (
                        <div key={task.id} className="dashboard-task-card">
                          <span className="task-title">{task.title}</span>
                          {bd && (
                            <span className="task-stats">
                              {bd.artifactCount} artifacts
                              {bd.totalCards > 0 && ` | ${bd.cardsDue} due`}
                              {bd.totalQuizQuestions > 0 &&
                                ` | ${(bd.quizAccuracy * 100).toFixed(0)}% quiz`}
                            </span>
                          )}
                          <button
                            className="study-btn"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectTask(task.id);
                            }}
                          >
                            Study
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
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

function ChatBubble({ message }: { message: TaskMessageRecord }) {
  // Detect if assistant message is a JSON artifact — show a clean card instead of raw JSON
  const isJsonArtifact = message.role === "assistant" && (() => {
    const trimmed = message.content.trim();
    if (!trimmed.startsWith("{") && !trimmed.includes("```json")) return false;
    try {
      const jsonStr = trimmed.startsWith("{") ? trimmed : (trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1] ?? "");
      if (!jsonStr) return false;
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      return ["flashcards", "quiz", "mindmap", "diagram", "mind_map", "flashcard", "mock_exam", "interactive", "custom"].includes(
        String(parsed.kind ?? parsed.artifactType ?? parsed.type ?? "").toLowerCase()
      );
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

  return (
    <article
      className={
        message.role === "user"
          ? "chat-bubble user"
          : message.role === "system"
            ? "chat-bubble system"
            : "chat-bubble assistant"
      }
    >
      <div className="chat-meta">
        <span className="chat-label">
          {message.role === "user" ? "You" : "Stuart"}
        </span>
        <span className="chat-time">{formatDate(message.createdAt)}</span>
      </div>
      {message.role === "assistant" ? (
        <MarkdownMessage content={displayContent} />
      ) : (
        <p className="plain-message">{message.content}</p>
      )}
    </article>
  );
}

function ThinkingBubble({ label, activities }: { label: string; activities?: AgentActivity[] }) {
  const running = activities?.filter(a => a.status === "running") ?? [];
  return (
    <article className="thinking-bubble">
      <div className="thinking-spinner" />
      <div>
        <span className="chat-label">Stuart</span>
        <p>{label}</p>
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  // Clean citation paths inline in content before rendering
  const cleanedContent = content.replace(
    /\[([^\]]*)\]\(attachments\/[a-f0-9-]+[-/][^)]+\)/gi,
    (match, linkText) => {
      // If the link text itself is a path, clean it
      const cleaned = cleanSourceName(linkText);
      return `**${cleaned}**`;
    }
  ).replace(
    /attachments\/[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+[-/][^\s)"\]]+/gi,
    (match) => cleanSourceName(match)
  );

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => {
            const normalizedHref = href?.trim() ?? "";
            if (!normalizedHref) {
              return <span>{children}</span>;
            }
            if (isExternalLink(normalizedHref)) {
              return (
                <a
                  href={normalizedHref}
                  target="_blank"
                  rel="noreferrer"
                  className="message-link external"
                >
                  {children}
                </a>
              );
            }
            // For workspace links, show as citation pill with clean name
            const displayName = cleanSourceName(normalizedHref);
            return (
              <span className="citation-pill" title={normalizedHref}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8" />
                </svg>
                {displayName || children}
              </span>
            );
          },
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          code: ({ children, className }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code>{children}</code>
            ),
          pre: ({ children }) => <pre>{children}</pre>,
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>
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

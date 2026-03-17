export type AttachmentMode = "reference" | "editable" | "output";

export type TaskRunStatus =
  | "draft"
  | "staging"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type ApprovalKind = "command" | "network" | "file" | "artifact";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type TaskMessageRole = "user" | "assistant" | "system";
export type ArtifactType =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "md"
  | "html"
  | "csv"
  | "folder"
  | "other";

export type WorkerRole =
  | "researcher"
  | "browser-operator"
  | "document-writer"
  | "spreadsheet-analyst"
  | "file-organizer";

export type WorkerStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type DiffOperationKind = "create" | "modify" | "delete" | "move";
export type VmState = "stopped" | "starting" | "running" | "error";
export type PreviewKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "html"
  | "jsx"
  | "text"
  | "image"
  | "folder"
  | "unsupported";

export interface ProjectAttachment {
  id: string;
  hostPath: string;
  mode: AttachmentMode;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface TaskSpec {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  globalInstructionProfileId: string;
  folderInstructionIds: string[];
  attachments: ProjectAttachment[];
  networkPolicyId: string;
  authMode: "chatgpt" | "api_key";
  browserEnabled: boolean;
  scheduleRRule?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  objective: string;
  globalInstructionProfileId?: string;
  folderInstructionIds?: string[];
  attachments: ProjectAttachment[];
  networkPolicyId?: string;
  authMode?: "chatgpt" | "api_key";
  browserEnabled?: boolean;
  scheduleRRule?: string;
}

export interface UpdateTaskInput {
  projectId?: string;
  title?: string;
  objective?: string;
  globalInstructionProfileId?: string;
  folderInstructionIds?: string[];
  attachments?: ProjectAttachment[];
  networkPolicyId?: string;
  authMode?: "chatgpt" | "api_key";
  browserEnabled?: boolean;
  scheduleRRule?: string;
}

export interface WorkerSpec {
  id: string;
  parentTaskId: string;
  role: WorkerRole | (string & {});
  objective: string;
  attachmentIds: string[];
  toolProfileId: string;
  taskRunId?: string;
  parentWorkerId?: string;
}

export interface CreateWorkerInput {
  role: WorkerRole | (string & {});
  objective: string;
  attachmentIds?: string[];
  toolProfileId?: string;
  taskRunId?: string;
  parentWorkerId?: string;
}

export interface TaskWorkerRecord extends WorkerSpec {
  status: WorkerStatus;
  threadId?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ArtifactRecord {
  id: string;
  taskRunId: string;
  type: ArtifactType;
  guestPath: string;
  proposedHostPath?: string;
  status: "draft" | "ready" | "applied" | "discarded";
  createdAt: string;
}

export interface WorkspaceFileRecord {
  id: string;
  taskId: string;
  taskRunId?: string;
  name: string;
  relativePath: string;
  sourceLabel: string;
  sourceKind: "project" | "attachment" | "staging";
  attachmentMode?: AttachmentMode;
  size: number;
  modifiedAt: string;
  previewKind: PreviewKind;
}

export interface IngestionDocumentRecord {
  id: string;
  taskId: string;
  taskRunId?: string;
  sourcePath: string;
  relativePath: string;
  fileType: string;
  parser: string;
  chunkCount: number;
  size: number;
  status: "indexed" | "skipped" | "failed";
  error?: string;
  indexedAt: string;
}

export interface IngestionChunkRecord {
  chunkId: string;
  documentId: string;
  taskId: string;
  taskRunId?: string;
  sourcePath: string;
  relativePath: string;
  fileType: string;
  heading?: string;
  locator?: string;
  text: string;
}

export interface IngestionSearchResult extends IngestionChunkRecord {
  score: number;
  snippet: string;
}

export interface IngestionIndexStats {
  taskId: string;
  taskRunId?: string;
  documentsIndexed: number;
  chunksIndexed: number;
  totalBytes: number;
  parserBreakdown: Record<string, number>;
  indexedAt?: string;
}

export interface ApprovalRecord {
  id: string;
  taskRunId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  detail?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface TaskMessageRecord {
  id: string;
  taskId: string;
  role: TaskMessageRole;
  content: string;
  createdAt: string;
}

export interface TaskRunRecord {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  stagingPath: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StagedAttachmentSnapshot {
  attachmentId: string;
  mode: AttachmentMode;
  hostPath: string;
  stagingPath: string;
  files: Record<string, FileFingerprint>;
}

export interface TaskRunManifest {
  taskRunId: string;
  taskId: string;
  createdAt: string;
  attachments: StagedAttachmentSnapshot[];
}

export interface FileFingerprint {
  relativePath: string;
  size: number;
  sha1: string;
  mtimeMs: number;
}

export interface DiffOperation {
  id: string;
  attachmentId: string;
  kind: DiffOperationKind;
  relativePath?: string;
  sourcePath?: string;
  targetPath?: string;
  size: number;
  sha1?: string;
  stale: boolean;
  reason?: string;
}

export interface DiffPreview {
  taskRunId: string;
  generatedAt: string;
  operations: DiffOperation[];
}

export function summarizeDiff(preview: DiffPreview): Record<DiffOperation["kind"], number> {
  return preview.operations.reduce<Record<DiffOperation["kind"], number>>(
    (summary, operation) => {
      summary[operation.kind] += 1;
      return summary;
    },
    {
      create: 0,
      modify: 0,
      delete: 0,
      move: 0
    }
  );
}

export interface VmStatus {
  state: VmState;
  detail: string;
  helperBinary?: string;
  imagePath?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  version: string;
  detail?: string;
}

export interface VmRpc {
  "guest.health": {};
  "task.prepare": { taskRunId: string };
  "task.startCodex": { taskRunId: string };
  "task.stopCodex": { taskRunId: string };
  "task.diff": { taskRunId: string };
  "task.applyPreview": { taskRunId: string };
  "worker.start": { taskRunId: string; worker: WorkerSpec };
  "worker.stop": { workerId: string };
  "index.build": { taskRunId: string; paths: string[] };
  "index.search": { taskRunId: string; query: string; filters?: Record<string, string> };
  "artifact.export": { taskRunId: string; kind: ArtifactType; inputPath: string; outputName: string };
  "browser.session.start": { taskRunId: string };
  "browser.session.stop": { taskRunId: string };
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string;
  result?: TResult;
  error?: {
    code: number;
    message: string;
  };
}

export interface McpServerSpec {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CommandFormSpec {
  id: string;
  title: string;
  description: string;
  promptTemplate: string;
}

export interface WorkerRoleExtension {
  id: string;
  role: WorkerRole | (string & {});
  description: string;
}

export interface ArtifactToolSpec {
  id: string;
  type: ArtifactType;
  command: string;
  args?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  skillsDir?: string;
  mcpServers?: McpServerSpec[];
  commandForms?: CommandFormSpec[];
  workerRoles?: WorkerRoleExtension[];
  artifactTools?: ArtifactToolSpec[];
  requiredPermissions: Array<"network" | "browser" | "filesystem" | "secrets">;
}

export interface DesktopApi {
  bootstrap(): Promise<void>;
  getVmStatus(): Promise<VmStatus>;
  listProjects(): Promise<ProjectRecord[]>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  listTasks(): Promise<TaskSpec[]>;
  createTask(input: CreateTaskInput): Promise<TaskSpec>;
  updateTask(taskId: string, input: UpdateTaskInput): Promise<TaskSpec>;
  listTaskWorkers(taskId: string): Promise<TaskWorkerRecord[]>;
  createTaskWorker(taskId: string, input: CreateWorkerInput): Promise<TaskWorkerRecord>;
  listTaskMessages(taskId: string): Promise<TaskMessageRecord[]>;
  addTaskMessage(taskId: string, content: string): Promise<TaskMessageRecord[]>;
  prepareTaskRun(taskId: string): Promise<TaskRunRecord>;
  previewTaskDiff(taskRunId: string): Promise<DiffPreview>;
  listTaskRuns(taskId: string): Promise<TaskRunRecord[]>;
  listArtifacts(taskRunId: string): Promise<ArtifactRecord[]>;
  pickFolder(): Promise<string | null>;
}

export type WorkspaceEvent =
  | {
      type: "connected";
    }
  | {
      type: "project.created";
      projectId: string;
    }
  | {
      type: "task.created";
      taskId: string;
    }
  | {
      type: "task.updated";
      taskId: string;
    }
  | {
      type: "task.run";
      taskId: string;
      taskRunId: string;
    }
  | {
      type: "task.approval";
      taskRunId: string;
      approvalId: string;
    }
  | {
      type: "task.message";
      taskId: string;
    }
  | {
      type: "task.worker";
      taskId: string;
      workerId: string;
      status: WorkerStatus;
      role: string;
      summary?: string;
    }
  | {
      type: "task.agent";
      taskId: string;
      agentId: string;
      status: "running" | "completed" | "failed";
      label: string;
      detail?: string;
    }
  | {
      type: "codex.turn.started";
      taskId: string;
      threadId: string;
      turnId: string;
      label: string;
    }
  | {
      type: "codex.thinking";
      taskId: string;
      threadId: string;
      turnId: string;
      label: string;
    }
  | {
      type: "codex.message.delta";
      taskId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "codex.message.completed";
      taskId: string;
      threadId: string;
      turnId: string;
      message: TaskMessageRecord;
    }
  | {
      type: "codex.turn.completed";
      taskId: string;
      threadId: string;
      turnId: string;
      status: "completed" | "failed";
      error?: string;
    }
  | {
      type: "task.context_compacting";
      taskId: string;
      active: boolean;
      message: string;
    };

export const DEFAULT_GLOBAL_INSTRUCTION_PROFILE = "default";
export const DEFAULT_NETWORK_POLICY = "ask";

export type StudyArtifactKind = "mindmap" | "flashcards" | "quiz" | "diagram" | "custom" | "mock_exam" | "interactive";

export type MindMapNode = { id: string; label: string; detail: string; citations: CitationRef[]; children?: MindMapNode[] };
export type Flashcard = { id: string; front: string; back: string; cue: string; citations: CitationRef[] };
export type QuizQuestion = { id: string; prompt: string; options: string[]; answer: string; explanation: string; citations: CitationRef[]; optionExplanations?: Record<string, string> };
export type DiagramScene = { title: string; mermaid: string; notes: Array<{ id: string; label: string; explanation: string; citations: CitationRef[] }> };

export type CustomSection = { heading: string; body: string; citations: CitationRef[] };

export type ArtifactDraft =
  | { kind: "mindmap"; title: string; nodes: MindMapNode[] }
  | { kind: "flashcards"; title: string; cards: Flashcard[] }
  | { kind: "quiz"; title: string; questions: QuizQuestion[] }
  | { kind: "diagram"; title: string; scene: DiagramScene }
  | { kind: "custom"; title: string; content: string; sections: CustomSection[] }
  | { kind: "mock_exam"; title: string; timeLimitMinutes: number; sections: MockExamSection[] }
  | { kind: "interactive"; title: string; html: string };

export type CitationRef = {
  sourceId: string;
  relativePath: string;
  chunkId?: string;
  locator?: string;
  excerpt: string;
  content?: string;
};

export type StudyArtifactRecord = {
  id: string;
  taskId: string;
  kind: StudyArtifactKind;
  title: string;
  payload: string;
  createdAt: string;
};

export type CardPerformanceRecord = {
  id: string;
  artifactId: string;
  cardId: string;
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewDate: string;
  lastRating: string | null;
  totalReviews: number;
  correctCount: number;
  createdAt: string;
  updatedAt: string;
};

export type QuizPerformanceRecord = {
  id: string;
  artifactId: string;
  questionId: string;
  attemptNumber: number;
  selectedAnswer: string | null;
  isCorrect: boolean;
  difficultyFlag: string | null;
  attemptedAt: string;
};

export type MockExamSection = {
  id: string;
  title: string;
  instructions: string;
  totalMarks: number;
  questions: MockExamQuestion[];
};

export type MockExamQuestion = {
  id: string;
  questionType: "mcq" | "short_answer" | "essay";
  prompt: string;
  marks: number;
  options?: string[];
  correctAnswer: string;
  markingCriteria?: string;
  citations: CitationRef[];
};

export type MindMapNodeNote = {
  id: string;
  artifactId: string;
  nodeId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type MockExamAttempt = {
  id: string;
  artifactId: string;
  answers: string;
  score: number | null;
  totalMarks: number;
  timeTakenSeconds: number | null;
  startedAt: string;
  completedAt: string | null;
};

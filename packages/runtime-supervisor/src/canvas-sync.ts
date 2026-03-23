/**
 * Canvas LMS Sync Orchestrator.
 *
 * Coordinates syncing files, assignments, grades, and modules from Canvas LMS
 * into Stuart's local database and project workspace.
 *
 * Phases (run in sequence):
 *   1. Files      – download new/updated files to <projectRoot>/canvas-files/
 *   2. Assignments – fetch assignments with inline student submissions
 *   3. Modules    – fetch course module structure
 *   4. Grades     – import graded submissions as student memory entries
 *   5. Curriculum  – generate curriculum.json from Canvas modules
 */

import { join, extname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CanvasApiClient,
  type CanvasFile,
} from "./canvas-client.js";
import type {
  CanvasConnectionRecord,
  CanvasCourseMappingRecord,
  CanvasSyncProgress,
  CreateStudentMemoryInput,
} from "@stuart/shared";

// ---------------------------------------------------------------------------
// File-type allow-list (matches Stuart's ingestion capabilities)
// ---------------------------------------------------------------------------

const INGESTIBLE_EXTENSIONS = new Set([
  // Documents
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".txt", ".md", ".csv", ".html", ".htm", ".rtf", ".tex",
  // Images
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  // Source code
  ".py", ".js", ".ts", ".java", ".c", ".cpp", ".rb", ".go", ".rs",
  // Data / config
  ".json", ".xml", ".yaml", ".yml",
]);

/** Skip files larger than 100 MB */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncProgressCallback = (progress: CanvasSyncProgress) => void;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Coordinates a full Canvas-to-Stuart sync for a single course mapping.
 *
 * The `db` parameter is typed as `any` because several Canvas-specific
 * persistence helpers (upsertCanvasSyncedFile, upsertCanvasAssignment, etc.)
 * are added at the raw-SQL level below and are not yet part of the
 * LocalDatabase public interface.
 *
 * TODO: Migrate the raw-SQL helpers into LocalDatabase proper once the
 *       Canvas integration stabilises.
 */
export class CanvasSyncOrchestrator {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: any,
    private onProgress?: SyncProgressCallback,
  ) {}

  // -------------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------------

  async syncCourse(
    connection: CanvasConnectionRecord & { token: string },
    mapping: CanvasCourseMappingRecord,
  ): Promise<void> {
    const client = new CanvasApiClient(connection.baseUrl, connection.token);

    // Use rootPath from the mapping (download folder), or fall back to project rootPath
    const rootPath = (mapping as any).rootPath
      ?? (mapping.projectId ? this.db.getProject?.(mapping.projectId)?.rootPath : null);
    if (!rootPath) {
      throw new Error(`No download folder set for course mapping ${mapping.id}`);
    }

    // Phase 1: Files — always runs (this is the core sync)
    await this.syncFiles(client, mapping, rootPath);

    // Phase 2: Assignments + Grades
    await this.syncAssignments(client, mapping);

    // Phase 3: Modules
    await this.syncModules(client, mapping);

    // Phase 4+5: Only import grades/curriculum if a project is linked
    if (mapping.projectId) {
      await this.importGradesAsMemories(mapping, rootPath);
      await this.importModulesAsCurriculum(mapping, rootPath);
    }

    // Update last sync timestamp on the connection
    this.db.updateCanvasConnection?.(connection.id, {
      lastSyncAt: new Date().toISOString(),
    });

    // Update the mapping's last_synced_at
    const now = new Date().toISOString();
    this.rawDb
      .prepare(
        "UPDATE canvas_course_mappings SET last_synced_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, mapping.id);
  }

  // -------------------------------------------------------------------------
  // Phase 1 – Files
  // -------------------------------------------------------------------------

  private async syncFiles(
    client: CanvasApiClient,
    mapping: CanvasCourseMappingRecord,
    projectRoot: string,
  ): Promise<void> {
    this.emitProgress(mapping, "files", 0, 0, "Fetching file list from Canvas...");

    // Build a map of folder IDs to their relative paths
    const folders = await client.listCourseFolders(mapping.canvasCourseId);
    const folderMap = new Map(
      folders.map((f) => [
        f.id,
        f.full_name.replace(/^course files\/?/i, ""),
      ]),
    );

    // Fetch all course files and filter to ingestible types / sizes
    const files = await client.listCourseFiles(mapping.canvasCourseId);
    const eligibleFiles = files.filter((f) => this.isEligibleForDownload(f));

    this.emitProgress(
      mapping,
      "files",
      0,
      eligibleFiles.length,
      `Found ${eligibleFiles.length} eligible files to sync`,
    );

    for (let i = 0; i < eligibleFiles.length; i++) {
      const file = eligibleFiles[i]!;
      const folderPath =
        file.folder_id != null ? (folderMap.get(file.folder_id) ?? "") : "";
      const localRelPath = join("canvas-files", folderPath, file.display_name);
      const localAbsPath = join(projectRoot, localRelPath);

      // Incremental sync: skip files that haven't changed since last download
      const existing = this.getCanvasSyncedFile(mapping.id, String(file.id));
      if (
        existing &&
        existing.canvasUpdatedAt >= file.updated_at &&
        existing.downloadStatus === "downloaded"
      ) {
        this.emitProgress(
          mapping,
          "files",
          i + 1,
          eligibleFiles.length,
          `Skipped (current): ${file.display_name}`,
        );
        continue;
      }

      // Download the file
      try {
        this.emitProgress(
          mapping,
          "files",
          i + 1,
          eligibleFiles.length,
          `Downloading: ${file.display_name}`,
        );
        await client.downloadFile(file.url, localAbsPath);

        this.upsertCanvasSyncedFile({
          courseMappingId: mapping.id,
          canvasFileId: String(file.id),
          canvasFolderPath: folderPath || null,
          filename: file.display_name,
          contentType: file["content-type"] || null,
          size: file.size,
          canvasUpdatedAt: file.updated_at,
          localPath: localRelPath,
          downloadStatus: "downloaded",
          lastDownloadedAt: new Date().toISOString(),
        });
      } catch (_err) {
        this.upsertCanvasSyncedFile({
          courseMappingId: mapping.id,
          canvasFileId: String(file.id),
          canvasFolderPath: folderPath || null,
          filename: file.display_name,
          contentType: file["content-type"] || null,
          size: file.size,
          canvasUpdatedAt: file.updated_at,
          localPath: localRelPath,
          downloadStatus: "failed",
          lastDownloadedAt: null,
        });
      }
    }

    this.emitProgress(
      mapping,
      "files",
      eligibleFiles.length,
      eligibleFiles.length,
      "File sync complete",
    );
  }

  // -------------------------------------------------------------------------
  // Phase 2 – Assignments
  // -------------------------------------------------------------------------

  private async syncAssignments(
    client: CanvasApiClient,
    mapping: CanvasCourseMappingRecord,
  ): Promise<void> {
    this.emitProgress(mapping, "assignments", 0, 0, "Fetching assignments...");

    const assignments = await client.listAssignments(mapping.canvasCourseId);
    const groups = await client.listAssignmentGroups(mapping.canvasCourseId);
    const groupMap = new Map(groups.map((g) => [g.id, g.name]));

    this.emitProgress(
      mapping,
      "assignments",
      0,
      assignments.length,
      `Found ${assignments.length} assignments`,
    );

    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i]!;
      this.upsertCanvasAssignment({
        courseMappingId: mapping.id,
        canvasAssignmentId: String(a.id),
        title: a.name,
        description: a.description
          ? stripHtml(a.description).slice(0, 2000)
          : null,
        dueAt: a.due_at,
        pointsPossible: a.points_possible,
        submissionScore: a.submission?.score ?? null,
        submissionGrade: a.submission?.grade ?? null,
        submissionSubmittedAt: a.submission?.submitted_at ?? null,
        assignmentGroupName: groupMap.get(a.assignment_group_id) ?? null,
        canvasUpdatedAt: a.updated_at,
      });
    }

    this.emitProgress(
      mapping,
      "assignments",
      assignments.length,
      assignments.length,
      "Assignment sync complete",
    );
  }

  // -------------------------------------------------------------------------
  // Phase 3 – Modules
  // -------------------------------------------------------------------------

  private async syncModules(
    client: CanvasApiClient,
    mapping: CanvasCourseMappingRecord,
  ): Promise<void> {
    this.emitProgress(mapping, "modules", 0, 0, "Fetching modules...");

    const modules = await client.listModules(mapping.canvasCourseId);

    for (const m of modules) {
      this.upsertCanvasModule({
        courseMappingId: mapping.id,
        canvasModuleId: String(m.id),
        name: m.name,
        position: m.position,
        itemsJson: JSON.stringify(m.items ?? []),
        canvasUpdatedAt: m.updated_at ?? new Date().toISOString(),
      });
    }

    this.emitProgress(
      mapping,
      "modules",
      modules.length,
      modules.length,
      "Module sync complete",
    );
  }

  // -------------------------------------------------------------------------
  // Phase 4 – Import grades as student memories
  // -------------------------------------------------------------------------

  private async importGradesAsMemories(
    mapping: CanvasCourseMappingRecord,
    _projectRoot: string,
  ): Promise<void> {
    if (!mapping.projectId) return;
    this.emitProgress(
      mapping,
      "grades",
      0,
      0,
      "Importing grades into study memory...",
    );

    const assignments = this.listCanvasAssignments(mapping.id);
    let imported = 0;

    for (const a of assignments) {
      if (
        a.submissionScore === null ||
        a.pointsPossible === null ||
        a.pointsPossible === 0
      ) {
        continue;
      }

      const pct = Math.round((a.submissionScore / a.pointsPossible) * 100);
      const status =
        pct >= 90
          ? "mastered"
          : pct >= 70
            ? "understands"
            : pct >= 50
              ? "learning"
              : "struggling";

      const gradeInput: CreateStudentMemoryInput = {
        scopeType: "project",
        scopeId: mapping.projectId,
        category: "progress",
        topic: a.assignmentGroupName ?? "coursework",
        memoryKey: `canvas-grade-${mapping.canvasCourseId}-${a.canvasAssignmentId}`,
        content: `Scored ${a.submissionScore}/${a.pointsPossible} (${pct}%) on "${a.title}". Status: ${status}.`,
        sourceKind: "canvas_grade",
        eventDate: a.submissionSubmittedAt ?? undefined,
      };

      this.db.createStudentMemory(gradeInput);
      imported++;
    }

    // Also create deadline memories for upcoming assignments
    const now = new Date();
    for (const a of assignments) {
      if (!a.dueAt) continue;
      const due = new Date(a.dueAt);
      if (due <= now) continue; // skip past deadlines
      const daysUntil = Math.ceil(
        (due.getTime() - now.getTime()) / 86_400_000,
      );
      if (daysUntil > 30) continue; // only upcoming 30 days

      const deadlineInput: CreateStudentMemoryInput = {
        scopeType: "project",
        scopeId: mapping.projectId,
        category: "goal",
        topic: a.title,
        memoryKey: `canvas-deadline-${a.canvasAssignmentId}`,
        content: `"${a.title}" due ${a.dueAt.slice(0, 10)} (${daysUntil} day${daysUntil !== 1 ? "s" : ""}).${a.pointsPossible ? ` Worth ${a.pointsPossible} points.` : ""}`,
        sourceKind: "canvas_assignment",
        eventDate: a.dueAt,
        expiresAt: a.dueAt,
      };

      this.db.createStudentMemory(deadlineInput);
    }

    this.emitProgress(
      mapping,
      "grades",
      imported,
      imported,
      `Imported ${imported} grade records`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 5 – Import modules as curriculum.json
  // -------------------------------------------------------------------------

  private async importModulesAsCurriculum(
    mapping: CanvasCourseMappingRecord,
    projectRoot: string,
  ): Promise<void> {
    if (!mapping.projectId) return;

    const modules = this.listCanvasModules(mapping.id);
    if (modules.length === 0) return;

    const phases = modules
      .sort(
        (a: CanvasModuleRow, b: CanvasModuleRow) => a.position - b.position,
      )
      .map((mod: CanvasModuleRow) => {
        const items = JSON.parse(mod.itemsJson) as Array<{
          title: string;
          type: string;
          id: number;
        }>;
        return {
          id: `canvas-module-${mod.canvasModuleId}`,
          title: mod.name,
          sources: items
            .filter((i) => i.type === "File" || i.type === "Page")
            .map((i) => i.title),
          checkpoints: items
            .filter((i) => i.type === "Assignment" || i.type === "Quiz")
            .map((i) => ({
              id: `canvas-item-${i.id}`,
              topic: i.title,
              description: `Complete: ${i.title}`,
            })),
        };
      });

    const curriculum = {
      title: mapping.canvasCourseName,
      phases,
    };

    const curriculumPath = join(projectRoot, "curriculum.json");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(curriculumPath, JSON.stringify(curriculum, null, 2));
  }

  // -------------------------------------------------------------------------
  // Helpers – file eligibility
  // -------------------------------------------------------------------------

  private isEligibleForDownload(file: CanvasFile): boolean {
    if (file.size > MAX_FILE_SIZE) return false;
    const ext = extname(file.display_name || file.filename).toLowerCase();
    return INGESTIBLE_EXTENSIONS.has(ext);
  }

  // -------------------------------------------------------------------------
  // Progress events
  // -------------------------------------------------------------------------

  private emitProgress(
    mapping: CanvasCourseMappingRecord,
    phase: CanvasSyncProgress["phase"],
    current: number,
    total: number,
    detail: string,
  ): void {
    this.onProgress?.({
      connectionId: mapping.connectionId,
      courseMappingId: mapping.id,
      phase,
      current,
      total,
      detail,
    });
  }

  // -------------------------------------------------------------------------
  // Raw-SQL persistence helpers
  //
  // These operate directly on the underlying DatabaseSync instance because
  // the Canvas-specific CRUD methods are not yet part of LocalDatabase's
  // public API.  Access is via (this.db as any).db which is the private
  // DatabaseSync field.
  //
  // TODO: Move these into LocalDatabase once the Canvas schema is stable.
  // -------------------------------------------------------------------------

  /** Shortcut to the raw DatabaseSync instance inside LocalDatabase. */
  private get rawDb(): RawDb {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (this.db as any).db as RawDb;
  }

  private getCanvasSyncedFile(
    courseMappingId: string,
    canvasFileId: string,
  ): CanvasSyncedFileRow | undefined {
    return this.rawDb
      .prepare(
        `SELECT
           id,
           course_mapping_id   AS courseMappingId,
           canvas_file_id      AS canvasFileId,
           canvas_folder_path  AS canvasFolderPath,
           filename,
           content_type        AS contentType,
           size,
           canvas_updated_at   AS canvasUpdatedAt,
           local_path          AS localPath,
           download_status     AS downloadStatus,
           last_downloaded_at  AS lastDownloadedAt,
           created_at          AS createdAt,
           updated_at          AS updatedAt
         FROM canvas_synced_files
         WHERE course_mapping_id = ? AND canvas_file_id = ?`,
      )
      .get(courseMappingId, canvasFileId) as CanvasSyncedFileRow | undefined;
  }

  private upsertCanvasSyncedFile(input: UpsertSyncedFileInput): void {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.rawDb
      .prepare(
        `INSERT INTO canvas_synced_files (
           id, course_mapping_id, canvas_file_id, canvas_folder_path,
           filename, content_type, size, canvas_updated_at,
           local_path, download_status, last_downloaded_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_mapping_id, canvas_file_id) DO UPDATE SET
           canvas_folder_path  = excluded.canvas_folder_path,
           filename            = excluded.filename,
           content_type        = excluded.content_type,
           size                = excluded.size,
           canvas_updated_at   = excluded.canvas_updated_at,
           local_path          = excluded.local_path,
           download_status     = excluded.download_status,
           last_downloaded_at  = excluded.last_downloaded_at,
           updated_at          = excluded.updated_at`,
      )
      .run(
        id,
        input.courseMappingId,
        input.canvasFileId,
        input.canvasFolderPath,
        input.filename,
        input.contentType,
        input.size,
        input.canvasUpdatedAt,
        input.localPath,
        input.downloadStatus,
        input.lastDownloadedAt,
        now,
        now,
      );
  }

  private upsertCanvasAssignment(input: UpsertAssignmentInput): void {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.rawDb
      .prepare(
        `INSERT INTO canvas_assignments (
           id, course_mapping_id, canvas_assignment_id, title,
           description, due_at, points_possible,
           submission_score, submission_grade, submission_submitted_at,
           assignment_group_name, canvas_updated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_mapping_id, canvas_assignment_id) DO UPDATE SET
           title                    = excluded.title,
           description              = excluded.description,
           due_at                   = excluded.due_at,
           points_possible          = excluded.points_possible,
           submission_score         = excluded.submission_score,
           submission_grade         = excluded.submission_grade,
           submission_submitted_at  = excluded.submission_submitted_at,
           assignment_group_name    = excluded.assignment_group_name,
           canvas_updated_at        = excluded.canvas_updated_at,
           updated_at               = excluded.updated_at`,
      )
      .run(
        id,
        input.courseMappingId,
        input.canvasAssignmentId,
        input.title,
        input.description,
        input.dueAt,
        input.pointsPossible,
        input.submissionScore,
        input.submissionGrade,
        input.submissionSubmittedAt,
        input.assignmentGroupName,
        input.canvasUpdatedAt,
        now,
        now,
      );
  }

  private upsertCanvasModule(input: UpsertModuleInput): void {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.rawDb
      .prepare(
        `INSERT INTO canvas_modules (
           id, course_mapping_id, canvas_module_id, name,
           position, items_json, canvas_updated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_mapping_id, canvas_module_id) DO UPDATE SET
           name              = excluded.name,
           position          = excluded.position,
           items_json        = excluded.items_json,
           canvas_updated_at = excluded.canvas_updated_at,
           updated_at        = excluded.updated_at`,
      )
      .run(
        id,
        input.courseMappingId,
        input.canvasModuleId,
        input.name,
        input.position,
        input.itemsJson,
        input.canvasUpdatedAt,
        now,
        now,
      );
  }

  private listCanvasAssignments(courseMappingId: string): CanvasAssignmentRow[] {
    return this.rawDb
      .prepare(
        `SELECT
           id,
           course_mapping_id       AS courseMappingId,
           canvas_assignment_id    AS canvasAssignmentId,
           title,
           description,
           due_at                  AS dueAt,
           points_possible         AS pointsPossible,
           submission_score        AS submissionScore,
           submission_grade        AS submissionGrade,
           submission_submitted_at AS submissionSubmittedAt,
           assignment_group_name   AS assignmentGroupName,
           canvas_updated_at       AS canvasUpdatedAt,
           created_at              AS createdAt,
           updated_at              AS updatedAt
         FROM canvas_assignments
         WHERE course_mapping_id = ?
         ORDER BY due_at ASC NULLS LAST`,
      )
      .all(courseMappingId) as CanvasAssignmentRow[];
  }

  private listCanvasModules(courseMappingId: string): CanvasModuleRow[] {
    return this.rawDb
      .prepare(
        `SELECT
           id,
           course_mapping_id   AS courseMappingId,
           canvas_module_id    AS canvasModuleId,
           name,
           position,
           items_json          AS itemsJson,
           canvas_updated_at   AS canvasUpdatedAt,
           created_at          AS createdAt,
           updated_at          AS updatedAt
         FROM canvas_modules
         WHERE course_mapping_id = ?
         ORDER BY position ASC`,
      )
      .all(courseMappingId) as CanvasModuleRow[];
  }
}

// ---------------------------------------------------------------------------
// Internal row / input types
// ---------------------------------------------------------------------------

/** Minimal interface for the raw node:sqlite DatabaseSync prepared statements */
interface RawDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

type CanvasSyncedFileRow = {
  id: string;
  courseMappingId: string;
  canvasFileId: string;
  canvasFolderPath: string | null;
  filename: string;
  contentType: string | null;
  size: number;
  canvasUpdatedAt: string;
  localPath: string;
  downloadStatus: string;
  lastDownloadedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CanvasAssignmentRow = {
  id: string;
  courseMappingId: string;
  canvasAssignmentId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  pointsPossible: number | null;
  submissionScore: number | null;
  submissionGrade: string | null;
  submissionSubmittedAt: string | null;
  assignmentGroupName: string | null;
  canvasUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
};

type CanvasModuleRow = {
  id: string;
  courseMappingId: string;
  canvasModuleId: string;
  name: string;
  position: number;
  itemsJson: string;
  canvasUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
};

type UpsertSyncedFileInput = {
  courseMappingId: string;
  canvasFileId: string;
  canvasFolderPath: string | null;
  filename: string;
  contentType: string | null;
  size: number;
  canvasUpdatedAt: string;
  localPath: string;
  downloadStatus: "downloaded" | "failed" | "pending";
  lastDownloadedAt: string | null;
};

type UpsertAssignmentInput = {
  courseMappingId: string;
  canvasAssignmentId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  pointsPossible: number | null;
  submissionScore: number | null;
  submissionGrade: string | null;
  submissionSubmittedAt: string | null;
  assignmentGroupName: string | null;
  canvasUpdatedAt: string;
};

type UpsertModuleInput = {
  courseMappingId: string;
  canvasModuleId: string;
  name: string;
  position: number;
  itemsJson: string;
  canvasUpdatedAt: string;
};

// ---------------------------------------------------------------------------
// Utility: strip HTML tags to plain text
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

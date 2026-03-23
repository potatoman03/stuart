/**
 * Canvas LMS REST API client.
 * Handles authentication via personal access token, pagination via Link headers,
 * and rate limiting via X-Rate-Limit-Remaining headers.
 */

// Canvas API response types (subset we care about)
export type CanvasUserSelf = {
  id: number;
  name: string;
  login_id: string;
  avatar_url?: string;
};

export type CanvasCourse = {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id?: number;
  term?: { name: string };
  enrollments?: Array<{
    type: string;
    computed_current_score?: number;
    computed_current_grade?: string;
  }>;
};

export type CanvasFile = {
  id: number;
  display_name: string;
  filename: string;
  "content-type": string;
  size: number;
  url: string;
  updated_at: string;
  folder_id?: number;
};

export type CanvasFolder = {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
};

export type CanvasAssignment = {
  id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points_possible: number | null;
  assignment_group_id: number;
  submission?: {
    score: number | null;
    grade: string | null;
    submitted_at: string | null;
    graded_at: string | null;
    workflow_state: string;
    late: boolean;
  };
  updated_at: string;
};

export type CanvasAssignmentGroup = {
  id: number;
  name: string;
  group_weight: number;
};

export type CanvasModule = {
  id: number;
  name: string;
  position: number;
  items_count: number;
  items?: CanvasModuleItem[];
  updated_at?: string;
};

export type CanvasModuleItem = {
  id: number;
  title: string;
  type: "File" | "Page" | "Discussion" | "Assignment" | "Quiz" | "ExternalTool" | "ExternalUrl" | "SubHeader";
  content_id?: number;
  position: number;
  indent: number;
  html_url?: string;
};

export class CanvasApiClient {
  private baseUrl: string;
  private token: string;
  private rateLimitRemaining = 700;

  constructor(baseUrl: string, token: string) {
    // Normalize: strip trailing slash, ensure no /api/v1 suffix
    this.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1\/?$/, "");
    this.token = token;
  }

  /** Validate the connection by fetching the current user. */
  async validateConnection(): Promise<CanvasUserSelf> {
    return this.get<CanvasUserSelf>("/api/v1/users/self");
  }

  /** List all active courses the student is enrolled in. */
  async listActiveCourses(): Promise<CanvasCourse[]> {
    return this.getAllPages<CanvasCourse>(
      "/api/v1/courses?enrollment_state=active&include[]=term&include[]=total_scores&per_page=50"
    );
  }

  /** List all files in a course (paginated). */
  async listCourseFiles(courseId: string | number): Promise<CanvasFile[]> {
    return this.getAllPages<CanvasFile>(
      `/api/v1/courses/${courseId}/files?per_page=100&sort=updated_at&order=desc`
    );
  }

  /** List all folders in a course. */
  async listCourseFolders(courseId: string | number): Promise<CanvasFolder[]> {
    return this.getAllPages<CanvasFolder>(
      `/api/v1/courses/${courseId}/folders?per_page=100`
    );
  }

  /** Download a file to a local path. */
  async downloadFile(fileUrl: string, destPath: string): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    await mkdir(dirname(destPath), { recursive: true });

    const response = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destPath, buffer);
  }

  /** List assignments with inline submissions for a course. */
  async listAssignments(courseId: string | number): Promise<CanvasAssignment[]> {
    return this.getAllPages<CanvasAssignment>(
      `/api/v1/courses/${courseId}/assignments?include[]=submission&order_by=due_at&per_page=50`
    );
  }

  /** List assignment groups for a course. */
  async listAssignmentGroups(courseId: string | number): Promise<CanvasAssignmentGroup[]> {
    return this.getAllPages<CanvasAssignmentGroup>(
      `/api/v1/courses/${courseId}/assignment_groups?per_page=50`
    );
  }

  /** List modules with items for a course. */
  async listModules(courseId: string | number): Promise<CanvasModule[]> {
    return this.getAllPages<CanvasModule>(
      `/api/v1/courses/${courseId}/modules?include[]=items&include[]=content_details&per_page=50`
    );
  }

  /** List items in a specific module. */
  async listModuleItems(courseId: string | number, moduleId: string | number): Promise<CanvasModuleItem[]> {
    return this.getAllPages<CanvasModuleItem>(
      `/api/v1/courses/${courseId}/modules/${moduleId}/items?per_page=100`
    );
  }

  /** Get a single file by ID. */
  async getFile(courseId: string | number, fileId: string | number): Promise<CanvasFile> {
    return this.get<CanvasFile>(`/api/v1/courses/${courseId}/files/${fileId}`);
  }

  /**
   * Collect all File-type items from course modules.
   * Returns CanvasFile objects for each unique file referenced in modules.
   * Files that already appear in the regular files listing can be deduped by the caller.
   */
  async listModuleFiles(courseId: string | number): Promise<CanvasFile[]> {
    const modules = await this.listModules(courseId);

    // Extract unique file content_ids from all module items
    const fileIds = new Set<number>();
    for (const mod of modules) {
      const items = mod.items ?? [];
      for (const item of items) {
        if (item.type === "File" && item.content_id != null) {
          fileIds.add(item.content_id);
        }
      }
    }

    if (fileIds.size === 0) return [];

    // Fetch file metadata for each unique file ID (in parallel, batched)
    const results: CanvasFile[] = [];
    const ids = [...fileIds];
    // Fetch in batches of 10 to avoid overwhelming the API
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const fetched = await Promise.allSettled(
        batch.map((fid) => this.getFile(courseId, fid))
      );
      for (const result of fetched) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
        // Silently skip files that fail (might be restricted/deleted)
      }
    }

    return results;
  }

  // ---- Internal methods ----

  private async get<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    await this.respectRateLimit();

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    this.updateRateLimit(response);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CanvasApiError(response.status, body, url);
    }

    return response.json() as Promise<T>;
  }

  private async getAllPages<T>(initialPath: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = initialPath.startsWith("http")
      ? initialPath
      : `${this.baseUrl}${initialPath}`;

    while (url) {
      await this.respectRateLimit();

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });

      this.updateRateLimit(response);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new CanvasApiError(response.status, body, url);
      }

      const page = (await response.json()) as T[];
      results.push(...page);

      // Parse Link header for next page
      url = this.parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match?.[1] ?? null;
  }

  private updateRateLimit(response: Response): void {
    const remaining = response.headers.get("x-rate-limit-remaining");
    if (remaining) {
      this.rateLimitRemaining = parseFloat(remaining);
    }
  }

  private async respectRateLimit(): Promise<void> {
    if (this.rateLimitRemaining < 10) {
      await new Promise((r) => setTimeout(r, 2000));
    } else if (this.rateLimitRemaining < 50) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export class CanvasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Canvas API error ${status} at ${url}: ${body.slice(0, 200)}`);
    this.name = "CanvasApiError";
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 403 || this.status === 429;
  }
}

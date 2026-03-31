import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { LocalDatabase } from "../../packages/db/dist/index.js";
import { renderDocument } from "../../packages/runtime-supervisor/dist/index.js";

const apiOrigin = process.env.STUART_E2E_API_ORIGIN ?? "http://127.0.0.1:8877";
const fixtureWorkspacePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/study-workspace",
);
const e2eDataDir = path.resolve(process.cwd(), ".stuart-data-e2e");
const cleanupPaths = [];
const cleanupEntities = [];

async function json(request, method, url, body) {
  const response = await eventually(async () => {
    const nextResponse = await request.fetch(`${apiOrigin}${url}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      data: body,
    });
    if (!nextResponse.ok()) {
      throw new Error(`${method} ${url} failed: ${nextResponse.status()} ${await nextResponse.text()}`);
    }
    return nextResponse;
  });
  const contentType = response.headers()["content-type"] ?? "";
  if (response.status() === 204 || !contentType.includes("application/json")) {
    return null;
  }
  return response.json();
}

async function eventually(fn, attempts = 20, delayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function cleanupHarnessState(request) {
  while (cleanupEntities.length > 0) {
    const target = cleanupEntities.pop();
    if (!target) continue;

    try {
      await json(request, "DELETE", `/api/tasks/${target.taskId}`);
    } catch {
      // Ignore already-removed tasks during cleanup.
    }

    try {
      await json(request, "DELETE", `/api/projects/${target.projectId}`);
    } catch {
      // Ignore already-removed projects during cleanup.
    }
  }
}

async function seedStudySession(request, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const workspacePath = overrides.workspacePath ?? fixtureWorkspacePath;
  const project = await json(request, "POST", "/api/projects", {
    name: overrides.projectName ?? `Study Workspace ${suffix}`,
    rootPath: workspacePath,
  });

  const task = await json(request, "POST", "/api/tasks", {
    projectId: project.id,
    title: overrides.taskTitle ?? `Study: Workspace ${suffix}`,
    objective:
      overrides.objective ??
      "Help me understand the materials in this folder and build study tools from them.",
    attachments: [
      {
        id: `attachment-${suffix}`,
        hostPath: workspacePath,
        mode: "reference",
      },
    ],
    browserEnabled: false,
    authMode: "chatgpt",
  });

  cleanupEntities.push({
    projectId: project.id,
    taskId: task.id,
  });

  return { project, task };
}

async function createStudyArtifact(request, taskId, artifact) {
  return json(request, "POST", `/api/tasks/${taskId}/study-artifacts`, artifact);
}

async function buildGeneratedWorkspace() {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "stuart-e2e-workspace-"));
  cleanupPaths.push(workspacePath);

  await renderDocument("document_pdf", {
    metadata: {
      subject: "Lecture 02 - Breadth First Search",
      author: "Stuart",
    },
    sections: [
      {
        heading: "Breadth-First Search",
        level: 1,
        paragraphs: [
          { type: "text", content: "Breadth-first search uses a FIFO queue as its frontier data structure." },
          { type: "text", content: "It expands nodes in layers of increasing depth." },
        ],
      },
    ],
  }, workspacePath, "Lecture 02 - Breadth First Search");

  await renderDocument("document_pptx", {
    presentation: {
      slides: [
        {
          layout: "title",
          title: "Breadth-First Search",
          subtitle: "Queue-based frontier expansion",
        },
        {
          layout: "content",
          title: "Frontier behavior",
          bullets: [
            "Breadth-first search uses a FIFO queue.",
            "Nodes are expanded in layers of increasing depth.",
          ],
        },
      ],
    },
  }, workspacePath, "Lecture 03 - Search Deck");

  return workspacePath;
}

async function buildIngestion(request, taskId) {
  await json(request, "POST", `/api/tasks/${taskId}/ingestion/build`, {});
}

function seedAssistantMessage(taskId, content) {
  const db = new LocalDatabase(path.join(e2eDataDir, "stuart.sqlite"));
  try {
    db.createTaskMessage({
      taskId,
      role: "assistant",
      content,
    });
  } finally {
    db.close();
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupHarnessState(request);
});

test.afterEach(async ({ request }) => {
  await cleanupHarnessState(request);
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

test("seeded workspace renders as a current study session", async ({ page, request }) => {
  const { project, task } = await seedStudySession(request, {
    projectName: "Accounting 101",
    taskTitle: "Study: Lecture Pack",
  });

  await page.goto("/");

  await expect(page.getByRole("button", { name: project.name })).toBeVisible();
  await expect(page.getByRole("button", { name: task.title })).toBeVisible();
  await expect(page.getByPlaceholder("Ask Stuart anything about your materials...")).toBeVisible();
  await expect(page.getByText("Study Tools", { exact: true })).toBeVisible();
});

test("flashcard artifact scaffold opens and supports card progression", async ({ page, request }) => {
  const { task } = await seedStudySession(request, {
    projectName: "ACC1701X",
    taskTitle: "Study: Lecture 2",
  });

  await createStudyArtifact(request, task.id, {
    kind: "flashcards",
    title: "Lecture 2 Core Cards",
    payload: JSON.stringify({
      kind: "flashcards",
      title: "Lecture 2 Core Cards",
      cards: [
        {
          id: "card-1",
          front: "What is the accounting equation?",
          back: "Assets = Liabilities + Equity.",
          cue: "It anchors the balance sheet.",
          citations: [
            {
              sourceId: "src-1",
              relativePath: "Lecture 02 Slides - Mechanics of Accounting.md",
              excerpt: "The fundamental accounting equation is Assets = Liabilities + Equity.",
            },
          ],
        },
        {
          id: "card-2",
          front: "What does a balance sheet show?",
          back: "It shows assets, liabilities, and equity at a point in time.",
          cue: "Think of financial position, not performance.",
          citations: [
            {
              sourceId: "src-2",
              relativePath: "Lecture 02 Slides - Mechanics of Accounting.md",
              excerpt: "The statement of financial position summarizes assets, liabilities, and equity.",
            },
          ],
        },
      ],
    }),
  });

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();

  await page.getByRole("button", { name: "Lecture 2 Core Cards" }).click();

  await expect(page.getByRole("heading", { name: "Lecture 2 Core Cards" })).toBeVisible();
  await expect(page.getByText("Card 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Show Answer" }).click();
  await expect(page.getByText("Assets = Liabilities + Equity.")).toBeVisible();
  await page.getByRole("button", { name: "Good" }).click();
  await expect(page.getByText("Card 2 of 2")).toBeVisible();
});

test("quiz artifact scaffold opens and supports answer checking", async ({ page, request }) => {
  const { task } = await seedStudySession(request, {
    projectName: "CS2109S",
    taskTitle: "Study: Bayes Net Review",
  });

  await createStudyArtifact(request, task.id, {
    kind: "quiz",
    title: "Lecture Review Quiz",
    payload: JSON.stringify({
      kind: "quiz",
      title: "Lecture Review Quiz",
      questions: [
        {
          id: "quiz-1",
          prompt: "Which statement best describes the accounting equation?",
          options: [
            "Revenue = Expense + Profit",
            "Assets = Liabilities + Equity",
            "Cash = Sales - Costs",
          ],
          answer: "Assets = Liabilities + Equity",
          explanation: "It is the core relationship used to structure the balance sheet.",
          citations: [
            {
              sourceId: "src-3",
              relativePath: "Lecture 02 Slides - Mechanics of Accounting.md",
              excerpt: "Assets = Liabilities + Equity is the fundamental accounting equation.",
            },
          ],
        },
      ],
    }),
  });

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();

  await page.getByRole("button", { name: "Lecture Review Quiz" }).click();

  await expect(page.getByRole("heading", { name: "Lecture Review Quiz" })).toBeVisible();
  await page.locator(".quiz-option-card").filter({
    hasText: "Assets = Liabilities + Equity",
  }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByText("Correct!")).toBeVisible();
  await expect(page.getByRole("button", { name: "See Results" })).toBeVisible();
});

test("pdf citations resolve excerpts and open a pdf-backed source preview", async ({ page, request }) => {
  const workspacePath = await buildGeneratedWorkspace();
  const { task } = await seedStudySession(request, {
    projectName: "Search Notes",
    taskTitle: "Study: BFS",
    workspacePath,
  });

  await buildIngestion(request, task.id);
  seedAssistantMessage(
    task.id,
    "Breadth-first search uses a FIFO queue as its frontier data structure [Lecture 2](Lecture 02 - Breadth First Search.pdf).",
  );

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();

  const citation = page.locator(".citation-pill.clickable", { hasText: "Lecture 2" }).first();
  await expect(citation).toBeVisible();
  await citation.click();

  await expect(page.locator(".citation-popover-empty")).toHaveCount(0);
  await expect(page.locator(".citation-popover-chunk")).toHaveCount(1);

  await page.getByRole("button", { name: "Open source" }).click();
  await expect(page.locator(".pdf-preview-shell")).toBeVisible();
  await expect(page.locator(".pdf-preview-status")).toContainText("Page 1 of");
  await expect(page.locator(".pdf-preview-canvas")).toBeVisible();
});

test("pptx citations open an actual preview route instead of the unsupported placeholder", async ({ page, request }) => {
  const workspacePath = await buildGeneratedWorkspace();
  const { task } = await seedStudySession(request, {
    projectName: "Search Slides",
    taskTitle: "Study: BFS Slides",
    workspacePath,
  });

  await buildIngestion(request, task.id);
  seedAssistantMessage(
    task.id,
    "The slide deck also states that breadth-first search uses a FIFO queue [Lecture 3](Lecture 03 - Search Deck.pptx).",
  );

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();

  const citation = page.locator(".citation-pill.clickable", { hasText: "Lecture 3" }).first();
  await expect(citation).toBeVisible();
  await citation.click();

  await expect(page.locator(".citation-popover-empty")).toHaveCount(0);
  await page.getByRole("button", { name: "Open source" }).first().click();

  const iframe = page.locator(".workspace-preview-iframe");
  await expect(iframe).toBeVisible();
  const src = await iframe.getAttribute("src");
  expect(src).toContain("/workspace-files/");

  const response = await request.fetch(src.startsWith("http") ? src : `${apiOrigin}${src}`);
  expect(response.ok()).toBe(true);
  const contentType = response.headers()["content-type"] ?? "";
  expect(contentType === "" ? false : /application\/pdf|text\/html/i.test(contentType)).toBe(true);

  if (contentType.includes("text/html")) {
    const body = await response.text();
    expect(body).not.toContain("This file type does not have an inline preview yet.");
    expect(body).not.toContain("No readable slide text was found in this deck.");
  }
});

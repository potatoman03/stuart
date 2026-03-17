import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const apiOrigin = process.env.STUART_E2E_API_ORIGIN ?? "http://127.0.0.1:8877";
const fixtureWorkspacePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/study-workspace",
);

async function json(request, method, url, body) {
  const response = await request.fetch(`${apiOrigin}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    data: body,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${url} failed: ${response.status()} ${await response.text()}`);
  }
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

async function resetHarnessState(request) {
  const dashboard = await eventually(() => json(request, "GET", "/api/dashboard"));

  for (const task of dashboard.tasks ?? []) {
    await json(request, "DELETE", `/api/tasks/${task.id}`);
  }

  for (const project of dashboard.projects ?? []) {
    await json(request, "DELETE", `/api/projects/${project.id}`);
  }
}

async function seedStudySession(request, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await json(request, "POST", "/api/projects", {
    name: overrides.projectName ?? `Study Workspace ${suffix}`,
    rootPath: fixtureWorkspacePath,
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
        hostPath: fixtureWorkspacePath,
        mode: "reference",
      },
    ],
    browserEnabled: false,
    authMode: "chatgpt",
  });

  return { project, task };
}

async function createStudyArtifact(request, taskId, artifact) {
  return json(request, "POST", `/api/tasks/${taskId}/study-artifacts`, artifact);
}

test.beforeEach(async ({ request }) => {
  await resetHarnessState(request);
});

test.afterEach(async ({ request }) => {
  await resetHarnessState(request);
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

  await page.getByRole("button", { name: "Lecture Review Quiz" }).click();

  await expect(page.getByRole("heading", { name: "Lecture Review Quiz" })).toBeVisible();
  await page.locator(".quiz-option-card").filter({
    hasText: "Assets = Liabilities + Equity",
  }).click();
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Correct!")).toBeVisible();
  await expect(page.getByRole("button", { name: "See Results" })).toBeVisible();
});

import { expect, test } from "@playwright/test";

const apiOrigin = process.env.STUART_E2E_API_ORIGIN ?? "http://127.0.0.1:8877";

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

const cleanupEntities = [];

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

async function seedStudySession(request, { socratic = false } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await json(request, "POST", "/api/projects", {
    name: socratic ? `Socratic ${suffix}` : `Normal ${suffix}`,
    rootPath: process.cwd(),
    config: socratic ? { teachingStyle: "Socratic" } : {},
  });

  const task = await json(request, "POST", "/api/tasks", {
    projectId: project.id,
    title: socratic ? `Study: Socratic ${suffix}` : `Study: Normal ${suffix}`,
    objective: "Help me study.",
    attachments: [],
    browserEnabled: false,
    authMode: "chatgpt",
  });

  cleanupEntities.push({
    projectId: project.id,
    taskId: task.id,
  });

  return { project, task };
}

async function createQuizArtifact(request, taskId, title) {
  return json(request, "POST", `/api/tasks/${taskId}/study-artifacts`, {
    kind: "quiz",
    title,
    payload: JSON.stringify({
      kind: "quiz",
      title,
      questions: [
        {
          id: "quiz-1",
          prompt: "Which scheduler always picks the shortest remaining job next?",
          options: ["FCFS", "SRTF", "Round Robin"],
          answer: "SRTF",
          explanation: "Shortest Remaining Time First chooses the runnable job with the least remaining time.",
          citations: [],
          optionExplanations: {},
        },
      ],
    }),
  });
}

test.beforeEach(async ({ request }) => {
  await cleanupHarnessState(request);
});

test.afterEach(async ({ request }) => {
  await cleanupHarnessState(request);
});

test("Socratic workspaces show coaching controls and a Socratic debrief action for quiz misses", async ({ page, request }) => {
  const { task } = await seedStudySession(request, { socratic: true });
  await createQuizArtifact(request, task.id, "Socratic Quiz");

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();
  await page.getByRole("button", { name: "Socratic Quiz" }).click();

  await page.locator(".quiz-option-card").filter({ hasText: "FCFS" }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("button", { name: "Coach me through this" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Coach Inline" })).toBeVisible();

  await page.getByRole("button", { name: "See Results" }).click();
  await expect(page.getByRole("button", { name: "Socratic Debrief" })).toBeVisible();
});

test("Non-Socratic workspaces keep direct explain controls for quiz misses", async ({ page, request }) => {
  const { task } = await seedStudySession(request, { socratic: false });
  await createQuizArtifact(request, task.id, "Normal Quiz");

  await page.goto("/");
  await page.getByRole("button", { name: task.title }).click();
  await page.getByRole("button", { name: "Normal Quiz" }).click();

  await page.locator(".quiz-option-card").filter({ hasText: "FCFS" }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("button", { name: "Explain this" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain Inline" })).toBeVisible();

  await page.getByRole("button", { name: "See Results" }).click();
  await expect(page.getByRole("button", { name: "Socratic Debrief" })).toHaveCount(0);
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LocalDatabase } from "../../packages/db/src/index.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Simulates realistic study activity on accounting flashcards and quizzes,
 * then validates that the memory and performance systems produce correct outputs.
 */

let db: LocalDatabase;
let tmpDir: string;
let projectId: string;
let taskId: string;
let flashcardArtifactId: string;
let quizArtifactId: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "stuart-memory-test-"));
  db = new LocalDatabase(join(tmpDir, "test.sqlite"));

  const project = db.createProject({ name: "Accounting 101", rootPath: "/tmp/accounting" });
  projectId = project.id;

  const task = db.createTask({
    projectId,
    title: "Study: Accounting 101",
    objective: "Study accounting fundamentals",
    attachments: [],
    browserEnabled: false,
    authMode: "chatgpt",
  });
  taskId = task.id;
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

describe("Memory System Pipeline", () => {
  it("should create flashcard and quiz artifacts", () => {
    const flashcard = db.createStudyArtifact({
      taskId,
      kind: "flashcards",
      title: "Financial Statements - Key Concepts",
      payload: JSON.stringify({
        kind: "flashcards",
        title: "Financial Statements - Key Concepts",
        cards: [
          { id: "card-assets-eq", front: "What is the accounting equation?", back: "Assets = Liabilities + Equity", cue: "A = L + E", citations: [] },
          { id: "card-debit-credit", front: "What do debits increase?", back: "Assets and Expenses", cue: "Debit left side", citations: [] },
          { id: "card-revenue-rec", front: "When is revenue recognized?", back: "When earned", cue: "Earned not received", citations: [] },
          { id: "card-balance-sheet", front: "Three sections of a balance sheet?", back: "Assets, Liabilities, Equity", cue: "A, L, E", citations: [] },
          { id: "card-income-stmt", front: "What does the income statement show?", back: "Revenue - Expenses = Net Income", cue: "Rev - Exp", citations: [] },
          { id: "card-closing", front: "Purpose of closing entries?", back: "Transfer temp balances to RE", cue: "Temp -> RE", citations: [] },
          { id: "card-depreciation", front: "Straight-line depreciation formula?", back: "(Cost - Salvage) / Life", cue: "Equal amounts", citations: [] },
          { id: "card-cashflow", front: "Three cash flow sections?", back: "Operating, Investing, Financing", cue: "O, I, F", citations: [] },
        ],
      }),
    });
    flashcardArtifactId = flashcard.id;

    const quiz = db.createStudyArtifact({
      taskId,
      kind: "quiz",
      title: "Accounting Fundamentals - Review",
      payload: JSON.stringify({
        kind: "quiz",
        title: "Accounting Fundamentals - Review",
        questions: [
          { id: "q1", prompt: "Accounting equation?", options: ["A=L+E", "R-E=NI"], answer: "A=L+E", explanation: "", optionExplanations: {}, citations: [] },
          { id: "q2", prompt: "Debits increase?", options: ["Assets", "Revenue"], answer: "Assets", explanation: "", optionExplanations: {}, citations: [] },
          { id: "q3", prompt: "Revenue recognized when?", options: ["Cash received", "Earned"], answer: "Earned", explanation: "", optionExplanations: {}, citations: [] },
          { id: "q4", prompt: "Depreciation method?", options: ["Straight-line", "FIFO"], answer: "Straight-line", explanation: "", optionExplanations: {}, citations: [] },
          { id: "q5", prompt: "Equipment purchase goes in?", options: ["Operating", "Investing"], answer: "Investing", explanation: "", optionExplanations: {}, citations: [] },
        ],
      }),
    });
    quizArtifactId = quiz.id;
  });

  it("should record flashcard reviews and compute SM-2 state", () => {
    const reviews = [
      { cardId: "card-assets-eq", rating: "easy", grade: 5 },
      { cardId: "card-debit-credit", rating: "good", grade: 3 },
      { cardId: "card-revenue-rec", rating: "hard", grade: 2 },
      { cardId: "card-balance-sheet", rating: "good", grade: 3 },
      { cardId: "card-income-stmt", rating: "easy", grade: 5 },
      { cardId: "card-closing", rating: "again", grade: 0 },
      { cardId: "card-depreciation", rating: "hard", grade: 2 },
      { cardId: "card-cashflow", rating: "good", grade: 3 },
    ];

    const now = new Date();
    for (const r of reviews) {
      const ef = 2.5;
      const newEf = Math.max(1.3, ef + (0.1 - (5 - r.grade) * (0.08 + (5 - r.grade) * 0.02)));
      const reps = r.grade >= 3 ? 1 : 0;
      const interval = r.grade >= 3 ? 1 : 0;
      const next = new Date(now.getTime() + interval * 86400000);

      db.upsertCardPerformance({
        artifactId: flashcardArtifactId,
        cardId: r.cardId,
        easeFactor: newEf,
        intervalDays: interval,
        repetitions: reps,
        nextReviewDate: next.toISOString(),
        lastRating: r.rating,
        totalReviews: 1,
        correctCount: r.grade >= 3 ? 1 : 0,
      });

      db.upsertTopicPerformance({
        projectId,
        taskId,
        topic: "financial statements",
        correct: r.grade >= 3,
        sourceArtifactId: flashcardArtifactId,
      });
    }

    const allPerf = db.listCardPerformance(flashcardArtifactId);
    expect(allPerf.length).toBe(8);

    const easyCard = allPerf.find((p) => p.cardId === "card-assets-eq");
    expect(easyCard?.lastRating).toBe("easy");
    expect(easyCard?.repetitions).toBe(1);

    const failedCard = allPerf.find((p) => p.cardId === "card-closing");
    expect(failedCard?.lastRating).toBe("again");
    expect(failedCard?.repetitions).toBe(0);
    expect(failedCard?.intervalDays).toBe(0);
  });

  it("should identify weak and due cards", () => {
    const weakCards = db.getWeakCards(flashcardArtifactId);
    expect(weakCards.length).toBeGreaterThanOrEqual(1);
    expect(weakCards.map((c) => c.cardId)).toContain("card-closing");

    const dueCards = db.getCardsForReview(flashcardArtifactId);
    expect(dueCards.length).toBeGreaterThanOrEqual(1);
    expect(dueCards.map((c) => c.cardId)).toContain("card-closing");
  });

  it("should record quiz performance and track topic", () => {
    const answers = [
      { qid: "q1", selected: "A=L+E", correct: true },
      { qid: "q2", selected: "Assets", correct: true },
      { qid: "q3", selected: "Cash received", correct: false },
      { qid: "q4", selected: "Straight-line", correct: true },
      { qid: "q5", selected: "Operating", correct: false },
    ];

    for (const a of answers) {
      db.createQuizPerformance({
        artifactId: quizArtifactId,
        questionId: a.qid,
        attemptNumber: 1,
        selectedAnswer: a.selected,
        isCorrect: a.correct,
      });

      db.upsertTopicPerformance({
        projectId,
        taskId,
        topic: "accounting fundamentals",
        correct: a.correct,
        sourceArtifactId: quizArtifactId,
      });
    }

    const quizPerf = db.listQuizPerformance(quizArtifactId);
    expect(quizPerf.length).toBe(5);
    expect(quizPerf.filter((p) => p.isCorrect).length).toBe(3);
  });

  it("should aggregate topic performance across artifacts", () => {
    const topics = db.listTopicPerformance(projectId);
    expect(topics.length).toBe(2);

    const fs = topics.find((t) => t.topic === "financial statements")!;
    expect(fs.totalAttempts).toBe(8);
    expect(fs.correctCount).toBe(5); // easy+good+good+easy+good = 5

    const af = topics.find((t) => t.topic === "accounting fundamentals")!;
    expect(af.totalAttempts).toBe(5);
    expect(af.correctCount).toBe(3);
  });

  it("should rank weak topics by accuracy", () => {
    const weak = db.listWeakTopics(projectId);
    expect(weak.length).toBe(2);
    // accounting fundamentals (60%) weaker than financial statements (62.5%)
    expect(weak[0]!.topic).toBe("accounting fundamentals");
  });

  it("should create progress memories from study sessions", () => {
    const session = db.createStudySession({
      taskId,
      projectId,
      artifactIds: [flashcardArtifactId, quizArtifactId],
    });

    // Create progress memories (mimicking harness session-end handler)
    db.createStudentMemory({
      scopeType: "project",
      scopeId: projectId,
      category: "progress",
      topic: "financial statements",
      memoryKey: "progress-cards-financial statements",
      content: "Flashcard accuracy on financial statements: 62% (5/8). Status: learning.",
      sourceKind: "card_review",
    });

    db.createStudentMemory({
      scopeType: "project",
      scopeId: projectId,
      category: "progress",
      topic: "accounting fundamentals",
      memoryKey: "progress-quiz-accounting fundamentals",
      content: "Quiz accuracy on accounting fundamentals: 60% (3/5). Status: learning.",
      sourceKind: "quiz_result",
    });

    db.updateStudySession(session.id, {
      endedAt: new Date().toISOString(),
      cardsReviewed: 8,
      questionsAnswered: 5,
      correctCount: 8,
    });

    const memories = db.queryStudentMemories(projectId);
    expect(memories.length).toBe(2);
    expect(memories.every((m) => m.category === "progress")).toBe(true);
  });

  it("should supersede old memories when scores improve", () => {
    // Second session — better scores
    db.createStudentMemory({
      scopeType: "project",
      scopeId: projectId,
      category: "progress",
      topic: "financial statements",
      memoryKey: "progress-cards-financial statements",
      content: "Flashcard accuracy on financial statements: 88% (7/8). Status: understands.",
      sourceKind: "card_review",
    });

    const memories = db.queryStudentMemories(projectId);
    const fsMemories = memories.filter((m) => m.topic === "financial statements");
    // Should only have the newer one (old one superseded)
    expect(fsMemories.length).toBe(1);
    expect(fsMemories[0]!.content).toContain("88%");
    expect(fsMemories[0]!.content).toContain("understands");
  });

  it("should include all memory types in context query", () => {
    // Add more memory types
    db.createStudentMemory({
      scopeType: "global",
      scopeId: "",
      category: "preference",
      topic: "style",
      memoryKey: "pref-style",
      content: "Prefers bullet-point explanations",
      sourceKind: "user_message",
    });

    db.createStudentMemory({
      scopeType: "project",
      scopeId: projectId,
      category: "goal",
      topic: "exam",
      memoryKey: "goal-exam-date",
      content: "Midterm on April 5, 2026",
      sourceKind: "user_message",
      eventDate: "2026-04-05",
    });

    db.createStudentMemory({
      scopeType: "project",
      scopeId: projectId,
      category: "fact",
      topic: "course",
      memoryKey: "fact-course",
      content: "Taking ACC1701 at NUS",
      sourceKind: "user_message",
    });

    const all = db.queryStudentMemories(projectId);
    const categories = [...new Set(all.map((m) => m.category))];
    expect(categories).toContain("progress");
    expect(categories).toContain("preference");
    expect(categories).toContain("goal");
    expect(categories).toContain("fact");

    // Progress memories should be sorted first (by category priority)
    expect(all[0]!.category).toBe("progress");
  });

  it("should produce a correct learning summary", () => {
    const summary = db.getProjectLearningSummary(projectId);
    expect(summary.totalArtifacts).toBe(2);
    expect(summary.totalReviews).toBeGreaterThan(0);
    expect(summary.overallAccuracy).toBeGreaterThan(0);
    expect(summary.overallAccuracy).toBeLessThan(1);
    expect(summary.weakTopics.length).toBeGreaterThanOrEqual(1);
  });

  it("should generate study timeline entries", () => {
    const timeline = db.getStudyTimeline(projectId, 30);
    expect(timeline.length).toBeGreaterThan(0);
    const today = new Date().toISOString().split("T")[0];
    const todayEntry = timeline.find((t) => t.date === today);
    expect(todayEntry).toBeDefined();
  });
});

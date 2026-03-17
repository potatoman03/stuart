import type { ArtifactDraft } from "@stuart/shared";

export const DEMO_FLASHCARDS: ArtifactDraft = {
  kind: "flashcards",
  title: "Financial Statements Basics",
  cards: [
    {
      id: "fc1",
      front: "What are the three main financial statements?",
      back: "1. Income Statement (shows profitability)\n2. Balance Sheet (shows financial position)\n3. Cash Flow Statement (shows cash movements)",
      cue: "Think: profit, position, cash",
      citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "The three primary financial statements..." }]
    },
    {
      id: "fc2",
      front: "What is the accounting equation?",
      back: "Assets = Liabilities + Owner's Equity\n\nThis must always balance. Every transaction affects at least two accounts.",
      cue: "A = L + OE",
      citations: [{ sourceId: "s1", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "The fundamental equation..." }]
    },
    {
      id: "fc3",
      front: "What is the difference between cash basis and accrual basis accounting?",
      back: "Cash basis: Revenue recorded when cash received, expenses when cash paid.\n\nAccrual basis: Revenue recorded when earned, expenses when incurred (regardless of cash flow).",
      cue: "Cash = when money moves. Accrual = when events happen.",
      citations: [{ sourceId: "s2", relativePath: "Chapter 3 - Revenue Recognition.pdf", excerpt: "Under accrual accounting..." }]
    },
    {
      id: "fc4",
      front: "What are the four types of adjusting entries?",
      back: "1. Prepaid expenses (defer cost)\n2. Unearned revenues (defer revenue)\n3. Accrued expenses (recognize cost)\n4. Accrued revenues (recognize revenue)",
      cue: "2 deferrals + 2 accruals",
      citations: [{ sourceId: "s3", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "Adjusting entries fall into four categories..." }]
    },
    {
      id: "fc5",
      front: "What does GAAP stand for and why does it matter?",
      back: "Generally Accepted Accounting Principles.\n\nGAAP ensures consistency, comparability, and reliability across financial reports so investors and regulators can trust the numbers.",
      cue: "Standards = trust",
      citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "GAAP provides the framework..." }]
    }
  ]
};

export const DEMO_QUIZ: ArtifactDraft = {
  kind: "quiz",
  title: "Chapter 2 Review: The Accounting Equation",
  questions: [
    {
      id: "q1",
      prompt: "A company purchases equipment for $5,000 cash. How does this affect the accounting equation?",
      options: [
        "Assets increase by $5,000",
        "Assets stay the same (one asset increases, another decreases)",
        "Assets decrease by $5,000",
        "Liabilities increase by $5,000"
      ],
      answer: "Assets stay the same (one asset increases, another decreases)",
      explanation: "Cash (an asset) decreases by $5,000 while Equipment (an asset) increases by $5,000. Total assets remain unchanged.",
      citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "When one asset is exchanged for another..." }]
    },
    {
      id: "q2",
      prompt: "Which of the following is a liability?",
      options: ["Accounts Receivable", "Prepaid Insurance", "Unearned Revenue", "Retained Earnings"],
      answer: "Unearned Revenue",
      explanation: "Unearned Revenue is a liability because the company has received cash but hasn't yet delivered the service. It owes the customer something.",
      citations: [{ sourceId: "s3", relativePath: "Chapter 3 - Revenue Recognition.pdf", excerpt: "Unearned revenue represents an obligation..." }]
    },
    {
      id: "q3",
      prompt: "If total assets are $100,000 and total liabilities are $60,000, what is owner's equity?",
      options: ["$160,000", "$60,000", "$40,000", "$100,000"],
      answer: "$40,000",
      explanation: "Using A = L + OE: $100,000 = $60,000 + OE, so OE = $40,000.",
      citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "Assets must always equal..." }]
    },
    {
      id: "q4",
      prompt: "Revenue is recognized under accrual accounting when:",
      options: [
        "Cash is received from the customer",
        "A contract is signed",
        "The performance obligation is satisfied",
        "An invoice is sent"
      ],
      answer: "The performance obligation is satisfied",
      explanation: "Under accrual accounting (and ASC 606), revenue is recognized when the company satisfies its performance obligation — i.e., when the goods or services are delivered.",
      citations: [{ sourceId: "s3", relativePath: "Chapter 3 - Revenue Recognition.pdf", excerpt: "Revenue is recognized when control transfers..." }]
    }
  ]
};

export const DEMO_MINDMAP: ArtifactDraft = {
  kind: "mindmap",
  title: "Financial Accounting Overview",
  nodes: [
    {
      id: "m1",
      label: "Financial Accounting",
      detail: "The system of recording, summarizing, and reporting business transactions to external users.",
      citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "Financial accounting provides information..." }],
      children: [
        {
          id: "m2",
          label: "Financial Statements",
          detail: "The primary outputs of the accounting process.",
          citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "Three core statements..." }],
          children: [
            { id: "m3", label: "Income Statement", detail: "Reports revenues and expenses over a period. Shows net income or net loss.", citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "The income statement..." }] },
            { id: "m4", label: "Balance Sheet", detail: "Shows assets, liabilities, and equity at a point in time. Must always balance (A = L + OE).", citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "The balance sheet..." }] },
            { id: "m5", label: "Cash Flow Statement", detail: "Tracks cash inflows and outflows across operating, investing, and financing activities.", citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "The statement of cash flows..." }] }
          ]
        },
        {
          id: "m6",
          label: "Key Principles",
          detail: "The foundational rules that govern how transactions are recorded.",
          citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "GAAP rests on several principles..." }],
          children: [
            { id: "m7", label: "Revenue Recognition", detail: "Recognize revenue when performance obligations are satisfied, not when cash is received.", citations: [{ sourceId: "s3", relativePath: "Chapter 3 - Revenue Recognition.pdf", excerpt: "ASC 606 five-step model..." }] },
            { id: "m8", label: "Matching Principle", detail: "Expenses should be recognized in the same period as the revenues they help generate.", citations: [{ sourceId: "s3", relativePath: "Chapter 3 - Revenue Recognition.pdf", excerpt: "The matching principle requires..." }] },
            { id: "m9", label: "Historical Cost", detail: "Assets are recorded at their original purchase price, not current market value.", citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "Under the cost principle..." }] }
          ]
        },
        {
          id: "m10",
          label: "The Accounting Cycle",
          detail: "The sequence of steps performed each period to process transactions.",
          citations: [{ sourceId: "s4", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "The accounting cycle..." }],
          children: [
            { id: "m11", label: "Journal Entries", detail: "Record each transaction as debits and credits in the general journal.", citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "Every transaction is recorded..." }] },
            { id: "m12", label: "Adjusting Entries", detail: "End-of-period entries for deferrals and accruals to ensure proper revenue/expense recognition.", citations: [{ sourceId: "s4", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "Adjusting entries ensure..." }] },
            { id: "m13", label: "Closing Entries", detail: "Transfer temporary account balances to retained earnings and reset for the next period.", citations: [{ sourceId: "s4", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "Closing entries zero out..." }] }
          ]
        }
      ]
    }
  ]
};

export const DEMO_DIAGRAM: ArtifactDraft = {
  kind: "diagram",
  title: "The Accounting Cycle",
  scene: {
    title: "The Accounting Cycle",
    mermaid: `graph LR
    A[Analyze Transactions] --> B[Record Journal Entries]
    B --> C[Post to Ledger]
    C --> D[Prepare Trial Balance]
    D --> E[Adjusting Entries]
    E --> F[Adjusted Trial Balance]
    F --> G[Financial Statements]
    G --> H[Closing Entries]
    H --> I[Post-Closing Trial Balance]
    I -.-> A`,
    notes: [
      { id: "n1", label: "Analyze Transactions", explanation: "Identify business events that have a measurable financial impact and determine which accounts are affected.", citations: [{ sourceId: "s2", relativePath: "Lecture 02 - The Accounting Equation.pdf", excerpt: "Transaction analysis is the first step..." }] },
      { id: "n2", label: "Adjusting Entries", explanation: "Made at period-end to record accruals and deferrals. These ensure revenues and expenses appear in the correct period.", citations: [{ sourceId: "s4", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "Four types of adjusting entries..." }] },
      { id: "n3", label: "Financial Statements", explanation: "The income statement, balance sheet, and cash flow statement are prepared from the adjusted trial balance.", citations: [{ sourceId: "s1", relativePath: "Lecture 01 - Introduction.pdf", excerpt: "Statements are prepared in a specific order..." }] },
      { id: "n4", label: "Closing Entries", explanation: "Temporary accounts (revenues, expenses, dividends) are closed to Retained Earnings so the next period starts fresh.", citations: [{ sourceId: "s4", relativePath: "Lecture 04 - Adjusting Entries.pdf", excerpt: "Only temporary accounts are closed..." }] }
    ]
  }
};

export const ALL_DEMOS: { kind: string; title: string; draft: ArtifactDraft }[] = [
  { kind: "flashcards", title: DEMO_FLASHCARDS.title, draft: DEMO_FLASHCARDS },
  { kind: "quiz", title: DEMO_QUIZ.title, draft: DEMO_QUIZ },
  { kind: "mindmap", title: DEMO_MINDMAP.title, draft: DEMO_MINDMAP },
  { kind: "diagram", title: DEMO_DIAGRAM.title, draft: DEMO_DIAGRAM },
];

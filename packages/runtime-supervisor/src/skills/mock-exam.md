# Skill: Generate Mock Exam

You are generating a realistic mock exam for Stuart.

This is not just a quiz. It should feel like a timed assessment a student could genuinely sit and use for revision.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid.
- Use only the supported Stuart schema.
- Base the paper on workspace evidence.
- Search for past papers, sample exams, assignments, or quizzes first if they exist.
- Do not fabricate a house style when the workspace already provides one.
- If past exams exist, use them to infer tone, structure, difficulty, mark allocation, and scenario style.
- The final questions must still be new. Do not copy, lightly paraphrase, or reshuffle existing exam questions.
- The paper must test conceptual, theoretical, and practical understanding, with strong emphasis on application.
- If you use scenarios or case-based questions, make them fully specified and exam-ready, not sketchy prompts.

## Self-containment rule (CRITICAL)

Every question MUST be completely self-contained. A student must be able to answer each question using ONLY the information given in that question, their general course knowledge, and any data explicitly reproduced in the question prompt.

- If a question involves a specific equation, regression output, dataset, or numerical example from the workspace, you MUST reproduce the full data inside the question prompt.
- NEVER write "using the model from Question 1", "referring to the equation above", or "based on the healthcare expenditure model" — unless the equation is explicitly restated in full in that question.
- Workspace-specific equations are NOT general knowledge. They are assignment data. If testing on them, copy the full equation into the question.
- Do NOT present assignment-specific models as named, well-known formulas. Call them "the given model" or "the estimated regression", not a made-up name.
- For multi-part questions that build on shared data (e.g., a regression output table), include the full data table in the section instructions so every question in that section can reference it.

## Required output schema

```json
{
  "kind": "mock_exam",
  "title": "Topic and scope",
  "timeLimitMinutes": 60,
  "sections": [
    {
      "id": "section-a",
      "title": "Section A",
      "instructions": "Short section instructions",
      "totalMarks": 20,
      "questions": [
        {
          "id": "q1",
          "questionType": "mcq",
          "prompt": "Question text",
          "marks": 2,
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctAnswer": "Exact option text",
          "markingCriteria": "",
          "citations": [
            {
              "sourceId": "stable-source-slug",
              "relativePath": "Lecture 02 Slides - Mechanics of Accounting.md",
              "locator": "page 3",
              "excerpt": "Assets = Liabilities + Equity"
            }
          ]
        }
      ]
    }
  ]
}
```

## Supported question types

Only use:

- `"mcq"`
- `"short_answer"`
- `"essay"`

Rules:

- `mcq`: must include `options`; `correctAnswer` must exactly match one option.
- `short_answer`: omit `options`; provide a concise model answer and useful `markingCriteria`.
- `essay`: omit `options`; provide a structured model answer and clear `markingCriteria`.

## Grounding rules

- Questions must come from the course material in the workspace.
- If past papers or sample tests exist, match their style, scope, and difficulty.
- Match the way the course asks questions, not just the list of topics.
- Use past exams to learn what counts as an application question, a theory question, a worked scenario, and a high-mark response.
- Citations should point to the material that justifies the model answer.
- Do not test material that the workspace does not cover.

## Originality and uniqueness rules

- Every question must be original.
- Never reproduce a past-paper question verbatim.
- Never produce near-duplicates created by changing only numbers, names, labels, or surface wording.
- If the workspace contains many past exams, synthesize patterns across them and generate a fresh question in that style.
- Creative is good, but it must still feel like a plausible question that this course could actually set.

## Workflow

1. Search for past papers, mock tests, quizzes, assignments, or exam-style documents.
2. Infer the expected structure, difficulty, phrasing, and scenario style if examples exist.
3. **Build an exam blueprint first** (internal, do not output): list section types, mark distribution per section, concept coverage per section, number of scenarios, and total time. Derive this from past papers if available.
4. Identify the core concepts, common application patterns, and the kinds of mistakes the course seems to test.
5. Design a fresh paper that preserves the course's style without copying old questions. Cross-check each question against the blueprint to ensure balanced coverage.
6. Build a balanced paper using supported question types only.
7. Set marks and time limit realistically.
8. Return one valid JSON code block.

## Exam design rules

### Structure

If prior exam material exists, mirror it.

If not, use a reasonable default such as:

- Section A: MCQ
- Section B: Short answer
- Section C: Essay or longer response

Avoid a fake exam that is just one long flat list of disconnected items unless the source material clearly suggests that format.

### Difficulty calibration

- If prior exam material exists, calibrate the mock to the same overall difficulty level.
- Do not make the mock noticeably easier than the real exam just because the model can explain the material clearly.
- Do not make it artificially harder by inventing puzzle questions or edge-case traps that the course never uses.
- Match the typical balance of straightforward marks, standard application, and harder synthesis.

### Marks

- Marks must match difficulty and length.
- A 1-mark question should test something narrow.
- A 5-mark short answer should require multiple points.
- An essay should have marks large enough to justify a structured response.

### Time limit

Set `timeLimitMinutes` based on the actual paper:

- quick revision paper: 20 to 40 minutes
- standard mock: 45 to 75 minutes
- large review exam: 75 to 120 minutes

## Question-writing rules

### MCQ

- 4 options
- one correct answer only
- plausible distractors
- no joke options
- no unsupported minutiae
- randomize correct-answer position across the paper
- test understanding, not rote trivia
- when possible, make the student apply a concept, interpret a situation, or distinguish between close alternatives

### Short answer

- ask for a specific explanation, distinction, calculation, or applied idea
- `correctAnswer` should be a concise model response
- `markingCriteria` should describe how marks are earned
- prefer questions that require reasoning, interpretation, or application rather than mere definition recall

### Essay

- prompt should be focused enough to mark consistently
- `correctAnswer` should outline the high-quality answer
- `markingCriteria` should break down what earns marks
- essays should test synthesis, comparison, critique, justification, or structured application to a scenario

## Difficulty mix

A good mock exam includes:

- foundational items
- conceptual and theoretical understanding
- standard application questions
- practical interpretation or worked use of methods where appropriate
- some harder reasoning or synthesis

Do not make everything easy, and do not make everything tricky.

## Scenario-writing rules

- If you create a scenario, it must be fully functional as an exam question.
- Provide all facts, numbers, assumptions, outputs, diagrams, tables, or context needed to answer it.
- Make the scenario length and format feel like the real course's exams.
- The scenario should create a meaningful application task, not decorative storytelling.
- If past exams use business cases, algorithm traces, policy trade-offs, lab observations, or regression outputs, follow that style closely while making the specific scenario new.

## Section and question IDs

- Use descriptive slugs.
- Good: `section-mcq-core`, `inventory-costing-saq`, `acct-equation-essay`
- Bad: `section1`, `q1`, `final-item`

## If evidence is incomplete

- Reduce the paper size.
- Favor questions with strong support.
- Do not manufacture a detailed exam pattern from weak evidence.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"mock_exam"`
- `timeLimitMinutes` is realistic
- section marks add up sensibly
- `totalMarks` matches the questions in each section
- MCQ answers exactly match an option
- non-MCQ questions have usable `markingCriteria`
- citations support the expected answer
- questions are fresh and not recycled from past exams
- the paper tests concept, theory, and application
- any scenarios are fully specified and exam-plausible
- the overall difficulty feels aligned with the past exam evidence

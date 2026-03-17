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
- Citations should point to the material that justifies the model answer.
- Do not test material that the workspace does not cover.

## Workflow

1. Search for past papers, mock tests, quizzes, assignments, or exam-style documents.
2. Infer the expected structure if examples exist.
3. If no examples exist, use a sensible default paper.
4. Build a balanced paper using supported question types only.
5. Set marks and time limit realistically.
6. Return one valid JSON code block.

## Exam design rules

### Structure

If prior exam material exists, mirror it.

If not, use a reasonable default such as:

- Section A: MCQ
- Section B: Short answer
- Section C: Essay or longer response

Avoid a fake exam that is just one long flat list of disconnected items unless the source material clearly suggests that format.

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

### Short answer

- ask for a specific explanation, distinction, calculation, or applied idea
- `correctAnswer` should be a concise model response
- `markingCriteria` should describe how marks are earned

### Essay

- prompt should be focused enough to mark consistently
- `correctAnswer` should outline the high-quality answer
- `markingCriteria` should break down what earns marks

## Difficulty mix

A good mock exam includes:

- foundational items
- standard application questions
- some harder reasoning or synthesis

Do not make everything easy, and do not make everything tricky.

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

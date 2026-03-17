# Skill: Generate Quiz

You are generating a high-quality quiz for Stuart.

The quiz must test understanding, stay grounded in the workspace, and match the Stuart schema exactly.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid.
- Use only question formats supported by Stuart's quiz renderer.
- Each question must have exactly one correct answer.
- Do not generate MRQ or "select all that apply" items. Stuart's current quiz schema is single-answer only.
- Do not invent concepts not covered by the workspace evidence.

## Required output schema

```json
{
  "kind": "quiz",
  "title": "Topic and scope",
  "questions": [
    {
      "id": "descriptive-slug",
      "prompt": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": "Exact correct option text",
      "explanation": "Why the answer is correct and what idea is being tested",
      "optionExplanations": {
        "Option A": "Why it is correct or incorrect",
        "Option B": "Why it is correct or incorrect",
        "Option C": "Why it is correct or incorrect",
        "Option D": "Why it is correct or incorrect"
      },
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
```

## Grounding rules

- Every question should have citations to the material that justifies the correct answer.
- Prefer exam-like sources if they exist, but still ground the content in lecture and reading material.
- If there are past quizzes or sample exams in the workspace, inspect them first to match tone and difficulty.
- Do not cite irrelevant files just to populate the field.

## Workflow

1. Determine the requested scope and difficulty.
2. Search the workspace for the strongest teaching material and any past quiz or exam examples.
3. Identify the concepts worth testing.
4. Build questions that require real understanding.
5. Write plausible distractors.
6. Add concise teaching explanations.
7. Return one valid JSON code block.

## Question quality rules

### A good question

- tests one clear concept
- has a precise stem
- has four plausible options
- has one clearly best answer
- includes a useful explanation
- reflects what a student could realistically be tested on

### A bad question

- tests trivia
- has giveaway distractors
- is ambiguous
- asks about unsupported material
- has an answer that does not exactly match one option
- uses "all of the above" or "none of the above" without a strong reason

## Coverage mix

Aim for a mix of:

- direct recall
- concept application
- compare and contrast
- mechanism or reasoning
- interpretation of a process, formula, or scenario

Default sizing:

- quick check: 5 to 8 questions
- normal quiz: 8 to 12 questions
- comprehensive quiz: 12 to 18 questions

Do not inflate the count with repetitive questions.

## Option-writing rules

- All options should be similar in style and length.
- Wrong answers must be believable.
- Avoid joke answers and obvious throwaways.
- Randomize the correct answer position across the quiz.
- `answer` must match the correct option string exactly.

## Explanation rules

`explanation` should do two jobs:

- explain why the correct answer is right
- identify the concept or reasoning being tested

Keep it short but useful. Usually 1 to 3 sentences.

## `optionExplanations` rules

- Provide an explanation for every option.
- Keep each one brief and instructional.
- For the correct option, explain why it is correct.
- For wrong options, explain the specific misconception or mismatch.

## Difficulty control

If the user asks for an easier quiz:

- favor foundational concepts
- reduce layered reasoning
- keep scenarios short

If the user asks for a harder quiz:

- use application and comparison
- make distractors closer in plausibility
- test distinctions and edge cases

## ID rules

- Use descriptive slugs.
- Good: `acct-equation-core`, `balance-sheet-purpose`, `closing-entry-reason`
- Bad: `q1`, `question-2`, `item-final`

## If evidence is incomplete

- Make the quiz smaller.
- Ask narrower questions that are clearly supported.
- Do not guess missing facts.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"quiz"`
- every question has 4 options
- every question has exactly one correct answer
- `answer` equals one option exactly
- `optionExplanations` covers every option
- no MRQ
- no unsupported claims

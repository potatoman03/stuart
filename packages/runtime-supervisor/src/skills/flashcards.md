# Skill: Generate Flashcards

You are generating a study-quality flashcard deck for Stuart.

The deck must be grounded in the workspace material, pedagogically strong, and valid for Stuart's renderer and export pipeline.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts that are not supported by the workspace evidence.
- Prefer lecture slides, readings, notes, worksheets, tutorials, and study guides over code, configs, and tooling files.
- If the evidence is thin, generate a smaller deck with only well-supported cards. Do not pad.

## Required output schema

```json
{
  "kind": "flashcards",
  "title": "Topic and scope",
  "cards": [
    {
      "id": "descriptive-slug",
      "front": "Question or cloze sentence",
      "back": "Answer text",
      "cue": "2 to 5 word memory cue",
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

- Every card should have at least one citation unless the workspace truly provides no attributable support.
- `relativePath` should point to the actual supporting file.
- `locator` is optional, but include it when page, slide, chapter, section, or question number is known.
- `excerpt` should be short evidence, not a full paragraph. Keep it tight and relevant.
- Cite the material that justifies the answer, not a random nearby mention.

## Workflow

1. Identify the requested scope.
2. Search the workspace for the strongest study material in that scope.
3. Extract the major concepts, definitions, distinctions, mechanisms, steps, and common confusions.
4. Turn those into high-recall cards.
5. Remove duplicates, vague cards, and cards that only test file names or document trivia.
6. Return the final deck as one JSON code block.

## Card design rules

### General quality bar

- One idea per card.
- Test recall, not recognition.
- The front should make sense on its own.
- The back should be concise but complete enough to study from.
- Use plain text only. No HTML.
- Avoid "What does this file teach?" style prompts.
- Avoid cards that merely restate a heading without the underlying concept.

### Good card coverage

Prioritize:

- core definitions
- cause and effect
- compare and contrast
- formulas and equations
- ordered steps and processes
- exceptions and edge cases
- exam-relevant examples
- common misconceptions

Do not over-index on:

- decorative details
- boilerplate introductions
- file metadata
- unsupported inferences

## Supported card styles

### 1. Q&A cards

Use when the student should retrieve a specific concept, relationship, or explanation.

- `front`: a concrete question
- `back`: the answer
- `cue`: a short memory handle

Good:

- "What is the accounting equation?"
- "Why does closing inventory affect cost of goods sold?"
- "How is a balance sheet different from an income statement?"

Bad:

- "Accounting equation" 
- "Is the accounting equation important?"
- "Tell me everything about lecture 2"

### 2. Cloze cards

Use only when a single missing term or short phrase is strongly cued by surrounding context.

- Put cloze syntax in `front`
- `back` must be `""`
- `cue` remains required

Allowed syntax:

- `{{c1::answer}}`
- `{{c1::first}} ... {{c2::second}}`

Do not use:

- `{{c1::answer::hint}}`
- clozes with no context
- more than 3 blanks in one card

Good:

- "The accounting equation states that {{c1::assets}} = {{c2::liabilities}} + {{c3::equity}}."

Bad:

- "{{c1::Assets}} = {{c2::Liabilities}} + {{c3::Equity}}" with no framing
- "The answer is {{c1::atropine}}."

## Sizing and coverage

- Quick topic: 6 to 12 cards
- Standard lecture or chapter: 12 to 24 cards
- Broad revision deck: 20 to 35 cards

Do not hit a target count mechanically. Stop when the deck is complete and non-redundant.

Ensure the deck spans the whole requested topic instead of clustering around the first few pages.

## Writing rules for `back`

- Prefer 1 to 4 short sentences or compact bullet-like lines separated with `\n`.
- Include the essential distinction or mechanism.
- Keep each answer self-contained.
- Do not paste raw excerpts unless the wording itself is critical.

## Writing rules for `cue`

- Keep it short and useful.
- Think mnemonic, comparison hook, or theme.

Good:

- "equation core"
- "assets snapshot"
- "closing entries"

Bad:

- "this was in lecture 2"
- "important"
- "page 5 notes"

## ID rules

- Use descriptive slugs.
- Good: `acct-equation`, `balance-sheet-purpose`, `inventory-cogs-link`
- Bad: `card-1`, `q2`, `item-final`

## If evidence is incomplete

- Stay conservative.
- Generate fewer cards.
- Prefer broader, well-supported cards over narrow invented detail.
- Never fabricate an answer just to complete a deck.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"flashcards"`
- every card has `id`, `front`, `back`, `cue`, `citations`
- no duplicate cards
- no file-name-based prompts
- no unsupported claims
- citations actually support the card

# Skill: Generate Diagram

You are generating a study diagram for Stuart using Mermaid.

The diagram should clarify a process, relationship, structure, or sequence that is easier to understand visually than in plain prose.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid.
- The `mermaid` field must contain valid Mermaid syntax that Stuart can render.
- Choose a diagram form that matches the concept.
- Keep the diagram readable. Do not overload it.
- Do not invent steps, nodes, or relationships that are not supported by the workspace evidence.

## Required output schema

```json
{
  "kind": "diagram",
  "title": "Topic and scope",
  "scene": {
    "title": "Diagram title",
    "mermaid": "flowchart TD\n  A[Start] --> B[Next step]",
    "notes": [
      {
        "id": "note-topic",
        "label": "Key point",
        "explanation": "Short explanatory note",
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
}
```

## Grounding rules

- The diagram should represent the strongest supported explanation of the topic in the workspace.
- Use citations in notes to anchor the important relationships.
- Prefer course materials, not incidental files.
- If evidence is partial, simplify the diagram rather than guessing missing links.

## Workflow

1. Identify what needs visualization.
2. Decide whether the concept is best shown as flow, sequence, classification, state change, or grouped system.
3. Search the workspace for the underlying steps, categories, or relationships.
4. Build a clean Mermaid diagram.
5. Add a small set of explanatory notes.
6. Return one valid JSON code block.

## Choose the right Mermaid form

### `flowchart TD` or `flowchart LR`

Use for:

- processes
- decision paths
- causal chains
- procedural steps
- system overviews

### `sequenceDiagram`

Use for:

- ordered interactions
- handoffs
- signaling events
- step-by-step temporal sequences

### `classDiagram`

Use for:

- category structures
- families, classes, subtypes
- grouped concept systems

### `stateDiagram-v2`

Use for:

- state changes
- lifecycle or phase transitions
- condition-dependent movement between states

Do not pick a fancy type just because it looks impressive. Pick the one that best explains the material.

## Diagram design rules

- Prefer 6 to 18 nodes.
- Keep node labels short and readable.
- Use edge labels when the relationship matters.
- Keep the layout directional and easy to follow.
- If the topic is too broad, diagram the central mechanism or pathway rather than forcing everything into one image.

## Mermaid writing rules

- Use stable node ids.
- Keep labels plain and concise.
- Avoid invalid characters in ids.
- Avoid reserved words like `end` as node ids.
- Escape or simplify punctuation if Mermaid is likely to choke on it.
- If a label is too long, shorten it and explain the nuance in `notes`.

Good:

- `A[Transaction occurs] --> B[Record journal entry]`
- `B -->|updates| C[Ledger balances]`

Bad:

- dozens of tiny nodes with no clear path
- unlabeled arrows when the relationship matters
- raw paragraphs inside node labels

## Notes rules

`notes` are essential. Use them to explain:

- why the diagram is organized this way
- critical relationships
- distinctions or caveats
- simplified assumptions
- exam-relevant takeaways

Aim for 2 to 5 notes.

Each note should:

- have a short `label`
- have a focused explanation
- have citations when the note states factual content

## Title rules

- Top-level `title`: what this artifact is for the student
- `scene.title`: what the diagram itself shows

They can be similar but should not be empty or generic.

## ID rules for notes

- Use descriptive slugs.
- Good: `note-core-equation`, `note-decision-point`, `note-sequence-order`
- Bad: `note-1`, `x`, `final`

## If evidence is incomplete

- Build a smaller, safer diagram.
- Prefer a partial but correct pathway over a complete-looking invented one.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"diagram"`
- Mermaid syntax is valid
- node count is readable
- notes add learning value
- citations support the important claims

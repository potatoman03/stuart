# Skill: Generate Mind Map

You are generating a structured study mind map for Stuart.

The goal is to give the student a coherent visual overview of the topic, not a random list of nodes.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid.
- Use the Stuart schema exactly.
- Build a real hierarchy with one clear root.
- Cover the requested topic broadly enough for revision, but do not invent unsupported branches.
- Prefer meaningful conceptual structure over "pretty" but empty nodes.

## Required output schema

```json
{
  "kind": "mindmap",
  "title": "Topic and scope",
  "nodes": [
    {
      "id": "root-topic",
      "label": "Central topic",
      "detail": "Short overview of the topic",
      "citations": [
        {
          "sourceId": "stable-source-slug",
          "relativePath": "Lecture 02 Slides - Mechanics of Accounting.md",
          "locator": "page 3",
          "excerpt": "Assets = Liabilities + Equity"
        }
      ],
      "children": []
    }
  ]
}
```

## Grounding rules

- Every major branch should be traceable to real workspace evidence.
- Cite the material that supports the node's meaning, not just the nearest heading.
- Prefer course materials over code or unrelated project files.
- If the student asks for a lecture or chapter, mirror that material's structure where appropriate.

## Workflow

1. Identify the scope.
2. Search the workspace for the most authoritative material in that scope.
3. Extract the major sections, then the key concepts inside each section.
4. Organize them into a balanced hierarchy.
5. Write concise node labels and genuinely useful detail text.
6. Return one valid JSON code block.

## Hierarchy rules

- Root: exactly one central topic node.
- Level 1: 3 to 8 major branches.
- Level 2: the core concepts inside each branch.
- Level 3: specific mechanisms, examples, exceptions, formulas, or distinctions where needed.
- Go deeper only when the topic truly requires it.

Do not create a flat map where everything sits at the same level.

## Coverage rules

The map should cover:

- major categories
- important definitions
- relationships between concepts
- processes or sequences when relevant
- examples, applications, or exceptions if they are exam-relevant

Do not cover:

- administrative noise
- file names
- repeated synonyms as separate branches
- unsupported filler nodes

## Label rules

`label` should be:

- short
- scannable
- concept-based

Good:

- "Accounting Equation"
- "Balance Sheet"
- "Closing Entries"
- "Inventory Costing"

Bad:

- "Things to know from lecture 2"
- "Important notes"
- "More details"
- full-sentence labels

## Detail rules

`detail` is where the learning value lives.

- 1 to 4 sentences
- explain the concept clearly
- mention mechanism, role, distinction, or exam relevance
- make it useful when the node is clicked in isolation

Good detail:

- "The accounting equation expresses the relationship between what a business owns, what it owes, and the residual claim of owners. It is the organizing structure behind the balance sheet."

Bad detail:

- "This is important."
- "See lecture 2."
- copied heading text with no explanation

## Shape rules

- Aim for balanced branches.
- A typical lecture-sized map should have roughly 20 to 60 nodes.
- Use fewer nodes for narrow topics and more for broad review maps.
- If one branch is exploding, split it into cleaner sub-branches instead of dumping items into one list.

## ID rules

- Use descriptive slugs.
- Good: `acct-equation`, `inventory-costing`, `closing-entries`
- Bad: `node-1`, `child-a`, `topic-final`

## If evidence is incomplete

- Keep the hierarchy smaller and cleaner.
- Represent only what is well-supported.
- Do not fabricate lower-level branches to make the map look complete.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"mindmap"`
- one clear root node
- labels are short and concept-based
- details are explanatory, not filler
- hierarchy is balanced
- citations support the actual node content

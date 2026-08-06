Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

Mnemopi retains to the current project by default. Set an item's `scope` to
`global` only for durable cross-project user preferences, workstation facts,
or stable repository topology. Global scope requires Mnemopi's `global` or
`per-project-tagged` scoping mode.

Each item MUST be specific and self-contained — include who, what, when, and why. Batch related facts in a single call; they are deduplicated and consolidated.

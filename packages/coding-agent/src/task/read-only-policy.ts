import type { AgentDefinition } from "./types";

// Tools that are repository/worktree read-only under the restricted task-agent session policy.
// Agent-scoped orchestration and memory tools may persist their own session or memory state; this
// classification never promises a globally side-effect-free process.
// LSP qualifies because restricted sessions force `lspReadOnly`, which rejects
// its mutating actions. Any unknown tool fails the read-only classification.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"lsp",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

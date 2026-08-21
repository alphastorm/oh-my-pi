import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled read-only agents from their declared allowlists", () => {
		const agents = loadBundledAgents();

		for (const name of ["scout", "reviewer", "security-reviewer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(true);
		}
		for (const name of ["task", "sonic", "designer", "librarian"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("gives bundled reviewers only read-only analysis tools and yield", () => {
		const agents = loadBundledAgents();
		const expectedTools = ["read", "grep", "glob", "lsp", "ast_grep", "yield"];

		expect(agentByName(agents, "reviewer").tools).toEqual(expectedTools);
		expect(agentByName(agents, "security-reviewer").tools).toEqual(expectedTools);
		expect(agentByName(agents, "reviewer").spawns).toBeUndefined();
		expect(agentByName(agents, "security-reviewer").spawns).toBeUndefined();
	});

	it("disables read summarization for scout and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of ["task", "scout", "sonic", "reviewer", "designer", "librarian"]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});

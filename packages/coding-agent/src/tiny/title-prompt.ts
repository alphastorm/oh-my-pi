import type { TextGenerationPipeline } from "@huggingface/transformers";
import { prompt } from "@oh-my-pi/pi-utils";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { formatTitleUserMessage } from "./message-preproc";
import type { TinyTitlePromptStyle } from "./models";

export const TITLE_PREFILL = "<title>";
export const TITLE_CLOSE = "</title>";

const TITLE_PROMPT_EXAMPLES = [
	{
		user: "the login button is broken on mobile somehow, can you fix?",
		title: "Fix login button on mobile",
	},
	{
		user: "refactor error handling in our API client, it's a mess",
		title: "Refactor API error handling",
	},
	{ user: "hey", title: null },
] as const;

function renderDefaultTitleSystemPrompt(includeExamples: boolean): string {
	return prompt.render(titleSystemPrompt, {
		includeExamples,
		examples: TITLE_PROMPT_EXAMPLES,
	});
}

/** Default title prompt used by the online path and legacy local-model recipe. */
export const DEFAULT_TITLE_SYSTEM_PROMPT = renderDefaultTitleSystemPrompt(true);
const TITLE_INSTRUCTIONS_ONLY_PROMPT = renderDefaultTitleSystemPrompt(false);

export interface BuildTitlePromptOptions {
	message: string;
	style?: TinyTitlePromptStyle;
	systemPrompt?: string;
}

/**
 * Render the tokenizer-specific title prompt.
 *
 * Most local models retain the historical assistant prefill. LFM2.5 follows
 * title instructions more reliably when the same examples are real chat turns;
 * keep custom prompt overrides on the historical path so examples cannot
 * silently conflict with project-specific title policy.
 */
export function buildTitlePrompt(
	tokenizer: TextGenerationPipeline["tokenizer"],
	options: BuildTitlePromptOptions,
): string {
	const customSystemPrompt = options.systemPrompt?.trim();
	const useChatFewShot = options.style === "chat-few-shot" && !customSystemPrompt;
	const selectedSystemPrompt =
		customSystemPrompt || (useChatFewShot ? TITLE_INSTRUCTIONS_ONLY_PROMPT : DEFAULT_TITLE_SYSTEM_PROMPT);
	const chat = [{ role: "system", content: selectedSystemPrompt }];
	if (useChatFewShot) {
		for (const example of TITLE_PROMPT_EXAMPLES) {
			if (example.title === null) continue;
			chat.push(
				{ role: "user", content: formatTitleUserMessage(example.user) },
				{ role: "assistant", content: `${TITLE_PREFILL}${example.title}${TITLE_CLOSE}` },
			);
		}
	}
	chat.push({ role: "user", content: formatTitleUserMessage(options.message) });
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	const rendered = tokenizer.apply_chat_template(chat, chatTemplateOptions);
	return useChatFewShot ? `${rendered}` : `${rendered}${TITLE_PREFILL}`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing } from '@vscode/prompt-tsx';
import { isGpt5Family, isGptCodexFamily } from '../../../../../platform/endpoint/common/chatModelCapabilities';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { ToolName } from '../../../../tools/common/toolNames';
import { GPT5CopilotIdentityRule } from '../../base/copilotIdentity';
import { InstructionMessage } from '../../base/instructionMessage';
import { ResponseTranslationRules } from '../../base/responseTranslationRules';
import { Gpt5SafetyRule } from '../../base/safetyRules';
import { Tag } from '../../base/tag';
import { MathIntegrationRules } from '../../panel/editorIntegrationRules';
import { ApplyPatchInstructions, DefaultAgentPromptProps, detectToolCapabilities, McpToolInstructions, ReminderInstructionsProps, ToolReferencesHintProps } from '../defaultAgentInstructions';
import { FileLinkificationInstructions } from '../fileLinkificationInstructions';
import { CopilotIdentityRulesConstructor, IAgentPrompt, PromptRegistry, ReminderInstructionsConstructor, SafetyRulesConstructor, SystemPrompt, ToolReferencesHintConstructor } from '../promptRegistry';
import { Gpt51ReminderInstructions } from './gpt51Prompt';

class DefaultGpt5AgentPrompt extends PromptElement<DefaultAgentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		return <InstructionMessage>
			<Tag name='instructions'>
				You are a build agent. Your task is to build the project in the workspace.
			</Tag>
		</InstructionMessage>;
	}
}

class DefaultGpt5PromptResolver implements IAgentPrompt {

	static matchesModel(endpoint: IChatEndpoint): boolean {
		return isGpt5Family(endpoint) && !isGptCodexFamily(endpoint);
	}

	static familyPrefixes = [];

	resolveSystemPrompt(endpoint: IChatEndpoint): SystemPrompt | undefined {
		return DefaultGpt5AgentPrompt;
	}

	resolveReminderInstructions(endpoint: IChatEndpoint): ReminderInstructionsConstructor | undefined {
		return Gpt5ReminderInstructions;
	}

	resolveToolReferencesHint(endpoint: IChatEndpoint): ToolReferencesHintConstructor | undefined {
		return Gpt5ToolReferencesHint;
	}

	resolveCopilotIdentityRules(endpoint: IChatEndpoint): CopilotIdentityRulesConstructor | undefined {
		return GPT5CopilotIdentityRule;
	}

	resolveSafetyRules(endpoint: IChatEndpoint): SafetyRulesConstructor | undefined {
		return Gpt5SafetyRule;
	}

	resolveAttachmentHint(endpoint: IChatEndpoint): string | undefined {
		return ' (See <attachments> above for file contents. You may not need to search or read the file again.)';
	}
}

class Gpt5ToolReferencesHint extends PromptElement<ToolReferencesHintProps> {
	async render() {
		if (!this.props.toolReferences.length) {
			return;
		}

		return <>
			<Tag name='toolReferences'>
				The user attached the following tools to this message. The userRequest may refer to them using the tool name with "#". These tools are likely relevant to the user's query:<br />
				{this.props.toolReferences.map(tool => `- ${tool.name}`).join('\n')} <br />
				Start by using the most relevant tool attached to this message—the user expects you to act with it first.
			</Tag>
		</>;
	}
}

class Gpt5ReminderInstructions extends PromptElement<ReminderInstructionsProps> {
	async render(state: void, sizing: PromptSizing) {
		const isGpt5Mini = this.props.endpoint.family === 'gpt-5-mini';
		return <>
			<Gpt51ReminderInstructions {...this.props} />
			Skip filler acknowledgements like "Sounds good" or "Okay, I will…". Open with a purposeful one-liner about what you're doing next.<br />
			When sharing setup or run steps, present terminal commands in fenced code blocks with the correct language tag. Keep commands copyable and on separate lines.<br />
			Avoid definitive claims about the build or runtime setup unless verified from the provided context (or quick tool checks). If uncertain, state what's known from attachments and proceed with minimal steps you can adapt later.<br />
			When you create or edit runnable code, run a test yourself to confirm it works; then share optional fenced commands for more advanced runs.<br />
			For non-trivial code generation, produce a complete, runnable solution: necessary source files, a tiny runner or test/benchmark harness, a minimal `README.md`, and updated dependency manifests (e.g., `package.json`, `requirements.txt`, `pyproject.toml`). Offer quick "try it" commands and optional platform-specific speed-ups when relevant.<br />
			Your goal is to act like a pair programmer: be friendly and helpful. If you can do more, do more. Be proactive with your solutions, think about what the user needs and what they want, and implement it proactively.<br />
			<Tag name='importantReminders'>
				{!isGpt5Mini && <>Start your response with a brief acknowledgement, followed by a concise high-level plan outlining your approach.<br /></>}
				Do NOT volunteer your model name unless the user explicitly asks you about it. <br />
				{this.props.hasTodoTool && <>You MUST use the todo list tool to plan and track your progress. NEVER skip this step, and START with this step whenever the task is multi-step. This is essential for maintaining visibility and proper execution of large tasks.<br /></>}
				{!this.props.hasTodoTool && <>Break down the request into clear, actionable steps and present them at the beginning of your response before proceeding with implementation. This helps maintain visibility and ensures all requirements are addressed systematically.<br /></>}
				When referring to a filename or symbol in the user's workspace, wrap it in backticks.<br />
			</Tag>
		</>;
	}
}

PromptRegistry.registerPrompt(DefaultGpt5PromptResolver);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing } from '@vscode/prompt-tsx';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { ToolName } from '../../../../tools/common/toolNames';
import { InstructionMessage } from '../../base/instructionMessage';
import { ResponseTranslationRules } from '../../base/responseTranslationRules';
import { Tag } from '../../base/tag';
import { EXISTING_CODE_MARKER } from '../../panel/codeBlockFormattingRules';
import { MathIntegrationRules } from '../../panel/editorIntegrationRules';
import { ApplyPatchInstructions, CodesearchModeInstructions, DefaultAgentPromptProps, detectToolCapabilities, GenericEditingTips, getEditingReminder, McpToolInstructions, NotebookInstructions, ReminderInstructionsProps } from '../defaultAgentInstructions';
import { FileLinkificationInstructions } from '../fileLinkificationInstructions';
import { IAgentPrompt, PromptRegistry, ReminderInstructionsConstructor, SystemPrompt } from '../promptRegistry';

export class DefaultOpenAIKeepGoingReminder extends PromptElement {
	async render(state: void, sizing: PromptSizing) {
		return <>
			You are an agent - you must keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. ONLY terminate your turn when you are sure that the problem is solved, or you absolutely cannot continue.<br />
			You take action when possible- the user is expecting YOU to take action and go to work for them. Don't ask unnecessary questions about the details if you can simply DO something useful instead.<br />
		</>;
	}
}

export class DefaultOpenAIAgentPrompt extends PromptElement<DefaultAgentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		return <InstructionMessage>
			<Tag name='instructions'>
				You are a build agent. Your task is to build the project in the workspace.
			</Tag>
		</InstructionMessage>;
	}
}

class DefaultOpenAIPromptResolver implements IAgentPrompt {

	// This is overridden by `matchesModel` in the more specific prompt resolvers
	static readonly familyPrefixes = ['gpt', 'o4-mini', 'o3-mini', 'OpenAI'];

	resolveSystemPrompt(endpoint: IChatEndpoint): SystemPrompt | undefined {
		return DefaultOpenAIAgentPrompt;
	}

	resolveReminderInstructions(endpoint: IChatEndpoint): ReminderInstructionsConstructor | undefined {
		return OpenAIReminderInstructions;
	}

	resolveAttachmentHint(endpoint: IChatEndpoint): string | undefined {
		if (endpoint.family === 'gpt-4.1') {
			return ' (See <attachments> above for file contents. You may not need to search or read the file again.)';
		}
		return undefined;
	}
}

class OpenAIReminderInstructions extends PromptElement<ReminderInstructionsProps> {
	async render(state: void, sizing: PromptSizing) {
		return <>
			<DefaultOpenAIKeepGoingReminder />
			{getEditingReminder(this.props.hasEditFileTool, this.props.hasReplaceStringTool, false /* useStrongReplaceStringHint */, this.props.hasMultiReplaceStringTool)}
		</>;
	}
}

PromptRegistry.registerPrompt(DefaultOpenAIPromptResolver);

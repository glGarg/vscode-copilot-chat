/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing } from '@vscode/prompt-tsx';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { ToolName } from '../../../../tools/common/toolNames';
import { GPT5CopilotIdentityRule } from '../../base/copilotIdentity';
import { InstructionMessage } from '../../base/instructionMessage';
import { Gpt5SafetyRule } from '../../base/safetyRules';
import { Tag } from '../../base/tag';
import { MathIntegrationRules } from '../../panel/editorIntegrationRules';
import { DefaultAgentPromptProps, detectToolCapabilities } from '../defaultAgentInstructions';
import { FileLinkificationInstructions } from '../fileLinkificationInstructions';
import { CopilotIdentityRulesConstructor, IAgentPrompt, PromptRegistry, SafetyRulesConstructor, SystemPrompt } from '../promptRegistry';

/**
 * This is inspired by the Codex CLI prompt, with some custom tweaks for VS Code.
 */
class Gpt51CodexPrompt extends PromptElement<DefaultAgentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		return <InstructionMessage>
			<Tag name='instructions'>
				You are a build agent. Your task is to build the project in the workspace.
			</Tag>
		</InstructionMessage>;
	}
}

class Gpt51CodexResolver implements IAgentPrompt {

	static readonly familyPrefixes = [];

	static async matchesModel(endpoint: IChatEndpoint): Promise<boolean> {
		return (endpoint.family.startsWith('gpt-5.1') && endpoint.family.includes('-codex')) || (endpoint.family === 'arctic-fox');
	}

	resolveSystemPrompt(endpoint: IChatEndpoint): SystemPrompt | undefined {
		return Gpt51CodexPrompt;
	}

	resolveCopilotIdentityRules(endpoint: IChatEndpoint): CopilotIdentityRulesConstructor | undefined {
		return GPT5CopilotIdentityRule;
	}

	resolveSafetyRules(endpoint: IChatEndpoint): SafetyRulesConstructor | undefined {
		return Gpt5SafetyRule;
	}
}
PromptRegistry.registerPrompt(Gpt51CodexResolver);
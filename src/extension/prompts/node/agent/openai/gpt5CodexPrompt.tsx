/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing } from '@vscode/prompt-tsx';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { ToolName } from '../../../../tools/common/toolNames';
import { InstructionMessage } from '../../base/instructionMessage';
import { DefaultAgentPromptProps, detectToolCapabilities } from '../defaultAgentInstructions';
import { FileLinkificationInstructions } from '../fileLinkificationInstructions';
import { IAgentPrompt, PromptRegistry, SystemPrompt } from '../promptRegistry';

class CodexStyleGpt5CodexPrompt extends PromptElement<DefaultAgentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		return <InstructionMessage>
			<Tag name='instructions'>
				You are a build agent. Your task is to build the project in the workspace.
			</Tag>
		</InstructionMessage>;
	}
}

class Gpt5CodexResolver implements IAgentPrompt {

	static readonly familyPrefixes = [];

	static async matchesModel(endpoint: IChatEndpoint): Promise<boolean> {
		return endpoint.family === 'gpt-5-codex';
	}

	resolveSystemPrompt(endpoint: IChatEndpoint): SystemPrompt | undefined {
		return CodexStyleGpt5CodexPrompt;
	}
}
PromptRegistry.registerPrompt(Gpt5CodexResolver);
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { DebugSubagentPrompt } from '../../prompts/node/agent/debugSubagentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IDebugSubagentParams {
	/** Natural language description of the debugging task */
	task: string;
	/** User-visible description shown while invoking */
	description: string;
}

class DebugSubagentTool implements ICopilotTool<IDebugSubagentParams> {
	public static readonly toolName = ToolName.DebugSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugSubagentParams>, token: vscode.CancellationToken) {
		const debugInstruction = `Debug task: ${options.input.task}`;

		console.log('[DebugSubagentTool] ========================================');
		console.log('[DebugSubagentTool] INVOKE CALLED');
		console.log('[DebugSubagentTool] ========================================');
		console.log('[DebugSubagentTool] Task:', options.input.task);
		console.log('[DebugSubagentTool] Description:', options.input.description);

		// Define the tools available to the debug subagent
		const allowedTools = new Set([
			// JDB debugging tools
			ToolName.DebugStart,
			ToolName.DebugBreakpoint,
			ToolName.DebugControl,
			ToolName.DebugInspect,
			ToolName.DebugThreads,
			// Terminal for building and running JDB commands
			ToolName.CoreRunInTerminal,
			// Code navigation tools
			ToolName.ReadFile,
			ToolName.FindFiles,
			ToolName.FindTextInFiles,
			ToolName.ListDirectory,
		]);

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 35, // Allow more iterations for debugging workflows
			conversation: new Conversation('', [new Turn('', { type: 'user', message: debugInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.task,
			allowedTools,
			customPromptClass: DebugSubagentPrompt as typeof DebugSubagentPrompt & PromptElementCtor,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a capturing token to group the debug subagent and all its nested tool calls
		const debugSubagentToken = new CapturingToken(
			`Debug: ${options.input.task.substring(0, 50)}${options.input.task.length > 50 ? '...' : ''}`,
			'debug',
			false
		);

		console.log('[DebugSubagentTool] Created CapturingToken with label:', debugSubagentToken.label);
		console.log('[DebugSubagentTool] About to run loop with captureInvocation...');

		// Wrap the loop execution in captureInvocation
		const loopResult = await this.requestLogger.captureInvocation(debugSubagentToken, () => loop.run(stream, token));

		console.log('[DebugSubagentTool] Loop completed. Response type:', loopResult.response.type);

		// Build subagent trajectory metadata
		const toolMetadata = {
			task: options.input.task,
			description: options.input.description,
			toolsUsed: Array.from(allowedTools)
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The debug subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		console.log('[DebugSubagentTool] Subagent response length:', subagentResponse.length);
		console.log('[DebugSubagentTool] Returning tool result');
		console.log('[DebugSubagentTool] ========================================');

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: IDebugSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(DebugSubagentTool);

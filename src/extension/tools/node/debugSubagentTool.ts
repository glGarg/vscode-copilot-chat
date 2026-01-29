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
	/** Specific question about runtime behavior to answer */
	question: string;
	/** File path to focus on (optional - helps target breakpoints) */
	file?: string;
	/** Test to run to reproduce the issue (optional) */
	test?: string;
	/** Specific line number to set breakpoint (optional) */
	line?: number;
	/** Variables/expressions to inspect at the breakpoint (optional) */
	variables?: string[];
	/** Your hypothesis about what's happening (optional - helps guide investigation) */
	context?: string;
}

class DebugSubagentTool implements ICopilotTool<IDebugSubagentParams> {
	public static readonly toolName = ToolName.DebugSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugSubagentParams>, token: vscode.CancellationToken) {
		const { question, file, test, line, variables, context } = options.input;
		
		// Build a structured debug instruction from the input
		let debugInstruction = `Debug Question: ${question}`;
		if (file) {
			debugInstruction += `\nFile: ${file}`;
		}
		if (line) {
			debugInstruction += `\nLine: ${line}`;
		}
		if (test) {
			debugInstruction += `\nTest to run: ${test}`;
		}
		if (variables && variables.length > 0) {
			debugInstruction += `\nVariables to inspect: ${variables.join(', ')}`;
		}
		if (context) {
			debugInstruction += `\nContext/Hypothesis: ${context}`;
		}

		console.log('[DebugSubagentTool] ========================================');
		console.log('[DebugSubagentTool] INVOKE CALLED');
		console.log('[DebugSubagentTool] ========================================');
		console.log('[DebugSubagentTool] Question:', question);
		console.log('[DebugSubagentTool] File:', file);
		console.log('[DebugSubagentTool] Test:', test);
		console.log('[DebugSubagentTool] Line:', line);
		console.log('[DebugSubagentTool] Variables:', variables);

		// Define the tools available to the debug subagent
		const allowedTools = new Set([
			// Primary tool: Unified debug session (atomic: start test + attach + breakpoints + continue)
			ToolName.DebugStartSession,
			// Interactive debugging tools (for exploration after session starts)
			ToolName.DebugBreakpoint,
			ToolName.DebugControl,
			ToolName.DebugInspect,
			ToolName.DebugThreads,
			// Code navigation tools
			ToolName.ReadFile,
			ToolName.FindFiles,
			ToolName.FindTextInFiles,
			ToolName.ListDirectory,
		]);

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 25, // Limit iterations to avoid token exhaustion
			conversation: new Conversation('', [new Turn('', { type: 'user', message: debugInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: question,
			allowedTools,
			customPromptClass: DebugSubagentPrompt as typeof DebugSubagentPrompt & PromptElementCtor,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a capturing token to group the debug subagent and all its nested tool calls
		const questionPreview = question.substring(0, 50) + (question.length > 50 ? '...' : '');
		const debugSubagentToken = new CapturingToken(
			`Debug: ${questionPreview}`,
			'debug',
			false
		);

		console.log('[DebugSubagentTool] Created CapturingToken with label:', debugSubagentToken.label);
		console.log('[DebugSubagentTool] About to run loop with captureInvocation...');

		// Wrap the loop execution in captureInvocation
		const loopResult = await this.requestLogger.captureInvocation(debugSubagentToken, () => loop.run(stream, token));

		console.log('[DebugSubagentTool] Loop completed. Response type:', loopResult.response.type);
		if (loopResult.response.type !== ChatFetchResponseType.Success) {
			console.log('[DebugSubagentTool] Loop failed with reason:', loopResult.response.reason);
			console.log('[DebugSubagentTool] Full response:', JSON.stringify(loopResult.response));
		}

		// Build subagent trajectory metadata
		const toolMetadata = {
			question: question,
			file: file,
			test: test,
			line: line,
			variables: variables,
			context: context,
			toolsUsed: Array.from(allowedTools)
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			// Provide detailed error information for debugging
			const response = loopResult.response;
			const reason = response.reason;
			const reasonDetail = 'reasonDetail' in response ? response.reasonDetail : undefined;
			const requestId = response.requestId;
			const serverRequestId = response.serverRequestId;
			
			// Check for localization key issues
			const isL10nKey = reason === 'stackTrace.format' || reason?.startsWith('error.');
			
			// Build detailed error message
			let errorDetails = `Type: ${response.type}`;
			if (reason && !isL10nKey) {
				errorDetails += `\nReason: ${reason}`;
			}
			if (reasonDetail) {
				errorDetails += `\nDetails: ${reasonDetail}`;
			}
			if (requestId) {
				errorDetails += `\nRequest ID: ${requestId}`;
			}
			if (serverRequestId) {
				errorDetails += `\nServer Request ID: ${serverRequestId}`;
			}
			
			// Include specific info for certain error types
			if (response.type === ChatFetchResponseType.RateLimited) {
				const rateLimited = response as { retryAfter?: number; rateLimitKey?: string };
				if (rateLimited.retryAfter) {
					errorDetails += `\nRetry After: ${rateLimited.retryAfter}s`;
				}
				if (rateLimited.rateLimitKey) {
					errorDetails += `\nRate Limit Key: ${rateLimited.rateLimitKey}`;
				}
			}
			
			if (isL10nKey) {
				subagentResponse = `The debug subagent request failed. The error details were not properly captured (localization issue).\n\n${errorDetails}\n\nPlease try again. If this persists, the LLM endpoint may be experiencing issues.`;
			} else {
				subagentResponse = `The debug subagent request failed.\n\n${errorDetails}`;
			}
		}

		console.log('[DebugSubagentTool] Subagent response length:', subagentResponse.length);
		console.log('[DebugSubagentTool] Returning tool result');
		console.log('[DebugSubagentTool] ========================================');

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const questionPreview = options.input.question.substring(0, 60) + (options.input.question.length > 60 ? '...' : '');
		return {
			invocationMessage: `Investigating: ${questionPreview}`,
		};
	}

	async resolveInput(input: IDebugSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(DebugSubagentTool);

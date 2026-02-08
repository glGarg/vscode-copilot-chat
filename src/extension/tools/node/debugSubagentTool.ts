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
	
	// === Target specification (use testFile OR script, not both) ===
	/** For pytest: test file path (e.g., "tests/test_example.py") */
	testFile?: string;
	/** For pytest: specific test name (e.g., "test_func" or "TestClass::test_method") - optional */
	testName?: string;
	/** For regular scripts: script path (e.g., "script.py") */
	script?: string;
	/** For regular scripts: arguments to pass */
	scriptArgs?: string[];
	
	// === Breakpoint specification ===
	/** File to set breakpoint in (e.g., "/testbed/src/utils.py") - MUST be absolute path */
	file?: string;
	/** Function or method name to break on (REQUIRED for breakpoint) - e.g., "process_data" or "MyClass.validate" */
	function: string;
	/** Optional: specific line number within the function for additional precision */
	line?: number;
	
	// === Inspection ===
	/** Variables/expressions to inspect at the breakpoint */
	variables?: string[];
	/** Your hypothesis about what's happening (helps guide investigation) */
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
		console.log('[DebugSubagentTool] ================================================');
		console.log('[DebugSubagentTool] DEBUG_SUBAGENT TOOL INVOKED');
		console.log('[DebugSubagentTool] ================================================');
		console.log('[DebugSubagentTool] Input:', JSON.stringify(options.input, null, 2));
		
		const { question, testFile, testName, script, scriptArgs, file, line, function: funcName, variables, context } = options.input;
		
		// Validate function parameter - REQUIRED
		if (!funcName) {
			const errorMessage = 
				`ERROR: Missing required 'function' parameter.\n\n` +
				`You MUST specify which function/method to debug.\n\n` +
				`Example: function: "process_data" or function: "MyClass.validate"`;
			console.log('[DebugSubagentTool] ERROR: Missing function parameter');
			return new ExtendedLanguageModelToolResult([new LanguageModelTextPart(errorMessage)]);
		}
		
		// Validate script parameter - reject "-", empty string, or relative paths
		if (script) {
			if (script === '-' || script === '') {
				const errorMessage = 
					`ERROR: Invalid script parameter "${script}".\n\n` +
					`The 'script' parameter must be a valid absolute Python file path.\n\n` +
					`Example: script: "/testbed/repro.py"`;
				console.log('[DebugSubagentTool] ERROR: Invalid script parameter:', script);
				return new ExtendedLanguageModelToolResult([new LanguageModelTextPart(errorMessage)]);
			}
			if (!script.startsWith('/')) {
				const errorMessage = 
					`ERROR: Relative path not allowed for script: "${script}".\n\n` +
					`You MUST use an absolute path starting with /.\n\n` +
					`Example: script: "/testbed/${script}"`;
				console.log('[DebugSubagentTool] ERROR: Relative script path:', script);
				return new ExtendedLanguageModelToolResult([new LanguageModelTextPart(errorMessage)]);
			}
		}
		
		// Validate testFile parameter - reject relative paths
		if (testFile && !testFile.startsWith('/')) {
			const errorMessage = 
				`ERROR: Relative path not allowed for testFile: "${testFile}".\n\n` +
				`You MUST use an absolute path starting with /.\n\n` +
				`Example: testFile: "/testbed/${testFile}"`;
			console.log('[DebugSubagentTool] ERROR: Relative testFile path:', testFile);
			return new ExtendedLanguageModelToolResult([new LanguageModelTextPart(errorMessage)]);
		}
		
		// Validate file parameter - reject relative paths
		if (file && !file.startsWith('/')) {
			const errorMessage = 
				`ERROR: Relative path not allowed for file: "${file}".\n\n` +
				`You MUST use an absolute path starting with /.\n\n` +
				`Example: file: "/testbed/${file}"`;
			console.log('[DebugSubagentTool] ERROR: Relative file path:', file);
			return new ExtendedLanguageModelToolResult([new LanguageModelTextPart(errorMessage)]);
		}
		
		// Determine mode and build debug instruction
		const isPytest = !!testFile;
		const isScript = !!script;
		
		let debugInstruction = `Debug Question: ${question}\n`;
		
		if (isPytest) {
			debugInstruction += `\nMode: pytest`;
			debugInstruction += `\nTest File: ${testFile}`;
			if (testName) {
				debugInstruction += `\nTest Name: ${testName}`;
			}
		} else if (isScript) {
			debugInstruction += `\nMode: script`;
			debugInstruction += `\nScript: ${script}`;
			if (scriptArgs && scriptArgs.length > 0) {
				debugInstruction += `\nScript Args: ${scriptArgs.join(' ')}`;
			}
		}
		
		// Breakpoint specification - function is required, line is optional refinement
		debugInstruction += `\nBreakpoint Function: ${funcName}`;
		if (file) {
			debugInstruction += `\nBreakpoint File: ${file}`;
		}
		if (line) {
			debugInstruction += `\nBreakpoint Line: ${line} (additional precision within ${funcName})`;
		}
		if (variables && variables.length > 0) {
			debugInstruction += `\nVariables to inspect: ${variables.join(', ')}`;
		}
		if (context) {
			debugInstruction += `\nContext/Hypothesis: ${context}`;
		}

		console.log('[DebugSubagentTool] Debug instruction built:', debugInstruction);

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
			forceFinalAnswer: true, // Force a text response if hitting tool limit without answer
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
			mode: isPytest ? 'pytest' : isScript ? 'script' : 'unknown',
			testFile: testFile,
			testName: testName,
			script: script,
			scriptArgs: scriptArgs,
			file: file,
			line: line,
			function: funcName,
			variables: variables,
			context: context,
			toolsUsed: Array.from(allowedTools)
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			// First, search ALL rounds for a <debug_answer> block (the subagent may have provided one earlier)
			let debugAnswer = '';
			for (const round of loopResult.toolCallRounds) {
				const response = round.response ?? '';
				const answerMatch = response.match(/<debug_answer>([\s\S]*?)<\/debug_answer>/);
				if (answerMatch) {
					debugAnswer = answerMatch[1].trim();
					// Keep looking - we want the LAST debug_answer if there are multiple
				}
			}
			// Also check the final round response
			const finalResponse = loopResult.round?.response ?? '';
			const finalAnswerMatch = finalResponse.match(/<debug_answer>([\s\S]*?)<\/debug_answer>/);
			if (finalAnswerMatch) {
				debugAnswer = finalAnswerMatch[1].trim();
			}
			
			if (debugAnswer) {
				// Found a proper debug answer
				subagentResponse = debugAnswer;
			} else {
				// No <debug_answer> found - the subagent hit the tool limit without providing an answer
				const lastResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
				
				// Check if the model was confused and tried to use wrong tool calling format
				const hasMalformedToolCall = lastResponse.includes('<function=') || lastResponse.includes('<parameter=');
				
				if (hasMalformedToolCall) {
					subagentResponse = `[Debug subagent encountered a tool calling format error]\n\nThe subagent attempted to call tools using an incorrect format (<function=...>) instead of using the native tool calling mechanism. This is a model behavior issue.\n\nPlease try debugging manually or analyze the code directly.`;
				} else {
					subagentResponse = `[Debug subagent reached tool limit without providing a structured answer]\n\nLast response from subagent:\n${lastResponse}\n\nNote: The subagent may have gathered useful information but did not provide a final conclusion. You may need to analyze the code directly or try debugging again with a more specific question.`;
				}
			}
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

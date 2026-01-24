/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';

export interface IDebugControlParams {
	/** Action to perform */
	action: 'run' | 'continue' | 'step_into' | 'step_over' | 'step_out' | 'pause' | 'terminate';
	/** Thread ID (optional, defaults to current thread) */
	threadId?: string;
}

// Track current debug state
let currentState = {
	status: 'stopped' as 'running' | 'suspended' | 'terminated' | 'stopped',
	currentThread: 'main',
	location: null as { className: string; method: string; line: number; file: string } | null
};

class DebugControlTool implements ICopilotTool<IDebugControlParams> {
	public static readonly toolName = ToolName.DebugControl;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugControlParams>, _token: vscode.CancellationToken) {
		const { action, threadId } = options.input;

		console.log('[DebugControlTool] Action:', action, { threadId });

		try {
			let jdbCommand: string;
			let message: string;
			let newStatus: typeof currentState.status;
			let stopReason: string | null = null;

			switch (action) {
				case 'run':
					jdbCommand = 'run';
					message = 'Starting program execution';
					newStatus = 'running';
					break;

				case 'continue':
					jdbCommand = threadId ? `resume ${threadId}` : 'cont';
					message = 'Continuing execution';
					newStatus = 'running';
					break;

				case 'step_into':
					jdbCommand = 'step';
					message = 'Stepping into';
					newStatus = 'suspended';
					stopReason = 'step';
					break;

				case 'step_over':
					jdbCommand = 'next';
					message = 'Stepping over';
					newStatus = 'suspended';
					stopReason = 'step';
					break;

				case 'step_out':
					jdbCommand = 'step up';
					message = 'Stepping out';
					newStatus = 'suspended';
					stopReason = 'step';
					break;

				case 'pause':
					jdbCommand = threadId ? `suspend ${threadId}` : 'suspend';
					message = 'Suspending execution';
					newStatus = 'suspended';
					stopReason = 'pause';
					break;

				case 'terminate':
					jdbCommand = 'quit';
					message = 'Terminating debug session';
					newStatus = 'terminated';
					break;

				default:
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							error: `Unknown action: ${action}`
						}, null, 2))
					]);
			}

			// Update state
			currentState.status = newStatus;

			// Simulate location update for step operations
			if (stopReason === 'step') {
				currentState.location = {
					className: 'Example',
					method: 'exampleMethod',
					line: 42,
					file: 'Example.java'
				};
			}

			const result = {
				status: newStatus,
				stopReason,
				jdbCommand,
				message,
				location: currentState.location,
				threadId: threadId || currentState.currentThread,
				instructions: action === 'terminate'
					? 'Debug session ended.'
					: `Execute in JDB: ${jdbCommand}\n` +
					  'After execution, use debug_inspect to examine program state.'
			};

			console.log('[DebugControlTool] Result:', result);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugControlTool] Error:', errorMessage);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					error: `Failed to execute ${action}: ${errorMessage}`
				}, null, 2))
			]);
		}
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugControlParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'run': 'Running program',
			'continue': 'Continuing execution',
			'step_into': 'Stepping into',
			'step_over': 'Stepping over',
			'step_out': 'Stepping out',
			'pause': 'Pausing execution',
			'terminate': 'Terminating debug session'
		};
		return {
			invocationMessage: actionLabels[options.input.action] || `Debug: ${options.input.action}`,
		};
	}

	async resolveInput(input: IDebugControlParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugControlParams> {
		return input;
	}
}

// Export for other tools to check state
export function getDebugState() {
	return { ...currentState };
}

export function setDebugState(state: Partial<typeof currentState>) {
	currentState = { ...currentState, ...state };
}

ToolRegistry.registerTool(DebugControlTool);

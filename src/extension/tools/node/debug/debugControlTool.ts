/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { getActiveJdbSession, sendJdbCommand, terminateJdbSession } from './jdbSession';

export interface IDebugControlParams {
	/** Action to perform */
	action: 'run' | 'continue' | 'step_into' | 'step_over' | 'step_out' | 'pause' | 'terminate';
	/** Thread ID (optional, defaults to current thread) */
	threadId?: string;
}

class DebugControlTool implements ICopilotTool<IDebugControlParams> {
	public static readonly toolName = ToolName.DebugControl;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugControlParams>, _token: vscode.CancellationToken) {
		const { action, threadId } = options.input;

		console.log('[DebugControlTool] Action:', action, { threadId });

		// Get active JDB session
		const session = getActiveJdbSession();
		if (!session) {
			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					status: 'error',
					error: 'No active JDB session. Call debug_start first.'
				}, null, 2))
			]);
		}

		try {
			let jdbCommand: string;

			switch (action) {
				case 'run':
					jdbCommand = 'run';
					break;
				case 'continue':
					jdbCommand = threadId ? `resume ${threadId}` : 'cont';
					break;
				case 'step_into':
					jdbCommand = 'step';
					break;
				case 'step_over':
					jdbCommand = 'next';
					break;
				case 'step_out':
					jdbCommand = 'step up';
					break;
				case 'pause':
					jdbCommand = threadId ? `suspend ${threadId}` : 'suspend';
					break;
				case 'terminate':
					terminateJdbSession(session.sessionId);
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							status: 'terminated',
							message: 'JDB session terminated'
						}, null, 2))
					]);
				default:
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							status: 'error',
							error: `Unknown action: ${action}`
						}, null, 2))
					]);
			}

			// Send command to JDB and wait for response
			// Use longer timeout for run/continue as they wait for breakpoint
			const timeout = (action === 'run' || action === 'continue') ? 30000 : 5000;
			const result = await sendJdbCommand(session.sessionId, jdbCommand, timeout);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					status: result.success ? 'success' : 'error',
					action,
					jdbCommand,
					jdbOutput: result.output,
					error: result.error
				}, null, 2))
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugControlTool] Error:', errorMessage);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					status: 'error',
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

ToolRegistry.registerTool(DebugControlTool);

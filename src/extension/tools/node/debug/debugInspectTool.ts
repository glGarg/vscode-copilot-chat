/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { getActiveJdbSession, sendJdbCommand } from './jdbSession';

export interface IDebugInspectParams {
	/** Action to perform */
	action: 'locals' | 'eval' | 'stack' | 'this' | 'fields';
	/** Expression to evaluate (for eval action) */
	expression?: string;
	/** Object ID to inspect fields of */
	objectId?: string;
}

class DebugInspectTool implements ICopilotTool<IDebugInspectParams> {
	public static readonly toolName = ToolName.DebugInspect;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugInspectParams>, _token: vscode.CancellationToken) {
		const { action, expression, objectId } = options.input;

		console.log('[DebugInspectTool] Action:', action, { expression, objectId });

		// Get active JDB session
		const session = getActiveJdbSession();
		if (!session) {
			return this.errorResult('No active JDB session. Call debug_start first.');
		}

		try {
			let jdbCommand: string;

			switch (action) {
				case 'locals':
					jdbCommand = 'locals';
					break;
				case 'eval':
					if (!expression) {
						return this.errorResult('expression is required for eval action');
					}
					jdbCommand = `print ${expression}`;
					break;
				case 'stack':
					jdbCommand = 'where';
					break;
				case 'this':
					jdbCommand = 'print this';
					break;
				case 'fields':
					jdbCommand = objectId ? `dump ${objectId}` : 'dump this';
					break;
				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			// Send command to JDB
			const result = await sendJdbCommand(session.sessionId, jdbCommand);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					status: result.success ? 'success' : 'error',
					action,
					jdbCommand,
					output: result.output,
					error: result.error
				}, null, 2))
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugInspectTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ status: 'error', error: message }, null, 2))
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugInspectParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'locals': 'Inspecting local variables',
			'eval': `Evaluating: ${options.input.expression}`,
			'stack': 'Viewing stack trace',
			'this': 'Inspecting "this" object',
			'fields': 'Inspecting object fields'
		};
		return {
			invocationMessage: actionLabels[options.input.action] || `Inspect: ${options.input.action}`,
		};
	}

	async resolveInput(input: IDebugInspectParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugInspectParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugInspectTool);

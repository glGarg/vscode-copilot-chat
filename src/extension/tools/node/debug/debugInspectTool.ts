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
			return this.errorResult(
				'No active JDB session.\n\n' +
				'Start a debug session first:\n' +
				'1. Run test with debug agent in background\n' +
				'2. Call debug_start({mode: "attach", port: 5005})'
			);
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

			// Parse output for LLM-friendly response
			const output = result.output || '';
			let statusMessage: string;

			switch (action) {
				case 'locals': {
					if (output.includes('No local variables')) {
						statusMessage = `📋 LOCAL VARIABLES: None\n\n` +
							`No local variables at this point in execution.\n` +
							`Try: debug_inspect({action: "this"}) to see instance fields, or\n` +
							`     debug_control({action: "step_over"}) to advance and check again.`;
					} else {
						// Parse variable list for cleaner display
						const lines = output.split('\n').filter(l => l.trim() && !l.includes('main['));
						statusMessage = `📋 LOCAL VARIABLES:\n\n${lines.join('\n') || 'None found'}`;
					}
					break;
				}
				case 'eval': {
					// Clean up the print output
					const cleanOutput = output.replace(/\s*main\[\d+\]\s*$/, '').trim();
					const exprName = expression || 'expression';
					if (cleanOutput.includes(' = ')) {
						statusMessage = `🔍 EVALUATED: ${cleanOutput}`;
					} else if (cleanOutput.includes('null')) {
						statusMessage = `🔍 ${exprName} = null`;
					} else {
						statusMessage = `🔍 ${exprName} = ${cleanOutput}`;
					}
					break;
				}
				case 'stack': {
					const lines = output.split('\n').filter(l => l.trim() && !l.includes('main['));
					statusMessage = `📚 CALL STACK:\n\n${lines.map((l, i) => `${i + 1}. ${l.trim()}`).join('\n') || 'Empty stack'}`;
					break;
				}
				case 'this': {
					const cleanOutput = output.replace(/\s*main\[\d+\]\s*$/, '').trim();
					statusMessage = `📦 THIS OBJECT:\n\n${cleanOutput || 'Not available (static context?)'}`;
					break;
				}
				case 'fields': {
					const cleanOutput = output.replace(/\s*main\[\d+\]\s*$/, '').trim();
					statusMessage = `📦 OBJECT FIELDS:\n\n${cleanOutput || 'No fields found'}`;
					break;
				}
				default:
					statusMessage = output.trim();
			}

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(statusMessage)
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugInspectTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
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

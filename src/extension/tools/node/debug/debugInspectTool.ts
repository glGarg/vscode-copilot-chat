/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';

export interface IDebugInspectParams {
	/** Action to perform */
	action: 'locals' | 'eval' | 'stack' | 'this' | 'fields';
	/** Expression to evaluate (for eval action) */
	expression?: string;
	/** Object ID to inspect fields of */
	objectId?: string;
	/** How deep to expand nested objects (default: 2) */
	maxDepth?: number;
	/** Truncate long strings (default: 100) */
	maxStringLength?: number;
}

interface IVariable {
	name: string;
	type: string;
	value: string | object;
	objectId?: string;
}

interface IStackFrame {
	index: number;
	className: string;
	method: string;
	file: string;
	line: number;
}

class DebugInspectTool implements ICopilotTool<IDebugInspectParams> {
	public static readonly toolName = ToolName.DebugInspect;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugInspectParams>, _token: vscode.CancellationToken) {
		const { action, expression, objectId, maxDepth = 2, maxStringLength = 100 } = options.input;

		console.log('[DebugInspectTool] Action:', action, { expression, objectId, maxDepth, maxStringLength });

		try {
			let jdbCommand: string;
			let result: { variables?: IVariable[]; stackFrames?: IStackFrame[]; jdbCommand: string; message: string };

			switch (action) {
				case 'locals': {
					jdbCommand = 'locals';
					result = {
						jdbCommand,
						message: 'Displaying local variables. Run "locals" in JDB to see actual values.',
						variables: [
							{ name: '<placeholder>', type: 'N/A', value: 'Run "locals" in JDB to see local variables' }
						]
					};
					break;
				}

				case 'eval': {
					if (!expression) {
						return this.errorResult('expression is required for eval action');
					}
					jdbCommand = `print ${expression}`;
					result = {
						jdbCommand,
						message: `Evaluating: ${expression}. Run "${jdbCommand}" in JDB to see the result.`,
						variables: [
							{ name: expression, type: 'N/A', value: `<run "${jdbCommand}" in JDB>` }
						]
					};
					break;
				}

				case 'stack': {
					jdbCommand = 'where';
					result = {
						jdbCommand,
						message: 'Displaying stack trace. Run "where" in JDB to see actual frames.',
						stackFrames: [
							{ index: 0, className: '<placeholder>', method: 'N/A', file: 'N/A', line: 0 }
						]
					};
					break;
				}

				case 'this': {
					jdbCommand = 'print this';
					result = {
						jdbCommand,
						message: 'Displaying "this" object. Run "print this" in JDB to see actual value.',
						variables: [
							{ name: 'this', type: 'N/A', value: '<run "print this" in JDB>' }
						]
					};
					break;
				}

				case 'fields': {
					if (!objectId) {
						jdbCommand = 'dump this';
						result = {
							jdbCommand,
							message: 'Displaying fields of "this". Run "dump this" in JDB to see actual values.',
							variables: [
								{ name: '<placeholder>', type: 'N/A', value: 'Run "dump this" or "dump <objectId>" in JDB' }
							]
						};
					} else {
						jdbCommand = `dump ${objectId}`;
						result = {
							jdbCommand,
							message: `Displaying fields of ${objectId}. Run "${jdbCommand}" in JDB.`,
							variables: [
								{ name: '<placeholder>', type: 'N/A', value: `Run "${jdbCommand}" in JDB` }
							]
						};
					}
					break;
				}

				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			// Add inspection options to result
			const fullResult = {
				...result,
				options: { maxDepth, maxStringLength },
				instructions: `Execute in JDB terminal: ${jdbCommand}\n` +
					'Parse the output to understand program state.'
			};

			console.log('[DebugInspectTool] Result:', fullResult);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(fullResult, null, 2))
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugInspectTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ error: message }, null, 2))
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

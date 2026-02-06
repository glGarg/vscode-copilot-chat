/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { getActivePdbSession, sendPdbCommand } from './pdbSession';

export interface IDebugInspectParams {
	/** Action to perform */
	action: 'locals' | 'globals' | 'eval' | 'pretty_print' | 'stack' | 'args' | 'display' | 'undisplay' | 'interact' | 'source';
	/** Expression to evaluate (for eval, pretty_print, display actions) */
	expression?: string;
	/** Display number to remove (for undisplay action) */
	displayNumber?: number;
	/** Number of context lines for source (default: 11) */
	contextLines?: number;
}

class DebugInspectTool implements ICopilotTool<IDebugInspectParams> {
	public static readonly toolName = ToolName.DebugInspect;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugInspectParams>, _token: vscode.CancellationToken) {
		const { action, expression, displayNumber, contextLines } = options.input;

		console.log('[DebugInspectTool] Action:', action, { expression, displayNumber, contextLines });

		// Get active PDB session
		const session = getActivePdbSession();
		if (!session) {
			return this.errorResult(
				'No active PDB session.\n\n' +
				'Start a debug session first:\n' +
				'debug_start_session({target: "script.py", initialBreakpoints: [...]})'
			);
		}

		try {
			let pdbCommand: string;

			switch (action) {
				case 'locals':
					// Use p locals() to get a dict of local variables
					pdbCommand = 'p locals()';
					break;
				case 'globals':
					// Use p globals() to get global variables (often large!)
					pdbCommand = 'p {k:v for k,v in globals().items() if not k.startswith("__")}';
					break;
				case 'eval':
					if (!expression) {
						return this.errorResult('expression is required for eval action');
					}
					pdbCommand = `p ${expression}`;
					break;
				case 'pretty_print':
					if (!expression) {
						return this.errorResult('expression is required for pretty_print action');
					}
					pdbCommand = `pp ${expression}`;
					break;
				case 'stack':
					pdbCommand = 'w';  // where - print stack trace
					break;
				case 'args':
					pdbCommand = 'a';  // args - print arguments of current function
					break;
				case 'display':
					if (!expression) {
						// Without expression, list current displays
						pdbCommand = 'display';
					} else {
						// Add expression to display list
						pdbCommand = `display ${expression}`;
					}
					break;
				case 'undisplay':
					if (displayNumber !== undefined) {
						pdbCommand = `undisplay ${displayNumber}`;
					} else {
						// Clear all displays
						pdbCommand = 'undisplay';
					}
					break;
				case 'interact':
					// Start interactive Python interpreter at current frame
					// Note: This is tricky in non-interactive mode, provide guidance
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							`ℹ️ INTERACT MODE\n\n` +
							`The 'interact' command starts an interactive Python interpreter at the current frame.\n` +
							`This is best used in a real terminal session.\n\n` +
							`Instead, you can use:\n` +
							`• debug_inspect({action: "eval", expression: "your_code"}) - evaluate any Python expression\n` +
							`• debug_inspect({action: "locals"}) - see all local variables\n` +
							`• debug_inspect({action: "pretty_print", expression: "obj"}) - pretty print an object`
						)
					]);
				case 'source':
					// List source code around current line
					const lines = contextLines || 11;
					pdbCommand = `l ${Math.floor(lines / 2)}`;  // l shows lines around current
					// Actually, PDB 'l' without args shows 11 lines around current, 'l .' re-lists
					pdbCommand = 'l';
					break;
				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			// Send command to PDB
			const result = await sendPdbCommand(session.sessionId, pdbCommand);

			// Parse output for LLM-friendly response
			const output = result.output || '';
			let statusMessage: string;

			switch (action) {
				case 'locals': {
					// Clean up and format locals output
					const cleanOutput = this.cleanPdbOutput(output);
					if (cleanOutput.includes('{}') || cleanOutput.trim() === '{}') {
						statusMessage = `📋 LOCAL VARIABLES: None\n\n` +
							`No local variables at this point.\n` +
							`Try: debug_inspect({action: "args"}) to see function arguments, or\n` +
							`     debug_control({action: "step_over"}) to advance and check again.`;
					} else {
						statusMessage = `📋 LOCAL VARIABLES:\n\n${cleanOutput}`;
					}
					break;
				}
				case 'globals': {
					const cleanOutput = this.cleanPdbOutput(output);
					statusMessage = `🌍 GLOBAL VARIABLES (filtered):\n\n${cleanOutput}`;
					break;
				}
				case 'eval': {
					const cleanOutput = this.cleanPdbOutput(output);
					statusMessage = `🔍 ${expression} = ${cleanOutput}`;
					break;
				}
				case 'pretty_print': {
					const cleanOutput = this.cleanPdbOutput(output);
					statusMessage = `🔍 ${expression}:\n\n${cleanOutput}`;
					break;
				}
				case 'stack': {
					const cleanOutput = this.cleanPdbOutput(output);
					const lines = cleanOutput.split('\n').filter(l => l.trim());
					statusMessage = `📚 CALL STACK:\n\n${lines.map((l, i) => `${i + 1}. ${l.trim()}`).join('\n') || 'Empty stack'}`;
					break;
				}
				case 'args': {
					const cleanOutput = this.cleanPdbOutput(output);
					if (!cleanOutput || cleanOutput.trim() === '') {
						statusMessage = `📋 FUNCTION ARGUMENTS: None (not in a function or no arguments)`;
					} else {
						statusMessage = `📋 FUNCTION ARGUMENTS:\n\n${cleanOutput}`;
					}
					break;
				}
				case 'display': {
					const cleanOutput = this.cleanPdbOutput(output);
					if (expression) {
						statusMessage = `✅ Now displaying: ${expression}\n\n${cleanOutput}`;
					} else {
						statusMessage = `📋 CURRENT DISPLAYS:\n\n${cleanOutput || 'No expressions being displayed'}`;
					}
					break;
				}
				case 'undisplay': {
					statusMessage = `✅ Display${displayNumber !== undefined ? ` #${displayNumber}` : 's'} removed`;
					break;
				}
				case 'source': {
					const cleanOutput = this.cleanPdbOutput(output);
					statusMessage = `📄 SOURCE CODE:\n\n${cleanOutput}`;
					break;
				}
				default:
					statusMessage = this.cleanPdbOutput(output);
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

	private cleanPdbOutput(output: string): string {
		// Remove PDB prompt and clean up output
		return output
			.split('\n')
			.filter(l => !l.match(/^\(Pdb\+*\)\s*$/))
			.join('\n')
			.trim();
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugInspectParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'locals': 'Inspecting local variables',
			'globals': 'Inspecting global variables',
			'eval': `Evaluating: ${options.input.expression}`,
			'pretty_print': `Pretty printing: ${options.input.expression}`,
			'stack': 'Viewing stack trace',
			'args': 'Inspecting function arguments',
			'display': options.input.expression ? `Adding display: ${options.input.expression}` : 'Listing displays',
			'undisplay': 'Removing display',
			'interact': 'Starting interactive mode',
			'source': 'Viewing source code'
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

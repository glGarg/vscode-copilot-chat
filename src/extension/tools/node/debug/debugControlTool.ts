/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { getActivePdbSession, sendPdbCommand, terminatePdbSession, parsePdbOutput } from './pdbSession';

export interface IDebugControlParams {
	/** Action to perform */
	action: 'continue' | 'step_into' | 'step_over' | 'step_out' | 'until' | 'jump' | 'restart' | 'quit';
	/** Line number (required for 'until' and 'jump' actions) */
	lineno?: number;
}

class DebugControlTool implements ICopilotTool<IDebugControlParams> {
	public static readonly toolName = ToolName.DebugControl;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugControlParams>, _token: vscode.CancellationToken) {
		const { action, lineno } = options.input;

		console.log('[DebugControlTool] Action:', action, { lineno });

		// Get active PDB session
		const session = getActivePdbSession();
		if (!session) {
			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(
					`❌ NO PDB SESSION\n\n` +
					`You must start a debug session first:\n` +
					`debug_start_session({target: "script.py", initialBreakpoints: [...]})`
				)
			]);
		}

		try {
			let pdbCommand: string;

			switch (action) {
				case 'continue':
					pdbCommand = 'c';
					break;
				case 'step_into':
					pdbCommand = 's';
					break;
				case 'step_over':
					pdbCommand = 'n';
					break;
				case 'step_out':
					pdbCommand = 'r';  // return - execute until current function returns
					break;
				case 'until':
					if (lineno === undefined) {
						return this.errorResult('lineno is required for "until" action');
					}
					pdbCommand = `unt ${lineno}`;  // continue until line >= lineno
					break;
				case 'jump':
					if (lineno === undefined) {
						return this.errorResult('lineno is required for "jump" action');
					}
					pdbCommand = `j ${lineno}`;  // jump to line (skip code)
					break;
				case 'restart':
					pdbCommand = 'run';  // restart the program
					break;
				case 'quit':
					terminatePdbSession(session.sessionId);
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(`✅ PDB session terminated`)
					]);
				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			// Send command to PDB and wait for response
			// Use longer timeout for continue as it waits for breakpoint
			const timeout = (action === 'continue' || action === 'until') ? 30000 : 5000;
			const result = await sendPdbCommand(session.sessionId, pdbCommand, timeout);

			// Parse output
			const output = result.output || '';
			const parsed = parsePdbOutput(output);
			let statusMessage: string;

			// Helper to get source code for context
			const getSourceCode = async (): Promise<string> => {
				const listResult = await sendPdbCommand(session.sessionId, 'l', 2000);
				const listOutput = listResult.output || '';
				if (listOutput && !listOutput.includes('Error')) {
					// Clean up PDB prompt from source listing
					return listOutput
						.split('\n')
						.filter(l => !l.match(/^\(Pdb\+*\)\s*$/) && l.trim())
						.join('\n');
				}
				return '';
			};

			if (action === 'continue' || action === 'until') {
				if (output.includes('Breakpoint') || parsed.isAtBreakpoint) {
					const source = await getSourceCode();
					const location = parsed.currentFile
						? `${parsed.currentFile}:${parsed.currentLine} in ${parsed.currentFunction || '<module>'}`
						: 'unknown location';

					statusMessage = `🎯 BREAKPOINT HIT!\n\n` +
						`Location: ${location}\n`;

					if (parsed.sourceLine) {
						statusMessage += `Current line: ${parsed.sourceLine}\n`;
					}

					if (source) {
						statusMessage += `\n📄 SOURCE CODE:\n${source}\n`;
					}

					statusMessage += `\nNext steps:\n` +
						`• debug_control({action: "step_over"}) - execute next line\n` +
						`• debug_control({action: "step_into"}) - step into function\n` +
						`• debug_control({action: "continue"}) - run to next breakpoint\n` +
						`• debug_inspect({action: "locals"}) - see local variables\n` +
						`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression`;

				} else if (output.includes('The program finished') || output.includes('--Return--')) {
					statusMessage = `⚠️ PROGRAM FINISHED - No breakpoint was hit\n\n` +
						`The program ran to completion.\n` +
						`Possible reasons:\n` +
						`1. Breakpoint location is not executed by this program\n` +
						`2. File or line number was incorrect\n\n` +
						`Output:\n${output}`;
				} else if (parsed.isException) {
					const source = await getSourceCode();
					statusMessage = `⚠️ EXCEPTION RAISED!\n\n` +
						`Type: ${parsed.exceptionType || 'Unknown'}\n` +
						`Message: ${parsed.exceptionMessage || 'No message'}\n`;

					if (parsed.currentFile) {
						statusMessage += `Location: ${parsed.currentFile}:${parsed.currentLine}\n`;
					}

					if (source) {
						statusMessage += `\n📄 SOURCE CODE:\n${source}\n`;
					}

					statusMessage += `\nSession paused at exception. You can:\n` +
						`• debug_inspect({action: "locals"}) - see local variables\n` +
						`• debug_inspect({action: "stack"}) - view call stack`;
				} else {
					statusMessage = `▶️ EXECUTION ${action.toUpperCase()}D\n\n${output.trim() || 'No output'}`;
				}

			} else if (action === 'step_into' || action === 'step_over' || action === 'step_out') {
				const source = await getSourceCode();
				const location = parsed.currentFile
					? `${parsed.currentFile}:${parsed.currentLine} in ${parsed.currentFunction || '<module>'}`
					: 'stepped';

				statusMessage = `👣 STEPPED to ${location}\n`;

				if (parsed.sourceLine) {
					statusMessage += `Current line: ${parsed.sourceLine}\n`;
				}

				if (source) {
					statusMessage += `\n📄 SOURCE CODE:\n${source}\n`;
				}

				statusMessage += `\nNext steps:\n` +
					`• debug_control({action: "step_over"}) - execute next line\n` +
					`• debug_control({action: "step_into"}) - step into function\n` +
					`• debug_control({action: "continue"}) - run to next breakpoint\n` +
					`• debug_inspect({action: "locals"}) - see local variables\n` +
					`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression`;

			} else if (action === 'jump') {
				statusMessage = `⏭️ JUMPED to line ${lineno}\n\n${output.trim() || 'Jump completed'}`;
			} else if (action === 'restart') {
				statusMessage = `🔄 PROGRAM RESTARTED\n\n${output.trim() || 'Restart completed'}`;
			} else {
				statusMessage = `✅ ${action.toUpperCase()} completed\n\n${output.trim() || 'No output'}`;
			}

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(statusMessage)
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugControlTool] Error:', errorMessage);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(`❌ ERROR: Failed to execute ${action}: ${errorMessage}`)
			]);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugControlParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'continue': 'Continuing execution',
			'step_into': 'Stepping into',
			'step_over': 'Stepping over',
			'step_out': 'Stepping out (return)',
			'until': `Running until line ${options.input.lineno}`,
			'jump': `Jumping to line ${options.input.lineno}`,
			'restart': 'Restarting program',
			'quit': 'Quitting debug session'
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

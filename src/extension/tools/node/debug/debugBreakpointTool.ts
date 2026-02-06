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

export interface IDebugBreakpointParams {
	/** Action to perform */
	action: 'set' | 'remove' | 'list' | 'enable' | 'disable' | 'condition' | 'clear_all';
	/** Python file path for the breakpoint location */
	file?: string;
	/** Line number for the breakpoint */
	line?: number;
	/** Function name for function breakpoint */
	function?: string;
	/** Conditional expression for the breakpoint */
	condition?: string;
	/** Breakpoint number (for remove/enable/disable/condition) */
	breakpointNumber?: number;
}

class DebugBreakpointTool implements ICopilotTool<IDebugBreakpointParams> {
	public static readonly toolName = ToolName.DebugBreakpoint;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugBreakpointParams>, _token: vscode.CancellationToken) {
		const { action, file, line, function: funcName, condition, breakpointNumber } = options.input;

		console.log('[DebugBreakpointTool] Action:', action, { file, line, function: funcName, condition, breakpointNumber });

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
			switch (action) {
				case 'set': {
					if (!file && !funcName) {
						return this.errorResult('file or function is required to set a breakpoint');
					}

					if (!line && !funcName) {
						return this.errorResult('line or function is required to set a breakpoint');
					}

					// Build PDB breakpoint command
					// Formats: b file:line, b file:function, b function, b line
					let pdbCommand: string;
					let locationDesc: string;

					if (funcName) {
						// Function breakpoint
						if (file) {
							pdbCommand = `b ${file}:${funcName}`;
							locationDesc = `${file}:${funcName}()`;
						} else {
							pdbCommand = `b ${funcName}`;
							locationDesc = `${funcName}()`;
						}
					} else if (line) {
						// Line breakpoint
						if (file) {
							pdbCommand = `b ${file}:${line}`;
							locationDesc = `${file}:${line}`;
						} else {
							pdbCommand = `b ${line}`;
							locationDesc = `line ${line}`;
						}
					} else {
						return this.errorResult('Could not determine breakpoint location');
					}

					// Add condition if provided (PDB syntax: b location, condition)
					if (condition) {
						pdbCommand += `, ${condition}`;
					}

					// Send command to PDB
					const result = await sendPdbCommand(session.sessionId, pdbCommand);

					if (!result.success) {
						return this.errorResult(`Failed to set breakpoint: ${result.error}`);
					}

					// Parse PDB output
					const output = result.output || '';
					const bpMatch = output.match(/Breakpoint (\d+) at (.+):(\d+)/);

					let statusMessage: string;
					if (bpMatch) {
						statusMessage = `✅ BREAKPOINT #${bpMatch[1]} SET at ${bpMatch[2]}:${bpMatch[3]}\n\n` +
							`Use: debug_control({action: "continue"}) to run to this breakpoint.`;
					} else if (output.includes('Breakpoint')) {
						statusMessage = `✅ BREAKPOINT SET at ${locationDesc}\n\n` +
							`PDB output: ${output.trim()}\n\n` +
							`Use: debug_control({action: "continue"}) to run.`;
					} else if (output.includes('Error') || output.includes('Cannot')) {
						statusMessage = `❌ FAILED to set breakpoint at ${locationDesc}\n\n` +
							`PDB output: ${output.trim()}`;
					} else {
						statusMessage = `✅ BREAKPOINT COMMAND SENT: ${pdbCommand}\n\n` +
							`PDB response: ${output.trim()}`;
					}

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(statusMessage)
					]);
				}

				case 'remove': {
					if (breakpointNumber === undefined) {
						return this.errorResult('breakpointNumber is required to remove a breakpoint. Use "list" to see breakpoint numbers.');
					}

					// PDB: cl(ear) breakpoint_number
					const pdbCommand = `cl ${breakpointNumber}`;
					const result = await sendPdbCommand(session.sessionId, pdbCommand);

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							result.output?.includes('Deleted') || !result.output?.includes('Error')
								? `✅ Breakpoint #${breakpointNumber} removed`
								: `❌ Failed to remove breakpoint: ${result.output}`
						)
					]);
				}

				case 'list': {
					// PDB: b (without args lists all breakpoints)
					const result = await sendPdbCommand(session.sessionId, 'b');
					const output = result.output || '';

					if (output.includes('No breakpoints')) {
						return new ExtendedLanguageModelToolResult([
							new LanguageModelTextPart('📋 No breakpoints set')
						]);
					}

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(`📋 BREAKPOINTS:\n\n${output.trim()}`)
					]);
				}

				case 'enable': {
					if (breakpointNumber === undefined) {
						return this.errorResult('breakpointNumber is required');
					}

					// PDB: enable breakpoint_number
					const result = await sendPdbCommand(session.sessionId, `enable ${breakpointNumber}`);

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							`✅ Breakpoint #${breakpointNumber} enabled\n\n${result.output || ''}`
						)
					]);
				}

				case 'disable': {
					if (breakpointNumber === undefined) {
						return this.errorResult('breakpointNumber is required');
					}

					// PDB: disable breakpoint_number
					const result = await sendPdbCommand(session.sessionId, `disable ${breakpointNumber}`);

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							`✅ Breakpoint #${breakpointNumber} disabled\n\n${result.output || ''}`
						)
					]);
				}

				case 'condition': {
					if (breakpointNumber === undefined) {
						return this.errorResult('breakpointNumber is required');
					}
					if (!condition) {
						return this.errorResult('condition is required');
					}

					// PDB: condition breakpoint_number expression
					const result = await sendPdbCommand(session.sessionId, `condition ${breakpointNumber} ${condition}`);

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							`✅ Condition set on breakpoint #${breakpointNumber}: ${condition}\n\n${result.output || ''}`
						)
					]);
				}

				case 'clear_all': {
					// PDB: cl (clear all breakpoints)
					const result = await sendPdbCommand(session.sessionId, 'cl');

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(
							`✅ All breakpoints cleared\n\n${result.output || ''}`
						)
					]);
				}

				default:
					return this.errorResult(`Unknown action: ${action}`);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugBreakpointTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugBreakpointParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { action, file, line, function: funcName, breakpointNumber } = options.input;
		const location = file ? `${file}:${line || funcName}` : (breakpointNumber ? `#${breakpointNumber}` : '');
		return {
			invocationMessage: `${action} breakpoint${location ? ` at ${location}` : ''}`,
		};
	}

	async resolveInput(input: IDebugBreakpointParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugBreakpointParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugBreakpointTool);

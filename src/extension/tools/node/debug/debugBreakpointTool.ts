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

export interface IDebugBreakpointParams {
	/** Action to perform */
	action: 'set' | 'remove' | 'list' | 'enable' | 'disable';
	/** Class name for the breakpoint location (can be simple name like "TypeUtils" or fully qualified) */
	className?: string;
	/** Line number for the breakpoint */
	line?: number;
	/** Method name for method-entry breakpoint (e.g., "cast", "readObject") */
	method?: string;
	/** Code snippet to search for - breakpoint set at line containing this code */
	nearCode?: string;
	/** File path to search when using nearCode */
	file?: string;
	/** Conditional expression for the breakpoint */
	condition?: string;
	/** Break only after N hits */
	hitCount?: number;
	/** Breakpoint ID (for remove/enable/disable) */
	breakpointId?: string;
}

class DebugBreakpointTool implements ICopilotTool<IDebugBreakpointParams> {
	public static readonly toolName = ToolName.DebugBreakpoint;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugBreakpointParams>, _token: vscode.CancellationToken) {
		const { action, className, line, method, nearCode, file, condition, breakpointId } = options.input;

		console.log('[DebugBreakpointTool] Action:', action, { className, line, method, nearCode, file, condition, breakpointId });

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
			switch (action) {
				case 'set': {
					if (!className) {
						return this.errorResult('className is required to set a breakpoint');
					}
					
					if (!line && !method && !nearCode) {
						return this.errorResult('One of line, method, or nearCode is required to set a breakpoint');
					}

					// Build JDB command
					let jdbCommand: string;
					let locationDesc: string;
					
					if (method) {
						jdbCommand = `stop in ${className}.${method}`;
						locationDesc = `${className}.${method}()`;
					} else if (line) {
						jdbCommand = `stop at ${className}:${line}`;
						locationDesc = `${className}:${line}`;
					} else if (nearCode) {
						// For nearCode, we need to resolve the line first
						// This would require searching the file - for now, guide the user
						return this.errorResult(`nearCode requires line resolution. Search for "${nearCode}" in ${file || className} to find the line number, then use line parameter.`);
					} else {
						return this.errorResult('Could not determine breakpoint location');
					}

					// Add condition if provided
					if (condition) {
						jdbCommand += ` if ${condition}`;
					}

					// Send command to JDB
					const result = await sendJdbCommand(session.sessionId, jdbCommand);

					if (!result.success) {
						return this.errorResult(`Failed to set breakpoint: ${result.error}`);
					}

					// Parse JDB output for LLM-friendly response
					const output = result.output || '';
					const isDeferred = output.includes('Deferring breakpoint');
					const isSet = output.includes('Set breakpoint') || output.includes('Breakpoint set');
					
					let statusMessage: string;
					if (isDeferred) {
						statusMessage = `⏳ BREAKPOINT DEFERRED at ${locationDesc}\n\n` +
							`The class is not yet loaded. The breakpoint will activate when the class loads.\n` +
							`This is normal - proceed with: debug_control({action: "continue"})`;
					} else if (isSet) {
						statusMessage = `✅ BREAKPOINT SET at ${locationDesc}\n\n` +
							`Ready to debug. Use: debug_control({action: "continue"}) to run until breakpoint hits.`;
					} else {
						statusMessage = `✅ BREAKPOINT COMMAND SENT: ${jdbCommand}\n\n` +
							`JDB response: ${output.trim()}\n\n` +
							`Use: debug_control({action: "continue"}) to run.`;
					}

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(statusMessage)
					]);
				}

				case 'remove': {
					if (!className && !breakpointId) {
						return this.errorResult('className or breakpointId is required to remove a breakpoint');
					}

					let jdbCommand: string;
					if (breakpointId) {
						// JDB uses "clear" with the location, not an ID
						jdbCommand = `clear ${breakpointId}`;
					} else if (method) {
						jdbCommand = `clear ${className}.${method}`;
					} else if (line) {
						jdbCommand = `clear ${className}:${line}`;
					} else {
						return this.errorResult('Specify method or line to clear breakpoint');
					}

					const result = await sendJdbCommand(session.sessionId, jdbCommand);

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							status: result.success ? 'success' : 'error',
							message: result.success ? 'Breakpoint removed' : result.error,
							jdbCommand,
							jdbOutput: result.output
						}, null, 2))
					]);
				}

				case 'list': {
					// JDB "stop" command without args lists all breakpoints
					const result = await sendJdbCommand(session.sessionId, 'stop');

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							status: 'success',
							message: 'Breakpoints listed',
							jdbOutput: result.output
						}, null, 2))
					]);
				}

				case 'enable':
				case 'disable': {
					// JDB doesn't have native enable/disable - would need to remove and re-add
					return this.errorResult(`JDB does not support ${action} - use remove and set instead`);
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
		const { action, className, line, method } = options.input;
		const location = className ? `${className}:${line || method}` : '';
		return {
			invocationMessage: `${action} breakpoint${location ? ` at ${location}` : ''}`,
		};
	}

	async resolveInput(input: IDebugBreakpointParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugBreakpointParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugBreakpointTool);

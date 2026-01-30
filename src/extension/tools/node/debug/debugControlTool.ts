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
				new LanguageModelTextPart(
					`❌ NO JDB SESSION\n\n` +
					`You must start a debug session first:\n` +
					`1. Start test in background: mvn test -Dtest=TestClass#method -Dmaven.surefire.debug > /tmp/test.log 2>&1 &\n` +
					`2. Wait: sleep 5\n` +
					`3. Attach: debug_start({mode: "attach", port: 5005})`
				)
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

			// Parse output for LLM-friendly response
			const output = result.output || '';
			let statusMessage: string;

			// Helper to get source code for context
			const getSourceCode = async (): Promise<string> => {
				const listResult = await sendJdbCommand(session.sessionId, 'list', 2000);
				
				// Parse source listing - JDB shows ~10 lines around current position with => marker
				// Format: "linenum    code" or "linenum =>  code" for current line
				// Note: JDB may append "Local variables:" section at the end - we need to strip that
				const listOutput = listResult.output || '';
				if (listOutput && 
				    !listOutput.includes('not available') && 
				    !listOutput.includes('Source file not found') &&
				    !listOutput.includes('not found')) {
					// Truncate at "Local variables:" or "Method arguments:" if present
					let sourceOnly = listOutput;
					const localVarsIdx = listOutput.indexOf('Local variables:');
					const methodArgsIdx = listOutput.indexOf('Method arguments:');
					const cutoffIdx = Math.min(
						localVarsIdx >= 0 ? localVarsIdx : Infinity,
						methodArgsIdx >= 0 ? methodArgsIdx : Infinity
					);
					if (cutoffIdx < Infinity) {
						sourceOnly = listOutput.slice(0, cutoffIdx);
					}
					
					const lines = sourceOnly.split('\n')
						.filter(l => l.trim() && !l.includes('main['))
						// Keep lines that look like source (start with line number)
						// but filter out JDB prompt lines that end with just ">"
						.filter(l => !l.match(/^\s*>\s*$/));
					return lines.join('\n');
				}
				return '';
			};

			if (action === 'continue' || action === 'run') {
				if (output.includes('Breakpoint hit')) {
					// Extract breakpoint location
					const match = output.match(/Breakpoint hit:.*?"thread=([^"]+)".*?(\S+)\(\),\s*line=(\d+)/);
					
					// Auto-fetch source code
					const source = await getSourceCode();
					
					if (match) {
						const [, thread, method, line] = match;
						statusMessage = `🎯 BREAKPOINT HIT!\n\n` +
							`Location: ${method}() at line ${line}\n` +
							`Thread: ${thread}\n`;
					} else {
						statusMessage = `🎯 BREAKPOINT HIT!\n\n${output.trim()}\n`;
					}
					
					// Add source code
					if (source) {
						statusMessage += `\n📄 SOURCE CODE:\n${source}\n`;
					}
					
					statusMessage += `\nNext steps:\n` +
						`• debug_control({action: "step_over"}) - execute next line\n` +
						`• debug_control({action: "step_into"}) - step into method call\n` +
						`• debug_control({action: "continue"}) - run to next breakpoint\n` +
						`• debug_inspect({action: "locals"}) - see local variables\n` +
						`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression`;
						
				} else if (output.includes('The application exited')) {
					statusMessage = `⚠️ APPLICATION EXITED - No breakpoint was hit\n\n` +
						`The test ran to completion without hitting any breakpoints.\n` +
						`Possible reasons:\n` +
						`1. Breakpoint location is not executed by this test\n` +
						`2. Class name or method name was incorrect\n` +
						`3. The test completes before reaching the breakpoint\n\n` +
						`Try setting a breakpoint earlier in the call chain or on the test method itself.`;
				} else if (output.includes('Set deferred breakpoint')) {
					statusMessage = `▶️ RUNNING - Deferred breakpoints now active\n\n` +
						`JDB output: ${output.trim()}\n\n` +
						`Waiting for breakpoint to hit...`;
				} else {
					statusMessage = `▶️ EXECUTION ${action.toUpperCase()}ED\n\n${output.trim() || 'No output'}`;
				}
			} else if (action === 'step_into' || action === 'step_over' || action === 'step_out') {
				// Extract current location after step
				const match = output.match(/Step completed:.*?(\S+)\(\),\s*line=(\d+)/);
				
				// Auto-fetch source code after stepping
				const source = await getSourceCode();
				
				if (match) {
					const [, method, line] = match;
					statusMessage = `👣 STEPPED to ${method}() line ${line}\n`;
				} else {
					statusMessage = `👣 STEP ${action.replace('_', ' ').toUpperCase()}\n\n${output.trim() || 'Step completed'}\n`;
				}
				
				// Add source code
				if (source) {
					statusMessage += `\n📄 SOURCE CODE:\n${source}\n`;
				}
				
				statusMessage += `\nNext steps:\n` +
					`• debug_control({action: "step_over"}) - execute next line\n` +
					`• debug_control({action: "step_into"}) - step into method call\n` +
					`• debug_control({action: "continue"}) - run to next breakpoint\n` +
					`• debug_inspect({action: "locals"}) - see local variables\n` +
					`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression`;
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { startPdbSession, startPytestPdbSession, getActivePdbSession, sendPdbCommand, terminatePdbSession, parsePdbOutput } from './pdbSession';

export interface IBreakpointSpec {
	/** Python file path (relative or absolute) */
	file: string;
	/** Line number for line breakpoint */
	line?: number;
	/** Function name for function breakpoint */
	function?: string;
	/** Condition expression for conditional breakpoint */
	condition?: string;
}

export interface IDebugStartSessionParams {
	// === Target specification (use testFile OR script, not both) ===
	/** For pytest: test file path (e.g., "tests/test_example.py") */
	testFile?: string;
	/** For pytest: specific test name (e.g., "test_func" or "TestClass::test_method") */
	testName?: string;
	/** For regular scripts: script path (e.g., "script.py") */
	script?: string;
	/** For regular scripts: arguments to pass */
	args?: string[];
	
	/** Initial breakpoints to set before continuing execution */
	initialBreakpoints?: IBreakpointSpec[];
	/** Working directory (defaults to workspace root) */
	workingDir?: string;
	/** Timeout in seconds to wait for breakpoint hit (default: 60) */
	timeout?: number;
}

interface DebugSessionResult {
	status: 'breakpoint_hit' | 'exception_caught' | 'completed' | 'timeout' | 'failed';
	location?: string;
	currentFile?: string;
	currentLine?: number;
	currentFunction?: string;
	sourceLine?: string;
	exceptionType?: string;
	exceptionMessage?: string;
	output?: string;
	error?: string;
}

// Store reference to active process for cleanup
let activeProcess: ChildProcess | null = null;

class DebugStartSessionTool implements ICopilotTool<IDebugStartSessionParams> {
	public static readonly toolName = ToolName.DebugStartSession;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugStartSessionParams>, _token: vscode.CancellationToken) {
		const {
			testFile,
			testName,
			script,
			args = [],
			initialBreakpoints = [],
			workingDir,
			timeout = 60
		} = options.input;

		const isPytest = !!testFile;
		const isScript = !!script;
		
		if (!isPytest && !isScript) {
			return this.errorResult(
				'Must specify either testFile (for pytest) or script (for regular scripts).\n\n' +
				'Examples:\n' +
				'• Pytest: {testFile: "tests/test_example.py", testName: "test_func"}\n' +
				'• Script: {script: "main.py", args: ["--verbose"]}'
			);
		}

		const target = isPytest ? `${testFile}${testName ? '::' + testName : ''}` : script!;
		console.log('[DebugStartSessionTool] Starting debug session:', { mode: isPytest ? 'pytest' : 'script', target, initialBreakpoints, timeout });

		try {
			// Clean up any existing session
			const existingSession = getActivePdbSession();
			if (existingSession) {
				terminatePdbSession(existingSession.sessionId);
			}
			if (activeProcess) {
				activeProcess.kill('SIGTERM');
				activeProcess = null;
			}

			// Determine working directory
			const cwd = workingDir || process.cwd();
			console.log('[DebugStartSessionTool] Working directory:', cwd);

			// Start appropriate session type
			const sessionId = `pdb-${Date.now()}`;
			let startResult;
			
			if (isPytest) {
				startResult = await startPytestPdbSession(sessionId, testFile!, testName, cwd);
			} else {
				startResult = await startPdbSession(sessionId, script!, args, cwd);
			}

			if (!startResult.success) {
				return this.errorResult(
					`Failed to start ${isPytest ? 'pytest' : 'PDB'} session.\n\n` +
					`Target: ${target}\n` +
					`Error: ${startResult.error || 'Unknown error'}\n\n` +
					`Output:\n${startResult.output || '(no output)'}\n\n` +
					`Common causes:\n` +
					(isPytest 
						? '• Test file not found\n• pytest not installed\n• Test syntax error'
						: '• Script not found\n• Python syntax error\n• Missing dependencies')
				);
			}

			const session = getActivePdbSession();
			if (!session) {
				return this.errorResult('PDB session started but not found');
			}
			activeProcess = session.process;

			// Set initial breakpoints
			const breakpointResults: string[] = [];
			for (const bp of initialBreakpoints) {
				const bpResult = await this.setBreakpoint(sessionId, bp);
				breakpointResults.push(bpResult);
			}

			// If breakpoints were set, continue to first breakpoint
			let result: DebugSessionResult;
			if (initialBreakpoints.length > 0) {
				result = await this.continueToBreakpoint(sessionId, timeout * 1000);
			} else {
				// No breakpoints, just return ready state
				result = {
					status: 'breakpoint_hit', // PDB starts paused at first line
					location: 'script start',
					output: startResult.output
				};
			}

			// Get current location and source
			const whereResult = await sendPdbCommand(sessionId, 'l', 2000);
			const parsed = parsePdbOutput(whereResult.output || '');

			if (parsed.currentFile) {
				result.currentFile = parsed.currentFile;
				result.currentLine = parsed.currentLine;
				result.currentFunction = parsed.currentFunction;
			}

			return this.formatResult(result, breakpointResults, whereResult.output || '');

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugStartSessionTool] Error:', errorMessage);
			this.cleanupProcess();
			return this.errorResult(`Debug session failed: ${errorMessage}`);
		}
	}

	private async setBreakpoint(sessionId: string, bp: IBreakpointSpec): Promise<string> {
		let cmd: string;
		let desc: string;

		if (bp.function) {
			// Function breakpoint: b function_name
			cmd = `b ${bp.file}:${bp.function}`;
			desc = `${bp.file}:${bp.function}()`;
		} else if (bp.line) {
			// Line breakpoint: b file:line
			cmd = `b ${bp.file}:${bp.line}`;
			desc = `${bp.file}:${bp.line}`;
		} else {
			return `${bp.file}: no line or function specified`;
		}

		// Add condition if present
		if (bp.condition) {
			cmd += `, ${bp.condition}`;
			desc += ` [if ${bp.condition}]`;
		}

		const result = await sendPdbCommand(sessionId, cmd, 2000);
		const output = result.output || '';

		// Check if breakpoint was set
		if (output.includes('Breakpoint') && output.match(/Breakpoint \d+ at/)) {
			return `✓ ${desc}`;
		} else if (output.includes('Error') || output.includes('Cannot')) {
			return `✗ ${desc}: ${output.split('\n')[0]}`;
		} else {
			return `? ${desc}: ${output.split('\n')[0]}`;
		}
	}

	private async continueToBreakpoint(sessionId: string, timeoutMs: number): Promise<DebugSessionResult> {
		// Send continue command
		const result = await sendPdbCommand(sessionId, 'c', timeoutMs);
		const output = result.output || '';
		const parsed = parsePdbOutput(output);

		// Check for breakpoint hit
		if (output.includes('Breakpoint') || output.includes('-> ')) {
			return {
				status: 'breakpoint_hit',
				location: parsed.currentFile
					? `${parsed.currentFile}:${parsed.currentLine} in ${parsed.currentFunction || '<module>'}`
					: 'unknown',
				currentFile: parsed.currentFile,
				currentLine: parsed.currentLine,
				currentFunction: parsed.currentFunction,
				sourceLine: parsed.sourceLine,
				output
			};
		}

		// Check for exception
		if (parsed.isException || output.includes('Exception') || output.includes('Error:')) {
			return {
				status: 'exception_caught',
				exceptionType: parsed.exceptionType,
				exceptionMessage: parsed.exceptionMessage || output,
				currentFile: parsed.currentFile,
				currentLine: parsed.currentLine,
				output
			};
		}

		// Check for program completion
		if (output.includes('The program finished') || output.includes('--Return--')) {
			return {
				status: 'completed',
				output
			};
		}

		// Timeout or other
		return {
			status: 'timeout',
			output
		};
	}

	private cleanupProcess(): void {
		if (activeProcess) {
			try {
				activeProcess.kill('SIGTERM');
			} catch {
				// Ignore cleanup errors
			}
			activeProcess = null;
		}
	}

	private formatResult(
		result: DebugSessionResult,
		breakpointResults: string[],
		sourceOutput: string = ''
	): ExtendedLanguageModelToolResult {
		let message: string;

		switch (result.status) {
			case 'breakpoint_hit':
				message =
					`🎯 BREAKPOINT HIT!\n\n` +
					`Location: ${result.location || 'unknown'}\n`;

				if (result.sourceLine) {
					message += `Current line: ${result.sourceLine}\n`;
				}

				// Add source listing if available
				if (sourceOutput) {
					message += `\n📄 SOURCE CODE:\n${this.cleanSourceOutput(sourceOutput)}\n`;
				}

				message += `\nNext steps:\n` +
					`• debug_control({action: "step_over"}) - execute next line (n)\n` +
					`• debug_control({action: "step_into"}) - step into function (s)\n` +
					`• debug_control({action: "continue"}) - run to next breakpoint (c)\n` +
					`• debug_inspect({action: "locals"}) - see local variables\n` +
					`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression\n` +
					`• debug_inspect({action: "stack"}) - view call stack`;
				break;

			case 'exception_caught':
				message =
					`⚠️ EXCEPTION CAUGHT!\n\n` +
					`Type: ${result.exceptionType || 'Unknown'}\n` +
					`Message: ${result.exceptionMessage || 'No message'}\n`;

				if (result.currentFile) {
					message += `Location: ${result.currentFile}:${result.currentLine}\n`;
				}

				if (sourceOutput) {
					message += `\n📄 SOURCE CODE:\n${this.cleanSourceOutput(sourceOutput)}\n`;
				}

				message += `\nSession is paused at exception. You can:\n` +
					`• debug_inspect({action: "locals"}) - see local variables\n` +
					`• debug_inspect({action: "stack"}) - view call stack\n` +
					`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression\n` +
					`• debug_control({action: "step_over"}) - continue past exception`;
				break;

			case 'completed':
				message =
					`📋 PROGRAM COMPLETED\n\n` +
					`The program ran to completion without hitting a breakpoint.\n\n` +
					(breakpointResults.length > 0 ? `Breakpoints that were set:\n${breakpointResults.map(r => `  • ${r}`).join('\n')}\n\n` : '') +
					`Possible reasons:\n` +
					`• Breakpoint location was not reached in this execution path\n` +
					`• File or line number was incorrect\n\n` +
					`Output:\n${result.output || '(no output captured)'}`;
				break;

			case 'timeout':
				message =
					`⏰ TIMEOUT\n\n` +
					`Debug session timed out waiting for breakpoint.\n\n` +
					`The program may be stuck or taking too long.\n\n` +
					`Output:\n${result.output || '(no output captured)'}`;
				break;

			case 'failed':
				message =
					`❌ DEBUG SESSION FAILED\n\n` +
					`Error: ${result.error}`;
				break;

			default:
				message = `Unknown status: ${result.status}`;
		}

		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(message)
		]);
	}

	private cleanSourceOutput(output: string): string {
		// Remove PDB prompt and clean up source listing
		return output
			.split('\n')
			.filter(line => !line.match(/^\(Pdb\+*\)\s*$/) && line.trim())
			.join('\n');
	}

	private errorResult(message: string): ExtendedLanguageModelToolResult {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugStartSessionParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Starting debug session for ${options.input.target}`,
		};
	}

	async resolveInput(input: IDebugStartSessionParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugStartSessionParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugStartSessionTool);

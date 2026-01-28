/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { attachJdbSession, getActiveJdbSession, sendJdbCommand, terminateJdbSession } from './jdbSession';

export interface IBreakpointSpec {
	/** Fully qualified or simple class name */
	className: string;
	/** Method name for method-entry breakpoint */
	method?: string;
	/** Line number for line breakpoint */
	line?: number;
}

export interface IDebugStartSessionParams {
	/** Test to run (e.g., "com.example.MyTest#testMethod" or "MyTest#testMethod") */
	test: string;
	/** Initial breakpoints to set before continuing execution */
	initialBreakpoints?: IBreakpointSpec[];
	/** Exception types to catch (e.g., ["NullPointerException", "AssertionError"]) */
	catchExceptions?: string[];
	/** Working directory (defaults to workspace root) */
	workingDir?: string;
	/** Debug port (default: 5005) */
	port?: number;
	/** Timeout in seconds to wait for breakpoint hit (default: 60) */
	timeout?: number;
}

interface DebugSessionResult {
	status: 'breakpoint_hit' | 'exception_caught' | 'test_completed' | 'timeout' | 'failed';
	location?: string;
	thread?: string;
	exceptionType?: string;
	exceptionMessage?: string;
	testPassed?: boolean;
	testOutput?: string;
	error?: string;
}

type BuildSystem = 'maven' | 'gradle' | 'unknown';

// Store reference to test process for cleanup
let activeTestProcess: ChildProcess | null = null;

class DebugStartSessionTool implements ICopilotTool<IDebugStartSessionParams> {
	public static readonly toolName = ToolName.DebugStartSession;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugStartSessionParams>, _token: vscode.CancellationToken) {
		const { 
			test, 
			initialBreakpoints = [], 
			catchExceptions = [],
			workingDir,
			port = 5005,
			timeout = 60
		} = options.input;

		console.log('[DebugStartSessionTool] Starting debug session:', { test, initialBreakpoints, catchExceptions, port, timeout });

		try {
			// Clean up any existing session
			const existingSession = getActiveJdbSession();
			if (existingSession) {
				terminateJdbSession(existingSession.sessionId);
			}
			if (activeTestProcess) {
				activeTestProcess.kill('SIGTERM');
				activeTestProcess = null;
			}

			// Determine working directory - default to /testbed (benchmark workspace)
			const cwd = workingDir || '/testbed';
			console.log('[DebugStartSessionTool] Working directory:', cwd);

			// Step 1: Detect build system (just for running test, not building)
			const buildSystem = this.detectBuildSystem(cwd);
			if (buildSystem === 'unknown') {
				return this.errorResult(
					'Could not detect build system.\n\n' +
					'Expected pom.xml (Maven) or build.gradle/build.gradle.kts (Gradle) in working directory.\n' +
					`Working directory: ${cwd}\n\n` +
					'Make sure the project is built before calling debug_start_session.'
				);
			}

			// Step 2: Start test with debug agent (suspend=y so JVM waits for us)
			// NOTE: Project must already be compiled by main agent
			const testProcess = await this.startTestWithDebug(buildSystem, test, port, cwd);
			if (!testProcess.process) {
				return this.errorResult(`Failed to start test: ${testProcess.error}`);
			}
			activeTestProcess = testProcess.process;

			// Step 3: Wait for debug port to be ready (poll, not fixed sleep!)
			// Use 90 seconds to allow for first-time compilation/dependency download
			const portReady = await this.waitForPort(port, 90000);
			if (!portReady) {
				this.cleanupTestProcess();
				return this.errorResult(
					`Debug port ${port} not ready after 90 seconds.\n\n` +
					`The test may have failed to start or crashed.\n` +
					`Common causes:\n` +
					`- Test class not found (check fully qualified name)\n` +
					`- Compilation errors (run 'mvn compile test-compile' first)\n` +
					`- Port already in use\n\n` +
					`Test output:\n${testProcess.output}`
				);
			}

			// Step 4: Attach JDB
			const sessionId = `jdb-${Date.now()}`;
			const attachResult = await attachJdbSession(sessionId, port, 'localhost', cwd);
			if (!attachResult.success) {
				this.cleanupTestProcess();
				return this.errorResult(`Failed to attach JDB: ${attachResult.error}\n\nOutput: ${attachResult.output}`);
			}

			// Step 5: TWO-STAGE BREAKPOINT APPROACH
			// Stage 1: Set breakpoint on test method itself (GUARANTEED to hit)
			// This ensures we pause inside the test before target classes might finish executing
			const breakpointResults: string[] = [];
			const { testClass, testMethod } = this.parseTestName(test);
			
			let testMethodBpSet = false;
			if (testClass && testMethod) {
				const testBpCmd = `stop in ${testClass}.${testMethod}`;
				const testBpResult = await sendJdbCommand(sessionId, testBpCmd, 2000);
				testMethodBpSet = !testBpResult.output?.includes('Unable') && !testBpResult.output?.includes('not found');
				if (testMethodBpSet) {
					breakpointResults.push(`${testClass}.${testMethod}() [test entry]: set`);
				}
			}

			// Stage 2: Set user's requested breakpoints (may be deferred)
			for (const bp of initialBreakpoints) {
				let cmd: string;
				let desc: string;
				if (bp.method) {
					cmd = `stop in ${bp.className}.${bp.method}`;
					desc = `${bp.className}.${bp.method}()`;
				} else if (bp.line) {
					cmd = `stop at ${bp.className}:${bp.line}`;
					desc = `${bp.className}:${bp.line}`;
				} else {
					continue;
				}
				const result = await sendJdbCommand(sessionId, cmd, 2000);
				const status = result.output?.includes('Deferring') ? 'deferred' : 'set';
				breakpointResults.push(`${desc}: ${status}`);
			}

			// Step 6: Set exception catches
			for (const ex of catchExceptions) {
				await sendJdbCommand(sessionId, `catch ${ex}`, 2000);
				breakpointResults.push(`catch ${ex}: set`);
			}

			// Step 7: Continue and handle two-stage stopping
			let result: DebugSessionResult;
			
			if (testMethodBpSet && initialBreakpoints.length > 0) {
				// Two-stage: First stop at test method, then continue to actual breakpoint
				const stage1Result = await this.waitForBreakpointOrCompletion(sessionId, testProcess, 30000);
				
				if (stage1Result.status === 'breakpoint_hit') {
					// We hit the test method entry - now continue to actual target breakpoint
					// The target classes should now be loaded or about to load
					console.log('[DebugStartSessionTool] Stage 1: Hit test method entry, continuing to target breakpoint...');
					result = await this.waitForBreakpointOrCompletion(sessionId, testProcess, timeout * 1000);
				} else {
					// Test completed or timed out before hitting test method breakpoint
					result = stage1Result;
				}
			} else {
				// Single stage: Just wait for breakpoint or completion
				result = await this.waitForBreakpointOrCompletion(sessionId, testProcess, timeout * 1000);
			}

			// Format and return result
			return this.formatResult(result, breakpointResults, buildSystem);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugStartSessionTool] Error:', errorMessage);
			this.cleanupTestProcess();
			return this.errorResult(`Debug session failed: ${errorMessage}`);
		}
	}

	private cleanupTestProcess(): void {
		if (activeTestProcess) {
			try {
				activeTestProcess.kill('SIGTERM');
			} catch {
				// Ignore cleanup errors
			}
			activeTestProcess = null;
		}
	}

	private detectBuildSystem(cwd: string): BuildSystem {
		if (fs.existsSync(path.join(cwd, 'pom.xml'))) {
			return 'maven';
		}
		if (fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'))) {
			return 'gradle';
		}
		return 'unknown';
	}

	/**
	 * Parse test name into class and method components.
	 * Handles formats like:
	 * - "com.example.MyTest#testMethod"
	 * - "MyTest#testMethod"
	 * - "com.example.MyTest" (class only)
	 */
	private parseTestName(test: string): { testClass: string | null; testMethod: string | null } {
		// Remove any parameters like (String, String)[2]
		const cleanTest = test.replace(/\(.*\)(\[\d+\])?$/, '');
		
		if (cleanTest.includes('#')) {
			const [testClass, testMethod] = cleanTest.split('#');
			return { testClass, testMethod };
		}
		
		// Just class name, no method
		return { testClass: cleanTest, testMethod: null };
	}

	private async startTestWithDebug(
		buildSystem: BuildSystem, 
		test: string, 
		port: number,
		cwd: string
	): Promise<{ process: ChildProcess | null; output: string; error?: string }> {
		return new Promise((resolve) => {
			let cmd: string;
			let args: string[];

			// The key: suspend=y makes JVM wait for debugger before executing any code
			const debugAgent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${port}`;

			if (buildSystem === 'maven') {
				// Maven Surefire - use surefire:test goal to skip compile lifecycle
				// Main agent should have already compiled the project
				cmd = 'mvn';
				args = [
					'surefire:test',  // Direct goal bypasses compile phases
					`-Dtest=${test}`,
					`-Dmaven.surefire.debug=${debugAgent}`,
					'-q' // quiet mode to reduce output noise
				];
			} else if (buildSystem === 'gradle') {
				// Gradle test with debug - use testOnly to skip compilation
				const gradleCmd = fs.existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle';
				cmd = gradleCmd;
				args = [
					'test',
					`--tests=${test}`,
					`--debug-jvm`, // Gradle's built-in debug flag
					'-x', 'compileJava', // Skip compile
					'-x', 'compileTestJava'
				];
			} else {
				resolve({ process: null, output: '', error: 'Unknown build system' });
				return;
			}

			console.log(`[DebugStartSessionTool] Starting: ${cmd} ${args.join(' ')}`);

			let output = '';
			const proc = spawn(cmd, args, { 
				cwd, 
				shell: true,
				env: { ...process.env }
			});

			proc.stdout?.on('data', (data: Buffer) => {
				const text = data.toString();
				output += text;
				console.log(`[DebugStartSessionTool] stdout: ${text.slice(0, 200)}`);
			});

			proc.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				output += text;
				console.log(`[DebugStartSessionTool] stderr: ${text.slice(0, 200)}`);
			});

			proc.on('error', (err) => {
				resolve({ process: null, output, error: err.message });
			});

			// Give it a moment to start, then resolve with the process
			// The JVM will suspend immediately due to suspend=y
			setTimeout(() => {
				resolve({ process: proc, output });
			}, 2000);
		});
	}

	private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
		const startTime = Date.now();
		
		while (Date.now() - startTime < timeoutMs) {
			const isOpen = await this.checkPort(port);
			if (isOpen) {
				console.log(`[DebugStartSessionTool] Port ${port} is ready`);
				return true;
			}
			await this.sleep(500);
		}
		
		console.log(`[DebugStartSessionTool] Port ${port} not ready after ${timeoutMs}ms`);
		return false;
	}

	private checkPort(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = new net.Socket();
			socket.setTimeout(1000);
			
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
			
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
			
			socket.connect(port, 'localhost');
		});
	}

	private async waitForBreakpointOrCompletion(
		sessionId: string,
		testProcess: { process: ChildProcess | null; output: string },
		timeoutMs: number
	): Promise<DebugSessionResult> {
		// Send continue command - this resumes the suspended JVM
		const contResult = await sendJdbCommand(sessionId, 'cont', timeoutMs);
		const output = contResult.output || '';

		// Check for breakpoint hit
		if (output.includes('Breakpoint hit')) {
			const match = output.match(/Breakpoint hit:.*?"thread=([^"]+)".*?(\S+)\(\),\s*line=(\d+)/);
			if (match) {
				return {
					status: 'breakpoint_hit',
					thread: match[1],
					location: `${match[2]}() line ${match[3]}`
				};
			}
			// Try alternative format
			const altMatch = output.match(/Breakpoint hit:.*?(\S+):(\d+)/);
			if (altMatch) {
				return {
					status: 'breakpoint_hit',
					location: `${altMatch[1]}:${altMatch[2]}`
				};
			}
			return {
				status: 'breakpoint_hit',
				location: 'unknown location'
			};
		}

		// Check for exception
		if (output.includes('Exception occurred') || output.includes('exception occurred')) {
			const exMatch = output.match(/Exception occurred:\s*(\S+)/i);
			return {
				status: 'exception_caught',
				exceptionType: exMatch?.[1] || 'unknown',
				exceptionMessage: output.trim()
			};
		}

		// Check for application exit
		if (output.includes('The application exited') || output.includes('application has been disconnected')) {
			const testOutput = testProcess.output;
			const passed = !testOutput.includes('FAILURE') && 
			               !testOutput.includes('FAILED') && 
			               !testOutput.includes('ERROR') && 
			               !testOutput.includes('AssertionError');
			return {
				status: 'test_completed',
				testPassed: passed,
				testOutput: this.truncateOutput(testOutput, 2000)
			};
		}

		// Timeout or other
		return {
			status: 'timeout',
			testOutput: this.truncateOutput(testProcess.output, 2000)
		};
	}

	private truncateOutput(output: string, maxLen: number): string {
		if (output.length <= maxLen) return output;
		return '...' + output.slice(-maxLen);
	}

	private formatResult(
		result: DebugSessionResult, 
		breakpointResults: string[], 
		buildSystem: string
	): ExtendedLanguageModelToolResult {
		let message: string;

		switch (result.status) {
			case 'breakpoint_hit':
				message = 
					`🎯 BREAKPOINT HIT!\n\n` +
					`Location: ${result.location}\n` +
					(result.thread ? `Thread: ${result.thread}\n` : '') +
					(breakpointResults.length > 0 ? `\nBreakpoints configured:\n${breakpointResults.map(r => `  • ${r}`).join('\n')}\n` : '') +
					`\n` +
					`Session is now paused. You can:\n` +
					`• debug_inspect({action: "locals"}) - view local variables\n` +
					`• debug_inspect({action: "eval", expression: "varName"}) - evaluate expression\n` +
					`• debug_inspect({action: "stack"}) - view call stack\n` +
					`• debug_breakpoint({action: "set", className: "X", method: "y"}) - add more breakpoints\n` +
					`• debug_control({action: "step_over"}) - execute next line\n` +
					`• debug_control({action: "step_into"}) - step into method call\n` +
					`• debug_control({action: "continue"}) - run to next breakpoint`;
				break;

			case 'exception_caught':
				message = 
					`⚠️ EXCEPTION CAUGHT!\n\n` +
					`Type: ${result.exceptionType}\n` +
					`${result.exceptionMessage}\n\n` +
					`Session is paused at exception. You can:\n` +
					`• debug_inspect({action: "locals"}) - view variables at exception point\n` +
					`• debug_inspect({action: "stack"}) - view call stack\n` +
					`• debug_inspect({action: "this"}) - view current object`;
				break;

			case 'test_completed':
				message = 
					`📋 TEST COMPLETED ${result.testPassed ? '✅ PASSED' : '❌ FAILED'}\n\n` +
					`No breakpoint was hit - the test ran to completion.\n\n` +
					(breakpointResults.length > 0 ? `Breakpoints that were set:\n${breakpointResults.map(r => `  • ${r}`).join('\n')}\n\n` : '') +
					`Possible reasons:\n` +
					`• Breakpoint location was not reached in this test path\n` +
					`• Class or method name was incorrect\n` +
					`• The breakpoint was deferred but class never loaded\n\n` +
					`Test output:\n${result.testOutput || '(no output captured)'}`;
				break;

			case 'timeout':
				message = 
					`⏰ TIMEOUT\n\n` +
					`Debug session timed out waiting for breakpoint or test completion.\n\n` +
					`The test may be stuck or taking too long.\n\n` +
					`Test output:\n${result.testOutput || '(no output captured)'}`;
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

	private errorResult(message: string): ExtendedLanguageModelToolResult {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugStartSessionParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Starting debug session for ${options.input.test}`,
		};
	}

	async resolveInput(input: IDebugStartSessionParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugStartSessionParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugStartSessionTool);

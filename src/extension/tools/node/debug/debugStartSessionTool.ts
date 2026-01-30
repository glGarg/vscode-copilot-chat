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

			// Step 2: Start test with debug agent and wait for port
			// This handles compilation, port checking, and full output capture in one step
			// Allow 120 seconds for compilation + test startup (large projects can take 2+ minutes)
			const buildTimeoutMs = 120000;
			const testResult = await this.startTestWithDebugAndWaitForPort(buildSystem, test, port, cwd, buildTimeoutMs);
			
			if (!testResult.portReady) {
				if (testResult.process) {
					activeTestProcess = testResult.process;
					this.cleanupTestProcess();
				}
				return this.errorResult(
					`Debug port ${port} not ready after ${buildTimeoutMs / 1000} seconds.\n\n` +
					`${testResult.error || 'The test may have failed to start or crashed.'}\n\n` +
					`Common causes:\n` +
					`- Test class not found (check fully qualified name)\n` +
					`- Compilation errors in source code\n` +
					`- Port already in use\n\n` +
					`Build/test output:\n${testResult.output || '(no output captured)'}`
				);
			}
			
			if (!testResult.process) {
				return this.errorResult(`Failed to start test: ${testResult.error}`);
			}
			activeTestProcess = testResult.process;
			
			// Create testProcess object for waitForBreakpointOrCompletion
			const testProcess = { process: testResult.process, output: testResult.output };

			// Step 3: Attach JDB
			const sessionId = `jdb-${Date.now()}`;
			const attachResult = await attachJdbSession(sessionId, port, 'localhost', cwd);
			if (!attachResult.success) {
				this.cleanupTestProcess();
				return this.errorResult(`Failed to attach JDB: ${attachResult.error}\n\nOutput: ${attachResult.output}`);
			}

			// Step 4: TWO-STAGE BREAKPOINT APPROACH
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

			// If we hit a breakpoint or exception, auto-fetch source code and locals
			let sourceCode = '';
			let localVars = '';
			if (result.status === 'breakpoint_hit' || result.status === 'exception_caught') {
				const [listResult, localsResult] = await Promise.all([
					sendJdbCommand(sessionId, 'list', 2000),
					sendJdbCommand(sessionId, 'locals', 2000)
				]);
				
				// Parse source listing
				if (listResult.output && !listResult.output.includes('not available')) {
					const lines = listResult.output.split('\n')
						.filter(l => l.trim() && !l.includes('main[') && !l.includes('>'));
					sourceCode = lines.join('\n');
				}
				
				// Parse locals
				if (localsResult.output && !localsResult.output.includes('No local variables')) {
					const lines = localsResult.output.split('\n')
						.filter(l => l.trim() && !l.includes('main[') && !l.includes('>'));
					localVars = lines.join('\n');
				}
			}

			// Format and return result
			return this.formatResult(result, breakpointResults, buildSystem, sourceCode, localVars);

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

	/**
	 * Starts the test process with debug agent and waits for either:
	 * 1. Debug port to open (success - ready to attach)
	 * 2. Process to exit (failure - return full output for diagnostics)
	 * 3. Timeout (failure - return captured output so far)
	 */
	private async startTestWithDebugAndWaitForPort(
		buildSystem: BuildSystem, 
		test: string, 
		port: number,
		cwd: string,
		timeoutMs: number
	): Promise<{ process: ChildProcess | null; output: string; portReady: boolean; error?: string }> {
		return new Promise((resolve) => {
			let cmd: string;
			let args: string[];

			// The key: suspend=y makes JVM wait for debugger before executing any code
			const debugAgent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${port}`;

			if (buildSystem === 'maven') {
				// Maven test with debug - allow incremental compilation
				// Maven/Surefire will skip compilation if classes are up-to-date
				// Skip coverage tools (JaCoCo, Cobertura) as they can conflict with debug instrumentation
				cmd = 'mvn';
				args = [
					'test',
					`-Dtest=${test}`,
					`-Dmaven.surefire.debug=${debugAgent}`,
					'-Djacoco.skip=true',      // Skip JaCoCo coverage (often causes instrumentation conflicts)
					'-Dcobertura.skip=true',   // Skip Cobertura coverage
					'-q' // quiet mode to reduce output noise
				];
			} else if (buildSystem === 'gradle') {
				// Gradle test with debug - allow incremental compilation
				// Gradle will skip compilation if classes are up-to-date (very fast)
				const gradleCmd = fs.existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle';
				// Convert JUnit format (Class#method) to Gradle format (Class.method)
				const gradleTestFilter = test.replace('#', '.');
				cmd = gradleCmd;
				args = [
					'test',
					`--tests=${gradleTestFilter}`,
					`--debug-jvm`, // Gradle's built-in debug flag
					'-x', 'jacocoTestReport',      // Skip JaCoCo report generation
					'-x', 'jacocoTestCoverageVerification' // Skip JaCoCo verification
				];
			} else {
				resolve({ process: null, output: '', portReady: false, error: 'Unknown build system' });
				return;
			}

			console.log(`[DebugStartSessionTool] Starting: ${cmd} ${args.join(' ')}`);

			let output = '';
			let resolved = false;
			let processExited = false;
			let exitCode: number | null = null;

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
				if (!resolved) {
					resolved = true;
					resolve({ process: null, output, portReady: false, error: err.message });
				}
			});

			proc.on('exit', (code) => {
				processExited = true;
				exitCode = code;
				console.log(`[DebugStartSessionTool] Process exited with code ${code}`);
				// Don't resolve here - let the port polling handle it
				// This ensures we capture any remaining output
			});

			// Poll for port OR process exit
			const startTime = Date.now();
			const pollInterval = setInterval(async () => {
				if (resolved) {
					clearInterval(pollInterval);
					return;
				}

				// Check if process exited (build failed, test not found, etc.)
				if (processExited) {
					clearInterval(pollInterval);
					resolved = true;
					// Give a moment to capture final output
					await this.sleep(500);
					const errorMsg = exitCode !== 0 
						? `Build/test process exited with code ${exitCode}` 
						: 'Build/test process exited unexpectedly';
					resolve({ process: null, output, portReady: false, error: errorMsg });
					return;
				}

				// Check if port is ready
				const isOpen = await this.checkPort(port);
				if (isOpen) {
					clearInterval(pollInterval);
					resolved = true;
					console.log(`[DebugStartSessionTool] Port ${port} is ready`);
					resolve({ process: proc, output, portReady: true });
					return;
				}

				// Check timeout
				if (Date.now() - startTime > timeoutMs) {
					clearInterval(pollInterval);
					resolved = true;
					console.log(`[DebugStartSessionTool] Timeout after ${timeoutMs}ms`);
					resolve({ process: proc, output, portReady: false, error: 'Timeout waiting for debug port' });
					return;
				}
			}, 500);
		});
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
		buildSystem: string,
		sourceCode: string = '',
		localVars: string = ''
	): ExtendedLanguageModelToolResult {
		let message: string;

		switch (result.status) {
			case 'breakpoint_hit':
				message = 
					`🎯 BREAKPOINT HIT!\n\n` +
					`Location: ${result.location}\n` +
					(result.thread ? `Thread: ${result.thread}\n` : '');
				
				// Add source code if available
				if (sourceCode) {
					message += `\n📄 SOURCE CODE:\n${sourceCode}\n`;
				}
				
				// Add local variables if available
				if (localVars) {
					message += `\n📋 LOCAL VARIABLES:\n${localVars}\n`;
				} else {
					message += `\n📋 LOCAL VARIABLES: (none at this point)\n`;
				}
				
				message += `\nNext steps:\n` +
					`• debug_control({action: "step_over"}) - execute next line\n` +
					`• debug_control({action: "step_into"}) - step into method call\n` +
					`• debug_control({action: "continue"}) - run to next breakpoint\n` +
					`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression\n` +
					`• debug_inspect({action: "stack"}) - view call stack`;
				break;

			case 'exception_caught':
				// Check if this is a setup/reflection exception vs a real test exception
				const isSetupException = result.exceptionType?.includes('NoSuchMethodException') || 
					result.exceptionType?.includes('ClassNotFoundException') ||
					result.exceptionMessage?.includes('ReflectionUtils') ||
					result.exceptionMessage?.includes('surefire');
				
				if (isSetupException) {
					message = 
						`⚠️ TEST SETUP EXCEPTION!\n\n` +
						`Type: ${result.exceptionType}\n` +
						`${result.exceptionMessage}\n\n` +
						`This exception occurred during test discovery/setup, not during test execution.\n` +
						`Common causes:\n` +
						`• Test method name is incorrect or doesn't exist\n` +
						`• Test class wasn't compiled\n` +
						`• Method signature changed\n\n` +
						`The debug session may have ended. You may need to verify the test name and try again.`;
				} else {
					message = 
						`⚠️ EXCEPTION CAUGHT!\n\n` +
						`Type: ${result.exceptionType}\n` +
						`${result.exceptionMessage}\n`;
					
					// Add source code if available
					if (sourceCode) {
						message += `\n📄 SOURCE CODE:\n${sourceCode}\n`;
					}
					
					// Add local variables if available
					if (localVars) {
						message += `\n📋 LOCAL VARIABLES:\n${localVars}\n`;
					}
					
					message += `\nSession is paused at exception. You can:\n` +
						`• debug_inspect({action: "stack"}) - view call stack\n` +
						`• debug_inspect({action: "eval", expression: "expr"}) - evaluate expression\n` +
						`• debug_inspect({action: "this"}) - view current object`;
				}
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

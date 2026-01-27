/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { startJdbSession, attachJdbSession, getActiveJdbSession } from './jdbSession';

export interface IDebugStartParams {
	/** Mode: 'launch' to start new process, 'attach' to connect to running JVM with debug agent */
	mode: 'launch' | 'attach';
	/** Main class to debug (required for launch mode - must have main() method) */
	mainClass?: string;
	/** Debug port (required for attach mode, default: 5005) */
	port?: number;
	/** Host to attach to (default: localhost) */
	host?: string;
	/** Classpath for the application (launch mode only) */
	classpath?: string;
	/** Working directory */
	workingDir?: string;
}

class DebugStartTool implements ICopilotTool<IDebugStartParams> {
	public static readonly toolName = ToolName.DebugStart;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugStartParams>, _token: vscode.CancellationToken) {
		const { mode, mainClass, port = 5005, host = 'localhost', classpath, workingDir } = options.input;

		console.log('[DebugStartTool] Starting debug session:', { mode, mainClass, port, host, classpath, workingDir });

		try {
			// Check if there's already an active session
			const existingSession = getActiveJdbSession();
			if (existingSession) {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify({
						sessionId: existingSession.sessionId,
						status: 'already_active',
						message: `JDB session already active: ${existingSession.sessionId}. Use debug_control action="terminate" first if needed.`
					}, null, 2))
				]);
			}

			if (mode === 'launch') {
				if (!mainClass) {
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							sessionId: null,
							status: 'error',
							message: 'mainClass is required for launch mode. Note: For JUnit tests, use attach mode instead - first run the test with debug agent enabled.'
						}, null, 2))
					]);
				}

				const sessionId = `jdb-${Date.now()}`;
				const result = await startJdbSession(sessionId, mainClass, classpath || '', workingDir);

				if (!result.success) {
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							sessionId: null,
							status: 'error',
							message: `Failed to start JDB: ${result.error}`,
							output: result.output
						}, null, 2))
					]);
				}

				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify({
						sessionId,
						status: 'started',
						message: `JDB session started for ${mainClass}`,
						output: result.output,
						hint: 'Use debug_breakpoint to set breakpoints, then debug_control action="run" to start execution'
					}, null, 2))
				]);

			} else if (mode === 'attach') {
				const sessionId = `jdb-${Date.now()}`;
				
				// Attach to running JVM
				const result = await attachJdbSession(sessionId, port, host, workingDir);

				if (!result.success) {
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							sessionId: null,
							status: 'error',
							message: `Failed to attach JDB to ${host}:${port}: ${result.error}`,
							output: result.output,
							hint: 'Make sure the target JVM is running with debug agent. For Maven: mvn test -Dmaven.surefire.debug. For Gradle: ./gradlew test --debug-jvm'
						}, null, 2))
					]);
				}

				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify({
						sessionId,
						status: 'attached',
						message: `JDB attached to ${host}:${port}`,
						output: result.output,
						hint: 'Use debug_breakpoint to set breakpoints, then debug_control action="continue" to resume execution'
					}, null, 2))
				]);

			} else {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify({
						sessionId: null,
						status: 'error',
						message: `Invalid mode: ${mode}. Use 'launch' for classes with main(), or 'attach' for JUnit tests.`
					}, null, 2))
				]);
			}

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugStartTool] Error:', errorMessage);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					sessionId: null,
					status: 'error',
					message: `Failed to start debug session: ${errorMessage}`
				}, null, 2))
			]);
		}
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugStartParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const mode = options.input.mode;
		const target = mode === 'launch' ? options.input.mainClass : `port ${options.input.port || 5005}`;
		return {
			invocationMessage: `Starting JDB session (${mode}: ${target})`,
		};
	}

	async resolveInput(input: IDebugStartParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugStartParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugStartTool);

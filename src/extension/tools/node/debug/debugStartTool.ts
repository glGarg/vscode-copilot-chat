/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';

export interface IDebugStartParams {
	/** Mode: 'launch' to start new process, 'attach' to connect to running process */
	mode: 'launch' | 'attach';
	/** Main class to debug (required for launch mode) */
	mainClass?: string;
	/** Debug port (required for attach mode) */
	port?: number;
	/** Classpath for the application */
	classpath?: string;
	/** Program arguments */
	args?: string[];
	/** Whether to suspend on start (default: true) */
	suspend?: boolean;
}

interface IDebugSession {
	sessionId: string;
	status: 'started' | 'attached' | 'error';
	message: string;
	jdbProcess?: unknown;
}

// Store active debug sessions
const activeSessions = new Map<string, IDebugSession>();

class DebugStartTool implements ICopilotTool<IDebugStartParams> {
	public static readonly toolName = ToolName.DebugStart;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugStartParams>, _token: vscode.CancellationToken) {
		const { mode, mainClass, port, classpath, args, suspend = true } = options.input;

		console.log('[DebugStartTool] Starting debug session:', { mode, mainClass, port, classpath, args, suspend });

		const sessionId = `debug-${Date.now()}`;
		let jdbCommand: string;
		let resultMessage: string;

		try {
			if (mode === 'launch') {
				if (!mainClass) {
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							sessionId: null,
							status: 'error',
							message: 'mainClass is required for launch mode'
						}, null, 2))
					]);
				}

				// Build JDB launch command
				const classpathArg = classpath ? `-classpath ${classpath}` : '';
				const argsStr = args?.join(' ') || '';
				jdbCommand = `jdb ${classpathArg} ${mainClass} ${argsStr}`.trim();
				resultMessage = `Started JDB debugging session for ${mainClass}`;

			} else if (mode === 'attach') {
				if (!port) {
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							sessionId: null,
							status: 'error',
							message: 'port is required for attach mode'
						}, null, 2))
					]);
				}

				jdbCommand = `jdb -attach ${port}`;
				resultMessage = `Attached JDB to port ${port}`;

			} else {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify({
						sessionId: null,
						status: 'error',
						message: `Invalid mode: ${mode}. Use 'launch' or 'attach'.`
					}, null, 2))
				]);
			}

			// Store session info
			const session: IDebugSession = {
				sessionId,
				status: mode === 'launch' ? 'started' : 'attached',
				message: resultMessage
			};
			activeSessions.set(sessionId, session);

			const result = {
				sessionId,
				status: session.status,
				message: resultMessage,
				jdbCommand,
				instructions: `Debug session initialized. Use the terminal to run: ${jdbCommand}\n` +
					'Then use debug_breakpoint to set breakpoints, debug_control to run/step, and debug_inspect to examine state.'
			};

			console.log('[DebugStartTool] Session created:', result);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);

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
		const target = mode === 'launch' ? options.input.mainClass : `port ${options.input.port}`;
		return {
			invocationMessage: `Starting debug session (${mode}: ${target})`,
		};
	}

	async resolveInput(input: IDebugStartParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugStartParams> {
		return input;
	}
}

// Export for use by other debug tools
export function getDebugSession(sessionId: string): IDebugSession | undefined {
	return activeSessions.get(sessionId);
}

export function setDebugSession(sessionId: string, session: IDebugSession): void {
	activeSessions.set(sessionId, session);
}

ToolRegistry.registerTool(DebugStartTool);

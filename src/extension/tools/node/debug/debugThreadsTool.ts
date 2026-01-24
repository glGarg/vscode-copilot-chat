/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';

export interface IDebugThreadsParams {
	/** Action to perform */
	action: 'list' | 'switch' | 'suspend' | 'resume' | 'stack_all';
	/** Thread ID (for switch/suspend/resume) */
	threadId?: string;
	/** Filter options */
	filter?: {
		state?: 'running' | 'waiting' | 'blocked' | 'all';
		excludeSystem?: boolean;
	};
}

interface IThreadInfo {
	id: string;
	name: string;
	state: string;
	isSuspended: boolean;
	stackSummary?: string;
}

class DebugThreadsTool implements ICopilotTool<IDebugThreadsParams> {
	public static readonly toolName = ToolName.DebugThreads;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugThreadsParams>, _token: vscode.CancellationToken) {
		const { action, threadId, filter } = options.input;
		const excludeSystem = filter?.excludeSystem ?? true;

		console.log('[DebugThreadsTool] Action:', action, { threadId, filter });

		try {
			let jdbCommand: string;
			let message: string;
			let threads: IThreadInfo[] | undefined;

			switch (action) {
				case 'list': {
					jdbCommand = 'threads';
					message = 'Listing all threads. Run "threads" in JDB to see actual thread state.';
					threads = [
						{
							id: 'main',
							name: 'main',
							state: 'running',
							isSuspended: false,
							stackSummary: '<run "threads" in JDB>'
						}
					];
					break;
				}

				case 'switch': {
					if (!threadId) {
						return this.errorResult('threadId is required for switch action');
					}
					jdbCommand = `thread ${threadId}`;
					message = `Switching to thread ${threadId}. Run "thread ${threadId}" in JDB.`;
					break;
				}

				case 'suspend': {
					if (!threadId) {
						return this.errorResult('threadId is required for suspend action');
					}
					jdbCommand = `suspend ${threadId}`;
					message = `Suspending thread ${threadId}. Run "suspend ${threadId}" in JDB.`;
					break;
				}

				case 'resume': {
					if (!threadId) {
						return this.errorResult('threadId is required for resume action');
					}
					jdbCommand = `resume ${threadId}`;
					message = `Resuming thread ${threadId}. Run "resume ${threadId}" in JDB.`;
					break;
				}

				case 'stack_all': {
					jdbCommand = 'where all';
					message = 'Getting stack traces for all threads. Run "where all" in JDB.';
					threads = [
						{
							id: 'main',
							name: 'main',
							state: 'running',
							isSuspended: false,
							stackSummary: '<run "where all" in JDB for full stack traces>'
						}
					];
					break;
				}

				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			const result = {
				jdbCommand,
				message,
				currentThread: 'main',
				threads,
				filter: { excludeSystem },
				instructions: `Execute in JDB terminal: ${jdbCommand}\n` +
					'For multi-threaded debugging:\n' +
					'- Use "threads" to list all threads\n' +
					'- Use "thread <id>" to switch context\n' +
					'- Use "suspend <id>" / "resume <id>" to control individual threads\n' +
					'- Use "where all" to see all thread stacks (useful for deadlock detection)'
			};

			console.log('[DebugThreadsTool] Result:', result);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugThreadsTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ error: message }, null, 2))
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugThreadsParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'list': 'Listing threads',
			'switch': `Switching to thread ${options.input.threadId}`,
			'suspend': `Suspending thread ${options.input.threadId}`,
			'resume': `Resuming thread ${options.input.threadId}`,
			'stack_all': 'Getting all thread stacks'
		};
		return {
			invocationMessage: actionLabels[options.input.action] || `Threads: ${options.input.action}`,
		};
	}

	async resolveInput(input: IDebugThreadsParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugThreadsParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugThreadsTool);

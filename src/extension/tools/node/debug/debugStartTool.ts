/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';
import { startPdbSession, getActivePdbSession, terminatePdbSession } from './pdbSession';

export interface IDebugStartParams {
	/** Python script path to debug */
	script?: string;
	/** Module to debug (alternative to script, uses -m flag) */
	module?: string;
	/** Arguments to pass to the script/module */
	args?: string[];
	/** Working directory */
	workingDir?: string;
}

class DebugStartTool implements ICopilotTool<IDebugStartParams> {
	public static readonly toolName = ToolName.DebugStart;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugStartParams>, _token: vscode.CancellationToken) {
		const { script, module, args = [], workingDir } = options.input;

		console.log('[DebugStartTool] Starting debug session:', { script, module, args, workingDir });

		try {
			// Check if there's already an active session
			const existingSession = getActivePdbSession();
			if (existingSession) {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(
						`⚠️ PDB SESSION ALREADY ACTIVE\n\n` +
						`Session: ${existingSession.sessionId}\n\n` +
						`To start a new session, first terminate the current one:\n` +
						`debug_control({action: "quit"})`
					)
				]);
			}

			if (!script && !module) {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(
						`❌ ERROR: Either 'script' or 'module' is required.\n\n` +
						`Examples:\n` +
						`• debug_start({script: "main.py"})\n` +
						`• debug_start({module: "mypackage.cli"})\n` +
						`• debug_start({script: "test_example.py", args: ["--verbose"]})`
					)
				]);
			}

			// Determine target - script or module
			const target = module ? `-m ${module}` : script!;
			const sessionId = `pdb-${Date.now()}`;

			const result = await startPdbSession(sessionId, target, args, workingDir);

			if (!result.success) {
				return new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(
						`❌ FAILED TO START PDB\n\n` +
						`Target: ${target}\n` +
						`Error: ${result.error}\n\n` +
						`Output:\n${result.output || '(no output)'}\n\n` +
						`Common causes:\n` +
						`• Script or module not found\n` +
						`• Python syntax error in the code\n` +
						`• Missing dependencies`
					)
				]);
			}

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(
					`✅ PDB SESSION STARTED\n\n` +
					`Target: ${target}\n` +
					`Session: ${sessionId}\n\n` +
					`PDB is paused at the first line of execution.\n\n` +
					`Next steps:\n` +
					`1. Set breakpoints: debug_breakpoint({action: "set", file: "module.py", line: 42})\n` +
					`2. Continue execution: debug_control({action: "continue"})\n` +
					`3. Or step through: debug_control({action: "step_over"})\n` +
					`4. Inspect variables: debug_inspect({action: "locals"})\n\n` +
					`Initial output:\n${result.output || '(PDB ready)'}`
				)
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugStartTool] Error:', errorMessage);

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(`❌ ERROR: Failed to start debug session: ${errorMessage}`)
			]);
		}
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugStartParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const target = options.input.module ? `module ${options.input.module}` : options.input.script || 'unknown';
		return {
			invocationMessage: `Starting PDB for ${target}`,
		};
	}

	async resolveInput(input: IDebugStartParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugStartParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugStartTool);

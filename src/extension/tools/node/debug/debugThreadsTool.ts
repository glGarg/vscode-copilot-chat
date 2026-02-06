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

export interface IDebugFramesParams {
	/** Action to perform */
	action: 'up' | 'down' | 'frame' | 'where' | 'list_frames';
	/** Frame number (for 'frame' action) */
	frameNumber?: number;
	/** Number of levels to move (for 'up' and 'down', default: 1) */
	levels?: number;
}

class DebugFramesTool implements ICopilotTool<IDebugFramesParams> {
	public static readonly toolName = ToolName.DebugThreads;  // Reusing the same tool name for backwards compatibility

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugFramesParams>, _token: vscode.CancellationToken) {
		const { action, frameNumber, levels = 1 } = options.input;

		console.log('[DebugFramesTool] Action:', action, { frameNumber, levels });

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
			let pdbCommand: string;
			let message: string;

			switch (action) {
				case 'up': {
					// Move up N frames in the stack (toward caller)
					// PDB 'u' moves up one frame, we can repeat it
					const commands: string[] = [];
					for (let i = 0; i < levels; i++) {
						commands.push('u');
					}
					// Execute all up commands
					let output = '';
					for (const cmd of commands) {
						const result = await sendPdbCommand(session.sessionId, cmd, 2000);
						output = result.output || '';
						if (output.includes('Oldest frame') || output.includes('Bottom of stack')) {
							break;  // Can't go further up
						}
					}
					
					// Get current location after moving
					const whereResult = await sendPdbCommand(session.sessionId, 'w', 2000);
					
					message = `⬆️ MOVED UP ${levels} FRAME(S)\n\n` +
						`${output}\n\n` +
						`Current stack:\n${this.cleanPdbOutput(whereResult.output || '')}`;
					break;
				}

				case 'down': {
					// Move down N frames in the stack (toward callee)
					const commands: string[] = [];
					for (let i = 0; i < levels; i++) {
						commands.push('d');
					}
					// Execute all down commands
					let output = '';
					for (const cmd of commands) {
						const result = await sendPdbCommand(session.sessionId, cmd, 2000);
						output = result.output || '';
						if (output.includes('Newest frame') || output.includes('Top of stack')) {
							break;  // Can't go further down
						}
					}
					
					// Get current location after moving
					const whereResult = await sendPdbCommand(session.sessionId, 'w', 2000);
					
					message = `⬇️ MOVED DOWN ${levels} FRAME(S)\n\n` +
						`${output}\n\n` +
						`Current stack:\n${this.cleanPdbOutput(whereResult.output || '')}`;
					break;
				}

				case 'frame': {
					if (frameNumber === undefined) {
						return this.errorResult('frameNumber is required for "frame" action');
					}
					// PDB doesn't have a direct "go to frame N" command
					// We need to go to the bottom and count up
					// First, get current stack to know how many frames
					const whereResult = await sendPdbCommand(session.sessionId, 'w', 2000);
					
					message = `📍 FRAME NAVIGATION\n\n` +
						`PDB doesn't support direct frame jumping. Use:\n` +
						`• debug_frames({action: "up"}) - move toward caller\n` +
						`• debug_frames({action: "down"}) - move toward current execution\n\n` +
						`Current stack:\n${this.cleanPdbOutput(whereResult.output || '')}`;
					break;
				}

				case 'where':
				case 'list_frames': {
					// Show full stack trace
					pdbCommand = 'w';
					const result = await sendPdbCommand(session.sessionId, pdbCommand, 2000);
					const output = result.output || '';
					
					// Parse and format the stack trace
					const cleanOutput = this.cleanPdbOutput(output);
					const frames = cleanOutput.split('\n').filter(l => l.trim());
					
					message = `📚 CALL STACK (${frames.length} frames):\n\n`;
					frames.forEach((frame, index) => {
						// Current frame is marked with '>' in PDB
						const isCurrent = frame.includes('>') || frame.startsWith('>');
						message += `${isCurrent ? '→ ' : '  '}${index + 1}. ${frame.trim()}\n`;
					});
					
					message += `\nNavigation:\n` +
						`• debug_frames({action: "up"}) - move to caller frame\n` +
						`• debug_frames({action: "down"}) - move to callee frame\n` +
						`• debug_inspect({action: "locals"}) - see variables in current frame`;
					break;
				}

				default:
					return this.errorResult(`Unknown action: ${action}`);
			}

			return new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(message)
			]);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[DebugFramesTool] Error:', errorMessage);
			return this.errorResult(errorMessage);
		}
	}

	private cleanPdbOutput(output: string): string {
		return output
			.split('\n')
			.filter(l => !l.match(/^\(Pdb\+*\)\s*$/))
			.join('\n')
			.trim();
	}

	private errorResult(message: string) {
		return new ExtendedLanguageModelToolResult([
			new LanguageModelTextPart(`❌ ERROR: ${message}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugFramesParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const actionLabels: Record<string, string> = {
			'up': `Moving up ${options.input.levels || 1} frame(s)`,
			'down': `Moving down ${options.input.levels || 1} frame(s)`,
			'frame': `Going to frame ${options.input.frameNumber}`,
			'where': 'Showing stack trace',
			'list_frames': 'Listing all frames'
		};
		return {
			invocationMessage: actionLabels[options.input.action] || `Frames: ${options.input.action}`,
		};
	}

	async resolveInput(input: IDebugFramesParams, _promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugFramesParams> {
		return input;
	}
}

ToolRegistry.registerTool(DebugFramesTool);

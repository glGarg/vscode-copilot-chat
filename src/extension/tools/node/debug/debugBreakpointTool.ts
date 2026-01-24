/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { LanguageModelTextPart, ExtendedLanguageModelToolResult } from '../../../../vscodeTypes';

export interface IDebugBreakpointParams {
	/** Action to perform */
	action: 'set' | 'remove' | 'list' | 'enable' | 'disable';
	/** Class name for the breakpoint location */
	className?: string;
	/** Line number for the breakpoint */
	line?: number;
	/** Method name (alternative to line number) */
	method?: string;
	/** Conditional expression for the breakpoint */
	condition?: string;
	/** Break only after N hits */
	hitCount?: number;
	/** Breakpoint ID (for remove/enable/disable) */
	breakpointId?: string;
}

interface IBreakpoint {
	id: string;
	className: string;
	line?: number;
	method?: string;
	condition?: string;
	enabled: boolean;
	hitCount: number;
}

// Store breakpoints (in real implementation, would sync with JDB)
const breakpoints = new Map<string, IBreakpoint>();
let breakpointCounter = 0;

class DebugBreakpointTool implements ICopilotTool<IDebugBreakpointParams> {
	public static readonly toolName = ToolName.DebugBreakpoint;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugBreakpointParams>, _token: vscode.CancellationToken) {
		const { action, className, line, method, condition, hitCount, breakpointId } = options.input;

		console.log('[DebugBreakpointTool] Action:', action, { className, line, method, condition, hitCount, breakpointId });

		try {
			switch (action) {
				case 'set': {
					if (!className) {
						return this.errorResult('className is required to set a breakpoint');
					}
					if (!line && !method) {
						return this.errorResult('Either line or method is required to set a breakpoint');
					}

					const id = `bp-${++breakpointCounter}`;
					const bp: IBreakpoint = {
						id,
						className,
						line,
						method,
						condition,
						enabled: true,
						hitCount: hitCount || 0
					};
					breakpoints.set(id, bp);

					// Generate JDB command
					let jdbCommand: string;
					if (line) {
						jdbCommand = condition
							? `stop at ${className}:${line} if ${condition}`
							: `stop at ${className}:${line}`;
					} else {
						jdbCommand = condition
							? `stop in ${className}.${method} if ${condition}`
							: `stop in ${className}.${method}`;
					}

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							breakpointId: id,
							jdbCommand,
							message: `Breakpoint set at ${className}:${line || method}${condition ? ` (condition: ${condition})` : ''}`,
							breakpoint: bp
						}, null, 2))
					]);
				}

				case 'remove': {
					if (!breakpointId) {
						return this.errorResult('breakpointId is required to remove a breakpoint');
					}
					const bp = breakpoints.get(breakpointId);
					if (!bp) {
						return this.errorResult(`Breakpoint ${breakpointId} not found`);
					}
					breakpoints.delete(breakpointId);

					const jdbCommand = bp.line
						? `clear ${bp.className}:${bp.line}`
						: `clear ${bp.className}.${bp.method}`;

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							jdbCommand,
							message: `Breakpoint ${breakpointId} removed`
						}, null, 2))
					]);
				}

				case 'list': {
					const allBreakpoints = Array.from(breakpoints.values());
					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							breakpoints: allBreakpoints,
							count: allBreakpoints.length,
							jdbCommand: 'stop'
						}, null, 2))
					]);
				}

				case 'enable':
				case 'disable': {
					if (!breakpointId) {
						return this.errorResult(`breakpointId is required to ${action} a breakpoint`);
					}
					const bp = breakpoints.get(breakpointId);
					if (!bp) {
						return this.errorResult(`Breakpoint ${breakpointId} not found`);
					}
					bp.enabled = action === 'enable';

					return new ExtendedLanguageModelToolResult([
						new LanguageModelTextPart(JSON.stringify({
							message: `Breakpoint ${breakpointId} ${action}d`,
							breakpoint: bp
						}, null, 2))
					]);
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
			new LanguageModelTextPart(JSON.stringify({ error: message }, null, 2))
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

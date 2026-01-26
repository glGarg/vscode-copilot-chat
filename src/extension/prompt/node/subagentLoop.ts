/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelChat, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart, LanguageModelTextPart, LanguageModelToolResult2 } from '../../../vscodeTypes';
import { getAgentTools } from '../../intents/node/agentIntent';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { AgentPrompt } from '../../prompts/node/agent/agentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { IToolsService } from '../../tools/common/toolsService';
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface ISubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
	/** Optional: if provided, only these tools will be available to the subagent */
	allowedTools?: Set<ToolName>;
	/** Optional: custom prompt class to use instead of AgentPrompt */
	customPromptClass?: PromptElementCtor;
}

export class SubagentToolCallingLoop extends ToolCallingLoop<ISubagentToolCallingLoopOptions> {

	public static readonly ID = 'subagent';

	constructor(
		options: ISubagentToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		
		// Log tool results available in context
		if (context.toolCallResults && Object.keys(context.toolCallResults).length > 0) {
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			this._logService.info('[SubagentToolCallingLoop] TOOL RESULTS AVAILABLE IN CONTEXT');
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			for (const [toolCallId, result] of Object.entries(context.toolCallResults)) {
				this._logService.info(`[SubagentToolCallingLoop] Tool Call ID: ${toolCallId}`);
				if (result instanceof LanguageModelToolResult2) {
					this._logService.info(`[SubagentToolCallingLoop]   Content parts: ${result.content.length}`);
					result.content.forEach((part, idx) => {
						if (part instanceof LanguageModelTextPart) {
							this._logService.info(`[SubagentToolCallingLoop]   Part ${idx + 1}: Text (length: ${part.value.length})`);
							this._logService.info(`[SubagentToolCallingLoop]   Full text:`, part.value);
						} else {
							this._logService.info(`[SubagentToolCallingLoop]   Part ${idx + 1}: ${part.constructor.name}`);
						}
					});
				} else {
					this._logService.info(`[SubagentToolCallingLoop]   Result type: ${typeof result}`);
					this._logService.info(`[SubagentToolCallingLoop]   Result:`, result);
				}
			}
			this._logService.info('[SubagentToolCallingLoop] ========================================');
		}
		
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				inSubAgent: true
			};
		}
		context.query = this.options.promptText;
		context.chatVariables = new ChatVariablesCollection();
		// Only clear conversation if using default AgentPrompt (no custom prompt class)
		if (!this.options.customPromptClass) {
			context.conversation = undefined;
		}
		return context;
	}

	private async logAvailableModels() {
		try {
			// Log all available chat endpoints
			const allEndpoints = await this.endpointProvider.getAllChatEndpoints();
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			this._logService.info('[SubagentToolCallingLoop] Available chat endpoints:');
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			for (const ep of allEndpoints) {
				this._logService.info(`[SubagentToolCallingLoop]   - ${ep.model} (family: ${ep.family}, toolCalls: ${ep.supportsToolCalls}, vendor: ${ep.isExtensionContributed ? 'extension' : 'copilot'})`);
			}
			this._logService.info('[SubagentToolCallingLoop] ========================================');
		} catch (error) {
			this._logService.warn('[SubagentToolCallingLoop] Failed to list available models:', error);
		}
	}

	private async getEndpoint(request: ChatRequest) {
		// Log available models for debugging
		await this.logAvailableModels();

		// Use the same model as the main agent request
		// This ensures the subagent uses whatever model the user has selected (e.g., gpt-5)
		const requestModel = request.model;
		
		this._logService.info('[SubagentToolCallingLoop] Using same model as main request:', JSON.stringify({
			vendor: requestModel.vendor,
			id: requestModel.id,
			name: requestModel.name,
			family: requestModel.family,
			hasCapabilities: !!requestModel.capabilities,
			supportsToolCalling: requestModel.capabilities?.supportsToolCalling
		}, null, 2));
		
		try {
			// Pass the request's model directly to getChatEndpoint
			const endpoint = await this.endpointProvider.getChatEndpoint(requestModel);
			
			this._logService.info('[SubagentToolCallingLoop] Successfully selected endpoint:', {
				modelId: requestModel.id,
				modelVendor: requestModel.vendor,
				endpointModel: endpoint.model,
				endpointFamily: endpoint.family,
				supportsToolCalls: endpoint.supportsToolCalls,
				supportsVision: endpoint.supportsVision,
				isExtensionContributed: endpoint.isExtensionContributed
			});
			
			if (!endpoint.supportsToolCalls) {
				const errorMsg = `Selected model ${requestModel.id} does not support tool calls, which is required for subagent`;
				this._logService.error(`[SubagentToolCallingLoop] ${errorMsg}`);
				throw new Error(errorMsg);
			}
			
			return endpoint;
		} catch (error) {
			// Log full error details and throw instead of falling back
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			this._logService.error('[SubagentToolCallingLoop] FAILED TO GET ENDPOINT');
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			this._logService.error('[SubagentToolCallingLoop] Request model:', JSON.stringify({ id: requestModel.id, vendor: requestModel.vendor }, null, 2));
			this._logService.error('[SubagentToolCallingLoop] Error type:', error?.constructor?.name);
			this._logService.error('[SubagentToolCallingLoop] Error message:', error instanceof Error ? error.message : String(error));
			this._logService.error('[SubagentToolCallingLoop] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			throw new Error(`Failed to get endpoint for subagent with model ${modelSelector.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	protected async buildPrompt(promptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint(this.options.request);
		const PromptClass = (this.options.customPromptClass ?? AgentPrompt) as typeof AgentPrompt;
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			PromptClass,
			{
				endpoint,
				promptContext: promptContext,
				location: this.options.location,
				enableCacheBreakpoints: false,
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const allTools = await this.instantiationService.invokeFunction(getAgentTools, this.options.request);

		if (this.options.allowedTools) {
			// If allowedTools is specified, get those tools directly from toolsService
			// This bypasses the "enabled" check to allow debug tools that aren't in the tool picker
			const toolsService = this.instantiationService.invokeFunction(accessor => accessor.get<IToolsService>(IToolsService));
			const tools: LanguageModelToolInformation[] = [];
			
			for (const toolName of this.options.allowedTools) {
				// First try to get from allTools (already filtered/enabled tools)
				const fromAllTools = allTools.find(t => t.name === toolName);
				if (fromAllTools) {
					tools.push(fromAllTools);
				} else {
					// If not in allTools, try to get directly from toolsService
					const directTool = toolsService.getTool(toolName);
					if (directTool) {
						tools.push(directTool);
					} else {
						this._logService.warn(`[SubagentToolCallingLoop] Tool ${toolName} not found in toolsService`);
					}
				}
			}
			
			return tools;
		} else {
			// Default behavior: exclude certain tools
			const excludedTools = new Set([ToolName.CoreRunSubagent, ToolName.CoreManageTodoList]);
			return allTools
				.filter(tool => !excludedTools.has(tool.name as ToolName))
				// TODO can't do virtual tools at this level
				.slice(0, 128);
		}
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest2({
			debugName: SubagentToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			requestOptions: {
				...(requestOptions ?? {}),
				temperature: 0,
				tools: normalizeToolSchema(
					endpoint.family,
					requestOptions?.tools,
					(tool, rule) => {
						this._logService.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
			},
			// This loop is inside a tool called from another request, so never user initiated
			userInitiatedRequest: false,
			telemetryProperties: {
				messageId: randomUUID(),
				messageSource: SubagentToolCallingLoop.ID
			},
		}, token);
	}
}

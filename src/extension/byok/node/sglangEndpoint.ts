/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Custom endpoint for SGLang and other local OpenAI-compatible servers.
 * Key differences from OpenAIEndpoint:
 * 1. Preserves max_tokens to prevent unlimited response generation
 * 2. Converts "tool" role messages to "user" role (sglang/vLLM don't support tool role)
 * 3. Adds "tool_choice: required" for Qwen models to ensure tool use
 * 4. Extensive logging for debugging
 */
export class SGLangEndpoint extends OpenAIEndpoint {
	constructor(
		_modelMetadata: IChatModelInformation,
		_apiKey: string,
		_modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(
			_modelMetadata,
			_apiKey,
			_modelUrl,
			fetcherService,
			domainService,
			capiClientService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			logService
		);
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options);
		
		this.logService.error(`[SGLangEndpoint] === REQUEST BODY BEFORE TOOL MESSAGE CONVERSION ===`);
		this.logService.error(`[SGLangEndpoint] Messages count: ${body.messages?.length || 0}`);
		this.logService.error(`[SGLangEndpoint] Tools count: ${body.tools?.length || 0}`);
		
		// Log message summaries
		if (body.messages) {
			body.messages.forEach((m: any, idx: number) => {
				const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
				this.logService.warn(`[SGLangEndpoint] Message ${idx}: role=${m.role}, length=${content.length}, preview="${content.substring(0, 150).replace(/\n/g, ' ')}..."`);
			});
		}
		
		// Convert "tool" role messages to "user" role
		// SGLang/vLLM don't support the "tool" role for tool call results
		if (body.messages) {
			let convertedCount = 0;
			body.messages = body.messages.map(msg => {
				if (typeof msg === 'object' && 'role' in msg && msg.role === 'tool') {
					convertedCount++;
					// Convert tool message to user message format
					const toolCallId = ('tool_call_id' in msg) ? msg.tool_call_id : 'unknown';
					const content = ('content' in msg) ? msg.content : '';
					
					this.logService.warn(`[SGLangEndpoint] Converting tool message to user message (tool_call_id: ${toolCallId}, content length: ${typeof content === 'string' ? content.length : 'N/A'})`);
					
					return {
						role: 'user',
						content: `Tool call result (id: ${toolCallId}):\n${content}`
					};
				}
				return msg;
			});
			
			if (convertedCount > 0) {
				this.logService.error(`[SGLangEndpoint] ✓ Converted ${convertedCount} tool messages to user messages`);
			}
		}
		
		this.logService.error(`[SGLangEndpoint] === REQUEST BODY AFTER TOOL MESSAGE CONVERSION ===`);
		
		return body;
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		this.logService.error(`[SGLangEndpoint] === INTERCEPT BODY START ===`);
		this.logService.warn(`[SGLangEndpoint] Original body: ${JSON.stringify({
			max_tokens: body?.max_tokens,
			temperature: body?.temperature,
			tools: body?.tools?.length || 0,
			messages: body?.messages?.length || 0
		}, null, 2)}`);
		
		// Call parent's interceptBody but skip the final step
		// We need to replicate the logic but preserve max_tokens
		if (body?.tools?.length === 0) {
			delete body.tools;
			this.logService.warn(`[SGLangEndpoint] Removed empty tools array`);
		}

		if (body?.tools) {
			body.tools = body.tools.map(tool => {
				if ('function' in tool && tool.function.parameters === undefined) {
					tool.function.parameters = { type: "object", properties: {} };
				}
				return tool;
			});
			
			// Add "tool_choice: required" for Qwen models to ensure they use tools
			// This is critical for Qwen models to properly engage with tool calling
			if (body.tools.length > 0) {
				body.tool_choice = 'required';
				this.logService.error(`[SGLangEndpoint] ✓ Added tool_choice=required for request with ${body.tools.length} tools`);
				this.logService.warn(`[SGLangEndpoint] Tool names: ${body.tools.map((t: any) => t.function?.name || 'unknown').join(', ')}`);
			}
		}

		if (body) {
			if (this.modelMetadata.capabilities.supports.thinking) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
				this.logService.warn(`[SGLangEndpoint] Thinking mode: set max_completion_tokens=${body['max_completion_tokens']}`);
			} else {
				// For SGLang/local models: ALWAYS enforce max_tokens to prevent unlimited generation
				// Force it to maxOutputTokens regardless of what VSCode set
				const maxOutputTokens = this.modelMetadata.capabilities.limits.max_output_tokens || 1024;
				const originalMaxTokens = body.max_tokens;
				body.max_tokens = maxOutputTokens;
				body['max_new_tokens'] = maxOutputTokens;  // SGLang prefers this parameter
				
				this.logService.error(`[SGLangEndpoint] ⚠️ ENFORCING TOKEN LIMITS ⚠️`);
				this.logService.error(`[SGLangEndpoint]   Original max_tokens: ${originalMaxTokens}`);
				this.logService.error(`[SGLangEndpoint]   New max_tokens: ${maxOutputTokens}`);
				this.logService.error(`[SGLangEndpoint]   New max_new_tokens: ${maxOutputTokens}`);
			}
			
			if (!this.useResponsesApi && body.stream) {
				body['stream_options'] = { 'include_usage': true };
			}
		}
		
		this.logService.error(`[SGLangEndpoint] === FINAL REQUEST BODY TO BE SENT ===`);
		this.logService.error(`[SGLangEndpoint] ${JSON.stringify({
			model: body?.model,
			max_tokens: body?.max_tokens,
			max_new_tokens: body?.['max_new_tokens'],
			temperature: body?.temperature,
			tool_choice: body?.tool_choice,
			tools_count: body?.tools?.length || 0,
			messages_count: body?.messages?.length || 0,
			stream: body?.stream
		}, null, 2)}`);
	}

	override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		this.logService.error(`[SGLangEndpoint] === MAKING CHAT REQUEST ===`);
		const response = await super.makeChatRequest2(options, token);
		
		this.logService.error(`[SGLangEndpoint] === RESPONSE RECEIVED ===`);
		this.logService.error(`[SGLangEndpoint] Response type: ${response.type}`);
		
		if ('value' in response) {
			this.logService.error(`[SGLangEndpoint] Response value length: ${typeof response.value === 'string' ? response.value.length : 'N/A'}`);
			this.logService.warn(`[SGLangEndpoint] Response preview: ${typeof response.value === 'string' ? response.value.substring(0, 200) : 'N/A'}`);
		}
		
		if ('reason' in response) {
			this.logService.error(`[SGLangEndpoint] ⚠️ Response reason: ${response.reason}`);
		}
		
		if ('truncatedValue' in response) {
			this.logService.error(`[SGLangEndpoint] ⚠️ Response was truncated! Length: ${typeof response.truncatedValue === 'string' ? response.truncatedValue.length : 'N/A'}`);
		}
		
		this.logService.warn(`[SGLangEndpoint] Full response: ${JSON.stringify(response, null, 2).substring(0, 1000)}`);
		
		return response;
	}
}

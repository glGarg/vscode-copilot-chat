/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
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
		
		// Convert "tool" role messages to "user" role
		// SGLang/vLLM don't support the "tool" role for tool call results
		if (body.messages) {
			body.messages = body.messages.map(msg => {
				if (typeof msg === 'object' && 'role' in msg && msg.role === 'tool') {
					// Convert tool message to user message format
					const toolCallId = ('tool_call_id' in msg) ? msg.tool_call_id : 'unknown';
					const content = ('content' in msg) ? msg.content : '';
					
					this.logService.info(`[SGLangEndpoint] Converting tool message to user message (tool_call_id: ${toolCallId})`);
					
					return {
						role: 'user',
						content: `Tool call result (id: ${toolCallId}):\n${content}`
					};
				}
				return msg;
			});
		}
		
		return body;
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		// Call parent's interceptBody but skip the final step
		// We need to replicate the logic but preserve max_tokens
		if (body?.tools?.length === 0) {
			delete body.tools;
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
				this.logService.info(`[SGLangEndpoint] Added tool_choice=required for request with ${body.tools.length} tools`);
			}
		}

		if (body) {
			if (this.modelMetadata.capabilities.supports.thinking) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
			} else {
				// For SGLang/local models: preserve max_tokens to prevent unlimited generation
				// Calculate a reasonable max_tokens based on maxOutputTokens
				if (body.max_tokens === undefined || body.max_tokens === null) {
					// Use the model's maxOutputTokens configuration
					const maxOutputTokens = this.modelMetadata.capabilities.limits.max_output_tokens;
					if (maxOutputTokens) {
						body.max_tokens = maxOutputTokens;
						this.logService.info(`[SGLangEndpoint] Setting max_tokens to ${maxOutputTokens} for model ${this.modelMetadata.id}`);
					}
				}
			}
			
			if (!this.useResponsesApi && body.stream) {
				body['stream_options'] = { 'include_usage': true };
			}
		}
	}
}

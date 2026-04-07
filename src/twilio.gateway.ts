import type { IncomingMessage } from 'http';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Injectable, Inject } from '@nestjs/common';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer as NativeWebSocketServer } from 'ws';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { TwilioAudioProcessor } from './types/twilio-audio-processor';
import { createFunctionMap, type ScheduleAppointmentParams } from './config/function-map';
import { VoiceAgentCrmBackTranscriptService } from './voice-agent-crm-back-transcript.service';

type CrmBackEventSourceType = 'ws_ms_events' | 'voice_agent_ms_events';

interface CrmBackEventPayload {
  readonly type: CrmBackEventSourceType;
  readonly payload: Record<string, unknown>;
}

@Injectable()
@WebSocketGateway({ path: '/twilio' })
export class TwilioGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly agentConfigTemplate: Record<string, unknown>;
  private readonly deepgramApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
    private readonly crmBackTranscriptService: VoiceAgentCrmBackTranscriptService,
  ) {
    const deepgramApiKey = this.configService.get<string>('DEEPGRAM_API_KEY');
    if (!deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }
    this.deepgramApiKey = deepgramApiKey;

    // Loaded once on startup (same behavior as Express server).
    const configPath = path.join(process.cwd(), 'config_lotes.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    this.agentConfigTemplate = JSON.parse(configData);
  }

  /** Nest `ws` adapter: fired once per new client on this gateway path (before message handlers attach). */
  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    this.onTwilioConnectionNew(client, request);
  }

  afterInit(server: NativeWebSocketServer): void {
    // Twilio connects here as a raw `ws` client.
    server.on('connection', (ws: WebSocket) => {
      const connectionTimeout = setTimeout(() => {
        console.log('⏰ WebSocket connection timeout');
        ws.close();
      }, 30000);

      void this.handleTwilioConnection(ws, connectionTimeout);
    });

    server.on('error', (error: unknown) => {
      console.error('❌ WebSocket server error:', error);
    });
  }

  private onTwilioConnectionNew(ws: WebSocket, request?: IncomingMessage): void {
    const remote = request?.socket?.remoteAddress ?? 'unknown';
    const url = request?.url ?? '';
    console.log('🔌 New Twilio WebSocket connection', {
      remote,
      url,
      readyState: ws.readyState,
    });
  }

  private async emitCallCompletedSuccessfullyToCrm(
    input: Readonly<{ flowId: string; userId: string; customer_id?: string }>,
  ): Promise<void> {
    if (input.flowId.trim().length === 0 || input.userId.trim().length === 0) {
      console.warn(
        'TwilioGateway: skipping call.completed_successfully emit due to missing flowId or userId',
        input,
      );
      return;
    }
    // Emitted into monolith to advance the onboarding flow.
    console.info(
      '🔔 Emitting call.completed_successfully event to CRM Back:',
      JSON.stringify(input, null, 2),
    );
    const event: CrmBackEventPayload = {
      type: 'voice_agent_ms_events',
      payload: {
        action: 'call.completed_successfully',
        flowId: input.flowId,
        userId: input.userId,
        customer_id: input.customer_id,
      },
    };

    await lastValueFrom(this.crmBackQueueClient.emit('voice_agent_ms_event', event));
  }

  /**
   * Frees the Twilio caller-ID pool row when the media stream ends (hangup, error, timeout).
   * Idempotent with `call.completed_successfully` (monolith release is per flowId).
   */
  private async emitVoiceConnectionClosedToCrm(flowId: string | undefined): Promise<void> {
    if (flowId == null || flowId.length === 0) return;
    try {
      await lastValueFrom(
        this.crmBackQueueClient.emit('voice_agent_ms_event', {
          type: 'voice_agent_ms_events',
          payload: {
            action: 'call.voice_connection_closed',
            flowId,
          },
        } as CrmBackEventPayload),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('TwilioGateway: emitVoiceConnectionClosedToCrm failed', message);
    }
  }

  private formatTranscriptFromSegments(
    segments: ReadonlyArray<{ readonly role: string; readonly content: string }>,
  ): string {
    return segments.map((s) => `${s.role}: ${s.content}`).join('\n\n');
  }

  private async emitCallTranscriptIfNeeded(callContext: {
    flowId?: string;
    customer_id?: string;
    callSid?: string;
    transcriptSegments: Array<{ role: string; content: string }>;
    transcriptSentToCrm: boolean;
  }): Promise<void> {
    if (callContext.transcriptSentToCrm) return;
    const flowId = callContext.flowId;
    const userId = callContext.customer_id;
    if (!flowId || !userId) return;

    const segments = callContext.transcriptSegments;
    const transcript = this.formatTranscriptFromSegments(segments);

    await this.crmBackTranscriptService.emitCallTranscriptComplete({
      flowId,
      userId,
      customer_id: userId,
      callSid: callContext.callSid,
      transcript,
      segments,
    });
    callContext.transcriptSentToCrm = true;
  }

  private isGoodbyeText(text: string | undefined): boolean {
    const t = (text ?? '').toLowerCase();
    // Heuristic: detect common Spanish farewell fragments.
    return (
      t.includes('adiós') ||
      t.includes('adios') ||
      t.includes('hasta luego') ||
      t.includes('hasta pronto') ||
      t.includes('feliz dia') ||
      t.includes('feliz día') ||
      t.includes('que tengas') ||
      (t.includes('gracias') && (t.includes('tiempo') || t.includes('buen') || t.includes('feliz')))
    );
  }

  private async handleTwilioConnection(
    ws: WebSocket,
    connectionTimeout: NodeJS.Timeout,
  ): Promise<void> {
    try {
      const callContext: {
        customer_name?: string;
        allowInterrupt?: boolean;
        flowId?: string;
        customer_id?: string;
        callSid?: string;
        lastAssistantText?: string;
        pendingCallCompleted?: Readonly<{ flowId: string; userId: string; customer_id?: string }> | null;
        shouldHangupAfterAgentAudioDone?: boolean;
        isHangingUp?: boolean;
        transcriptSegments: Array<{ role: string; content: string }>;
        transcriptSentToCrm: boolean;
      } = {
        transcriptSegments: [],
        transcriptSentToCrm: false,
      };

      // Per-connection function map:
      // - Deepgram can request tool calls at any time
      // - We delay emitting `call.completed_successfully` until the conversation is actually finished
      const functionMap = createFunctionMap({
        emitCallCompletedSuccessfully: async (input: Readonly<{ flowId: string; userId: string }>) => {
          callContext.pendingCallCompleted = {
            ...input,
            // The monolith expects `customer_id` from the Twilio start params.
            // If it's missing, fall back to the same value we have as `userId`.
            customer_id: callContext.customer_id ?? input.userId,
          };
        },
      });

      // Native ws connection to Deepgram (no SDK).
      const deepgramConnection = new WebSocket(
        'wss://agent.deepgram.com/v1/agent/converse',
        ['token', this.deepgramApiKey],
      );

      const audioProcessor = new TwilioAudioProcessor({
        bufferSize: 20 * 160,
      });

      deepgramConnection.on('open', () => {
        clearTimeout(connectionTimeout);
        // Clone config per-call to avoid leaking previous caller context.
        const connectionAgentConfig = JSON.parse(
          JSON.stringify(this.agentConfigTemplate),
        ) as Record<string, unknown>;

        // Customize greeting using the customer name received in `start` event.
        const agent = (connectionAgentConfig['agent'] as any) ?? {};
        const greetingTemplate = String(agent.greeting ?? '');
        agent.greeting = greetingTemplate.replace('CUSTOMER_NAME', callContext.customer_name ?? '');
        connectionAgentConfig['agent'] = agent;

        deepgramConnection.send(JSON.stringify(connectionAgentConfig));
      });

      deepgramConnection.on('message', async (data: Buffer) => {
        try {
          const messageStr = data.toString();
          const message = JSON.parse(messageStr);
          console.log('🎤 Received from Deepgram:', message);

          if (typeof message === 'object') {
            await this.handleTextMessage(
              message,
              ws,
              deepgramConnection,
              audioProcessor.getStreamSid(),
              callContext,
              functionMap,
            );
          }
        } catch {
          // Non-JSON payloads are treated as audio; forward to Twilio.
          const currentStreamSid = audioProcessor.getStreamSid();
          if (!currentStreamSid) return;

          ws.send(
            JSON.stringify({
              event: 'media',
              streamSid: currentStreamSid,
              media: {
                payload: data.toString('base64'),
              },
            }),
          );
        }
      });

      deepgramConnection.on('close', () => {
        console.log('🚪 Conexión con Deepgram cerrada.');
        void (async () => {
          // If Deepgram ends the conversation without us already hanging up,
          // still complete the CRM event and close the Twilio media stream.
          await this.emitCallTranscriptIfNeeded(callContext);
          if (!callContext.isHangingUp && callContext.pendingCallCompleted) {
            await this.emitCallCompletedSuccessfullyToCrm(callContext.pendingCallCompleted);
            callContext.pendingCallCompleted = null;
          }

          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          } catch (error) {
            console.error('❌ Error closing Twilio WS after Deepgram close:', error);
          }
        })();
      });

      deepgramConnection.on('error', (error: unknown) => {
        console.error('❌ Deepgram connection error:', error);
      });

      ws.on('message', (message: Buffer) => {
        try {
          const raw = message.toString();
          const twilioMsg = JSON.parse(raw) as {
            event?: string;
            start?: {
              streamSid?: string;
              callSid?: string;
              customParameters?: Record<string, string>;
            };
          };

          if (twilioMsg.event === 'start') {
            const start = twilioMsg.start;
            if (start?.callSid != null) {
              callContext.callSid = String(start.callSid).trim();
            }
            const params = start?.customParameters ?? {};
            if (params.customer_name != null) {
              callContext.customer_name = String(params.customer_name).trim();
            }
            if (params.flowId != null) {
              callContext.flowId = String(params.flowId).trim();
            }
            if (params.customer_id != null) {
              callContext.customer_id = String(params.customer_id).trim();
            }
          }

          const messageObj = { type: 'utf8', utf8Data: raw };
          audioProcessor.processMessage(messageObj, deepgramConnection);
        } catch (error) {
          console.error('❌ Error processing Twilio message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log(
          '🔌 Cliente de Twilio desconectado. Code:',
          code,
          'Reason:',
          reason.toString(),
        );
        void this.emitVoiceConnectionClosedToCrm(callContext.flowId);
        deepgramConnection.close();
      });

      ws.on('error', (error: unknown) => {
        console.error('❌ Error en WebSocket de Twilio:', error);
        clearTimeout(connectionTimeout);
      });
    } catch (error) {
      console.error('❌ Error in Twilio connection handler:', error);
      clearTimeout(connectionTimeout);
    }
  }

  private async handleTextMessage(
    message: any,
    twilioWs: WebSocket,
    deepgramConnection: WebSocket,
    streamSid: string | null,
    callContext: {
      customer_name?: string;
      allowInterrupt?: boolean;
      flowId?: string;
      customer_id?: string;
      callSid?: string;
      lastAssistantText?: string;
      pendingCallCompleted?: Readonly<{ flowId: string; userId: string }> | null;
      shouldHangupAfterAgentAudioDone?: boolean;
      isHangingUp?: boolean;
      transcriptSegments: Array<{ role: string; content: string }>;
      transcriptSentToCrm: boolean;
    },
    functionMap: ReturnType<typeof createFunctionMap>,
  ): Promise<void> {
    if (message.type === 'ConversationText') {
      const role = typeof message.role === 'string' ? message.role : 'unknown';
      const rawContent = message.content;
      const content =
        typeof rawContent === 'string' ? rawContent.trim() : String(rawContent ?? '').trim();
      if (content.length > 0) {
        callContext.transcriptSegments.push({ role, content });
      }
    }

    if (message.type === 'UserStartedSpeaking') {
      console.log({ callContext, streamSid });
      if (callContext.allowInterrupt && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    }

    if (message.type === 'ConversationText' && message.role === 'assistant') {
      const content: string = message.content ?? '';
      callContext.lastAssistantText = content;
      if (content.includes('Te explico rápidamente')) {
        callContext.allowInterrupt = true;
      } else {

      }
    }

    if (message.type === 'AgentAudioDone') {
      if (
        callContext.shouldHangupAfterAgentAudioDone &&
        !callContext.isHangingUp
      ) {
        const lastAssistantText = callContext.lastAssistantText ?? '';
        if (lastAssistantText && !this.isGoodbyeText(lastAssistantText)) {
          // Wait for Deepgram to finish and/or ensure the farewell is spoken.
          return;
        }

        callContext.isHangingUp = true;
        callContext.shouldHangupAfterAgentAudioDone = false;

        if (callContext.pendingCallCompleted) {
          await this.emitCallTranscriptIfNeeded(callContext);
          await this.emitCallCompletedSuccessfullyToCrm(callContext.pendingCallCompleted);
          callContext.pendingCallCompleted = null;
        }

        // At this point the agent finished speaking its final goodbye.
        // Close the Twilio media stream to ensure the actual call hangs up.
        try {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.close();
          }
        } catch (error) {
          console.error('❌ Error closing Twilio WS after AgentAudioDone:', error);
        }

        try {
          deepgramConnection.close();
        } catch {
          // ignore
        }
      }
    }

    if (message.type === 'FunctionCallRequest') {
      await this.handleFunctionCallRequest(message, deepgramConnection, callContext, functionMap);
    }
  }

  private async handleFunctionCallRequest(
    message: any,
    deepgramConnection: WebSocket,
    callContext: {
      customer_name?: string;
      allowInterrupt?: boolean;
      flowId?: string;
      customer_id?: string;
      callSid?: string;
      shouldHangupAfterAgentAudioDone?: boolean;
      transcriptSegments: Array<{ role: string; content: string }>;
      transcriptSentToCrm: boolean;
    },
    functionMap: ReturnType<typeof createFunctionMap>,
  ): Promise<void> {
    try {
      for (const functionCall of message.functions) {
        const funcName = functionCall.name;
        const funcId = functionCall.id;
        let arguments_ = JSON.parse(functionCall.arguments || '{}');
        console.log('[handleFunctionCallRequest]', { funcName, funcId, arguments_ });
        if (funcName === 'scheduleAppointment' || funcName === 'disabledUser') {
          // After the agent executes these tools, we want to end the call
          // right after the agent's final audio (goodbye).
          callContext.shouldHangupAfterAgentAudioDone = true;
        }

        if (funcName === 'getContactName') {
          arguments_ = { ...arguments_, customer_name: callContext.customer_name ?? '' };
        }

        let result: any;
        if (funcName === 'scheduleAppointment') {
          const scheduleArgs = arguments_ as ScheduleAppointmentParams;
          arguments_ = {
            ...scheduleArgs,
            flowId: scheduleArgs.flowId ?? callContext.flowId,
            userId: scheduleArgs.userId ?? callContext.customer_id,
          };
        }

        if (funcName in functionMap) {
          result = await (functionMap as any)[funcName](arguments_);
        } else {
          result = { error: `Unknown function: ${funcName}` };
        }

        const functionResult = {
          type: 'FunctionCallResponse',
          id: funcId,
          name: funcName,
          content: JSON.stringify(result),
        };

        deepgramConnection.send(JSON.stringify(functionResult));
      }
    } catch (error) {
      console.error('Error calling function:', error);
      const errorResult = {
        type: 'FunctionCallResponse',
        id: 'unknown',
        name: 'unknown',
        content: JSON.stringify({ error: `Function call failed with: ${error}` }),
      };
      deepgramConnection.send(JSON.stringify(errorResult));
    }
  }
}


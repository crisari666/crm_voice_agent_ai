import { ConfigService } from '@nestjs/config';
import { OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Injectable, Inject } from '@nestjs/common';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer as NativeWebSocketServer } from 'ws';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { TwilioAudioProcessor } from './types/twilio-audio-processor';
import { createFunctionMap, type ScheduleAppointmentParams } from './config/function-map';

type CrmBackEventSourceType = 'ws_ms_events' | 'voice_agent_ms_events';

interface CrmBackEventPayload {
  readonly type: CrmBackEventSourceType;
  readonly payload: Record<string, unknown>;
}

@Injectable()
@WebSocketGateway({ path: '/twilio' })
export class TwilioGateway implements OnGatewayInit {
  private agentConfig: Record<string, unknown>;
  private readonly deepgramApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
  ) {
    const deepgramApiKey = this.configService.get<string>('DEEPGRAM_API_KEY');
    if (!deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }
    this.deepgramApiKey = deepgramApiKey;

    // Loaded once on startup (same behavior as Express server).
    const configPath = path.join(process.cwd(), 'config_lotes.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    this.agentConfig = JSON.parse(configData);
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

  private async emitCallCompletedSuccessfullyToCrm(
    input: Readonly<{ flowId: string; userId: string; customer_id?: string }>,
  ): Promise<void> {
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
        lastAssistantText?: string;
        pendingCallCompleted?: Readonly<{ flowId: string; userId: string; customer_id?: string }> | null;
        shouldHangupAfterAgentAudioDone?: boolean;
        isHangingUp?: boolean;
      } = {};

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
        // Customize greeting using the customer name received in `start` event.
        this.agentConfig['agent']['greeting'] = String(
          (this.agentConfig['agent'] as any)?.greeting ?? '',
        ).replace( 'CUSTOMER_NAME', callContext.customer_name ?? '');

        deepgramConnection.send(JSON.stringify(this.agentConfig));
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
              customParameters?: Record<string, string>;
            };
          };

          if (twilioMsg.event === 'start') {
            const params = twilioMsg.start?.customParameters ?? {};
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
      lastAssistantText?: string;
      pendingCallCompleted?: Readonly<{ flowId: string; userId: string }> | null;
      shouldHangupAfterAgentAudioDone?: boolean;
      isHangingUp?: boolean;
    },
    functionMap: ReturnType<typeof createFunctionMap>,
  ): Promise<void> {
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
      shouldHangupAfterAgentAudioDone?: boolean;
    },
    functionMap: ReturnType<typeof createFunctionMap>,
  ): Promise<void> {
    try {
      for (const functionCall of message.functions) {
        const funcName = functionCall.name;
        const funcId = functionCall.id;
        let arguments_ = JSON.parse(functionCall.arguments || '{}');

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


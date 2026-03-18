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
  private readonly functionMap: ReturnType<typeof createFunctionMap>;

  constructor(
    private readonly configService: ConfigService,
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
  ) {
    this.functionMap = createFunctionMap({
      emitCallCompletedSuccessfully: async (input: Readonly<{ flowId: string; userId: string }>) => {
        // Emitted into monolith to advance the onboarding flow.
        console.info('🔔 Emitting call.completed_successfully event to CRM Back:', JSON.stringify(input, null, 2));
        const event: CrmBackEventPayload = {
          type: 'voice_agent_ms_events',
          payload: {
            action: 'call.completed_successfully',
            flowId: input.flowId,
            userId: input.userId,
          },
        };

        await lastValueFrom(this.crmBackQueueClient.emit('voice_agent_ms_event', event));
      },
    });

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
      } = {};

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
        ).replace(
          'CUSTOMER_NAME',
          callContext.customer_name ?? '',
        );

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
    },
  ): Promise<void> {
    if (message.type === 'UserStartedSpeaking') {
      console.log({ callContext, streamSid });
      if (callContext.allowInterrupt && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    }

    if (message.type === 'ConversationText' && message.role === 'assistant') {
      const content: string = message.content ?? '';
      if (content.includes('Te explico rápidamente')) {
        callContext.allowInterrupt = true;
      } else {

      }
    }

    if (message.type === 'FunctionCallRequest') {
      await this.handleFunctionCallRequest(message, deepgramConnection, callContext);
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
    },
  ): Promise<void> {
    try {
      for (const functionCall of message.functions) {
        const funcName = functionCall.name;
        const funcId = functionCall.id;
        let arguments_ = JSON.parse(functionCall.arguments || '{}');

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

        if (funcName in this.functionMap) {
          result = await this.functionMap[funcName](arguments_);
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


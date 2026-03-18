
import { WebSocket } from 'ws';
import { FUNCTION_MAP } from '../config/function-map';
import { TwilioAudioProcessor } from '../types/twilio-audio-processor';



export class WebsocketsHandler {

  async handleTwilioConnection(
    ws: WebSocket,
    connectionTimeout: NodeJS.Timeout,
    agentConfig: Record<string, unknown>,
    deepgramApiKey: string,
  ): Promise<void> {
    try {
      const callContext: { customer_name?: string; allowInterrupt?: boolean } = {};
      
      // Connect to Deepgram using the correct authentication method
      const deepgramConnection = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['token', deepgramApiKey!]);

      // Initialize Twilio audio processor with optimized settings
      const audioProcessor = new TwilioAudioProcessor({
        bufferSize: 20 * 160, // Same as Python BUFFER_SIZE
      });


      deepgramConnection.on('open', () => {
        console.log('✅ Conexión con Deepgram establecida.');
        clearTimeout(connectionTimeout);

        // Send the agent configuration to Deepgram
        console.log('📤 Sending agent config to Deepgram...');
        agentConfig['agent']['greeting'] = agentConfig['agent']['greeting'].replace('CUSTOMER_NAME', callContext.customer_name ?? '');
        deepgramConnection.send(JSON.stringify(agentConfig));
      });

      deepgramConnection.on('message', async (data: Buffer) => {
        try {
          const messageStr = data.toString();
          const message = JSON.parse(messageStr);
          console.log('🎤 Received from Deepgram:', message);
          
          // Handle text messages (like Python sts_receiver)
          if (typeof message === 'object') {
            await this.handleTextMessage(message, ws, deepgramConnection, audioProcessor.getStreamSid(), callContext);
          }
        } catch (error) {
          // If it's not JSON, it's raw audio data from Deepgram (like Python)
         // console.log('🎤 Received raw audio from Deepgram');
          const currentStreamSid = audioProcessor.getStreamSid();
          if (currentStreamSid) {
            //console.log('🎤 Sending media message to Twilio');
            const mediaMessage = {
              event: 'media',
              streamSid: currentStreamSid,
              media: {
                payload: data.toString('base64')
              }
            };
            ws.send(JSON.stringify(mediaMessage));
          }
        }
      });

      deepgramConnection.on('close', () => {
        console.log('🚪 Conexión con Deepgram cerrada.');
      });

      deepgramConnection.on('error', (error) => {
        console.error('❌ Deepgram connection error:', error);
      });

      ws.on('message', (message: Buffer) => {
        try {
          const raw = message.toString();
          const twilioMsg = JSON.parse(raw) as { event?: string; start?: { streamSid?: string; customParameters?: Record<string, string> }; customParameters?: Record<string, string> };
          if (twilioMsg.event === 'start') {
            console.log(JSON.stringify(twilioMsg, null, 2))
            const params = twilioMsg.start?.customParameters
            if (params.customer_name != null) {
              callContext.customer_name = String(params.customer_name).trim();
            }
          }
          const messageObj = { type: 'utf8', utf8Data: raw };
          audioProcessor.processMessage(messageObj, deepgramConnection);
        } catch (error) {
          console.error('❌ Error processing Twilio message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('🔌 Cliente de Twilio desconectado. Code:', code, 'Reason:', reason.toString());
        deepgramConnection.close();
      });

      ws.on('error', (error) => {
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
    callContext: { customer_name?: string; allowInterrupt?: boolean }
  ): Promise<void> {
    if (message.type === 'UserStartedSpeaking') {
      console.log('🎤 User started speaking');
      if (callContext.allowInterrupt && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    }

    if (message.type === 'ConversationText' && message.role === 'assistant') {
      const content: string = message.content ?? '';
      if (content.includes('Te explico rápidamente')) {
        callContext.allowInterrupt = true;
        console.log('✅ Interruptions now allowed: agent started business explanation.');
      }
    }

    if (message.type === 'FunctionCallRequest') {
      await this.handleFunctionCallRequest(message, deepgramConnection, callContext);
    }
  }

  private async handleFunctionCallRequest(
    message: any,
    deepgramConnection: WebSocket,
    callContext: { customer_name?: string; allowInterrupt?: boolean }
  ): Promise<void> {
    try {
      for (const functionCall of message.functions) {
        const funcName = functionCall.name;
        const funcId = functionCall.id;
        let arguments_ = JSON.parse(functionCall.arguments || '{}');

        if (funcName === 'getContactName') {
          arguments_ = { ...arguments_, customer_name: callContext.customer_name ?? '' };
        }

        console.log(`Function call: ${funcName} (ID: ${funcId}), arguments:`, arguments_);

        let result: any;
        if (funcName in FUNCTION_MAP) {
          result = FUNCTION_MAP[funcName](arguments_);
          console.log('Function call result:', result);
        } else {
          result = { error: `Unknown function: ${funcName}` };
          console.log(result);
        }

        const functionResult = {
          type: 'FunctionCallResponse',
          id: funcId,
          name: funcName,
          content: JSON.stringify(result)
        };

        deepgramConnection.send(JSON.stringify(functionResult));
        console.log('Sent function result:', functionResult);
      }
    } catch (error) {
      console.error('Error calling function:', error);
      const errorResult = {
        type: 'FunctionCallResponse',
        id: 'unknown',
        name: 'unknown',
        content: JSON.stringify({ error: `Function call failed with: ${error}` })
      };
      deepgramConnection.send(JSON.stringify(errorResult));
    }
  }

  private async handleDeepGramMessage() {}
}
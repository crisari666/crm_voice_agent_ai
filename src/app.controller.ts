import { All, Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import { CallService } from './call-service/call.service';
import { escapeXmlAttr } from './common/xml-escape';
import { Twilio } from 'twilio';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { lastValueFrom } from 'rxjs';
import { ANSWERED_BY_SHOULD_HANGUP, CrmBackEventPayload } from './app.constants';

const TERMINAL_CALL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

@Controller()
export class AppController {
  private twilioClient?: Twilio;

  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
    private readonly callService: CallService,
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
  ) {
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('/request')
  public async handleRequest(@Body() body: unknown, @Res() res: Response): Promise<void> {
    // Express version logged the full payload and always returned { status: 'ok' }.
    console.log('📥 Request received:', body);
    res.status(200).json({ status: 'ok' });
  }

  @Post('/iniciar-llamada')
  @HttpCode(200)
  public async handleIniciarLlamada(@Body() body: any): Promise<string> {
    console.log('📞 Iniciando llamada...');
    return this.callService.initiateCall(body);
  }

  /**
   * Twilio fetches this URL when `calls.create({ url })` connects (GET or POST).
   * Query: required `websocketUrl` (wss://…); any other keys become `<Parameter name value>` on the Stream.
   */
  @All('/twiml')
  @HttpCode(200)
  public handleTwiML(@Query() query: Record<string, string | string[] | undefined>, @Res() res: Response): void {
    console.log('📄 TwiML request:', JSON.stringify(query));

    const rawWs = query.websocketUrl;
    const websocketUrl = Array.isArray(rawWs) ? rawWs[0] : rawWs;

    if (!websocketUrl || String(websocketUrl).trim().length === 0) {
      console.error('❌ Error: websocketUrl query parameter is required');
      res.status(400).send('Error: websocketUrl query parameter is required');
      return;
    }

    const streamUrl = escapeXmlAttr(String(websocketUrl).trim());
    const isProd = this.configService.get<boolean>('IS_PROD');

    const parameterLines = Object.entries(query)
      .filter(([key]) => key !== 'websocketUrl')
      .map(([key, val]) => {
        const v = Array.isArray(val) ? val[0] : val;
        if (v === undefined || v === '') return '';
        return `<Parameter name="${escapeXmlAttr(key)}" value="${escapeXmlAttr(String(v))}" />`;
      })
      .filter(Boolean)
      .join('\n                ');

    const twiml = `
        <Response>
            ${isProd ? '' : '<Say voice="alice" language="es-ES">Hola, esta es una llamada de prueba.</Say>'}
            <Connect>
                <Stream url="${streamUrl}">
                ${parameterLines}
                </Stream>
            </Connect>
        </Response>
      `;

    console.log('🔗 TwiML generated (Connect + Stream + parameters)');

    res.type('text/xml');
    res.send(twiml.trim());
  }

  @Post('/call-income')
  public handleCallIncome(@Body() body: unknown, @Res() res: Response): void {
    console.log('📞 Call income received:', body);
    res.status(200).json({ status: 'ok' });
  }

  @Post('/handle-fails')
  public handleFails(@Body() body: unknown, @Res() res: Response): void {
    console.log('❌ Handle fails received:', body);
    res.status(200).json({ status: 'ok' });
  }

  @Post('/status-change')
  public handleStatusChange(@Body() body: unknown, @Res() res: Response): void {
    console.log('🔄 Status change received 2:', body);
    res.status(200).json({ status: 'ok' });
  }

  @Post('/status-change-2')
  public handleStatusChange2(
    @Body() body: Record<string, unknown>,
    @Query('flowId') queryFlowId: string | undefined,
    @Query('userId') queryUserId: string | undefined,
    @Res() res: Response,
  ): void {
    console.log('🔄 Status second change received:', body);
    const callStatus = this.getOptionalNonEmptyString(body.CallStatus)?.toLowerCase();
    const flowId =
      this.getOptionalNonEmptyString(body.flowId) ?? this.getOptionalNonEmptyString(queryFlowId);
    const userId =
      this.getOptionalNonEmptyString(body.userId) ?? this.getOptionalNonEmptyString(queryUserId);
    if (callStatus != null && TERMINAL_CALL_STATUSES.has(callStatus)) {
      if (flowId != null || userId != null) {
        void this.emitVoiceConnectionClosedToCrm({
          flowId,
          userId,
          callStatus,
          callSid: this.getOptionalNonEmptyString(body.CallSid),
        });
      } else {
        console.warn(
          'Skipping call.voice_connection_closed event. Missing flowId and userId in /status-change-2 payload.',
        );
      }
    } else {
      console.warn(
        'Skipping call.voice_connection_closed event. Invalid or non-terminal call status.',
        body.CallStatus,
      );
    }
    res.status(200).json({ status: 'ok' });
  }

  @Post('/amd-status')
  public handleAmdStatus(
    @Body() body: Record<string, unknown>,
    @Query('flowId') queryFlowId: string | undefined,
    @Query('userId') queryUserId: string | undefined,
    @Res() res: Response,
  ): void {
    const { AnsweredBy, CallSid } = body ?? {};

    console.log(`🤖 AMD status for call ${CallSid}: ${AnsweredBy}`);

    if (typeof CallSid === 'string' && CallSid.length > 0 && ANSWERED_BY_SHOULD_HANGUP.has(String(AnsweredBy))) {
      console.log(`🤖 Voicemail/machine/fax detected for call ${CallSid} (${AnsweredBy}). Hanging up.`);
      const flowId = this.getOptionalNonEmptyString(body.flowId) ?? this.getOptionalNonEmptyString(queryFlowId);
      const userId = this.getOptionalNonEmptyString(body.userId) ?? this.getOptionalNonEmptyString(queryUserId);
      if (flowId != null || userId != null) {
        void this.emitVoicemailDetectedToCrmBack({
          flowId,
          userId,
          answeredBy: String(AnsweredBy),
          callSid: CallSid,
        });
      }
      const twilioClient = this.ensureTwilioClient();
      void twilioClient
        .calls(CallSid)
        .update({ status: 'completed' })
        .then(() => console.log(`📞 Call ${CallSid} terminated (AMD).`))
        .catch((error: unknown) =>
          console.error(`❌ Error terminating call ${CallSid}:`, error),
        );
    } else if (AnsweredBy === 'human') {
      console.log(`🧑 Human answered call ${CallSid}.`);
    }

    res.status(200).send('OK');
  }

  @Get('/health')
  public health(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  private ensureTwilioClient(): Twilio {
    if (this.twilioClient) return this.twilioClient;
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID_PROD');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN_PROD');

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID_PROD and TWILIO_AUTH_TOKEN_PROD are required');
    }

    this.twilioClient = new Twilio(accountSid, authToken);
    return this.twilioClient;
  }

  private getOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }

  private async emitVoicemailDetectedToCrmBack(input: {
    readonly flowId?: string | null;
    readonly userId?: string | null;
    readonly answeredBy: string;
    readonly callSid: string;
  }): Promise<void> {
    const event: CrmBackEventPayload = {
      type: 'voice_agent_ms_events',
      payload: {
        action: 'call.voicemail_detected',
        ...(input.flowId != null ? { flowId: input.flowId } : {}),
        ...(input.userId != null ? { userId: input.userId } : {}),
        answeredBy: input.answeredBy,
        callSid: input.callSid,
      },
    };
    try {
      await lastValueFrom(this.crmBackQueueClient.emit('voice_agent_ms_event', event));
    } catch (error) {
      console.error('❌ Error emitting call.voicemail_detected to CRM Back:', error);
    }
  }

  private async emitVoiceConnectionClosedToCrm(input: {
    readonly flowId?: string | null;
    readonly userId?: string | null;
    readonly callStatus: string;
    readonly callSid?: string | null;
  }): Promise<void> {
    const event: CrmBackEventPayload = {
      type: 'voice_agent_ms_events',
      payload: {
        action: 'call.voice_connection_closed',
        ...(input.flowId != null ? { flowId: input.flowId } : {}),
        ...(input.userId != null ? { userId: input.userId } : {}),
        callStatus: input.callStatus,
        ...(input.callSid != null ? { callSid: input.callSid } : {}),
      },
    };
    try {
      await lastValueFrom(this.crmBackQueueClient.emit('voice_agent_ms_event', event));
    } catch (error) {
      console.error('❌ Error emitting call.voice_connection_closed to CRM Back:', error);
    }
  }
}

import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import { Twilio } from 'twilio';
import type { Response } from 'express';

@Controller()
export class AppController {
  private twilioClient?: Twilio;

  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
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
  public async handleIniciarLlamada(
    @Body() body: any,
    @Res() res: Response,
  ): Promise<void> {
    const twilioClient = this.ensureTwilioClient();
    console.log('📞 Iniciando llamada...');

    const { websocketUrl, fromNumber, toNumber, ...additionalParams } = body ?? {};

    const customerPhoneNumber =
      toNumber ?? this.configService.get<string>('CUSTOMER_PHONE_NUMBER');
    const twilioPhoneNumber =
      fromNumber ?? this.configService.get<string>('TWILIO_PHONE_NUMBER');

    if (!customerPhoneNumber || !twilioPhoneNumber) {
      res.status(500).send(
        'Error: Phone numbers are required. Either provide fromNumber and toNumber in request body or set CUSTOMER_PHONE_NUMBER and TWILIO_PHONE_NUMBER environment variables',
      );
      return;
    }

    console.log({ websocketUrl, additionalParams });

    if (!websocketUrl) {
      res.status(400).send('Error: websocketUrl parameter is required');
      return;
    }

    try {
      const twiml = `
        <Response>
            <Say voice="alice" language="es-ES">Hola, esta es una llamada de prueba.</Say>
            <Connect>
            <Stream url="${websocketUrl}">
                ${Object.entries(additionalParams)
                  .map(([key, value]) => `<Parameter name="${key}" value="${value}" />`)
                  .join('\n')}
              </Stream>
            </Connect>
        </Response>
      `;

      console.log('🔗 Calling from:', twilioPhoneNumber, 'to:', customerPhoneNumber);

      await twilioClient.calls.create({
        to: customerPhoneNumber,
        from: twilioPhoneNumber,
        twiml,
        statusCallback: `${this.configService.get<string>('TWILIO_STATUS_CALLBACK_URL')}/status-change-2`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: [
          'queued',
          'no-answer',
          'ringing',
          'answered',
          'canceled',
          'failed',
          'completed',
          'busy',
        ],
      });

      res.send('Llamada iniciada. Revisa tu teléfono.');
    } catch (error) {
      console.error('❌ Error al iniciar la llamada:', error);
      res.status(500).send('Error al iniciar la llamada.');
    }
  }

  @Post('/twiml')
  @HttpCode(200)
  public handleTwiML(
    @Query('websocketUrl') websocketUrl: string,
    @Res() res: Response,
  ): void {
    console.log('📄 Generando TwiML para la llamada...');

    if (!websocketUrl) {
      console.error('❌ Error: websocketUrl parameter is required');
      res.status(400).send('Error: websocketUrl parameter is required');
      return;
    }

    console.log('🔗 WebSocket URL for TwiML:', websocketUrl);

    const twiml = `
      <Response>
          <Say voice="alice" language="es-ES"> Hola. </Say>
          <Connect>
            <Stream url="${encodeURIComponent(websocketUrl)}"/>
          </Connect>
      </Response>
    `;

    res.type('text/xml');
    res.send(twiml);
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
  public handleStatusChange2(@Body() body: unknown, @Res() res: Response): void {
    console.log('🔄 Status secod change received:', body);
    res.status(200).json({ status: 'ok' });
  }

  @Post('/amd-status')
  public handleAmdStatus(@Body() body: any, @Res() res: Response): void {
    const { AnsweredBy, CallSid } = body ?? {};

    console.log(`🤖 AMD status for call ${CallSid}: ${AnsweredBy}`);

    if (AnsweredBy === 'machine_start') {
      console.log(`🤖 Answering machine detected for call ${CallSid}. Hanging up.`);
      const twilioClient = this.ensureTwilioClient();
      void twilioClient.calls(CallSid).update({ status: 'completed' })
        .then(() => console.log(`📞 Call ${CallSid} terminated.`))
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
}

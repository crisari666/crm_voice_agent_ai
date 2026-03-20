import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

export type CallInitiateParams = {
  websocketUrl?: string;
  fromNumber?: string;
  toNumber?: string;
  customer_name?: string;
  customer_id?: string;
  is_dev?: boolean;
  [key: string]: unknown;
};

@Injectable()
export class CallService {
  private twilioClient?: Twilio;

  constructor(private readonly configService: ConfigService) {}

  async initiateCall(params: CallInitiateParams): Promise<string> {
    const { websocketUrl, fromNumber, toNumber, ...additionalParams } = params ?? {};

    const customerPhoneNumber =
      toNumber ?? this.configService.get<string>('CUSTOMER_PHONE_NUMBER');
    const twilioPhoneNumber =
      fromNumber ?? this.configService.get<string>('TWILIO_PHONE_NUMBER');

    if (!customerPhoneNumber || !twilioPhoneNumber) {
      throw new InternalServerErrorException(
        'Error: Phone numbers are required. Either provide fromNumber and toNumber in request body or set CUSTOMER_PHONE_NUMBER and TWILIO_PHONE_NUMBER environment variables',
      );
    }

    console.log({ websocketUrl, additionalParams });

    if (!websocketUrl) {
      throw new BadRequestException('Error: websocketUrl parameter is required');
    }

    try {
      const twiml = `
        <Response>
            <Say voice="alice" language="es-ES">Hola, esta es una llamada de prueba.</Say>
            <Connect>
            <Stream url="${websocketUrl}">
                ${Object.entries(additionalParams)
                  .map(
                    ([key, value]) =>
                      `<Parameter name="${key}" value="${String(value)}" />`,
                  )
                  .join('\n')}
              </Stream>
            </Connect>
        </Response>
      `;

      console.log('🔗 Calling from:', twilioPhoneNumber, 'to:', customerPhoneNumber);

      await this.ensureTwilioClient().calls.create({
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

      console.log('🔗 Twiml generated:', twiml);

      return 'Llamada iniciada. Revisa tu teléfono.';
    } catch (error) {
      console.error('❌ Error al iniciar la llamada:', error);
      throw new InternalServerErrorException('Error al iniciar la llamada.');
    }
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


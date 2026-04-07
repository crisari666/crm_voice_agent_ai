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
      const statusBaseUrl = this.configService.get<string>('TWILIO_STATUS_CALLBACK_URL');
      const amdStatusUrl =
        this.configService.get<string>('TWILIO_AMD_STATUS_CALLBACK_URL') ??
        (statusBaseUrl != null && statusBaseUrl.length > 0
          ? `${statusBaseUrl.replace(/\/$/, '')}/amd-status`
          : undefined);
      const flowId = typeof additionalParams.flowId === 'string' ? additionalParams.flowId.trim() : '';
      const userId = typeof additionalParams.customer_id === 'string' ? additionalParams.customer_id.trim() : '';
      const amdStatusCallbackUrl = this.buildAmdStatusCallbackUrl({
        baseUrl: amdStatusUrl,
        flowId,
        userId,
      });

      const statusCallbackUrl = this.buildStatusCallbackUrl({
        baseUrl: this.configService.get<string>('TWILIO_STATUS_CALLBACK_URL'),
        flowId,
        userId,
      });
      const twimlUrl = this.buildTwimlRequestUrl(websocketUrl, additionalParams);
      if (!twimlUrl) {
        throw new InternalServerErrorException(
          'Set TWILIO_TWIML_URL or TWILIO_STATUS_CALLBACK_URL so the outbound call can fetch TwiML from /twiml',
        );
      }

      console.log('🔗 Calling from:', twilioPhoneNumber, 'to:', customerPhoneNumber);
      console.log('🔗 TwiML URL:', twimlUrl);

      await this.ensureTwilioClient().calls.create({
        to: customerPhoneNumber,
        from: twilioPhoneNumber,
        url: twimlUrl,
        method: 'POST',
        ...(amdStatusCallbackUrl != null && amdStatusCallbackUrl.length > 0
          ? {
              machineDetection: 'Enable',
              asyncAmd: 'true',
              asyncAmdStatusCallback: amdStatusCallbackUrl,
              asyncAmdStatusCallbackMethod: 'POST' as const,
            }
          : {}),
        ...(statusCallbackUrl != null && statusCallbackUrl.length > 0
          ? { statusCallback: statusCallbackUrl }
          : {}),
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

      return 'Llamada iniciada. Revisa tu teléfono.';
    } catch (error) {
      console.error('❌ Error al iniciar la llamada:', error);
      throw new InternalServerErrorException('Error al iniciar la llamada.');
    }
  }

  /**
   * Public TwiML endpoint (see AppController GET/POST `/twiml`). Twilio loads this URL when the call is answered.
   */
  private buildTwimlRequestUrl(
    websocketUrl: string,
    additionalParams: Record<string, unknown>,
  ): string | undefined {
    const explicit = this.configService.get<string>('TWILIO_TWIML_URL')?.trim();
    const statusBase = this.configService.get<string>('TWILIO_STATUS_CALLBACK_URL')?.replace(/\/$/, '');
    const base =
      explicit && explicit.length > 0
        ? explicit.replace(/\/$/, '')
        : statusBase != null && statusBase.length > 0
          ? `${statusBase}/twiml`
          : undefined;
    if (!base) return undefined;

    const qs = new URLSearchParams();
    qs.set('websocketUrl', websocketUrl);
    for (const [key, value] of Object.entries(additionalParams)) {
      if (value === undefined || value === null) continue;
      qs.set(key, String(value));
    }

    return `${base}?${qs.toString()}`;
  }

  private buildAmdStatusCallbackUrl(input: {
    readonly baseUrl?: string;
    readonly flowId?: string;
    readonly userId?: string;
  }): string | undefined {
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl == null || baseUrl.length === 0) {
      return undefined;
    }
    const flowId = input.flowId?.trim() ?? '';
    const userId = input.userId?.trim() ?? '';
    if (flowId.length === 0 && userId.length === 0) {
      return baseUrl;
    }
    const url = new URL(baseUrl);
    if (flowId.length > 0) {
      url.searchParams.set('flowId', flowId);
    }
    if (userId.length > 0) {
      url.searchParams.set('userId', userId);
    }
    return url.toString();
  }

  private buildStatusCallbackUrl(input: {
    readonly baseUrl?: string;
    readonly flowId?: string;
    readonly userId?: string;
  }): string | undefined {
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl == null || baseUrl.length === 0) {
      return undefined;
    }
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/status-change-2`);
    const flowId = input.flowId?.trim() ?? '';
    const userId = input.userId?.trim() ?? '';
    if (flowId.length > 0) {
      url.searchParams.set('flowId', flowId);
    }
    if (userId.length > 0) {
      url.searchParams.set('userId', userId);
    }
    return url.toString();
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

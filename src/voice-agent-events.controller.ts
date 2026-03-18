import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { CallInitiateParams } from './call-service/call.service';
import { CallService } from './call-service/call.service';

type CrmBackEventSourceType = 'ws_ms_events' | 'voice_agent_ms_events';

interface CrmBackEventPayload {
  readonly type: CrmBackEventSourceType;
  readonly payload: Record<string, unknown>;
}

@Controller()
export class VoiceAgentEventsController {
  public constructor(private readonly callService: CallService) {}

  @EventPattern('ms_voice_agent')
  public async handleMs2Event(@Payload() event: CrmBackEventPayload): Promise<void> {
    console.log('handleMs2Event', JSON.stringify(event, null, 2));
    const payload = event.payload as Record<string, unknown>;
    const actionValue = payload.action;
    if (typeof actionValue !== 'string') return;

    if (actionValue === 'call.trigger_request') {
      const websocketUrl = payload.websocketUrl != null ? String(payload.websocketUrl) : '';
      const toNumber = payload.toNumber != null ? String(payload.toNumber) : '';
      const customerName = payload.customer_name != null ? String(payload.customer_name) : '';
      const userId = payload.userId != null ? String(payload.userId) : '';
      const flowId = payload.flowId != null ? String(payload.flowId) : '';

      const callParams: CallInitiateParams = {
        websocketUrl,
        toNumber,
        customer_name: customerName,
        customer_id: userId,
        flowId,
      };

      await this.callService.initiateCall(callParams);
    }
  }
}


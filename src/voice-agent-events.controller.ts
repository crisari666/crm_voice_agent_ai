import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import type { CallInitiateParams } from './call-service/call.service';
import { CallService } from './call-service/call.service';
import {
  VoiceAgentCrmBackTranscriptService,
  type EmitCallTranscriptCompleteInput,
} from './voice-agent-crm-back-transcript.service';

type CrmBackEventSourceType = 'ws_ms_events' | 'voice_agent_ms_events';

interface CrmBackEventPayload {
  readonly type: CrmBackEventSourceType;
  readonly payload: Record<string, unknown>;
}

@Controller()
export class VoiceAgentEventsController {
  public constructor(
    private readonly callService: CallService,
    private readonly transcriptService: VoiceAgentCrmBackTranscriptService,
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
  ) {}

  /** Emits `call.transcript_complete` on `crm_back_queue` for monolith onboarding / analytics. */
  public async sendCallTranscriptToBackend(
    input: EmitCallTranscriptCompleteInput,
  ): Promise<void> {
    await this.transcriptService.emitCallTranscriptComplete(input);
  }

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
      const candidateIdRaw = payload.candidateId ?? payload.leadCandidateId;
      const candidateId =
        candidateIdRaw != null ? String(candidateIdRaw).trim() : '';
      const flowId = payload.flowId != null ? String(payload.flowId) : '';
      const fromNumber =
        payload.fromNumber != null ? String(payload.fromNumber) : '';
      if (candidateId.length === 0) {
        console.error('VoiceAgentEventsController: missing candidateId in call.trigger_request', {
          flowId,
        });
        return;
      }

      const callParams: CallInitiateParams = {
        websocketUrl,
        toNumber,
        fromNumber: fromNumber.length > 0 ? fromNumber : undefined,
        customer_name: customerName,
        customer_id: candidateId,
        flowId,
      };

      try {
        await this.callService.initiateCall(callParams);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('VoiceAgentEventsController: call.trigger_request failed', message);
        await lastValueFrom(
          this.crmBackQueueClient.emit('voice_agent_ms_event', {
            type: 'voice_agent_ms_events',
            payload: {
              action: 'call.init_failed',
              flowId,
              candidateId,
              reason: message,
            },
          } as CrmBackEventPayload),
        );
      }
    }
  }
}


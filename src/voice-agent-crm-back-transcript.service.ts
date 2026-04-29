import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

type CrmBackEventSourceType = 'ws_ms_events' | 'voice_agent_ms_events';

interface CrmBackEventPayload {
  readonly type: CrmBackEventSourceType;
  readonly payload: Record<string, unknown>;
}

export type CallTranscriptSegment = {
  readonly role: string;
  readonly content: string;
};

export type EmitCallTranscriptCompleteInput = Readonly<{
  flowId: string;
  candidateId: string;
  callSid?: string;
  /** Full call transcript (plain text), typically built from `segments`. */
  transcript: string;
  /** Ordered utterances for structured persistence on the monolith. */
  segments?: readonly CallTranscriptSegment[];
}>;

@Injectable()
export class VoiceAgentCrmBackTranscriptService {
  public constructor(
    @Inject('CRM_BACK_QUEUE') private readonly crmBackQueueClient: ClientProxy,
  ) {}

  /**
   * Sends the full call transcript to CRM Back (`voice_agent_ms_event`).
   * Monolith should handle `payload.action === 'call.transcript_complete'`.
   */
  public async emitCallTranscriptComplete(
    input: EmitCallTranscriptCompleteInput,
  ): Promise<void> {
    const event: CrmBackEventPayload = {
      type: 'voice_agent_ms_events',
      payload: {
        action: 'call.transcript_complete',
        flowId: input.flowId,
        candidateId: input.candidateId,
        callSid: input.callSid,
        transcript: input.transcript,
        segments: input.segments,
      },
    };

    console.info(
      '🔔 Emitting call.transcript_complete to CRM Back:',
      JSON.stringify(
        { flowId: input.flowId, candidateId: input.candidateId, callSid: input.callSid },
        null,
        2,
      ),
    );

    await lastValueFrom(this.crmBackQueueClient.emit('voice_agent_ms_event', event));
  }
}

import { Injectable } from '@nestjs/common';

export type RecruitingCallContext = {
  readonly voiceAgentPrompt: string;
  readonly recruiting: boolean;
  readonly candidateId: string;
  readonly flowId: string;
};

/**
 * Short-lived store for recruiting call prompts (Twilio URL cannot carry large prompts).
 */
@Injectable()
export class RecruitingCallContextStore {
  private readonly byFlowId = new Map<string, RecruitingCallContext>();

  public put(context: RecruitingCallContext): void {
    const flowId = context.flowId.trim();
    if (flowId.length === 0) return;
    this.byFlowId.set(flowId, context);
  }

  public take(flowId: string): RecruitingCallContext | undefined {
    const key = flowId.trim();
    if (key.length === 0) return undefined;
    const value = this.byFlowId.get(key);
    if (value != null) {
      this.byFlowId.delete(key);
    }
    return value;
  }

  public peek(flowId: string): RecruitingCallContext | undefined {
    return this.byFlowId.get(flowId.trim());
  }
}

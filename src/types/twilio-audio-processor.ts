import { WebSocket } from 'ws';

/** Adapter for sending audio to Deepgram (WebSocket or SDK connection). */
export interface DeepgramAudioSender {
  send(data: Buffer): void;
  readyState?: number;
}

export interface TwilioAudioProcessorConfig {
  readonly bufferSize: number;
}

export class TwilioAudioProcessor {
  private readonly config: TwilioAudioProcessorConfig;
  private inBuffer: Buffer;
  private streamSid: string | null;

  constructor(config: TwilioAudioProcessorConfig) {
    this.config = config;
    this.inBuffer = Buffer.alloc(0);
    this.streamSid = null;
  }

  public processMessage(
    message: { type: string; utf8Data?: string },
    sender: WebSocket | DeepgramAudioSender
  ): void {
    if (message.type !== 'utf8' || !message.utf8Data) return;
    const data = JSON.parse(message.utf8Data);
    this.handleTwilioEvent(data, sender);
  }

  private handleTwilioEvent(
    data: { event?: string; start?: { streamSid: string }; media?: { track?: string; payload?: string } },
    sender: WebSocket | DeepgramAudioSender
  ): void {
    switch (data.event) {
      case 'connected':
        break;
      case 'start':
        console.log('get our streamsid');
        this.streamSid = data.start?.streamSid ?? null;
        break;
      case 'media':
        this.handleMediaEvent(data, sender);
        break;
      case 'stop':
        break;
      default:
        console.log('Unknown event:', data.event);
    }
  }

  private handleMediaEvent(
    data: { media?: { track?: string; payload?: string } },
    sender: WebSocket | DeepgramAudioSender
  ): void {
    const media = data.media;
    if (media?.track !== 'inbound' || !media.payload) return;
    const chunk = Buffer.from(media.payload, 'base64');
    this.inBuffer = Buffer.concat([this.inBuffer, chunk]);

    const ready =
      typeof (sender as DeepgramAudioSender).readyState === 'number'
        ? (sender as DeepgramAudioSender).readyState === 1
        : (sender as WebSocket).readyState === WebSocket.OPEN;
    while (this.inBuffer.length >= this.config.bufferSize) {
      const audioChunk = this.inBuffer.slice(0, this.config.bufferSize);
      this.inBuffer = this.inBuffer.slice(this.config.bufferSize);
      if (ready) {
        if ('send' in sender && typeof (sender as DeepgramAudioSender).send === 'function') {
          (sender as DeepgramAudioSender).send(audioChunk);
        } else {
          (sender as WebSocket).send(audioChunk);
        }
      }
    }
  }

  public getStreamSid(): string | null {
    return this.streamSid;
  }
} 
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
}

export interface FunctionCall {
  readonly name: string;
  readonly id: string;
  readonly arguments: string;
}

export interface FunctionCallResponse {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

export interface TwilioMessage {
  readonly event: string;
  readonly start?: {
    readonly streamSid: string;
  };
  readonly media?: {
    readonly payload: string;
    readonly track: string;
  };
}

export interface MediaMessage {
  readonly event: string;
  readonly streamSid: string;
  readonly media: {
    readonly payload: string;
  };
}

export interface ClearMessage {
  readonly event: string;
  readonly streamSid: string;
}

export interface FunctionMap {
  [key: string]: (...args: any[]) => any;
} 
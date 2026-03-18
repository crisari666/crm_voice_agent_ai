import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CallService } from './call-service/call.service';
import { TwilioGateway } from './twilio.gateway';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { VoiceAgentEventsController } from './voice-agent-events.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      {
        name: 'CRM_BACK_QUEUE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => {
          const rabbitMqUser = configService.get<string>('RABBIT_MQ_USER', 'guest');
          const rabbitMqPass = configService.get<string>('RABBIT_MQ_PASS', 'guest');
          const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@localhost:5672`;
          return {
            transport: Transport.RMQ,
            options: {
              urls: [rabbitMqUrl],
              queue: 'crm_back_queue', // where MS2 is listening
              queueOptions: { durable: true },
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [AppController, VoiceAgentEventsController],
  providers: [AppService, TwilioGateway, CallService],
})
export class AppModule {}

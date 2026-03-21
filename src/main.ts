import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import * as express from 'express';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Required by your constraint: use Nest WsAdapter (even though we attach `ws` directly too).

  const rabbitMqUser = process.env.RABBIT_MQ_USER || 'guest';
  const rabbitMqPass = process.env.RABBIT_MQ_PASS || 'guest';
  const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@localhost:5672`;
  app.setGlobalPrefix('voice-agent', { exclude: ['/twilio'] });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitMqUrl],
      queue: 'voice_agent_ms_queue',
      queueOptions: {
        durable: true, // 👈 asegura persistencia
      },
    },
  });
  await app.startAllMicroservices();



  app.useWebSocketAdapter(new WsAdapter(app));

  const port = parseInt(process.env.PORT || '8881', 10);
  await app.listen(port);
}
bootstrap();

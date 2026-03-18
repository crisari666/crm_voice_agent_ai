import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Required by your constraint: use Nest WsAdapter (even though we attach `ws` directly too).
  app.useWebSocketAdapter(new WsAdapter(app));

  const port = parseInt(process.env.PORT || '8881', 10);
  await app.listen(port);
}
bootstrap();

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';

export const SAFETRADE_EXCHANGE = 'safetrade.events';

@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection?: ChannelModel;
  private channel?: Channel;
  private initPromise?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL not set; event publishing/consuming is disabled');
      return;
    }
    try {
      this.connection = await connect(url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(SAFETRADE_EXCHANGE, 'topic', {
        durable: true,
      });
      this.logger.log('Connected to RabbitMQ');
    } catch (error) {
      this.logger.error('Failed to connect to RabbitMQ', error as Error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      this.logger.warn(`RabbitMQ channel not ready; skipping publish: ${routingKey}`);
      return;
    }
    try {
      this.channel.publish(
        SAFETRADE_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json' },
      );
      this.logger.log(`Published: ${routingKey}`);
    } catch (error) {
      this.logger.error(`Failed to publish ${routingKey}`, error as Error);
    }
  }

  async consume(
    queue: string,
    routingKeys: string[],
    handler: (routingKey: string, body: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      this.logger.warn(`RabbitMQ channel not ready; skipping consume: ${queue}`);
      return;
    }
    await this.channel.assertQueue(queue, { durable: true });
    for (const key of routingKeys) {
      await this.channel.bindQueue(queue, SAFETRADE_EXCHANGE, key);
    }
    this.logger.log(`Consuming queue ${queue} for keys: ${routingKeys.join(', ')}`);
    await this.channel.consume(queue, (msg: ConsumeMessage | null) => {
      void this.handleMessage(msg, handler);
    });
  }

  private async handleMessage(
    msg: ConsumeMessage | null,
    handler: (routingKey: string, body: unknown) => Promise<void>,
  ): Promise<void> {
    if (!msg || !this.channel) return;
    try {
      const body = JSON.parse(msg.content.toString()) as unknown;
      await handler(msg.fields.routingKey, body);
      this.channel.ack(msg);
    } catch (error) {
      this.logger.error('Consumer error', error as Error);
      this.channel.nack(msg, false, true);
    }
  }
}
